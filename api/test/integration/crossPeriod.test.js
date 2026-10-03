// August's documents arriving in September's portal data, and Corrections.
//
// Portal records belong to the period of their upload. September's data carries
// four August documents: MS-878's GSTR-1A amendment, PS-3401 added through
// GSTR-1A, AE/177 (saved, then filed on 9 Oct) and KE-112 (Krishna's quarterly
// return, in the 14 Oct 2B only). Each must join its August books row in
// September's run, never become a September phantom, and never change August.
//
// Driven over HTTP with the live demo's files. Owns org 29.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { supplierOf } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister, demoTwoB } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.crossPeriod;
const AUGUST = '2026-08';
const SEPTEMBER = '2026-09';
const AUGUST_DOCS = ['AE/177', 'KE-112', 'MS-878', 'NS-612', 'PS-3401'];

let api;
const steps = {};

async function setDate(asOfDate) {
  expect((await api.call('PUT', '/api/workspace/clock', { asOfDate })).status).toBe(200);
}

async function ingest(kind, path) {
  const res = await api.ingest(kind, path);
  expect(res.status, res.body?.message).toBe(200);
}

async function view(taxPeriod) {
  const { body } = await api.call('GET', `/api/runs?taxPeriod=${taxPeriod}`);
  const results = (await api.call('GET', `/api/runs/${body.run.id}/results?pageSize=500`)).body.results;
  return { run: body.run, results };
}

async function corrections(taxPeriod) {
  const { status, body } = await api.call('GET', `/api/corrections?taxPeriod=${taxPeriod}`);
  expect(status).toBe(200);
  return body.corrections;
}

// Everything a reviewer saw on a period: each result's pair, verdict and value.
const fingerprint = ({ run, results }) => ({
  totals: run.totals,
  openDecisions: run.openDecisions.count,
  rows: results
    .map((row) => [row.books?.invoiceNo, row.portal?.invoiceNo, row.portal?.filingStatus, row.bucket,
      row.recommendedAction, row.signedItc, row.totalBucket].join('|'))
    .sort()
});

const numbers = (items, status) =>
  items.filter((item) => item.status === status).map((item) => item.document.invoiceNo).sort();

async function snapshot(name, taxPeriod = SEPTEMBER) {
  steps[name] = { ...(await view(taxPeriod)), corrections: await corrections(taxPeriod) };
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);

  // August, as reviewed on 14 Sep. Krishna is quarterly.
  await setDate('2026-09-11');
  await ingest('PURCHASE_REGISTER', demoRegister('aug'));
  expect((await api.call('PUT', `/api/suppliers/${supplierOf('krishna').gstin}/filing-scheme`, { scheme: 'QRMP' })).status).toBe(200);
  await ingest('IMS', demoIms('aug', '2026-09-11'));
  expect((await api.call('POST', '/api/runs', { taxPeriod: AUGUST })).status).toBe(201);
  await setDate('2026-09-14');
  await ingest('GSTR2B', demoTwoB('aug'));
  steps.august = await view(AUGUST);

  // September.
  await setDate('2026-10-05');
  await ingest('PURCHASE_REGISTER', demoRegister('sep'));
  await ingest('IMS', demoIms('sep', '2026-10-05'));
  expect((await api.call('POST', '/api/runs', { taxPeriod: SEPTEMBER })).status).toBe(201);
  await snapshot('oct5');
  steps.augustOnOct5 = await view(AUGUST);
}, 240000);

afterAll(async () => {
  await api?.close();
  await closePool();
});

const late = (results) => results.filter((row) => row.linkedFrom);

