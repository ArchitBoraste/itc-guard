// export-training-data.js — supplier_periods -> CSV for ml/train.py.
//
// Run:  node tools/export-training-data.js --seed        (load fixtures, then export)
//       node tools/export-training-data.js               (export what is there)
//       node tools/export-training-data.js --org 10 --out ml/training-data.csv
//
// ---------------------------------------------------------------------------
// One row per (supplier, period) — and the period is the LABEL period
// ---------------------------------------------------------------------------
//
// The row's features are computed from the periods BEFORE it, never including
// it. That separation is the whole point: `filed_late` in period P is most of
// the label, so a feature set that also spanned P would let the model read the
// answer off its own input and score ~1.0 on nothing. Trained the honest way it
// answers the question the product actually asks in the first week of the month
// — "given what this supplier has done up to now, will THIS month's invoice
// reach my 2B on time?" — at a point where P has not happened yet.
//
// ---------------------------------------------------------------------------
// Why the phase-7 heuristic score is exported alongside
// ---------------------------------------------------------------------------
//
// The brief says to keep the hand-weighted scorer if the model cannot beat it on
// held-out data. Judging that needs both scores over the same rows, and the
// heuristic column is produced by CALLING scoreSupplierRisk() from
// services/preventive.js rather than by reimplementing it here. A second copy
// would drift, and the comparison would then be against a scorer that is not the
// one in production.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, pool } from '../api/src/db/pool.js';
import { commitUpload, createUpload } from '../api/src/services/ingest.js';
import { createRun } from '../api/src/services/reconcile.js';
import { rebuildSupplierPeriods } from '../api/src/services/supplierStats.js';
import { HISTORY_PERIODS, scoreSupplierRisk } from '../api/src/services/preventive.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO_ROOT, 'fixtures');

// org 1 is the RUNNING APPLICATION's org — stubAuth serves it, seed-demo writes
// to it, and the "Load sample data" button lands there. Training reads a corpus
// six periods deep and --seed would overwrite whatever the demo had loaded, so
// this tool takes its own org and refuses org 1 outright. Same reservation as
// TEST_ORGS in api/test/helpers/db.js.
const APP_ORG_ID = 1;
const TRAINING_ORG_ID = 10;

const TRADER = {
  gstin: '27AABCS1429F10Z',
  legalName: 'Sharma Electronics Private Limited',
  tradeName: 'Sharma Electronics',
  stateCode: '27'
};

const PERIODS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

const SOURCES = [
  { kind: 'PURCHASE_REGISTER', filename: 'purchase_register.xlsx' },
  { kind: 'IMS', filename: 'ims.json' },
  { kind: 'GSTR2B', filename: 'gstr2b.json' }
];

