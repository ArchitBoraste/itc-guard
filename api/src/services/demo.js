// Demo seed: load one fixture period end to end so the app is never a dead empty
// screen on first open.
//
// Deliberately runs the REAL ingestion path — createUpload -> commitUpload ->
// createRun — rather than inserting rows directly. A demo that takes a shortcut
// past the adapters proves nothing about the adapters, and this is the path the
// hackathon demo runs from.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { ServiceError, commitUpload, createUpload } from './ingest.js';
import { FILING_SCHEMES } from '../matching/cutoff.js';
import { createRun } from './reconcile.js';
import { rebuildSupplierStats } from './supplierRisk.js';
import { setSupplierScheme, syncSuppliers } from './supplierStats.js';

// The fixture generator's own trader. Matches tools/seed-demo.js, because the two
// have to seed the same org or the IMS action JSON comes out under a different
// GSTIN depending on which one ran.
const TRADER = Object.freeze({
  gstin: '27AABCS1429F1Z8',
  legalName: 'Sharma Electronics Private Limited',
  tradeName: 'Sharma Electronics',
  stateCode: '27'
});

export const DEMO_PERIOD = '2026-04';

// organizations.gstin is globally UNIQUE, and it has to stay that way — two
// traders sharing a GSTIN is not a thing. So each demo tenant gets its own valid
// GSTIN under the same PAN prefix, varying the PAN's four serial digits and
// recomputing the check digit. That is a real registration pattern (one PAN, many
// registrations), and it keeps the trader's NAME identical on every judge's
// screen while the identity underneath is genuinely distinct.
//
// Org 1 keeps the canonical fixture GSTIN so the presenter's own demo, every
// screenshot and the README all still say 27AABCS1429F1Z8.
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// GSTIN check digit: weights alternate 1,2 across the first 14 characters; each
// product contributes its quotient and remainder mod 36.
function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]);
    if (value < 0) throw new Error(`invalid GSTIN character '${first14[i]}'`);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

export function traderGstinFor(orgId) {
  if (Number(orgId) === 1) return TRADER.gstin;
  // 27 AABCS <dddd> F 1 Z <check> — indices 7..10 are the PAN serial digits.
  const serial = String(Number(orgId) % 10000).padStart(4, '0');
  const first14 = `27AABCS${serial}F1Z`;
  return first14 + gstinCheckDigit(first14);
}

const SOURCES = Object.freeze([
  { kind: 'PURCHASE_REGISTER', filename: 'purchase_register.xlsx' },
  { kind: 'IMS', filename: 'ims.json' },
  { kind: 'GSTR2B', filename: 'gstr2b.json' }
]);

// Which periods can be seeded, i.e. which ones actually have fixture files on
// disk. Empty when the fixtures are not mounted — the UI hides the button rather
// than offering one that 500s.
export function availableDemoPeriods() {
  const root = config.fixturesDir;
  if (!root || !existsSync(root)) return [];
  const periods = [];
  for (let year = 2026; year <= 2027; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const period = `${year}-${String(month).padStart(2, '0')}`;
      const complete = SOURCES.every((source) =>
        existsSync(join(root, period, source.filename))
      );
      if (complete) periods.push(period);
    }
  }
  return periods;
}

// Creates the org if it is not there, and otherwise leaves it completely alone.
//
// It used to be an INSERT ... ON DUPLICATE KEY UPDATE writing the one hard-coded
// trader GSTIN. With more than one org that is a cross-tenant write, not an
// upsert: the duplicate key it hits is the UNIQUE on gstin, which belongs to a
// DIFFERENT org's row, so seeding org N would rename org 1. Nothing here has any
// business editing an org that already exists.
export async function ensureOrg(orgId) {
  const [existing] = await pool.query('SELECT id FROM organizations WHERE id = ?', [orgId]);
  if (existing.length) return;
  await pool.query(
    `INSERT IGNORE INTO organizations (id, gstin, legal_name, trade_name, state_code, filer_type)
     VALUES (?, ?, ?, ?, ?, 'MONTHLY')`,
    [orgId, traderGstinFor(orgId), TRADER.legalName, TRADER.tradeName, TRADER.stateCode]
  );
}

