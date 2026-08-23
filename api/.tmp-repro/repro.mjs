// Mimics the HTTP path exactly: uploadFile sends NO taxPeriod, then preview, then commit.
import { pool, closePool } from '../src/db/pool.js';
import { createUpload, previewUpload, commitUpload } from '../src/services/ingest.js';
import { readFileSync } from 'node:fs';

const ORG = 7;
const PERIOD = '2026-04';
const dir = '../../fixtures/' + PERIOD + '/';

await pool.query(
  `INSERT INTO organizations (id, gstin, legal_name, state_code) VALUES (?, '27AABCS1429F7Z2','Repro Org','27')
   ON DUPLICATE KEY UPDATE gstin=VALUES(gstin)`, [ORG]);
for (const sql of ['match_results','runs','record_changes','supplier_periods','supplier_risk','suppliers',
  'expected_rate_lines','expected_invoices','portal_rate_lines','portal_records','uploads']) {
  await pool.query(`DELETE FROM ${sql} WHERE org_id = ?`, [ORG]);
}

async function httpLikeUpload(kind, filename) {
  const created = await createUpload({
    orgId: ORG, kind, filename, buffer: readFileSync(dir + filename), taxPeriod: null // <- the UI sends none
  });
  await previewUpload(ORG, created.id, { limit: 8, columnMap: null });
  return commitUpload(ORG, created.id, { columnMap: null });
}

const pr = await httpLikeUpload('PURCHASE_REGISTER', 'purchase_register.xlsx');
console.log('PR   ', JSON.stringify(pr));
for (let i = 1; i <= 3; i += 1) {
  const out = await httpLikeUpload('IMS', 'ims.json');
  console.log(`IMS#${i}`, JSON.stringify(out));
}
const [rows] = await pool.query(
  `SELECT rc.change_type, COUNT(*) n FROM record_changes rc WHERE rc.org_id=? GROUP BY rc.change_type`, [ORG]);
console.log('record_changes:', JSON.stringify(rows));
const [periods] = await pool.query(
  `SELECT source, tax_period, COUNT(*) n FROM portal_records WHERE org_id=? GROUP BY source, tax_period`, [ORG]);
console.log('portal periods:', JSON.stringify(periods));
const [nulls] = await pool.query(
  `SELECT COUNT(*) n FROM portal_records WHERE org_id=? AND identity_key IS NULL`, [ORG]);
console.log('null identity_key:', nulls[0].n);
await closePool();