describe('September on 5 Oct', () => {
  it('shows every August record as August’s document, never a September phantom', () => {
    const { results } = steps.oct5;
    expect(results.filter((row) => row.bucket === 'MISSING_IN_BOOKS')).toEqual([]);
    expect(late(results).map((row) => row.books.invoiceNo).sort()).toEqual(['AE/177', 'MS-878', 'PS-3401']);
    for (const row of late(results)) {
      expect(row.books.taxPeriod).toBe(AUGUST);
      expect(row.linkedFrom.taxPeriod).toBe(AUGUST);
      expect(row.flags).toContain('FROM_EARLIER_PERIOD');
    }
    const amendment = results.find((row) => row.books?.invoiceNo === 'MS-878');
    expect(amendment.linkedFrom.via).toBe('AMENDMENT');
    expect(amendment.portal.section).toBe('b2ba');
    expect(results.find((row) => row.books?.invoiceNo === 'PS-3401').linkedFrom.via).toBe('LATE_FILING');
  });

  it('credits September with all of MS-878 when August left it open', () => {
    const mahavir = steps.oct5.results.find((row) => row.books?.invoiceNo === 'MS-878');
    expect(mahavir).toMatchObject({ bucket: 'MATCHED', signedItc: 720000, claimableItc: 720000, needsDecision: false });
  });

  it('keeps the late arrivals out of September’s own totals and reports them apart', () => {
    const { run } = steps.oct5;
    // September's own books: Rs 37,080, whatever arrives from August.
    expect(run.totals.expectedTotalItc).toBe(3708000);
    expect(Object.values(run.bucketCounts).reduce((sum, n) => sum + n, 0)).toBe(10);
    // MS-878 Rs 7,200 and PS-3401 Rs 3,240 claimable; AE/177 Rs 3,960 only saved.
    expect(run.carriedIn).toMatchObject({ count: 3, itc: 1440000, claimableItc: 1044000, atRiskItc: 396000 });
    expect(run.carriedIn.byPeriod[AUGUST]).toMatchObject({ count: 3, itc: 1440000 });
  });

  it('lists 2 arrived and 3 waiting in Corrections', () => {
    const { corrections: list } = steps.oct5;
    expect(list.counts).toEqual({ arrived: 2, waiting: 3 });
    expect(numbers(list.items, 'ARRIVED')).toEqual(['MS-878', 'PS-3401']);
    expect(numbers(list.items, 'WAITING')).toEqual(['AE/177', 'KE-112', 'NS-612']);
    expect(list.items.map((item) => item.taxPeriod)).toEqual(Array(5).fill(AUGUST));
  });

  it('says what each needed, and where each arrival came from', () => {
    const byNo = new Map(steps.oct5.corrections.items.map((item) => [item.document.invoiceNo, item]));
    expect(byNo.get('MS-878').needed).toMatchObject({ kind: 'VALUE_MISMATCH', route: 'AMEND', claimedItc: 0, outstandingItc: 720000 });
    expect(byNo.get('MS-878').arrival).toMatchObject({ via: 'AMENDMENT', creditItc: 720000, inGstr2b: false });
    expect(byNo.get('MS-878').arrival.seenIn).toEqual([
      expect.objectContaining({ source: 'IMS', section: 'b2ba', snapshotDate: '2026-10-05' })
    ]);
    // IMS carries no filing date; only 2B says when the supplier filed.
    expect(byNo.get('MS-878').arrival.text).toBe('Amended by the supplier: in the IMS download of 5 Oct 2026.');
    expect(byNo.get('PS-3401').needed.kind).toBe('NOT_FILED');
    expect(byNo.get('PS-3401').arrival).toMatchObject({ via: 'LATE_FILING', sourceForm: 'R1A', creditItc: 324000 });
    expect(byNo.get('AE/177').needed.kind).toBe('SAVED_NOT_FILED');
  });

  it('says how long the rest have waited and when the supplier can still fix it', () => {
    const byNo = new Map(steps.oct5.corrections.items.map((item) => [item.document.invoiceNo, item]));
    // Saved in September's IMS, not filed yet.
    expect(byNo.get('AE/177').waiting).toMatchObject({ monthsWaiting: 1, saved: expect.objectContaining({ filingStatus: 'SAVED' }) });
    expect(byNo.get('NS-612').waiting.nextChance).toMatchObject({ date: '2026-10-11', reachesPeriod: SEPTEMBER });
    expect(byNo.get('NS-612').waiting.nextChance.text).toMatch(/amend it by 11 Oct 2026/);
    // Krishna files quarterly: the 13th.
    expect(byNo.get('KE-112').waiting.nextChance).toMatchObject({ date: '2026-10-13', scheme: 'QRMP' });
    expect(byNo.get('KE-112').waiting.nextChance.text).toMatch(/files quarterly/);
  });

  it('leaves August exactly as reviewed', () => {
    expect(fingerprint(steps.augustOnOct5)).toEqual(fingerprint(steps.august));
    expect(steps.august.results.some((row) => row.linkedFrom)).toBe(false);
  });
});

