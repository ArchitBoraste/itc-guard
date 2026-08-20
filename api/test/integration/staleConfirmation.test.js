// A confirmed_action is a decision about a SPECIFIC version of a record.
//
// The dangerous sequence: the trader sees a VALUE_MISMATCH, confirms REJECT, and
// then the supplier corrects their filing. Re-running now produces a clean
// MATCHED row — but identity_key deliberately excludes amounts, so it is the SAME
// portal_records row with the SAME id, and a naive carry-forward keeps the REJECT.
// The upload would then reject an invoice the trader already agrees with, costing
// them a month of credit, and nothing on screen looks wrong.
//
// IMS itself resets the recipient's action when a supplier edits a saved record.
// This suite pins that behaviour.
//
// Owns org 3.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { confirmResult, createRun, listResults } from '../../src/services/reconcile.js';
import { buildRunImsActions } from '../../src/services/imsActions.js';
import { UPLOAD_SECTIONS } from '../../src/adapters/imsActionWriter.js';
import { ensureOrg, ingest, requireDatabase, resetOrg, rowCounts } from '../helpers/db.js';
import { FIXTURES_PRESENT, readJson } from '../helpers/fixtures.js';

const ORG_ID = 3;
const TRADER_GSTIN = '27AABCS1429F3Z6';
const PERIOD = '2026-03';
const AS_OF = '2026-04-16';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

const toRupees = (paise) => Number((paise / 100).toFixed(2));
const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');

// Rewrites one invoice in the IMS download so its amounts equal the trader's books.
function correctIms(json, { gstin, invoiceNo, books }) {
  let touched = 0;
  const out = { imsDetails: {} };
  for (const [section, rows] of Object.entries(json.imsDetails)) {
    out.imsDetails[section] = rows.map((row) => {
      const number = row.inum ?? row.nt_num;
      if (row.stin !== gstin || String(number) !== invoiceNo) return row;
      touched += 1;
      return {
        ...row,
        txval: toRupees(books.taxable),
        iamt: toRupees(books.igst),
        camt: toRupees(books.cgst),
        samt: toRupees(books.sgst),
        cess: toRupees(books.cess),
        val: toRupees(books.taxable + books.tax)
      };
    });
  }
  return { json: out, touched };
}

// Same correction on the 2B side. Rate lines are collapsed to a single line that
// sums to the corrected total, which is what the adapter reads.
function correct2b(json, { gstin, invoiceNo, books }) {
  let touched = 0;
  const out = { ...json, docdata: {} };
  for (const [section, groups] of Object.entries(json.docdata)) {
    out.docdata[section] = (groups ?? []).map((group) => {
      if (group.ctin !== gstin) return group;
      const copy = { ...group };
      const fix = (doc) => {
        const number = doc.inum ?? doc.ntnum ?? doc.nt_num;
        if (String(number) !== invoiceNo) return doc;
        touched += 1;
        return {
          ...doc,
          val: toRupees(books.taxable + books.tax),
          items: [
            {
              hsn: doc.items?.[0]?.hsn ?? null,
              rt: doc.items?.[0]?.rt ?? 18,
              txval: toRupees(books.taxable),
              igst: toRupees(books.igst),
              cgst: toRupees(books.cgst),
              sgst: toRupees(books.sgst),
              cess: toRupees(books.cess)
            }
          ]
        };
      };
      if (Array.isArray(copy.inv)) copy.inv = copy.inv.map(fix);
      if (Array.isArray(copy.nt)) copy.nt = copy.nt.map(fix);
      return copy;
    });
  }
  return { json: out, touched };
}

