// One as-of date for the whole workspace.
//
// Every recommendation, cut-off state and "days left" is a statement about a day.
// The workspace now has one, defaulting to today in India; every run is computed
// against it, and moving it re-evaluates what is already reconciled without a
// single file being uploaded again.
//
// Driven over HTTP with the live demo's August files. Owns org 25.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { todayInIndia } from '../../src/services/workspaceClock.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.workspaceClock;
const AUGUST = '2026-08';

let api;

async function augustResults() {
  const { body } = await api.call('GET', `/api/runs?taxPeriod=${AUGUST}`);
  const results = (await api.call('GET', `/api/runs/${body.run.id}/results?pageSize=500`)).body.results;
  return { run: body.run, results };
}

const byBooksNo = (results, invoiceNo) => results.find((row) => row.books?.invoiceNo === invoiceNo);

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);
});

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('the workspace date', () => {
  it('follows today in India until it is set', async () => {
    const { status, body } = await api.call('GET', '/api/workspace/clock');
    expect(status).toBe(200);
    expect(body.clock).toEqual({ asOfDate: todayInIndia(), today: todayInIndia(), followsToday: true });
    expect(body.calendar).toBeNull();
  });

  it('refuses something that is not a date, and a body without one', async () => {
    for (const asOfDate of ['2026-02-30', '05-09-2026']) {
      const { status, body } = await api.call('PUT', '/api/workspace/clock', { asOfDate });
      expect(status).toBe(400);
      expect(body.message).toMatch(/real date/);
    }
    expect((await api.call('PUT', '/api/workspace/clock', {})).status).toBe(400);
  });

  it('is what a run is computed against, and a run cannot name its own', async () => {
    const set = await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-05' });
    expect(set.status).toBe(200);
    expect(set.body.clock).toMatchObject({ asOfDate: '2026-09-05', followsToday: false });
    expect(set.body.reruns).toEqual([]);

    expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
    expect((await api.ingest('IMS', demoIms('aug', '2026-09-05'))).status).toBe(200);

    const refused = await api.call('POST', '/api/runs', { taxPeriod: AUGUST, asOfDate: '2026-09-16' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('as_of_is_workspace_wide');

    const created = await api.call('POST', '/api/runs', { taxPeriod: AUGUST });
    expect(created.status).toBe(201);
    expect(created.body.run.asOfDate).toBe('2026-09-05');
    expect(created.body.run.calendar.window).toBe('PREVENTIVE');

    // Krishna has not reported, and on the 5th the cut-off is six days away.
    const { results } = await augustResults();
    expect(byBooksNo(results, 'KE-112').recommendedAction).toBe('CHASE_SUPPLIER');
  });

  it('re-evaluates every reconciled period when it moves, with nothing uploaded again', async () => {
    const uploadsBefore = (await api.call('GET', '/api/uploads')).body.uploads.length;

    const moved = await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-16' });
    expect(moved.status).toBe(200);
    expect(moved.body.reruns).toEqual([
      expect.objectContaining({ taxPeriod: AUGUST, ran: true, asOfDate: '2026-09-16' })
    ]);

    const { run, results } = await augustResults();
    expect(run.asOfDate).toBe('2026-09-16');
    expect(run.calendar.window).toBe('REACTIVE');
    // The same unreported invoice, now past the cut-off: nothing to act on this month.
    expect(byBooksNo(results, 'KE-112').recommendedAction).toBe('DEFERRED');
    expect((await api.call('GET', '/api/uploads')).body.uploads).toHaveLength(uploadsBefore);
  });

  it('is what the re-run after an upload reads', async () => {
    await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-07' });
    const committed = await api.ingest('IMS', demoIms('aug', '2026-09-07'));
    expect(committed.status).toBe(200);
    expect(committed.body.rerun).toMatchObject({ ran: true, asOfDate: '2026-09-07' });
    expect((await augustResults()).run.asOfDate).toBe('2026-09-07');
  });

  it('is the date the chase list is read at, unless another day is named', async () => {
    const today = await api.call('GET', `/api/alerts?taxPeriod=${AUGUST}`);
    expect(today.body.alerts.asOfDate).toBe('2026-09-07');
    const other = await api.call('GET', `/api/alerts?taxPeriod=${AUGUST}&asOf=2026-09-10`);
    expect(other.body.alerts.asOfDate).toBe('2026-09-10');
  });

  it("answers a period's deadlines and the days left to each", async () => {
    const { body } = await api.call('GET', `/api/workspace/clock?taxPeriod=${AUGUST}`);
    expect(body.calendar.deadlines).toEqual([
      { key: 'CUTOFF_MONTHLY', date: '2026-09-11', daysLeft: 4 },
      { key: 'CUTOFF_QRMP', date: '2026-09-13', daysLeft: 6 },
      { key: 'GSTR2B_GENERATED', date: '2026-09-14', daysLeft: 7 },
      { key: 'GSTR3B_DUE', date: '2026-09-20', daysLeft: 13 }
    ]);
  });

  it('follows today again once cleared', async () => {
    const cleared = await api.call('PUT', '/api/workspace/clock', { asOfDate: null });
    expect(cleared.body.clock).toEqual({ asOfDate: todayInIndia(), today: todayInIndia(), followsToday: true });
    expect((await augustResults()).run.asOfDate).toBe(todayInIndia());
  });
});
