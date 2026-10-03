// A stored verdict is an answer about a SPECIFIC version of a portal record, but
// every read joins the portal row live. Ingest new data without rebuilding and the
// screen shows the supplier's new figures — both sides visibly different — under a
// verdict of "Agrees with the portal", score 1.00, recommending Accept.
//
// Accepting there is the most expensive thing this product can do: the trader
// waives a discrepancy they were never shown, and the disputed credit is gone for
// good. Two defences, and this suite pins both.
//
//   1. committing a source re-runs the period's EXISTING run, so verdicts and
//      portal rows move together (rerunPeriodIfRun, called by the commit route).
//   2. every result records the portal content_hash it was computed from. When
//      that no longer matches, the row is stale, the API refuses to confirm it,
//      and the UI greys it out. This holds even when (1) never ran — a failed
//      rebuild, or data loaded outside the request cycle.
//
// Owns org 8.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import {
  confirmResult,
  createRun,
  getRun,
  listPeriodInventory,
  listResults,
  rerunPeriodIfRun
} from '../../src/services/reconcile.js';
import { commitUpload, createUpload } from '../../src/services/ingest.js';
import { writeWorkspaceClock } from '../../src/services/workspaceClock.js';
import { TEST_ORGS, ensureOrg, ingest, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT, readBuffer, readJson } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.staleRun;
const TRADER_GSTIN = '27AABCS1429F8Z1';
const PERIOD = '2026-04';
const AS_OF = '2026-05-16';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');

// The supplier revises one record downward — the shape of the reported bug.
function reduceOne(json, { gstin, invoiceNo }) {
  let touched = 0;
  const out = { imsDetails: {} };
  for (const [section, rows] of Object.entries(json.imsDetails)) {
    out.imsDetails[section] = rows.map((row) => {
      if (row.stin !== gstin || String(row.inum ?? row.nt_num) !== invoiceNo) return row;
      touched += 1;
      const igst = Number(row.iamt) || 0;
      return {
        ...row,
        txval: Number(row.txval) - 5000,
        iamt: igst ? igst - 900 : 0,
        camt: igst ? Number(row.camt) : Number(row.camt) - 450,
        samt: igst ? Number(row.samt) : Number(row.samt) - 450,
        val: Number(row.val) - 5900
      };
    });
  }
  return { json: out, touched };
}

async function allResults(runId) {
  const first = await listResults(ORG_ID, runId, { pageSize: 500 });
  const out = [...first.results];
  for (let page = 2; out.length < first.total; page += 1) {
    const next = await listResults(ORG_ID, runId, { page, pageSize: 500 });
    if (!next.results.length) break;
    out.push(...next.results);
  }
  return out;
}

