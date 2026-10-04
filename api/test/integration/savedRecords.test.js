// A record the supplier has only saved, against the supplier's cut-off.
//
//   on or before the cut-off   never an open IMS decision: the fix is a free phone
//                              call, and the record is not safe (at risk) until filed
//   after it, amounts agree    not filed: deferred, never matched or claimable,
//                              because it cannot reach this period's GSTR-2B
//
// Driven over HTTP with the live demo's August files: National's NS-612 is saved
// with a higher amount on 10 Sep, and Anand's AE/177 is saved on 8 Sep and never
// filed. Owns org 28.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister, demoTwoB } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.savedRecords;
const AUGUST = '2026-08';

let api;

const nameOf = (row) => row.books?.invoiceNo ?? row.portal?.invoiceNo;
const byBooksNo = (results, invoiceNo) => results.find((row) => row.books?.invoiceNo === invoiceNo);

async function setDate(asOfDate) {
  expect((await api.call('PUT', '/api/workspace/clock', { asOfDate })).status).toBe(200);
}

async function august() {
  const { body } = await api.call('GET', `/api/runs?taxPeriod=${AUGUST}`);
  const results = (await api.call('GET', `/api/runs/${body.run.id}/results?pageSize=500`)).body.results;
  return { run: body.run, results };
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);

  await setDate('2026-09-10');
  expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
  expect((await api.ingest('IMS', demoIms('aug', '2026-09-10'))).status).toBe(200);
  expect((await api.call('POST', '/api/runs', { taxPeriod: AUGUST })).status).toBe(201);
}, 120000);

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('on or before the cut-off (10 Sep)', () => {
  it('counts two decisions, not National: its saved mismatch is a phone call', async () => {
    const { run, results } = await august();
    expect(run.openDecisions.count).toBe(2);
    expect(results.filter((row) => row.needsDecision).map(nameOf).sort()).toEqual(['BA/219', 'MS-878']);

    const national = byBooksNo(results, 'NS-612');
    expect(national).toMatchObject({
      bucket: 'VALUE_MISMATCH',
      recommendedAction: 'CHASE_SUPPLIER',
      needsDecision: false,
      decisionCategory: null
    });
    expect(national.portal.filingStatus).toBe('SAVED');
  });

  it('holds a saved record that agrees at risk, not claimable, until it is filed', async () => {
    const anand = byBooksNo((await august()).results, 'AE/177');
    expect(anand).toMatchObject({ bucket: 'MATCHED', totalBucket: 'AT_RISK', needsDecision: false });
    expect(anand.portal.filingStatus).toBe('SAVED');
  });

  it('holds the export back for the two decisions only', async () => {
    const { run } = await august();
    const held = await api.call('GET', `/api/runs/${run.id}/ims-actions.json`);
    expect(held.status).toBe(409);
    expect(held.body.openDecisions.count).toBe(2);
  });

  it('lists both saved records as saved on the not-filed list', async () => {
    const { body } = await api.call('GET', `/api/alerts?taxPeriod=${AUGUST}`);
    const statusOf = (invoiceNo) =>
      body.alerts.suppliers.flatMap((entry) => entry.invoices).find((invoice) => invoice.invoiceNo === invoiceNo)?.status;
    expect(statusOf('NS-612')).toBe('SAVED_VALUE_MISMATCH');
    expect(statusOf('AE/177')).toBe('SAVED_NOT_FILED');
  });
});

describe('after the cut-off, with GSTR-2B (14 Sep)', () => {
  beforeAll(async () => {
    await setDate('2026-09-11');
    expect((await api.ingest('IMS', demoIms('aug', '2026-09-11'))).status).toBe(200);
    await setDate('2026-09-14');
    expect((await api.ingest('GSTR2B', demoTwoB('aug'))).status).toBe(200);
  }, 120000);

  it('counts Anand as not filed: deferred, beside its saved record', async () => {
    const anand = byBooksNo((await august()).results, 'AE/177');
    expect(anand).toMatchObject({
      bucket: 'MISSING_IN_PORTAL',
      recommendedAction: 'DEFERRED',
      totalBucket: 'DEFERRED',
      needsDecision: false
    });
    expect(anand.portal).toMatchObject({ invoiceNo: 'AE/177', filingStatus: 'SAVED' });
    expect(anand.flags).toEqual(expect.arrayContaining(['SUPPLIER_UNFILED', 'CUTOFF_PASSED']));
  });

  it('reads the story totals: exact matches Rs 18,900, not filed Rs 9,360', async () => {
    const { run } = await august();
    expect(run.totals.claimableItc).toBe(1890000);
    expect(run.totals.deferredItc).toBe(936000);
    // The books, plus Reliable's Rs 5,400 phantom on top.
    expect(run.totals.expectedTotalItc).toBe(4266000 + 540000);
  });
});
