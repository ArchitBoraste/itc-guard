// seed-demo.js — load one fixture period end to end for org 1.
//
// Runs the real ingestion path (upload -> commit) rather than inserting rows
// directly, so what the demo shows is what the API does.
//
// Run:  node tools/seed-demo.js                  (default period)
//       node tools/seed-demo.js 2026-03
//       node tools/seed-demo.js 2026-03 --reset   (wipe org 1 data first)
//       node tools/seed-demo.js --all             (every fixture period)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, closePool } from '../api/src/db/pool.js';
import { commitUpload, createUpload } from '../api/src/services/ingest.js';
import { createRun } from '../api/src/services/reconcile.js';
import { rebuildSupplierPeriods } from '../api/src/services/supplierStats.js';
import { buildRunImsActions } from '../api/src/services/imsActions.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO_ROOT, 'fixtures');
const ORG_ID = 1;
const DEFAULT_PERIOD = '2026-03';

const TRADER = {
  gstin: '27AABCS1429F1Z8',
  legalName: 'Sharma Electronics Private Limited',
  tradeName: 'Sharma Electronics',
  stateCode: '27'
};

function rupees(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}₹${whole.toLocaleString('en-IN')}.${fraction}`;
}

async function ensureOrg() {
  await pool.query(
    `INSERT INTO organizations (id, gstin, legal_name, trade_name, state_code, filer_type)
     VALUES (?, ?, ?, ?, ?, 'MONTHLY')
     ON DUPLICATE KEY UPDATE gstin = VALUES(gstin), legal_name = VALUES(legal_name),
       trade_name = VALUES(trade_name), state_code = VALUES(state_code)`,
    [ORG_ID, TRADER.gstin, TRADER.legalName, TRADER.tradeName, TRADER.stateCode]
  );
  await pool.query(
    `INSERT INTO users (id, org_id, email, display_name)
     VALUES (1, ?, 'demo@itcguard.local', 'Demo User')
     ON DUPLICATE KEY UPDATE email = VALUES(email)`,
    [ORG_ID]
  );
}

// Child rows first: the FKs are RESTRICT on org, CASCADE on parents.
async function resetOrgData() {
  const statements = [
    'DELETE FROM match_results WHERE org_id = ?',
    'DELETE FROM runs WHERE org_id = ?',
    'DELETE FROM record_changes WHERE org_id = ?',
    'DELETE FROM supplier_periods WHERE org_id = ?',
    'DELETE FROM supplier_risk WHERE org_id = ?',
    'DELETE FROM suppliers WHERE org_id = ?',
    'DELETE FROM expected_rate_lines WHERE org_id = ?',
    'DELETE FROM expected_invoices WHERE org_id = ?',
    'DELETE FROM portal_rate_lines WHERE org_id = ?',
    'DELETE FROM portal_records WHERE org_id = ?',
    'DELETE FROM uploads WHERE org_id = ?'
  ];
  for (const sql of statements) await pool.query(sql, [ORG_ID]);
}

async function ingest(kind, filename, taxPeriod) {
  const path = join(FIXTURES, taxPeriod, filename);
  if (!existsSync(path)) {
    throw new Error(`missing fixture ${path} — run: npm run gen:fixtures`);
  }
  const created = await createUpload({
    orgId: ORG_ID,
    kind,
    filename,
    buffer: readFileSync(path),
    taxPeriod
  });
  const committed = await commitUpload(ORG_ID, created.id);
  console.log(
    `  ${kind.padEnd(18)} ${String(committed.parsed).padStart(4)} rows  ` +
      `(${committed.inserted} new, ${committed.updated} updated` +
      `${committed.changes ? `, ${committed.changes} changed` : ''})`
  );
  return committed;
}

async function seedPeriod(taxPeriod) {
  console.log(`\nperiod ${taxPeriod}`);
  await ingest('PURCHASE_REGISTER', 'purchase_register.xlsx', taxPeriod);
  await ingest('IMS', 'ims.json', taxPeriod);
  await ingest('GSTR2B', 'gstr2b.json', taxPeriod);

  // Mid-window: after 2B generation on the 14th, before GSTR-3B on the 20th —
  // the reactive window the decision engine is built for.
  const [year, month] = taxPeriod.split('-').map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  const asOfDate = `${nextMonth}-16`;

  const run = await createRun({
    orgId: ORG_ID,
    taxPeriod,
    mode: 'REACTIVE',
    asOfDate
  });
  await rebuildSupplierPeriods(ORG_ID, taxPeriod, { runId: run.id });

  const buckets = Object.entries(run.bucketCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, n]) => `${bucket}=${n}`)
    .join('  ');

  console.log(`  run #${run.id}  as of ${asOfDate}  cut-off ${run.cutOffDate}`);
  console.log(`  ${buckets}`);
  console.log('  totals (paise -> rupees):');
  for (const [name, value] of Object.entries(run.totals)) {
    console.log(`    ${name.padEnd(18)} ${String(value).padStart(12)}  ${rupees(value)}`);
  }

  const balance =
    run.totals.claimableItc + run.totals.atRiskItc + run.totals.deferredItc +
    run.totals.ineligibleItc;
  console.log(
    `  identity: claimable+atRisk+deferred+ineligible = ${balance} ` +
      `${balance === run.totals.expectedTotalItc ? '==' : '!='} expectedTotalItc ` +
      `${run.totals.expectedTotalItc}`
  );

  const actions = await buildRunImsActions(ORG_ID, run.id);
  const byAction = Object.entries(actions.stats.byAction)
    .map(([code, n]) => `${code}=${n}`)
    .join(' ');
  console.log(`  ims-actions.json: ${actions.stats.records} records  ${byAction}`);
  if (actions.warnings.length) console.log(`  warnings: ${actions.warnings.length}`);

  return run;
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const all = args.includes('--all');
  const periods = args.filter((arg) => /^\d{4}-\d{2}$/.test(arg));

  const allPeriods = JSON.parse(readFileSync(join(FIXTURES, 'ground_truth.json'), 'utf8')).periods;
  const targets = all ? allPeriods : periods.length ? periods : [DEFAULT_PERIOD];

  console.log('ITC Guard — demo seed');
  console.log(`org ${ORG_ID} (${TRADER.tradeName}, ${TRADER.gstin})`);

  await ensureOrg();
  if (reset) {
    console.log('resetting org data...');
    await resetOrgData();
  }

  for (const period of targets) await seedPeriod(period);

  console.log('\ndone. Try:');
  console.log('  curl "http://localhost:3000/api/runs?taxPeriod=' + targets[0] + '"');
  console.log('  curl "http://localhost:3000/api/suppliers" | head -c 400');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(`\nfailed: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    await closePool();
    process.exit(1);
  });