describe('a run whose portal data moved underneath it', () => {
  let runId;
  let target;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);
    // The workspace date every re-run reads.
    await writeWorkspaceClock(ORG_ID, AS_OF);

    await ingest(ORG_ID, 'PURCHASE_REGISTER', 'purchase_register.xlsx', PERIOD);
    await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD);
    await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD);

    const run = await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });
    runId = run.id;

    // A clean agreeing record present in IMS: the one the bug turns into a
    // recommended Accept on figures that no longer agree.
    const results = await allResults(runId);
    target = results.find(
      (row) => row.bucket === 'MATCHED' && row.portal?.source === 'IMS' && row.books
    );
    expect(target, 'fixture must contain a clean matched IMS record').toBeTruthy();
  }, 240000);

  afterAll(async () => {
    await closePool();
  });

  it('starts current, and says so', async () => {
    const run = await getRun(ORG_ID, runId);
    expect(run.staleness.isStale).toBe(false);
    expect(run.staleness.staleResults).toBe(0);
    expect(run.staleness.unseenRecords).toBe(0);
    expect(target.stale).toBe(false);
    expect(target.recommendedAction).toBe('ACCEPT');
  });

  it('marks exactly the changed row stale when data lands without a rebuild', async () => {
    const edit = reduceOne(readJson(PERIOD, 'ims.json'), {
      gstin: target.portal.supplierGstin,
      invoiceNo: target.portal.invoiceNo
    });
    expect(edit.touched).toBe(1);

    // Deliberately the path that does NOT re-run: this is what defence (2) has to
    // survive on its own.
    await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(edit.json));

    const results = await allResults(runId);
    const stale = results.filter((row) => row.stale);
    expect(stale).toHaveLength(1);
    expect(stale[0].portal.invoiceNo).toBe(target.portal.invoiceNo);
    expect(stale[0].staleReason).toBe('PORTAL_CHANGED');

    // The exact reported symptom: a MATCHED / Accept verdict sitting on figures
    // that now differ. The row is still RENDERED — the trader has to see the
    // disagreement — but it is labelled out of date.
    expect(stale[0].bucket).toBe('MATCHED');
    expect(stale[0].recommendedAction).toBe('ACCEPT');
    expect(stale[0].portal.taxableValue).not.toBe(stale[0].books.taxableValue);

    const run = await getRun(ORG_ID, runId);
    expect(run.staleness.isStale).toBe(true);
    expect(run.staleness.staleResults).toBe(1);
  }, 240000);

  it('refuses to accept a stale row', async () => {
    const stale = (await allResults(runId)).find((row) => row.stale);

    // A 409, not a warning. The UI disables the button, but the UI is not the
    // thing standing between a trader and a credit they cannot get back.
    await expect(
      confirmResult(ORG_ID, stale.id, { confirmedAction: 'ACCEPT' })
    ).rejects.toMatchObject({ status: 409, code: 'stale_run' });

    const [rows] = await pool.query(
      'SELECT confirmed_action FROM match_results WHERE org_id = ? AND id = ?',
      [ORG_ID, stale.id]
    );
    expect(rows[0].confirmed_action).toBeNull();
  });

  it('clears once the run is rebuilt, and the verdict actually changes', async () => {
    const rerun = await createRun({
      orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF
    });
    expect(rerun.id).toBe(runId);
    expect(rerun.staleness.isStale).toBe(false);
    expect((await allResults(runId)).filter((row) => row.stale)).toHaveLength(0);

    // The point of all of it: the old answer was wrong, and rebuilding changes it.
    // If the record still came back MATCHED/ACCEPT, staleness would be cosmetic.
    const now = (await allResults(runId)).find(
      (row) => row.portal?.invoiceNo === target.portal.invoiceNo
    );
    expect(now.bucket).not.toBe('MATCHED');
    expect(now.recommendedAction).not.toBe('ACCEPT');
  }, 240000);

  it('notices records that arrived after the run and appear in no result at all', async () => {
    // A record nobody has seen is deemed accepted at GSTR-3B. "No row on screen is
    // stale" is not the same as "the run is current".
    const json = readJson(PERIOD, 'ims.json');
    json.imsDetails.b2b.push({ ...json.imsDetails.b2b[0], inum: 'LATE/ARRIVAL/1' });
    const committed = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(json));
    expect(committed.inserted).toBe(1);

    const run = await getRun(ORG_ID, runId);
    expect(run.staleness.unseenRecords).toBeGreaterThan(0);
    expect(run.staleness.isStale).toBe(true);

    // ...and it clears itself. Rebuilding takes the new record in.
    const rerun = await createRun({
      orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF
    });
    expect(rerun.staleness.isStale).toBe(false);
    expect(rerun.staleness.unseenRecords).toBe(0);
  }, 240000);

  // --- the rebuild that commit triggers ------------------------------------

  it('re-runs the period on commit, keeping the run, at the workspace date', async () => {
    const before = await getRun(ORG_ID, runId);

    const edit = reduceOne(readJson(PERIOD, 'ims.json'), {
      gstin: target.portal.supplierGstin,
      invoiceNo: target.portal.invoiceNo
    });
    const upload = await createUpload({
      orgId: ORG_ID, kind: 'IMS', filename: 'ims.json',
      buffer: asBuffer(edit.json), taxPeriod: PERIOD
    });
    await commitUpload(ORG_ID, upload.id);

    // This is what the commit route calls immediately after committing.
    const rerun = await rerunPeriodIfRun(ORG_ID, PERIOD);
    expect(rerun).toMatchObject({ ran: true, runId, taxPeriod: PERIOD });

    const after = await getRun(ORG_ID, runId);
    expect(after.staleness.isStale).toBe(false);
    // The as-of date decides whether a mismatch is a free supplier fix or a
    // reject. The re-run reads the workspace's, not today's, so the file alone
    // cannot change the answers.
    expect(after.asOfDate).toBe(AS_OF);
    expect(before.asOfDate).toBe(AS_OF);
    expect(after.mode).toBe(before.mode);
    expect(after.filingScheme).toBe(before.filingScheme);
  }, 240000);

  it('leaves a period with no run alone rather than inventing one', async () => {
    // Uploading a file is not a request to reconcile a period the trader has never
    // reconciled — that decision belongs to the Reconcile button.
    const neighbour = '2026-05';
    await ingest(ORG_ID, 'IMS', 'ims.json', neighbour);

    expect(await rerunPeriodIfRun(ORG_ID, neighbour)).toMatchObject({
      ran: false,
      reason: 'no_run_yet'
    });
    const [runs] = await pool.query(
      'SELECT id FROM runs WHERE org_id = ? AND tax_period = ?',
      [ORG_ID, neighbour]
    );
    expect(runs).toHaveLength(0);
  }, 240000);

  it('never fails a commit because the rebuild could not run', async () => {
    // A period with a run but nothing left to reconcile is the degenerate case.
    // Whatever happens, the answer is a report — never a throw that would lose the
    // trader an upload that already succeeded.
    const outcome = await rerunPeriodIfRun(ORG_ID, null);
    expect(outcome).toMatchObject({ ran: false, reason: 'unknown_period' });
  });

  it('takes a withdrawn record out of the run when it is rebuilt', async () => {
    // A download that no longer carries a record replaces the one that did: the
    // record is off the portal. Until the run is rebuilt its row is un-actionable
    // (accepting it would send an action for a document that is not there) and
    // the run says it is out of date; rebuilding takes the record out entirely,
    // where it used to stay in — matched and counted — for good.
    const json = readJson(PERIOD, 'ims.json');
    const gone = json.imsDetails.b2b.find(
      (row) => row.stin !== target.portal.supplierGstin
    );
    json.imsDetails.b2b = json.imsDetails.b2b.filter((row) => row !== gone);
    await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(json));

    const before = await getRun(ORG_ID, runId);
    expect(before.staleness.withdrawnResults).toBeGreaterThan(0);
    expect(before.staleness.isStale).toBe(true);

    const withdrawn = (await allResults(runId)).filter((row) => row.withdrawn);
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn[0].stale).toBe(false);
    await expect(
      confirmResult(ORG_ID, withdrawn[0].id, { confirmedAction: 'ACCEPT' })
    ).rejects.toMatchObject({ status: 409, code: 'record_withdrawn' });

    const rerun = await createRun({
      orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF
    });
    expect(rerun.staleness).toMatchObject({ withdrawnResults: 0, isStale: false });
    expect((await allResults(runId)).filter((row) => row.withdrawn)).toHaveLength(0);
    // The document may well still be in 2B; it is the IMS record that left.
    const isGone = (row) =>
      row.portal?.source === 'IMS' &&
      row.portal?.supplierGstin === gone.stin &&
      row.portal?.invoiceNo === String(gone.inum);
    expect((await allResults(runId)).some(isGone)).toBe(false);
  }, 240000);

  // --- what a period already holds ----------------------------------------

  it('reports a period as runnable from what is stored, not from one upload', async () => {
    // The reported bug: re-uploading IMS alone said "1 source committed" and
    // disabled Reconcile, though all three had been committed earlier.
    const inventory = await listPeriodInventory(ORG_ID);
    const april = inventory.find((entry) => entry.taxPeriod === PERIOD);

    expect(april).toBeTruthy();
    expect(april.hasBooks).toBe(true);
    expect(april.hasPortal).toBe(true);
    expect(april.books).toBeGreaterThan(0);
    expect(april.ims).toBeGreaterThan(0);
    expect(april.gstr2b).toBeGreaterThan(0);
    expect(april.runId).toBe(runId);

    // The neighbour got an IMS file and nothing else: portal yes, books no. The
    // gate has to be able to tell those apart, or it would just always say yes.
    const may = inventory.find((entry) => entry.taxPeriod === '2026-05');
    expect(may.hasPortal).toBe(true);
    expect(may.hasBooks).toBe(false);
    expect(may.runId).toBeNull();
  });

  it('still refuses a period it has nothing for', async () => {
    const inventory = await listPeriodInventory(ORG_ID);
    expect(inventory.find((entry) => entry.taxPeriod === '2026-02')).toBeUndefined();
  });

  // Guards the fixture read used above, so a missing file fails here rather than
  // as a confusing assertion further up.
  it('reads its fixtures from disk', () => {
    expect(readBuffer(PERIOD, 'ims.json').length).toBeGreaterThan(0);
  });
});
