// N is never a decision (audit P1, and the API half of P24).
//
// The audit confirmed every group on April's Actions screen and watched the
// banner turn green while 22 records — all six phantom invoices among them —
// still went to the portal as N, which is deemed acceptance at GSTR-3B. Through
// the real routes, this pins what stops that now:
//
//   * an unconfirmed recommendation, a Reject included, goes out as N and stays
//     an open decision; confirming N leaves it open;
//   * "Confirm all" is refused (422) for Verify rows, which are decided one by one;
//   * books-only and other non-IMS rows take no action at all, N included;
//   * the IMS file is held back (409, counts by category) while any record would
//     go out as N, unless the trader acknowledges it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';
import { createRun, getRun, listResults } from '../../src/services/reconcile.js';
import { UPLOAD_SECTIONS } from '../../src/adapters/imsActionWriter.js';
import { TEST_ORGS, ensureOrg, ingestPeriod, requireDatabase, resetOrg } from '../helpers/db.js';
import { groundTruth } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.noActionIsNotADecision;
const TRADER_GSTIN = '27AABCS1429F7Z0';
const PERIOD = '2026-04';
const AS_OF = '2026-05-16';

let server;
let run;

const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
};

const results = async () => (await listResults(ORG_ID, run.id, { pageSize: 500 })).results;
const openCount = async () => (await getRun(ORG_ID, run.id)).openDecisions.count;
const wireRecords = (json) => UPLOAD_SECTIONS.flatMap((section) => json.invdata[section]);
const wireNo = (wire) => wire.inum ?? wire.nt_num;

async function decisionRows(ids) {
  const [rows] = await pool.query(
    'SELECT id, recommended_action, confirmed_action FROM match_results WHERE org_id = ? AND id IN (?)',
    [ORG_ID, ids]
  );
  return rows;
}
const confirmedActions = async (ids) => (await decisionRows(ids)).map((row) => row.confirmed_action);

// The wire record for a result's portal side. Number, date and amount, because
// the fixtures hold invoices that share a number and differ only in amount.
const wireKey = (wire) => `${wire.stin}|${wireNo(wire)}|${wire.idt ?? wire.nt_dt}|${wire.txval}`;
const resultKey = ({ portal }) => {
  const [y, m, d] = portal.invoiceDate.split('-');
  return `${portal.supplierGstin}|${portal.invoiceNo}|${d}-${m}-${y}|${portal.taxableValue / 100}`;
};

// What ground truth says is open before anyone decides anything.
function truthOpen() {
  const open = groundTruth(PERIOD).documents.filter(
    (doc) => doc.presence.inIms && ['VALUE_MISMATCH', 'SUGGESTED', 'MISSING_IN_BOOKS'].includes(doc.expectedBucket)
  );
  const count = (bucket) => open.filter((doc) => doc.expectedBucket === bucket).length;
  return { count: open.length, phantom: count('MISSING_IN_BOOKS'), verify: count('SUGGESTED'), other: count('VALUE_MISMATCH') };
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID, TRADER_GSTIN);
  await resetOrg(ORG_ID);
  await ingestPeriod(ORG_ID, PERIOD);
  run = await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });

  const app = createApp({
    pingDb: async () => true,
    auth: (req, res, next) => {
      req.orgId = ORG_ID;
      req.userId = null;
      next();
    }
  });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
}, 120000);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await resetOrg(ORG_ID);
  await closePool();
});

describe('the IMS file while decisions are open', () => {
  it('is held back with the open records counted by category', async () => {
    const expected = truthOpen();
    const { status, body } = await call('GET', `/runs/${run.id}/ims-actions.json`);

    expect(status).toBe(409);
    expect(body.error).toBe('open_decisions');
    expect(body.openDecisions.count).toBe(expected.count);
    expect(body.openDecisions.byCategory.phantom.count).toBe(expected.phantom);
    expect(body.openDecisions.byCategory.verify.count).toBe(expected.verify);
    expect(body.openDecisions.byCategory.other.count).toBe(expected.other);
    // The same count every screen shows.
    expect(body.openDecisions.count).toBe(await openCount());
  });

  it('reports the same counts on the summary the download panel reads', async () => {
    const { status, body } = await call('GET', `/runs/${run.id}/ims-actions-summary`);
    expect(status).toBe(200);
    expect(body.openDecisions).toEqual((await getRun(ORG_ID, run.id)).openDecisions);
    expect(body.stats.byAction.N).toBe(body.openDecisions.count);
  });

  it('when acknowledged, sends every open record as N and never applies a Reject on its own', async () => {
    const { status, body } = await call('GET', `/runs/${run.id}/ims-actions.json?acknowledgeOpenDecisions=true`);
    expect(status).toBe(200);

    const byKey = new Map(wireRecords(body).map((wire) => [wireKey(wire), wire]));
    const imsRows = (await results()).filter((result) => result.portal?.source === 'IMS');
    expect(byKey.size).toBe(imsRows.length);
    for (const result of imsRows) {
      const wire = byKey.get(resultKey(result));
      expect(wire.action).toBe(result.needsDecision ? 'N' : 'A');
      // An engine Reject is a proposal; its remark goes nowhere until confirmed.
      if (result.recommendedAction === 'REJECT') expect('remarks' in wire).toBe(false);
    }
    expect(imsRows.some((result) => result.recommendedAction === 'REJECT')).toBe(true);
  });
});

