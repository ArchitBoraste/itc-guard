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
import { createRun } from './reconcile.js';
import { rebuildSupplierPeriods } from './supplierStats.js';

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

async function ensureOrg(orgId) {
  await pool.query(
    `INSERT INTO organizations (id, gstin, legal_name, trade_name, state_code, filer_type)
     VALUES (?, ?, ?, ?, ?, 'MONTHLY')
     ON DUPLICATE KEY UPDATE gstin = VALUES(gstin), legal_name = VALUES(legal_name),
       trade_name = VALUES(trade_name), state_code = VALUES(state_code)`,
    [orgId, TRADER.gstin, TRADER.legalName, TRADER.tradeName, TRADER.stateCode]
  );
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

  const run = await createRun({
    orgId,
    taxPeriod,
    mode: 'REACTIVE',
    asOfDate: asOfDate ?? `${next}-16`
  });
  await rebuildSupplierPeriods(orgId, taxPeriod, { runId: run.id });

  return { taxPeriod, uploads, runId: run.id, run };
}
