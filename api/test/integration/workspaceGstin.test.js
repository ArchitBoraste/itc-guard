// The trader GSTIN a workspace is for (services/workspaceGstin.js).
//
// An empty workspace adopts the GSTIN of the first uploaded file that carries one;
// a later file for another trader is refused with 422; emptying the workspace
// resets it; the IMS export goes out under it.
//
// The demo files are Sharma Electronics, 27AABCS1080F1ZN, on every file. The big
// fixtures' register names 27AABCS1429F1Z8 and their portal files name nobody.
// Driven over HTTP. Owns org 30.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { wipeOrgData } from '../../src/services/demoStory.js';
import { TRADER } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { FIXTURES_DIR } from '../helpers/fixtures.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.workspaceGstin;
const OTHER_TRADER = '27AABCS1429F1Z8';
const fixtureFile = (name) => join(FIXTURES_DIR, '2026-03', name);

let api;
const org = async () => (await api.call('GET', '/api/org')).body.org;

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);
  expect((await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' })).status).toBe(200);
});

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('an empty workspace', () => {
  it('has adopted nothing yet', async () => {
    expect((await org()).gstinAdopted).toBe(false);
  });

  it('adopts the trader GSTIN from the first file that carries one, an IMS download here', async () => {
    const committed = await api.ingest('IMS', demoIms('aug', '2026-09-11'));
    expect(committed.status).toBe(200);
    expect(committed.body.traderGstin).toBe(TRADER.gstin);
    expect(await org()).toMatchObject({ gstin: TRADER.gstin, gstinAdopted: true });
  });
});

describe('a workspace for one trader', () => {
  it("refuses another trader's register on upload, with both GSTINs named", async () => {
    const refused = await api.upload('PURCHASE_REGISTER', fixtureFile('purchase_register.xlsx'));
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('gstin_mismatch');
    expect(refused.body.message).toBe(
      `These files belong to GSTIN ${OTHER_TRADER}; this workspace is for ${TRADER.gstin}.`
    );
    expect((await api.call('GET', '/api/uploads')).body.uploads).toHaveLength(1);
  });

  it('takes its own register, and a file that names nobody on trust', async () => {
    expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
    const anonymous = await api.upload('IMS', fixtureFile('ims.json'));
    expect(anonymous.status).toBe(201);
    expect((await org()).gstin).toBe(TRADER.gstin);
  });

  it('files its IMS actions under the adopted GSTIN', async () => {
    const run = await api.call('POST', '/api/runs', { taxPeriod: '2026-08' });
    expect(run.status).toBe(201);
    const exported = await api.call('GET', `/api/runs/${run.body.run.id}/ims-actions.json?acknowledgeOpenDecisions=true`);
    expect(exported.status).toBe(200);
    expect(exported.body.rtin).toBe(TRADER.gstin);
  });
});

describe('emptying the workspace', () => {
  beforeAll(async () => {
    await wipeOrgData(ORG_ID);
  });

  it('forgets the GSTIN, so the next file sets it afresh', async () => {
    expect((await org()).gstinAdopted).toBe(false);
    expect((await api.ingest('PURCHASE_REGISTER', fixtureFile('purchase_register.xlsx'))).status).toBe(200);
    expect(await org()).toMatchObject({ gstin: OTHER_TRADER, gstinAdopted: true });
  });

  it('checks again at commit: of two uploads made while empty, the second commit is refused', async () => {
    await wipeOrgData(ORG_ID);
    const first = await api.upload('PURCHASE_REGISTER', demoRegister('aug'));
    const second = await api.upload('PURCHASE_REGISTER', fixtureFile('purchase_register.xlsx'));
    expect([first.status, second.status]).toEqual([201, 201]);

    expect((await api.call('POST', `/api/uploads/${first.body.upload.id}/commit`, {})).status).toBe(200);
    const refused = await api.call('POST', `/api/uploads/${second.body.upload.id}/commit`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('gstin_mismatch');
    expect((await org()).gstin).toBe(TRADER.gstin);
  });
});
