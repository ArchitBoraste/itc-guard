// A supplier's filing scheme decides every date measured against them (audit P9).
//
// The portal data cannot tell a QRMP supplier who uses IFF and files by the 11th
// from a monthly filer, so the app labels its guess "assumed" and lets the trader
// settle it. The demo trader has already told it about their 7 quarterly
// suppliers. On the sample that changes two things the audit caught:
//
//   * Krishna Systems & Co filed on the 13th of one month: late for a monthly
//     filer, on time for QRMP. It read "late in 3 of 6"; the truth is 2.
//   * Fortune Hardware & Co on 12-13 June read "Cut-off passed ... needs
//     GSTR-1A" for May, while its free-fix window ran to the 13th.
//
// Driven over HTTP from the state a visitor gets, with all six months loaded.
//
// Owns org 21.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg, seedDemoPeriod } from '../../src/services/demo.js';
import { STORY_PERIODS, seedDemoStory } from '../../src/services/demoStory.js';
import { createRun } from '../../src/services/reconcile.js';
import { rebuildSupplierStats } from '../../src/services/supplierRisk.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT, PERIODS } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.supplierScheme;
const KRISHNA = '09PEETV7080K9ZA';
const FORTUNE = '29UPKPN4174V1ZP';
const MAY = '2026-05';
const LAST = '2026-07';
// Fortune's May invoice saved on the portal with less tax than the books.
const FORTUNE_SAVED_MISMATCH = 'A/2022';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

let server;
let base;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const nextMonth16 = (period) => {
  const [year, month] = period.split('-').map(Number);
  return month === 12 ? `${year + 1}-01-16` : `${year}-${String(month + 1).padStart(2, '0')}-16`;
};

async function suppliers() {
  return (await call('GET', `/api/suppliers?taxPeriod=${LAST}`)).body.suppliers;
}
const supplier = async (gstin) => (await suppliers()).find((entry) => entry.gstin === gstin);

async function fortuneOnMayList(asOf) {
  const { body } = await call('GET', `/api/alerts?taxPeriod=${MAY}&asOf=${asOf}`);
  return body.alerts.suppliers.find((entry) => entry.gstin === FORTUNE);
}

// May reconciled as of a given workspace date, and Fortune's saved mismatch in it.
async function fortuneMismatchOn(asOfDate) {
  expect((await call('PUT', '/api/workspace/clock', { asOfDate })).status).toBe(200);
  const { status, body } = await call('POST', '/api/runs', { taxPeriod: MAY });
  expect(status).toBe(201);
  const results = (await call('GET', `/api/runs/${body.run.id}/results?bucket=VALUE_MISMATCH&pageSize=500`)).body.results;
  return results.find((row) => row.books?.invoiceNo === FORTUNE_SAVED_MISMATCH);
}

