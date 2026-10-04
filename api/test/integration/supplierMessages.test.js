// What the screens are handed to send a supplier, and what the Upload cards count,
// over HTTP with the live demo's files.
//
//   * Every result, Not filed yet row and waiting correction that needs something
//     from a supplier carries a short message about that one document, against
//     the supplier's own cut-off; a clean match carries none.
//   * The alerts' digest is signed with the workspace's own GSTIN.
//   * GET /api/periods describes each source the way the Upload cards do.
//   * GET /api/suppliers says when each supplier last filed for the period.
//   * GET /api/demo/files lists and serves the demo's sample files.
//
// Owns org 32.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { MESSAGE_KINDS as K } from '../../src/services/supplierMessages.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister, demoTwoB } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.supplierMessages;
const TRADER_GSTIN = '27AABCS1080F1ZN';
let api;

const byInvoice = (results, invoiceNo) =>
  results.find((row) => (row.books?.invoiceNo ?? row.portal?.invoiceNo) === invoiceNo && !row.linkedFrom);

async function resultsFor(taxPeriod) {
  const { run } = (await api.call('GET', `/api/runs?taxPeriod=${taxPeriod}`)).body;
  return (await api.call('GET', `/api/runs/${run.id}/results?pageSize=500`)).body.results;
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);

  await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' });
  await api.ingest('PURCHASE_REGISTER', demoRegister('aug'));
  await api.ingest('IMS', demoIms('aug', '2026-09-11'));
  await api.call('POST', '/api/runs', { taxPeriod: '2026-08' });
});

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('on the cut-off day, 11 Sep', () => {
  it('gives each open result the message its case needs', async () => {
    const results = await resultsFor('2026-08');
    expect(byInvoice(results, 'NS-612').message.kind).toBe(K.PORTAL_HIGHER);
    expect(byInvoice(results, 'MS-878').message.kind).toBe(K.PORTAL_LOWER);
    expect(byInvoice(results, 'MS-878').message.text).toContain('Please report the remaining ₹5,000 taxable (₹900 tax) through GSTR-1A.');
    expect(byInvoice(results, 'BA/219').message.kind).toBe(K.INVOICE_NO_DIFFERS);
    expect(byInvoice(results, 'BA/219').message.text).toContain('appears on the GST portal as BA/291');
    expect(byInvoice(results, 'RT-760').message.kind).toBe(K.NOT_IN_BOOKS);
    expect(byInvoice(results, 'AE/177').message.kind).toBe(K.SAVED_NOT_FILED_BEFORE_CUTOFF);
    expect(byInvoice(results, 'PS-3401').message.text).toContain('in your GSTR-1 by 11 Sep 2026');
    // Krishna files quarterly: their own cut-off, the 13th.
    expect(byInvoice(results, 'KE-112').message.text).toContain('in your GSTR-1 or IFF by 13 Sep 2026');
    // A clean match, and Unity's ₹0.60, need nothing from anyone.
    expect(byInvoice(results, 'INV-0801').message).toBeNull();
    expect(byInvoice(results, 'UD-1905').message).toBeNull();
  });

  it('signs every message with the trader, and the digest with the workspace GSTIN', async () => {
    const results = await resultsFor('2026-08');
    expect(byInvoice(results, 'NS-612').message.text).toMatch(/Thank you, Sharma Electronics$/);

    const { alerts } = (await api.call('GET', '/api/alerts?taxPeriod=2026-08')).body;
    const anand = alerts.suppliers.find((entry) => entry.tradeName === 'Anand Electricals');
    expect(anand.chaseMessage).toContain(`GSTIN ${TRADER_GSTIN}`);
    expect(anand.invoices[0].message.kind).toBe(K.SAVED_NOT_FILED_BEFORE_CUTOFF);
    const krishna = alerts.suppliers.find((entry) => entry.tradeName === 'Krishna Enterprises');
    expect(krishna.filingSchemeSource).toBe('USER');
  });

  it('describes each source the way the Upload cards do', async () => {
    const { periods } = (await api.call('GET', '/api/periods')).body;
    const august = periods.find((entry) => entry.taxPeriod === '2026-08');
    expect(august.register).toEqual({
      documents: 11, suppliers: 11, invoices: 10, creditNotes: 1, debitNotes: 0, contacts: 11
    });
    expect(august.imsRecords).toEqual({ records: 10, suppliers: 10, filed: 9, saved: 1 });
    expect(august.twoB).toBeNull();
  });
});

describe('after the cut-off', () => {
  it('asks for GSTR-1A once the supplier has missed it', async () => {
    await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-14' });
    const results = await resultsFor('2026-08');
    expect(byInvoice(results, 'PS-3401').message.kind).toBe(K.NOT_FILED_AFTER_CUTOFF);
    expect(byInvoice(results, 'PS-3401').message.text).toContain('Please add it through GSTR-1A');
    expect(byInvoice(results, 'KE-112').message.text).toContain('include it in your quarterly GSTR-1');
  });

  it('says when each supplier last filed, once GSTR-2B says so', async () => {
    const before = (await api.call('GET', '/api/suppliers?taxPeriod=2026-08')).body.suppliers;
    expect(before.find((row) => row.tradeName === 'Orbit Distributors').lastFiledOn).toBeNull();

    expect((await api.ingest('GSTR2B', demoTwoB('aug'))).status).toBe(200);
    const after = (await api.call('GET', '/api/suppliers?taxPeriod=2026-08')).body.suppliers;
    expect(after.find((row) => row.tradeName === 'Orbit Distributors').lastFiledOn).toBe('2026-09-04');
    expect(after.find((row) => row.tradeName === 'Patel Systems').lastFiledOn).toBeNull();
  });

  it("reminds August's suppliers of what is still waiting in September", async () => {
    await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-10-05' });
    await api.ingest('PURCHASE_REGISTER', demoRegister('sep'));
    await api.ingest('IMS', demoIms('sep', '2026-10-05'));
    await api.call('POST', '/api/runs', { taxPeriod: '2026-09' });

    const { corrections } = (await api.call('GET', '/api/corrections?taxPeriod=2026-09')).body;
    const national = corrections.items.find((item) => item.document.invoiceNo === 'NS-612');
    expect(national.status).toBe('WAITING');
    expect(national.message.kind).toBe(K.CORRECTION_REMINDER);
    expect(national.message.text).toContain('Please correct it through GSTR-1A by 11 Oct 2026 so it reaches our September 2026 GSTR-2B.');
    for (const item of corrections.items.filter((entry) => entry.status === 'ARRIVED')) {
      expect(item.message).toBeNull();
    }
  });
});

describe('the demo files', () => {
  it('lists both months and serves a file', async () => {
    const { files } = (await api.call('GET', '/api/demo/files')).body;
    expect(files.filter((file) => file.folder === 'aug').map((file) => file.name)).toContain('purchase_register_aug26.xlsx');
    expect(files.filter((file) => file.folder === 'sep')).toHaveLength(6);

    const ims = files.find((file) => file.name === 'ims_aug26_as_of_05sep.json');
    const served = await api.call('GET', ims.url);
    expect(served.status).toBe(200);
    expect(served.body.gstin).toBe(TRADER_GSTIN);

    expect((await api.call('GET', '/api/demo/files/aug/..%2F..%2F.env')).status).toBe(404);
  });
});
