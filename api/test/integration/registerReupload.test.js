// Re-uploading a file replaces what the org held for its period (audit P30).
//
// The audit loaded June from a Tally-style CSV, then uploaded the register again
// with one column mapped differently ("Document type" unmapped). Every credit and
// debit note came back as an invoice, under a new identity, so the commit ADDED
// 19 rows beside the originals: 418 register rows for 399 documents, 428 results,
// deferred up from Rs 2,28,581 to Rs 9,21,023, and Still fixable drafting chase
// messages for invoices that do not exist. Nothing but "Reset my data" could
// remove the earlier upload.
//
// A commit now replaces its period's register in one transaction, a portal
// download replaces the previous download of its source, the run is out of date
// until rebuilt, and an upload can be deleted.
//
// Owns org 22.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool, pool } from '../../src/db/pool.js';
import { commitUpload, createUpload } from '../../src/services/ingest.js';
import { createRun, getRun, rerunPeriodIfRun } from '../../src/services/reconcile.js';
import { TEST_ORGS, ensureOrg, ingest, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT, readJson } from '../helpers/fixtures.js';
import { TALLY_COLUMN_MAP, columnMapWithout, tallyCsv } from '../helpers/tallyCsv.js';

const ORG_ID = TEST_ORGS.registerReupload;
const TRADER_GSTIN = '27AABCS1429F22Z';
const JUNE = '2026-06';
const AS_OF = '2026-07-16';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');

// The register exactly as the trader would upload it: a CSV, no declared period.
async function uploadRegister(columnMap, options = {}) {
  const upload = await createUpload({
    orgId: ORG_ID, kind: 'PURCHASE_REGISTER', filename: 'tally_june.csv', buffer: tallyCsv(JUNE)
  });
  const committed = await commitUpload(ORG_ID, upload.id, { columnMap, ...options });
  return { upload, committed };
}

async function count(sql) {
  const [rows] = await pool.query(sql, [ORG_ID, JUNE]);
  return Number(rows[0].n);
}
const registerRows = () =>
  count('SELECT COUNT(*) AS n FROM expected_invoices WHERE org_id = ? AND tax_period = ?');

async function resultCount(runId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM match_results WHERE org_id = ? AND run_id = ?',
    [ORG_ID, runId]
  );
  return Number(rows[0].n);
}

let server;
let base;

async function call(method, path) {
  const res = await fetch(`${base}${path}`, { method });
  return { status: res.status, body: await res.json() };
}

