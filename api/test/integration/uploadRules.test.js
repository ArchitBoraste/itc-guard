// Upload rules for snapshots.
//
//   * GSTR-2B does not exist before the 14th of the following month, so a 2B file
//     is refused while the workspace date is earlier.
//   * An IMS download is the portal on one day: the upload records that day (the
//     workspace date), replaces the period's previous IMS, and the previous upload
//     stays in the history marked replaced. A file named for another day is a
//     warning, not an error.
//   * Every record in an IMS file belongs to the upload's period, whatever source
//     period a GSTR-1A record names.
//   * Register + IMS reconciles on its own, before 2B exists.
//
// Driven over HTTP with the live demo's files. Owns org 26.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister, demoTwoB } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.uploadRules;

let api;

const setDate = async (asOfDate) =>
  expect((await api.call('PUT', '/api/workspace/clock', { asOfDate })).status).toBe(200);
const uploads = async () => (await api.call('GET', '/api/uploads')).body.uploads;
const inventory = async (taxPeriod) =>
  (await api.call('GET', '/api/periods')).body.periods.find((entry) => entry.taxPeriod === taxPeriod);

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

describe('register and IMS, before GSTR-2B exists', () => {
  it('reconcile on their own', async () => {
    await setDate('2026-09-05');
    expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
    expect((await api.ingest('IMS', demoIms('aug', '2026-09-05'))).status).toBe(200);

    const { status, body } = await api.call('POST', '/api/runs', { taxPeriod: '2026-08' });
    expect(status).toBe(201);
    expect(body.run.bucketCounts).toMatchObject({ MATCHED: 1, VALUE_MISMATCH: 1, MISSING_IN_PORTAL: 9 });
  });
});

describe('an IMS upload', () => {
  it('records the workspace date as its snapshot', async () => {
    const [latest] = await uploads();
    expect(latest).toMatchObject({ kind: 'IMS', snapshot_date: '2026-09-05', replaced_at: null });
  });

  it('replaces the period’s previous IMS, which stays in the history marked replaced', async () => {
    const [first] = await uploads();
    await setDate('2026-09-07');
    const committed = await api.ingest('IMS', demoIms('aug', '2026-09-07'));
    expect(committed.status).toBe(200);
    expect(committed.body.replacedUploadIds).toEqual([first.id]);
    expect(committed.body.snapshotDate).toBe('2026-09-07');

    const history = await uploads();
    const old = history.find((row) => row.id === first.id);
    expect(old.replaced_at).not.toBeNull();
    expect(old.replaced_by_upload_id).toBe(committed.body.uploadId);
    expect(history.filter((row) => row.kind === 'IMS' && !row.replaced_at)).toHaveLength(1);
    // Only the latest download's records are live: 5 by the 7th.
    expect((await inventory('2026-08')).ims).toBe(5);
  });

  it('warns, without refusing, when its name is for another day', async () => {
    await setDate('2026-09-11');
    const named05 = await api.upload('IMS', demoIms('aug', '2026-09-05'));
    expect(named05.status).toBe(201);
    expect(named05.body.upload.snapshot_date).toBe('2026-09-11');
    expect(named05.body.upload.warnings).toEqual([
      expect.stringMatching(/as of 5 Sep 2026, but the workspace date is 11 Sep 2026/)
    ]);
    const committed = await api.call('POST', `/api/uploads/${named05.body.upload.id}/commit`, {});
    expect(committed.body.warnings).toHaveLength(1);

    const named11 = await api.ingest('IMS', demoIms('aug', '2026-09-11'));
    expect(named11.body.warnings).toEqual([]);
  });

  it('puts every record in the upload’s period, GSTR-1A records included', async () => {
    const augustBefore = await inventory('2026-08');
    await setDate('2026-10-05');
    // Two of these records name August as their source period (GSTR-1A).
    const committed = await api.ingest('IMS', demoIms('sep', '2026-10-05'));
    expect(committed.status).toBe(200);
    expect(committed.body.taxPeriod).toBe('2026-09');
    expect(committed.body.periods).toEqual(['2026-09']);
    expect((await inventory('2026-09')).ims).toBe(7);
    // August's IMS is not replaced by September's file.
    expect(await inventory('2026-08')).toMatchObject({ ims: augustBefore.ims });
  });
});

describe('GSTR-2B', () => {
  it('is refused before the 14th of the following month, and nothing is stored', async () => {
    await setDate('2026-09-13');
    const before = (await uploads()).length;
    const refused = await api.upload('GSTR2B', demoTwoB('aug'));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('gstr2b_not_generated');
    expect(refused.body.message).toMatch(
      /GSTR-2B for August 2026 is generated on 14 Sep 2026, and the workspace date is 13 Sep 2026/
    );
    expect(await uploads()).toHaveLength(before);
  });

  it('is refused at commit if the date moved back after the upload', async () => {
    await setDate('2026-09-14');
    const created = await api.upload('GSTR2B', demoTwoB('aug'));
    expect(created.status).toBe(201);
    await setDate('2026-09-12');
    const refused = await api.call('POST', `/api/uploads/${created.body.upload.id}/commit`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('gstr2b_not_generated');

    await setDate('2026-09-14');
    const committed = await api.call('POST', `/api/uploads/${created.body.upload.id}/commit`, {});
    expect(committed.status).toBe(200);
    expect((await inventory('2026-08')).gstr2b).toBe(9);
  });
});

describe('removing an upload', () => {
  it('takes its rows, leaves the upload it replaced marked replaced, and rebuilds the run', async () => {
    const imsUploads = (await uploads()).filter((row) => row.kind === 'IMS' && row.tax_period === '2026-08');
    const latest = imsUploads.find((row) => !row.replaced_at);
    const { status, body } = await api.call('DELETE', `/api/uploads/${latest.id}`);
    expect(status).toBe(200);
    expect(body.reruns).toEqual([expect.objectContaining({ taxPeriod: '2026-08', ran: true })]);

    const after = (await uploads()).filter((row) => row.kind === 'IMS' && row.tax_period === '2026-08');
    expect(after.map((row) => row.id)).not.toContain(latest.id);
    for (const row of after) {
      expect(row.replaced_at).not.toBeNull();
      if (row.replaced_by_upload_id !== null) expect(row.replaced_by_upload_id).not.toBe(latest.id);
    }
  });
});