describe('a confirmed action does not survive the record changing under it', () => {
  let target;
  let books;
  let runId;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);

    await ingest(ORG_ID, 'PURCHASE_REGISTER', 'purchase_register.xlsx', PERIOD);
    await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD);
    await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD);

    const run = await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });
    runId = run.id;

    // A filed value mismatch: the engine recommends REJECT, and it is present in
    // IMS so it reaches the action JSON.
    const page = await listResults(ORG_ID, runId, { bucket: 'VALUE_MISMATCH', pageSize: 50 });
    target = page.results.find(
      (row) => row.recommendedAction === 'REJECT' && row.portal && row.books
    );
    expect(target, 'fixture must contain a filed VALUE_MISMATCH').toBeTruthy();

    const [rows] = await pool.query(
      `SELECT ei.taxable_value, ei.igst, ei.cgst, ei.sgst, ei.cess, ei.total_tax
         FROM match_results mr JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE mr.org_id = ? AND mr.id = ?`,
      [ORG_ID, target.id]
    );
    books = {
      taxable: Number(rows[0].taxable_value),
      igst: Number(rows[0].igst),
      cgst: Number(rows[0].cgst),
      sgst: Number(rows[0].sgst),
      cess: Number(rows[0].cess),
      tax: Number(rows[0].total_tax)
    };
  }, 180000);

  afterAll(async () => {
    await closePool();
  });

  it('starts as a value mismatch the trader can reject', async () => {
    expect(target.bucket).toBe('VALUE_MISMATCH');
    expect(target.deltaTotalTax).not.toBe(0);

    const confirmed = await confirmResult(ORG_ID, target.id, { confirmedAction: 'REJECT' });
    expect(confirmed.confirmed_action).toBe('REJECT');

    // And that rejection genuinely reaches the portal upload.
    const built = await buildRunImsActions(ORG_ID, runId);
    const wire = UPLOAD_SECTIONS.flatMap((s) => built.json.invdata[s]).find(
      (row) => (row.inum ?? row.nt_num) === target.portal.invoiceNo
    );
    expect(wire).toBeTruthy();
    expect(wire.action).toBe('R');
  });

  it('records what the decision was about', async () => {
    const [rows] = await pool.query(
      `SELECT mr.confirmed_content_hash, mr.confirmed_bucket, pr.content_hash
         FROM match_results mr JOIN portal_records pr ON pr.id = mr.portal_record_id
        WHERE mr.org_id = ? AND mr.id = ?`,
      [ORG_ID, target.id]
    );
    // Without this the rebuild has no way to tell the record changed.
    expect(rows[0].confirmed_content_hash).toBe(rows[0].content_hash);
    expect(rows[0].confirmed_bucket).toBe('VALUE_MISMATCH');
  });

  it('drops the stale REJECT once the supplier corrects the value', async () => {
    const key = { gstin: target.portal.supplierGstin, invoiceNo: target.portal.invoiceNo, books };
    const imsFix = correctIms(readJson(PERIOD, 'ims.json'), key);
    const twoBFix = correct2b(readJson(PERIOD, 'gstr2b.json'), key);
    expect(imsFix.touched).toBeGreaterThan(0);
    expect(twoBFix.touched).toBeGreaterThan(0);

    const before = await rowCounts(ORG_ID);
    const ims = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(imsFix.json));
    const twoB = await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD, asBuffer(twoBFix.json));

    // The correction is an UPDATE of the same rows, and it is detected as a change.
    expect(ims.inserted).toBe(0);
    expect(twoB.inserted).toBe(0);
    expect((await rowCounts(ORG_ID)).portal_records).toBe(before.portal_records);
    expect(ims.changes + twoB.changes).toBeGreaterThan(0);

    const rerun = await createRun({
      orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF
    });
    expect(rerun.id).toBe(runId);

    const page = await listResults(ORG_ID, runId, { bucket: 'MATCHED', pageSize: 500 });
    const now = page.results.find((row) => row.portal?.invoiceNo === target.portal.invoiceNo);

    // It now matches cleanly...
    expect(now, 'the corrected invoice should now be MATCHED').toBeTruthy();
    expect(now.deltaTotalTax).toBe(0);
    // ...and the decision made about the OLD value is gone.
    expect(now.confirmedAction).toBeNull();
    expect(now.recommendedAction).toBe('ACCEPT');
    // The UI can tell the trader why their earlier choice disappeared.
    expect(now.flags).toContain('CONFIRMATION_RESET');
  }, 180000);

  it('never emits the stale rejection to the portal', async () => {
    const built = await buildRunImsActions(ORG_ID, runId);
    const wire = UPLOAD_SECTIONS.flatMap((s) => built.json.invdata[s]).find(
      (row) => (row.inum ?? row.nt_num) === target.portal.invoiceNo
    );
    expect(wire).toBeTruthy();
    // A stale R here would cost the trader a month of credit on an invoice that
    // is now correct.
    expect(wire.action).not.toBe('R');
    expect(wire.action).toBe('A');
    expect('remarks' in wire).toBe(false);
  });

  it('leaves the run totals consistent afterwards', async () => {
    const [rows] = await pool.query(
      `SELECT expected_total_itc, claimable_itc, at_risk_itc, deferred_itc,
              ineligible_itc, non_ims_itc, grand_total_itc
         FROM runs WHERE org_id = ? AND id = ?`,
      [ORG_ID, runId]
    );
    const t = rows[0];
    expect(
      Number(t.claimable_itc) + Number(t.at_risk_itc) + Number(t.deferred_itc) +
        Number(t.ineligible_itc)
    ).toBe(Number(t.expected_total_itc));
    expect(Number(t.expected_total_itc) + Number(t.non_ims_itc)).toBe(Number(t.grand_total_itc));
  });

  it('still carries a confirmation forward when nothing changed', async () => {
    // The reset must be targeted: an unrelated decision has to survive a rebuild,
    // or the feature would just be "confirmations do not persist".
    const page = await listResults(ORG_ID, runId, { bucket: 'MISSING_IN_BOOKS', pageSize: 5 });
    expect(page.results.length).toBeGreaterThan(0);
    const other = page.results[0];

    await confirmResult(ORG_ID, other.id, { confirmedAction: 'REJECT' });
    await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });

    const after = await listResults(ORG_ID, runId, { bucket: 'MISSING_IN_BOOKS', pageSize: 5 });
    const survived = after.results.find((row) => row.portal?.invoiceNo === other.portal.invoiceNo);
    expect(survived.confirmedAction).toBe('REJECT');
    expect(survived.flags).not.toContain('CONFIRMATION_RESET');
  }, 180000);
});