describe('deciding', () => {
  it('keeps phantoms as Verify: on the portal, not in the books, never rejected unseen', async () => {
    const phantoms = (await results()).filter((result) => result.bucket === 'MISSING_IN_BOOKS');
    expect(phantoms.length).toBeGreaterThan(0);
    for (const result of phantoms) {
      expect(result.recommendedAction).toBe('VERIFY');
      expect(result.needsDecision).toBe(true);
      expect(result.decisionCategory).toBe('phantom');
      expect(result.recommendationReason).toMatch(/Verify no goods or invoice were received/);
    }
  });

  it('refuses "Confirm all" on Verify rows, and writes nothing', async () => {
    const verify = (await results()).filter((result) => result.recommendedAction === 'VERIFY');
    const ids = verify.map((result) => result.id);

    const { status, body } = await call('POST', `/runs/${run.id}/confirmations`, { resultIds: ids });
    expect(status).toBe(422);
    expect(body.error).toBe('not_bulk_confirmable');
    expect(await confirmedActions(ids)).toEqual(ids.map(() => null));
  });

  it('refuses the whole request when a single Verify row is mixed in', async () => {
    const all = await results();
    const reject = all.find((result) => result.recommendedAction === 'REJECT');
    const verify = all.find((result) => result.recommendedAction === 'VERIFY');

    const { status } = await call('POST', `/runs/${run.id}/confirmations`, { resultIds: [reject.id, verify.id] });
    expect(status).toBe(422);
    expect(await confirmedActions([reject.id, verify.id])).toEqual([null, null]);
  });

  it('confirms a group of Accept and Reject recommendations, and closes exactly those', async () => {
    const before = await openCount();
    const mismatches = (await results()).filter(
      (result) => result.bucket === 'VALUE_MISMATCH' && result.needsDecision &&
        ['ACCEPT', 'REJECT'].includes(result.recommendedAction)
    );
    const ids = mismatches.map((result) => result.id);

    const { status, body } = await call('POST', `/runs/${run.id}/confirmations`, { resultIds: ids });
    expect(status).toBe(200);
    expect([...body.confirmed].sort()).toEqual([...ids].sort());
    for (const row of await decisionRows(ids)) {
      expect(row.confirmed_action).toBe(row.recommended_action);
    }
    expect(await openCount()).toBe(before - ids.length);

    // Asked again, nothing is overwritten.
    const again = await call('POST', `/runs/${run.id}/confirmations`, { resultIds: ids });
    expect(again.body.confirmed).toEqual([]);
    expect(again.body.skipped).toHaveLength(ids.length);
  });

  it('does not count a confirmed N as a decision', async () => {
    const before = await openCount();
    const verify = (await results()).find((result) => result.bucket === 'SUGGESTED');

    const { status } = await call('PATCH', `/results/${verify.id}`, { confirmedAction: 'NO_ACTION' });
    expect(status).toBe(200);

    const after = (await results()).find((result) => result.id === verify.id);
    expect(after.confirmedAction).toBe('NO_ACTION');
    expect(after.needsDecision).toBe(true);
    expect(await openCount()).toBe(before);
  });

  it('takes no action at all on a books-only row, N included', async () => {
    const booksOnly = (await results()).find((result) => !result.portal);
    for (const confirmedAction of ['NO_ACTION', 'ACCEPT']) {
      const { status, body } = await call('PATCH', `/results/${booksOnly.id}`, { confirmedAction });
      expect(status).toBe(409);
      expect(body.error).toBe('action_blocked');
    }
  });

  it('takes no action on a record that never enters IMS, N included', async () => {
    const outside = (await results()).find((result) => result.bucket === 'NON_IMS');
    const { status, body } = await call('PATCH', `/results/${outside.id}`, { confirmedAction: 'NO_ACTION' });
    expect(status).toBe(409);
    expect(body.error).toBe('action_blocked');
  });

  it('hands the file over without asking once every record is decided', async () => {
    // Every remaining open row decided by hand: suggested matches accepted,
    // phantoms rejected — one row at a time, as the Verify group requires.
    for (const result of (await results()).filter((row) => row.needsDecision)) {
      const confirmedAction = result.bucket === 'MISSING_IN_BOOKS' ? 'REJECT' : 'ACCEPT';
      const { status } = await call('PATCH', `/results/${result.id}`, { confirmedAction });
      expect(status).toBe(200);
    }
    expect(await openCount()).toBe(0);

    const { status, body } = await call('GET', `/runs/${run.id}/ims-actions.json`);
    expect(status).toBe(200);
    expect(wireRecords(body).some((wire) => wire.action === 'N')).toBe(false);
  }, 60000);
});