describe('a re-uploaded file replaces the period, never adds to it', () => {
  let baseline;
  let latestRegister;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);

    latestRegister = (await uploadRegister(TALLY_COLUMN_MAP)).upload;
    await ingest(ORG_ID, 'IMS', 'ims.json', JUNE);
    await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', JUNE);
    const run = await createRun({ orgId: ORG_ID, taxPeriod: JUNE, mode: 'REACTIVE', asOfDate: AS_OF });
    baseline = {
      runId: run.id,
      rows: await registerRows(),
      results: await resultCount(run.id),
      totals: run.totals
    };

    const app = createApp({
      pingDb: async () => true,
      auth: (req, res, next) => {
        req.orgId = ORG_ID;
        req.userId = null;
        req.sessionState = 'READY';
        next();
      }
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }, 240000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closePool();
  });

  it('starts where the audit started: June from a Tally CSV, deferred Rs 2,28,581', () => {
    expect(baseline.totals.deferredItc).toBe(22858135);
  });

  it('replaces the register when the same period is uploaded again with a column unmapped', async () => {
    // The audit's second upload: "Voucher Type" left unmapped, every row an invoice.
    const second = await uploadRegister(columnMapWithout('docType'));
    latestRegister = second.upload;
    const staleBeforeRebuild = (await getRun(ORG_ID, baseline.runId)).staleness.isStale;

    // The commit route's rebuild brings it back to one row per document.
    await rerunPeriodIfRun(ORG_ID, JUNE);
    expect(await registerRows()).toBe(baseline.rows);
    expect(await resultCount(baseline.runId)).toBe(baseline.results);

    const run = await getRun(ORG_ID, baseline.runId);
    // Committed without a rebuild, the run said it was out of date.
    expect(staleBeforeRebuild).toBe(true);
    expect(run.staleness.isStale).toBe(false);
    expect(run.totals.deferredItc).toBe(baseline.totals.deferredItc);
    expect(second.committed.replaced).toBeGreaterThan(0);
    expect(second.committed.periods).toEqual([JUNE]);
  }, 240000);

  it('replaces an IMS download: a record it no longer carries leaves the run', async () => {
    // The supplier deletes a record they had only saved, so the next download no
    // longer carries it. It used to stay in the run, matched and claimable.
    const json = readJson(JUNE, 'ims.json');
    const saved = json.imsDetails.b2b.find((row) => row.srcfilstatus === 'SAVED');
    json.imsDetails.b2b = json.imsDetails.b2b.filter((row) => row !== saved);
    const committed = await ingest(ORG_ID, 'IMS', 'ims.json', JUNE, asBuffer(json));
    expect(committed).toMatchObject({ inserted: 0, replaced: 1, periods: [JUNE] });

    await rerunPeriodIfRun(ORG_ID, JUNE);
    const [rows] = await pool.query(
      `SELECT mr.bucket, mr.portal_record_id
         FROM match_results mr JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND ei.supplier_gstin = ? AND ei.invoice_no = ?`,
      [ORG_ID, baseline.runId, saved.stin, saved.inum]
    );
    expect(rows).toEqual([{ bucket: 'MISSING_IN_PORTAL', portal_record_id: null }]);
    expect(await resultCount(baseline.runId)).toBe(baseline.results);
    expect((await getRun(ORG_ID, baseline.runId)).staleness).toMatchObject({ isStale: false, withdrawnResults: 0 });
  }, 240000);

  it('deletes an upload and everything it owns, then rebuilds the period', async () => {
    const { status, body } = await call('DELETE', `/api/uploads/${latestRegister.id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      uploadId: latestRegister.id,
      kind: 'PURCHASE_REGISTER',
      removed: { registerRows: baseline.rows, portalRecords: 0 },
      periods: [JUNE],
      emptiedPeriods: []
    });
    expect(body.reruns).toEqual([expect.objectContaining({ taxPeriod: JUNE, ran: true })]);

    expect(await registerRows()).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM uploads WHERE org_id = ? AND id = ' + Number(latestRegister.id))).toBe(0);
    // Rebuilt from what is left: the portal side, with no books to match.
    const run = await getRun(ORG_ID, baseline.runId);
    expect(run.staleness.isStale).toBe(false);
    const withBooks = await count(
      `SELECT COUNT(*) AS n FROM match_results mr JOIN runs r ON r.id = mr.run_id
        WHERE mr.org_id = ? AND r.tax_period = ? AND mr.expected_invoice_id IS NOT NULL`
    );
    expect(withBooks).toBe(0);
    expect(run.bucketCounts.MISSING_IN_BOOKS).toBeGreaterThan(0);
  }, 240000);

  it('drops the run of a period left with nothing to reconcile', async () => {
    const [uploads] = await pool.query(
      `SELECT id FROM uploads WHERE org_id = ? AND kind IN ('IMS', 'GSTR2B') ORDER BY id`,
      [ORG_ID]
    );
    let last;
    for (const upload of uploads) last = await call('DELETE', `/api/uploads/${upload.id}`);
    expect(last.body.emptiedPeriods).toEqual([JUNE]);
    expect((await call('GET', `/api/runs?taxPeriod=${JUNE}`)).body.run).toBeNull();
  }, 240000);

  it('refuses to delete an upload it cannot find', async () => {
    const { status, body } = await call('DELETE', '/api/uploads/999999999');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});