// Loading the sample into a period replaces what the org holds for it, because a
// commit replaces its period. Harmless while the period still IS the sample;
// destructive once anything has changed since: a file the visitor uploaded, or a
// portal record amended after the sample was loaded — which is what the scripted
// April story is. Re-loading April used to undo the story silently (audit P23).
// So the reload is refused, with the reason, instead.
async function assertSampleReloadSafe(orgId, taxPeriod) {
  const samples = SOURCES.map((source) => source.filename);
  const [[own]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM expected_invoices ei JOIN uploads u ON u.id = ei.upload_id
              WHERE ei.org_id = ? AND ei.tax_period = ? AND u.original_filename NOT IN (?)) +
            (SELECT COUNT(*) FROM portal_records pr JOIN uploads u ON u.id = pr.upload_id
              WHERE pr.org_id = ? AND pr.tax_period = ? AND u.original_filename NOT IN (?)) AS n`,
    [orgId, taxPeriod, samples, orgId, taxPeriod, samples]
  );
  const [[changed]] = await pool.query(
    `SELECT COUNT(DISTINCT rc.portal_record_id) AS n
       FROM record_changes rc JOIN portal_records pr ON pr.id = rc.portal_record_id
      WHERE rc.org_id = ? AND pr.tax_period = ?`,
    [orgId, taxPeriod]
  );
  const ownRows = Number(own.n);
  const changedRecords = Number(changed.n);
  if (!ownRows && !changedRecords) return;

  const reasons = [
    ownRows ? `${ownRows} row${ownRows === 1 ? '' : 's'} from files you uploaded` : null,
    changedRecords
      ? `${changedRecords} portal record${changedRecords === 1 ? '' : 's'} changed since the ` +
        'sample was loaded (the demo story is one such change)'
      : null
  ].filter(Boolean);
  throw new ServiceError(
    `${taxPeriod} is already loaded and holds ${reasons.join(' and ')}. Loading the sample ` +
      'again would overwrite that, so it was not loaded. Use "Reset my data" to start over.',
    409,
    'sample_reload_refused'
  );
}

// The demo trader knows which of their suppliers file quarterly, the way a real
// trader does, and has told the app — so the sample opens with those schemes
// "set by you" rather than "assumed". The portal data cannot show it: a QRMP
// supplier using IFF who files early looks monthly (audit P9).
//
// The ONLY reader of fixtures/suppliers.json, which is the generator's record of
// each supplier's true scheme. Inference and everything else work from the
// portal data. Only QRMP suppliers are pre-set, and never over a scheme the
// visitor chose themselves. No file, nothing to pre-set: schemes stay assumed.
export async function presetDemoSupplierSchemes(orgId) {
  const path = join(config.fixturesDir ?? '', 'suppliers.json');
  if (!config.fixturesDir || !existsSync(path)) return { preset: 0 };

  const { suppliers = [] } = JSON.parse(readFileSync(path, 'utf8'));
  let preset = 0;
  for (const supplier of suppliers.filter((entry) => entry.scheme === 'QUARTERLY')) {
    const changed = await setSupplierScheme(orgId, supplier.gstin, FILING_SCHEMES.QRMP, {
      onlyIfInferred: true
    });
    if (changed) preset += 1;
  }
  return { preset };
}

// seedDemoPeriod(orgId, { taxPeriod, asOfDate }) -> { taxPeriod, uploads, runId }
//
// asOfDate defaults to the 16th of the following month: after 2B generates on the
// 14th, before GSTR-3B falls due on the 20th. That is the reactive window the
// decision engine is built for, and the one the deemed-acceptance banner is about.
export async function seedDemoPeriod(orgId, { taxPeriod = DEMO_PERIOD, asOfDate = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod ?? ''))) {
    throw new ServiceError('taxPeriod must be YYYY-MM');
  }
  const root = config.fixturesDir;
  if (!root || !existsSync(join(root, taxPeriod))) {
    throw new ServiceError(
      `no sample data on disk for ${taxPeriod} — run "npm run gen:fixtures" and make sure ` +
        'the fixtures directory is mounted into the api container',
      404,
      'not_found'
    );
  }

  await ensureOrg(orgId);
  await assertSampleReloadSafe(orgId, taxPeriod);

  const uploads = [];
  for (const source of SOURCES) {
    const path = join(root, taxPeriod, source.filename);
    if (!existsSync(path)) {
      throw new ServiceError(`missing sample file ${source.filename} for ${taxPeriod}`, 404, 'not_found');
    }
    const created = await createUpload({
      orgId,
      kind: source.kind,
      filename: source.filename,
      buffer: readFileSync(path),
      taxPeriod
    });
    const committed = await commitUpload(orgId, created.id);
    uploads.push({ ...committed, uploadId: created.id, filename: source.filename });
  }

  const [year, month] = taxPeriod.split('-').map(Number);
  const next = month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;

  // Before the run, so its recommendations and totals use the right cut-offs.
  await syncSuppliers(orgId);
  await presetDemoSupplierSchemes(orgId);

  const run = await createRun({
    orgId,
    taxPeriod,
    mode: 'REACTIVE',
    asOfDate: asOfDate ?? `${next}-16`
  });
  await rebuildSupplierStats(orgId, taxPeriod, { runId: run.id });

  return { taxPeriod, uploads, runId: run.id, run };
}
