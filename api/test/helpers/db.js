// Shared setup for the DB-backed integration suites.
//
// Each suite owns its own org_id so the files stay independent and can run in
// parallel without resetting each other's rows.
import { checkConnection, pool } from '../../src/db/pool.js';
import { commitUpload, createUpload } from '../../src/services/ingest.js';
import { readBuffer } from './fixtures.js';

// Fails the suite loudly instead of skipping it.
//
// A green run with twenty silent skips reads as a pass and is not one. If the
// database is unreachable, or reachable but holding a different schema, that is a
// broken environment and the run has to say so.
export async function requireDatabase() {
  const status = await checkConnection();
  if (status.ok) return status;

  throw new Error(
    [
      '',
      'INTEGRATION TESTS CANNOT RUN — the database is not usable.',
      '',
      `  target: ${status.target}`,
      `  reason: ${status.reason}`,
      '',
      '  These tests are NOT skipped on purpose: a run that skips them silently',
      '  looks like phase 4 is verified when nothing was checked.',
      '',
      '  To fix:',
      '    1. Clear any stale DB_* variables in your shell. They override .env',
      '       (dotenv runs with override:false so Docker Compose can win), so a',
      '       leftover DB_NAME from another project silently redirects the app.',
      '         bash:       env | grep ^DB_',
      '         PowerShell: Get-ChildItem Env:DB_*',
      '    2. Start the database:  docker compose up -d db',
      '    3. Apply migrations:    cd api && npm run migrate',
      ''
    ].join('\n')
  );
}

// org 1 is the RUNNING APPLICATION's org: stubAuth hands every API request
// org 1, tools/seed-demo.js seeds into it, and the "Load sample data" button
// writes there. A suite that resets org 1 destroys whatever the user (or the
// demo) had loaded, and leaves its own fixture periods behind looking like real
// runs. Suites take an id from here instead; see APP_ORG_ID below.
export const APP_ORG_ID = 1;

// One id per suite. Kept in one place so adding a suite cannot silently collide
// with another one — or with the app.
export const TEST_ORGS = Object.freeze({
  reconcile: 5,
  ordinalStability: 2,
  staleConfirmation: 3,
  negativeTotals: 4
});

export async function ensureOrg(orgId, gstin) {
  assertNotAppOrg(orgId, 'ensureOrg');
  await pool.query(
    `INSERT INTO organizations (id, gstin, legal_name, trade_name, state_code)
     VALUES (?, ?, 'Sharma Electronics Private Limited', 'Sharma Electronics', '27')
     ON DUPLICATE KEY UPDATE gstin = VALUES(gstin)`,
    [orgId, gstin]
  );
}

// The guard that makes the reservation real rather than a convention in a comment.
// Throwing here is the whole point: a suite that reaches for org 1 fails loudly on
// its first setup call instead of quietly deleting the demo data.
function assertNotAppOrg(orgId, fnName) {
  if (Number(orgId) === APP_ORG_ID) {
    throw new Error(
      `${fnName}() refuses org ${APP_ORG_ID}: that is the running application's org ` +
        '(stubAuth serves it, and npm run seed:demo writes to it). Take an id from ' +
        'TEST_ORGS in test/helpers/db.js instead.'
    );
  }
}

// Child rows first — org FKs are RESTRICT, parent FKs are CASCADE.
export async function resetOrg(orgId) {
  assertNotAppOrg(orgId, 'resetOrg');
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
  for (const sql of statements) await pool.query(sql, [orgId]);
}

export const COUNTED_TABLES = [
  'expected_invoices',
  'expected_rate_lines',
  'portal_records',
  'portal_rate_lines',
  'match_results',
  'runs',
  'supplier_periods'
];

export async function rowCounts(orgId, tables = COUNTED_TABLES) {
  const counts = {};
  for (const table of tables) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, [orgId]);
    counts[table] = Number(rows[0].n);
  }
  return counts;
}

// Ingests one file. `buffer` overrides the fixture bytes, which is how the
// shuffle and value-correction tests feed modified content through the real path.
export async function ingest(orgId, kind, filename, period, buffer = null) {
  const created = await createUpload({
    orgId,
    kind,
    filename,
    buffer: buffer ?? readBuffer(period, filename),
    taxPeriod: period
  });
  const committed = await commitUpload(orgId, created.id);
  return { uploadId: created.id, ...committed };
}

export async function ingestPeriod(orgId, period) {
  return {
    register: await ingest(orgId, 'PURCHASE_REGISTER', 'purchase_register.xlsx', period),
    ims: await ingest(orgId, 'IMS', 'ims.json', period),
    gstr2b: await ingest(orgId, 'GSTR2B', 'gstr2b.json', period)
  };
}

// Deterministic shuffle, so a failure is reproducible rather than "sometimes".
export function seededShuffle(items, seed = 1) {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    // xorshift32
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