// Amendment sections across both sources. The 2B adapter maps IMS b2ba/b2bdna/
// b2bcna onto these same names.
const AMENDMENT_SECTIONS = ['b2ba', 'cdnra', 'isda', 'ecoma'];

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { seed: false, org: TRAINING_ORG_ID, out: join(REPO_ROOT, 'ml', 'training-data.csv') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seed') args.seed = true;
    else if (argv[i] === '--org') args.org = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function assertNotAppOrg(orgId) {
  if (Number(orgId) === APP_ORG_ID) {
    throw new Error(
      `refusing org ${APP_ORG_ID}: that is the running application's org. ` +
        `Training uses org ${TRAINING_ORG_ID} — pass --org with a different id.`
    );
  }
}

async function seedFixtures(orgId) {
  await pool.query(
    `INSERT INTO organizations (id, gstin, legal_name, trade_name, state_code, filer_type)
     VALUES (?, ?, ?, ?, ?, 'MONTHLY')
     ON DUPLICATE KEY UPDATE gstin = VALUES(gstin)`,
    [orgId, TRADER.gstin, TRADER.legalName, TRADER.tradeName, TRADER.stateCode]
  );

  for (const period of PERIODS) {
    for (const source of SOURCES) {
      const path = join(FIXTURES, period, source.filename);
      if (!existsSync(path)) throw new Error(`missing fixture: ${path}`);
      const created = await createUpload({
        orgId,
        kind: source.kind,
        filename: source.filename,
        buffer: (await import('node:fs')).readFileSync(path),
        taxPeriod: period
      });
      await commitUpload(orgId, created.id);
    }
    process.stdout.write(`  ingested ${period}\n`);
  }

  // Every period's portal rows are in place before the first rebuild, so scheme
  // inference sees the whole filing cadence at once. Rebuilding as each period
  // landed would measure the early months against a scheme inferred from one
  // observation and leave stale days-late figures behind.
  //
  // A RUN per period, and its id handed to the rebuild, is not optional here.
  // supplier_periods.mismatch_count is populated FROM a run's verdicts; without
  // one it stays 0 for every supplier, which silently empties both the
  // mismatch_rate feature and most of the label. The first version of this export
  // did exactly that and produced 9 positives in 200 rows.
  //
  // Runs are REACTIVE as of the 16th — after 2B generates on the 14th — because
  // the label is about what actually reached 2B, which is not knowable earlier.
  for (const period of PERIODS) {
    const run = await createRun({
      orgId,
      taxPeriod: period,
      mode: 'REACTIVE',
      asOfDate: `${nextPeriod(period)}-16`
    });
    // Periods only, NOT rebuildSupplierStats(). Training needs the behaviour
    // table and nothing else; scoring here would band these suppliers with a
    // model fitted on this very data, which is circular and would land in
    // supplier_risk looking like a real verdict.
    await rebuildSupplierPeriods(orgId, period, { runId: run.id });
  }
  process.stdout.write('  reconciled and rebuilt supplier periods\n');
}

function nextPeriod(taxPeriod) {
  const [year, month] = taxPeriod.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

// gstin -> tax_period -> observation. The same shape scoreSupplierRisk() consumes,
// so the heuristic column below is the production scorer's own answer.
async function loadObservations(orgId) {
  const [rows] = await pool.query(
    `SELECT s.gstin, sp.tax_period, sp.expected_count, sp.invoice_count,
            sp.appeared_in_2b, sp.appeared_in_ims, sp.mismatch_count,
            sp.days_late, sp.filed_late, sp.missed, sp.filing_scheme
       FROM supplier_periods sp
       JOIN suppliers s ON s.id = sp.supplier_id AND s.org_id = sp.org_id
      WHERE sp.org_id = ?
      ORDER BY s.gstin, sp.tax_period`,
    [orgId]
  );

  // Amendments are not on supplier_periods, so they are counted straight off the
  // portal rows. In THIS corpus the count is always zero — see the note in
  // ml/train.py about what the fixture generator does and does not emit.
  const [amendments] = await pool.query(
    `SELECT supplier_gstin, tax_period, COUNT(*) AS amendments
       FROM portal_records
      WHERE org_id = ? AND supplier_gstin IS NOT NULL AND section IN (?)
      GROUP BY supplier_gstin, tax_period`,
    [orgId, AMENDMENT_SECTIONS]
  );
  const amendmentBy = new Map(
    amendments.map((row) => [`${row.supplier_gstin}|${row.tax_period}`, Number(row.amendments)])
  );

  // The label side, at INVOICE level. "Reached 2B, correct and on time" is a
  // claim about the documents the trader booked, so it is read off the run's
  // verdicts rather than off a supplier-level aggregate.
  //
  // Only two buckets count as the supplier's failure:
  //   MISSING_IN_PORTAL  they never reported an invoice the trader booked
  //   VALUE_MISMATCH     they reported it with figures that disagree
  // SUGGESTED is excluded on purpose — the money agrees and only the invoice
  // NUMBER still differs, which is our matcher's uncertainty, not their mistake.
  // MISSING_IN_BOOKS is the trader's own register. INELIGIBLE and NON_IMS were
  // never claimable through IMS at all.
  const [failures] = await pool.query(
    `SELECT ru.tax_period, ei.supplier_gstin,
            SUM(mr.bucket IN ('MISSING_IN_PORTAL','VALUE_MISMATCH')) AS bad
       FROM match_results mr
       JOIN runs ru ON ru.id = mr.run_id AND ru.org_id = mr.org_id
       JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
      WHERE mr.org_id = ?
      GROUP BY ru.tax_period, ei.supplier_gstin`,
    [orgId]
  );
  const failuresBy = new Map(
    failures.map((row) => [`${row.supplier_gstin}|${row.tax_period}`, Number(row.bad)])
  );

  const bySupplier = new Map();
  for (const row of rows) {
    if (!bySupplier.has(row.gstin)) bySupplier.set(row.gstin, []);
    bySupplier.get(row.gstin).push({
      badDocuments: failuresBy.get(`${row.gstin}|${row.tax_period}`) ?? 0,
      taxPeriod: row.tax_period,
      filingScheme: row.filing_scheme,
      expectedCount: Number(row.expected_count),
      invoiceCount: Number(row.invoice_count),
      appearedIn2b: Boolean(row.appeared_in_2b),
      appearedInIms: Boolean(row.appeared_in_ims),
      mismatchCount: Number(row.mismatch_count),
      daysLate: row.days_late === null ? null : Number(row.days_late),
      filedLate: Boolean(row.filed_late),
      missed: Boolean(row.missed),
      amendments: amendmentBy.get(`${row.gstin}|${row.tax_period}`) ?? 0
    });
  }
  return bySupplier;
}

// The features named in the brief, computed over `history` (periods strictly
// before the label period).
//
// gstr3b_filed_ratio is emitted EMPTY, always. Whether a supplier filed their own
// GSTR-3B is not in anything this app ingests: GSTR-2B carries `cfs`, and
// docs/gstr2b-schema.md records that it is unverified whether `cfs` refers to
// GSTR-1 or GSTR-3B — while the fixture generator hard-codes it to 'Y' on every
// record, so it carries no information here either way. The column is exported so
// the contract matches the brief and so a real 2B corpus could fill it in later;
// train.py decides what to do with an all-missing column and says so out loud.
function featuresFrom(history) {
  const observed = history.length;
  const in2b = history.filter((entry) => entry.appearedIn2b).length;

  const daysLate = history
    .map((entry) => entry.daysLate)
    .filter((value) => value !== null && value !== undefined);

  const documents = history.reduce((sum, entry) => sum + entry.invoiceCount, 0);
  const mismatches = history.reduce((sum, entry) => sum + entry.mismatchCount, 0);
  const amendments = history.reduce((sum, entry) => sum + entry.amendments, 0);

  return {
    filed_ratio_6m: observed ? in2b / observed : 0,
    mean_days_late: daysLate.length ? daysLate.reduce((a, b) => a + b, 0) / daysLate.length : 0,
    max_days_late: daysLate.length ? Math.max(...daysLate) : 0,
    mismatch_rate: documents ? mismatches / documents : 0,
    amendment_rate: documents ? amendments / documents : 0,
    periods_observed: observed,
    gstr3b_filed_ratio: null
  };
}

// The label: did this supplier's invoices reach THIS period's 2B, correct and on
// time? Modelled as its NEGATION — y = 1 means they did not — because everything
// downstream is a risk: the bands read P(this goes wrong), so HIGH is a high
// probability.
//
// Three ways it fails, and each costs the trader differently:
//   nothing of theirs reached 2B at all       the credit simply is not there
//   they filed after their own cut-off        it lands next period instead
//   a booked invoice is missing or disagrees  that document's credit is at risk
function labelFor(period) {
  const reached = period.appearedIn2b && !period.filedLate && period.badDocuments === 0;
  return reached ? 0 : 1;
}

const FEATURE_NAMES = [
  'filed_ratio_6m',
  'mean_days_late',
  'max_days_late',
  'mismatch_rate',
  'amendment_rate',
  'periods_observed',
  'gstr3b_filed_ratio'
];

const COLUMNS = ['gstin', 'tax_period', ...FEATURE_NAMES, 'heuristic_score', 'label'];

function buildRows(bySupplier) {
  const rows = [];
  let skippedNothingExpected = 0;
  let skippedNoHistory = 0;

  for (const [gstin, periods] of bySupplier) {
    periods.forEach((period, index) => {
      // Nothing booked from them that month means there is nothing that OUGHT to
      // have reached 2B, so "did not appear" is not a failure on their part and
      // the row would teach the model a label it cannot earn.
      if (period.expectedCount === 0) {
        skippedNothingExpected += 1;
        return;
      }
      // Features come only from earlier periods. The first observation of a
      // supplier has none, which is precisely the cold-start case the MEDIUM
      // guard in preventive.js exists to handle rather than something to learn.
      const history = periods.slice(Math.max(0, index - HISTORY_PERIODS), index);
      if (!history.length) {
        skippedNoHistory += 1;
        return;
      }

      const features = featuresFrom(history);
      // The production heuristic's own verdict over the same window.
      const heuristic = scoreSupplierRisk(history, { scheme: period.filingScheme });

      rows.push({
        gstin,
        tax_period: period.taxPeriod,
        ...features,
        heuristic_score: heuristic.score ?? 0,
        label: labelFor(period)
      });
    });
  }

  return { rows, skippedNothingExpected, skippedNoHistory };
}

function toCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      COLUMNS.map((column) => {
        const value = row[column];
        // Empty field, not the string "null" and not 0 — the difference between
        // "unknown" and "zero" is exactly what train.py has to be able to see.
        if (value === null || value === undefined) return '';
        return typeof value === 'number' ? String(Math.round(value * 1e6) / 1e6) : String(value);
      }).join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNotAppOrg(args.org);

  if (args.seed) {
    process.stdout.write(`seeding fixtures into org ${args.org}\n`);
    await seedFixtures(args.org);
  }

  const bySupplier = await loadObservations(args.org);
  if (!bySupplier.size) {
    throw new Error(
      `no supplier_periods for org ${args.org}. Run with --seed to load the fixtures first.`
    );
  }

  const { rows, skippedNothingExpected, skippedNoHistory } = buildRows(bySupplier);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, toCsv(rows), 'utf8');

  const positives = rows.filter((row) => row.label === 1).length;
  const periods = [...new Set(rows.map((row) => row.tax_period))].sort();

  process.stdout.write(
    [
      '',
      `wrote ${args.out}`,
      `  rows        ${rows.length}  (one per supplier x label period)`,
      `  suppliers   ${new Set(rows.map((row) => row.gstin)).size}`,
      `  periods     ${periods.join(', ')}`,
      `  label = 1   ${positives} (${((positives / rows.length) * 100).toFixed(1)}%) did not reach 2B correct and on time`,
      `  skipped     ${skippedNoHistory} first-sightings (no prior period to build features from)`,
      `              ${skippedNothingExpected} periods with nothing booked from that supplier`,
      ''
    ].join('\n')
  );
}

main()
  .catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`\nexport failed: ${error.message}\n`);
  })
  .finally(closePool);
