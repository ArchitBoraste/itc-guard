// A supplier's filing scheme from the purchase register's "Supplier filing
// frequency" column.
//
// The column sets the scheme as the trader's own (USER), the same as
// PUT /suppliers/:gstin/filing-scheme, and whichever came last wins. The demo
// register says Krishna Enterprises files quarterly, so on 11 Sep Krishna has 2
// days left, not 0, without anybody touching the Suppliers screen.
//
// Driven over HTTP with the live demo's August files. Owns org 31.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { supplierOf } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.registerSchemes;
const AUGUST = '2026-08';
const KRISHNA = supplierOf('krishna').gstin;
const ORBIT = supplierOf('orbit').gstin;

let api;
let firstCommit;

const supplier = async (gstin) => (await api.call('GET', `/api/suppliers/${gstin}`)).body.supplier;
const krishnaAlert = async () =>
  (await api.call('GET', `/api/alerts?taxPeriod=${AUGUST}`)).body.alerts.suppliers.find((entry) => entry.gstin === KRISHNA);

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);
  expect((await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' })).status).toBe(200);
  firstCommit = await api.ingest('PURCHASE_REGISTER', demoRegister('aug'));
  expect(firstCommit.status).toBe(200);
  expect((await api.ingest('IMS', demoIms('aug', '2026-09-11'))).status).toBe(200);
  expect((await api.call('POST', '/api/runs', { taxPeriod: AUGUST })).status).toBe(201);
}, 120000);

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('the register says Krishna files quarterly', () => {
  it('sets Krishna quarterly, as the trader’s own, and leaves the blank ones to inference', async () => {
    expect(firstCommit.body.filingSchemes).toEqual({ declared: 1, changed: 1 });
    expect(await supplier(KRISHNA)).toMatchObject({ filingScheme: 'QRMP', filingSchemeSource: 'USER' });
    expect(await supplier(ORBIT)).toMatchObject({ filingScheme: 'MONTHLY', filingSchemeSource: 'INFERRED' });
  });

  it('gives Krishna 2 days left on 11 Sep with no manual step', async () => {
    expect(await krishnaAlert()).toMatchObject({ cutOffDate: '2026-09-13', daysToCutOff: 2, preCutOff: true });
  });

  it('keeps KE-112 chaseable on the 12th, past a monthly filer’s cut-off', async () => {
    expect((await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-12' })).status).toBe(200);
    const { body } = await api.call('GET', `/api/runs?taxPeriod=${AUGUST}`);
    const results = (await api.call('GET', `/api/runs/${body.run.id}/results?pageSize=500`)).body.results;
    expect(results.find((row) => row.books?.invoiceNo === 'KE-112')).toMatchObject({
      recommendedAction: 'CHASE_SUPPLIER',
      totalBucket: 'AT_RISK'
    });
  });
});

describe('the register and the Suppliers screen', () => {
  it('lets the later of the two win', async () => {
    await api.call('PUT', `/api/suppliers/${KRISHNA}/filing-scheme`, { scheme: 'MONTHLY' });
    expect((await supplier(KRISHNA)).filingScheme).toBe('MONTHLY');

    const again = await api.ingest('PURCHASE_REGISTER', demoRegister('aug'));
    expect(again.body.filingSchemes).toEqual({ declared: 1, changed: 1 });
    expect(await supplier(KRISHNA)).toMatchObject({ filingScheme: 'QRMP', filingSchemeSource: 'USER' });
    // A scheme moves a cut-off in every period, so every reconciled one is re-run.
    expect(again.body.reruns.map((rerun) => rerun.taxPeriod)).toEqual([AUGUST]);
    expect(again.body.reruns[0].ran).toBe(true);
  });

  it('changes nothing when the register says what is already set', async () => {
    const same = await api.ingest('PURCHASE_REGISTER', demoRegister('aug'));
    expect(same.body.filingSchemes).toEqual({ declared: 1, changed: 0 });
  });
});
