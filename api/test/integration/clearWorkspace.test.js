// "Clear all data" on a single-trader run (DEMO_TENANCY off): the one trader's
// uploads, runs, decisions, contacts and clock go, and the org itself stays.
// Clearing a visitor's workspace, and refusing one from a single-trader run, is
// the tenancy suite's.
//
// Driven over HTTP with the live demo's August files. Owns org 33.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { SUPPLIERS } from '../../../tools/demo-timeline.js';
import { COUNTED_TABLES, TEST_ORGS, requireDatabase, resetOrg, rowCounts } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.clearWorkspace;
const AUGUST = '2026-08';
const TABLES = [...COUNTED_TABLES, 'uploads', 'suppliers', 'supplier_contacts', 'supplier_risk'];
const RELIABLE = SUPPLIERS.find((supplier) => supplier.key === 'reliable');

let api;

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);
});

afterAll(async () => {
  await api?.close();
  await resetOrg(ORG_ID);
  await closePool();
});

describe('Clear all data with one trader', () => {
  it('says this run has one trader, not a workspace per visitor', async () => {
    const { body } = await api.call('GET', '/api/session');
    expect(body.session.perVisitor).toBe(false);
  });

  it("clears the trader's uploads, runs, decisions, contacts and clock", async () => {
    await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' });
    expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
    expect((await api.ingest('IMS', demoIms('aug', '2026-09-11'))).status).toBe(200);
    const { run } = (await api.call('POST', '/api/runs', { taxPeriod: AUGUST })).body;
    const { results } = (await api.call('GET', `/api/runs/${run.id}/results?pageSize=500`)).body;
    const mahavir = results.find((row) => row.books?.invoiceNo === 'MS-878');
    expect((await api.call('PATCH', `/api/results/${mahavir.id}`, { confirmedAction: 'ACCEPT' })).status).toBe(200);
    const contact = { contactPerson: 'Rohit Shah', phone: '+91 98765 43210', email: '' };
    expect((await api.call('PUT', `/api/suppliers/${RELIABLE.gstin}/contact`, contact)).status).toBe(200);

    const before = await rowCounts(ORG_ID, TABLES);
    for (const table of ['uploads', 'runs', 'match_results', 'expected_invoices', 'portal_records', 'supplier_contacts']) {
      expect(before[table], table).toBeGreaterThan(0);
    }

    const cleared = await api.call('POST', '/api/workspace/clear');
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toEqual({ orgId: ORG_ID });
    expect(cleared.body.clock.followsToday).toBe(true);

    const after = await rowCounts(ORG_ID, TABLES);
    expect(Object.values(after).every((count) => count === 0), JSON.stringify(after)).toBe(true);
    const [[org]] = await pool.query(
      'SELECT as_of_date, workspace_gstin, demo_state FROM organizations WHERE id = ?',
      [ORG_ID]
    );
    expect(org).toEqual({ as_of_date: null, workspace_gstin: null, demo_state: null });
    expect((await api.call('GET', '/api/periods')).body.periods).toEqual([]);
  });

  it('starts again from empty: the next file is adopted as on a first visit', async () => {
    expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
    const { body } = await api.call('GET', '/api/org');
    expect(body.org.gstinAdopted).toBe(true);
  });
});