describe("a supplier's filing scheme, assumed or set", () => {
  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID);
    await resetOrg(ORG_ID);
    await seedDemoStory(ORG_ID);
    for (const period of PERIODS.filter((p) => !STORY_PERIODS.includes(p))) {
      await seedDemoPeriod(ORG_ID, { taxPeriod: period });
    }
    // Every period again with all six loaded, as the answer-key verifier does.
    for (const period of PERIODS) {
      const run = await createRun({ orgId: ORG_ID, taxPeriod: period, mode: 'REACTIVE', asOfDate: nextMonth16(period) });
      await rebuildSupplierStats(ORG_ID, period, { runId: run.id });
    }

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
  }, 600000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closePool();
  });

  it('opens with the 7 quarterly suppliers set by the trader and every other scheme assumed', async () => {
    const all = await suppliers();
    const set = all.filter((entry) => entry.filingSchemeSource === 'USER');
    expect(set).toHaveLength(7);
    for (const entry of set) {
      expect(entry).toMatchObject({ filingScheme: 'QRMP', filingSchemeReason: 'set by you' });
    }
    expect(set.map((entry) => entry.gstin)).toEqual(expect.arrayContaining([KRISHNA, FORTUNE]));

    // Nothing in the portal data proves a monthly scheme, so no inferred one is
    // presented as known: low confidence is what the screens print as "assumed".
    const inferredMonthly = all.filter(
      (entry) => entry.filingSchemeSource === 'INFERRED' && entry.filingScheme === 'MONTHLY'
    );
    expect(inferredMonthly.length).toBeGreaterThan(0);
    for (const entry of inferredMonthly) expect(entry.filingSchemeConfidence).toBe('LOW');
  });

  it('reads Krishna Systems & Co as late in 2 of 6, measured against the 13th', async () => {
    const krishna = await supplier(KRISHNA);
    expect(krishna.stats.lateCount).toBe(2);
    expect(krishna.risk.features).toMatchObject({ lateCount: 2, periodsObserved: 6, cutOffDay: 13 });
    expect(krishna.risk.reasons.join(' | ')).toContain('filed late in 2 of the last 6 months');
  });

  it("keeps Fortune Hardware & Co inside its free-fix window on 12 and 13 June", async () => {
    const on12 = await fortuneOnMayList('2026-06-12');
    expect(on12).toMatchObject({ cutOffDate: '2026-06-13', preCutOff: true, daysToCutOff: 1 });
    expect(on12.urgency).not.toBe('PAST_CUTOFF');

    const on13 = await fortuneOnMayList('2026-06-13');
    expect(on13).toMatchObject({ preCutOff: true, urgency: 'LAST_DAY' });

    // ...and out of it the day after.
    expect((await fortuneOnMayList('2026-06-14')).urgency).toBe('PAST_CUTOFF');
  });

  it("recommends the free fix for Fortune's saved mismatch on 12 June, not the monthly verdict", async () => {
    const row = await fortuneMismatchOn('2026-06-12');
    expect(row.portal.filingStatus).toBe('SAVED');
    expect(row.recommendedAction).toBe('CHASE_SUPPLIER');
    expect(row.flags).not.toContain('CUTOFF_PASSED');
  }, 120000);

  it('moves every figure measured against a scheme the trader changes', async () => {
    // Fortune set monthly: May is now past its 11th on the 12th, in the engine's
    // recommendation (May is still reconciled as of 12 June) and on Still fixable.
    const put = await call('PUT', `/api/suppliers/${FORTUNE}/filing-scheme`, { scheme: 'MONTHLY' });
    expect(put.status).toBe(200);
    expect(put.body.supplier).toMatchObject({ filingScheme: 'MONTHLY', filingSchemeSource: 'USER' });
    expect(put.body.reruns.map((rerun) => rerun.taxPeriod)).toEqual(PERIODS);

    const row = (await call('GET', `/api/runs?taxPeriod=${MAY}`)).body.run;
    expect(row.asOfDate).toBe('2026-06-12');
    const mismatch = (await call('GET', `/api/runs/${row.id}/results?bucket=VALUE_MISMATCH&pageSize=500`)).body.results
      .find((entry) => entry.books?.invoiceNo === FORTUNE_SAVED_MISMATCH);
    expect(mismatch.recommendedAction).toBe('ACCEPT');
    expect(mismatch.flags).toContain('CUTOFF_PASSED');
    expect((await fortuneOnMayList('2026-06-12')).urgency).toBe('PAST_CUTOFF');

    // Krishna set monthly: the filing on the 13th counts as late again.
    await call('PUT', `/api/suppliers/${KRISHNA}/filing-scheme`, { scheme: 'MONTHLY' });
    expect((await supplier(KRISHNA)).risk.features.lateCount).toBe(3);

    // Handed back to inference: monthly, assumed, and still 3.
    const cleared = await call('PUT', `/api/suppliers/${KRISHNA}/filing-scheme`, { scheme: null });
    expect(cleared.body.supplier).toMatchObject({
      filingScheme: 'MONTHLY',
      filingSchemeConfidence: 'LOW',
      filingSchemeSource: 'INFERRED'
    });
    expect((await supplier(KRISHNA)).stats.lateCount).toBe(3);

    // And back to QRMP, where the free fix returns.
    await call('PUT', `/api/suppliers/${FORTUNE}/filing-scheme`, { scheme: 'QRMP' });
    await call('PUT', `/api/suppliers/${KRISHNA}/filing-scheme`, { scheme: 'QRMP' });
    expect((await fortuneOnMayList('2026-06-12')).preCutOff).toBe(true);
    expect((await supplier(KRISHNA)).risk.features.lateCount).toBe(2);
  }, 600000);

  it('never lets inference overwrite a scheme the trader set', async () => {
    await rebuildSupplierStats(ORG_ID, LAST);
    expect(await supplier(KRISHNA)).toMatchObject({ filingScheme: 'QRMP', filingSchemeSource: 'USER' });
  });

  it('refuses a scheme it does not know, a supplier it has never seen, and an empty body', async () => {
    expect((await call('PUT', `/api/suppliers/${KRISHNA}/filing-scheme`, { scheme: 'ANNUAL' })).status).toBe(400);
    expect((await call('PUT', '/api/suppliers/27ZZZZZ9999Z1Z9/filing-scheme', { scheme: 'QRMP' })).status).toBe(404);
    expect((await call('PUT', `/api/suppliers/${KRISHNA}/filing-scheme`, {})).status).toBe(400);
  });
});