describe('a decision in August after September was reconciled', () => {
  beforeAll(async () => {
    // Moving the date re-ran August, so its rows are read again for their ids.
    const mahavir = steps.augustOnOct5.results.find((row) => row.books?.invoiceNo === 'MS-878');
    const decided = await api.call('PATCH', `/api/results/${mahavir.id}`, { confirmedAction: 'ACCEPT' });
    expect(decided.status).toBe(200);
    await snapshot('accepted');
  }, 120000);

  it('leaves September only what August did not claim: Rs 900 of MS-878', () => {
    const mahavir = steps.accepted.results.find((row) => row.books?.invoiceNo === 'MS-878');
    expect(mahavir).toMatchObject({ signedItc: 90000, claimableItc: 90000 });
    const item = steps.accepted.corrections.items.find((entry) => entry.document.invoiceNo === 'MS-878');
    expect(item.needed).toMatchObject({ claimedItc: 630000, outstandingItc: 90000 });
    expect(item.arrival.creditItc).toBe(90000);
  });
});

describe('September on 10 Oct and with its GSTR-2B', () => {
  beforeAll(async () => {
    await setDate('2026-10-10');
    await ingest('IMS', demoIms('sep', '2026-10-10'));
    await snapshot('oct10');
    await setDate('2026-10-14');
    await ingest('GSTR2B', demoTwoB('sep'));
    await snapshot('oct14');
    steps.augustAtEnd = await view(AUGUST);
  }, 240000);

  it('counts AE/177 as arrived once Anand files it', () => {
    const { corrections: list } = steps.oct10;
    expect(list.counts).toEqual({ arrived: 3, waiting: 2 });
    expect(numbers(list.items, 'ARRIVED')).toEqual(['AE/177', 'MS-878', 'PS-3401']);
  });

  it('counts KE-112 as arrived in the 2B, leaving NS-612 waiting', () => {
    const { corrections: list } = steps.oct14;
    expect(list.counts).toEqual({ arrived: 4, waiting: 1 });
    expect(numbers(list.items, 'WAITING')).toEqual(['NS-612']);
    const krishna = list.items.find((item) => item.document.invoiceNo === 'KE-112');
    expect(krishna.arrival).toMatchObject({ inGstr2b: true, creditItc: 216000 });
    expect(krishna.arrival.text).toBe('Filed late on 12 Oct 2026: in GSTR-2B.');
    // National missed September's cut-off too: next chance is October's.
    expect(list.items.find((item) => item.document.invoiceNo === 'NS-612').waiting.nextChance)
      .toMatchObject({ date: '2026-11-11', reachesPeriod: '2026-10' });
  });

  it('never shows an August document as a September phantom', () => {
    for (const step of ['oct10', 'oct14']) {
      const phantoms = steps[step].results.filter((row) => row.bucket === 'MISSING_IN_BOOKS');
      expect(phantoms.map((row) => row.portal.invoiceNo), step).toEqual([]);
      expect(late(steps[step].results).map((row) => row.books.invoiceNo).every((no) => AUGUST_DOCS.includes(no))).toBe(true);
    }
  });

  it('exports the late arrivals with September, and nothing of September’s with August', async () => {
    const september = await api.call('GET', `/api/runs/${steps.oct14.run.id}/ims-actions.json?acknowledgeOpenDecisions=true`);
    expect(september.status).toBe(200);
    expect(september.body.invdata.b2ba.map((record) => record.inum)).toEqual(['MS-878']);
    // KE-112 reached GSTR-2B only, so there is no IMS record of it to act on.
    const b2b = september.body.invdata.b2b.map((record) => record.inum);
    expect(b2b).toEqual(expect.arrayContaining(['PS-3401', 'AE/177']));
    expect(b2b).not.toContain('KE-112');

    const august = await api.call('GET', `/api/runs/${steps.augustAtEnd.run.id}/ims-actions.json?acknowledgeOpenDecisions=true`);
    const augustNumbers = Object.values(august.body.invdata).flat().map((record) => record.inum ?? record.nt_num);
    expect(augustNumbers).not.toContain('KE-130');
    expect(august.body.invdata.b2ba).toEqual([]);
  });

  it('keeps August’s change feed to August’s own records', async () => {
    const { body } = await api.call('GET', `/api/changes?runId=${steps.augustAtEnd.run.id}`);
    expect(body.changes.every((change) => change.record.taxPeriod === AUGUST)).toBe(true);
  });

  it('still leaves August as reviewed, the Accept on MS-878 aside', () => {
    const before = fingerprint(steps.augustOnOct5);
    const after = fingerprint(steps.augustAtEnd);
    expect(after.rows).toEqual(before.rows.map((row) => (row.startsWith('MS-878|') ? row.replace('|AT_RISK', '|CLAIMABLE') : row)));
  });
});
