// Accepting a value mismatch claims what the portal will actually give (audit P5).
//
// The scripted demo story: Mahavir Sales Corp 06-17/AMD/3538 is revised down by
// Rs 5,000 of taxable value after the trader accepted it, so the books carry
// Rs 1,21,033.45 of tax and the portal Rs 1,20,190.49. Accepting it now must raise
// claimable by the portal's Rs 1,20,190.49 — the old build added the books' Rs
// 1,21,033.45 and overstated the claim by Rs 842.96.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { confirmResult, createRun, getRun, listResults } from '../../src/services/reconcile.js';
import { STORY_PERIOD, seedDemoStory } from '../../src/services/demoStory.js';
import { TEST_ORGS, ensureOrg, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.claimableOnAccept;
const TRADER_GSTIN = '27AABCS1429F6Z2';

const BOOKS_TAX = 12103345;
const PORTAL_TAX = 12019049;

let run;
let mahavir;

const identityHolds = (t) =>
  t.claimableItc + t.atRiskItc + t.deferredItc + t.ineligibleItc === t.expectedTotalItc &&
  t.expectedTotalItc + t.nonImsItc === t.grandTotalItc;

async function rowOf(resultId) {
  const [rows] = await pool.query(
    'SELECT confirmed_action, total_bucket, signed_itc, claimable_itc FROM match_results WHERE org_id = ? AND id = ?',
    [ORG_ID, resultId]
  );
  return rows[0];
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID, TRADER_GSTIN);
  await resetOrg(ORG_ID);
  const built = await seedDemoStory(ORG_ID);
  run = built.run;
  const page = await listResults(ORG_ID, run.id, { bucket: 'VALUE_MISMATCH', pageSize: 100 });
  mahavir = page.results.find((result) => result.books?.invoiceNo === '06-17/AMD/3538');
}, 120000);

afterAll(async () => {
  await resetOrg(ORG_ID);
  await closePool();
});

describe('accepting the Mahavir mismatch', () => {
  it('is the scripted story: books Rs 1,21,033.45, portal Rs 1,20,190.49, recommended Accept', () => {
    expect(run.taxPeriod).toBe(STORY_PERIOD);
    expect(mahavir.books.totalTax).toBe(BOOKS_TAX);
    expect(mahavir.portal.totalTax).toBe(PORTAL_TAX);
    expect(mahavir.recommendedAction).toBe('ACCEPT');
    expect(mahavir.needsDecision).toBe(true);
    expect(mahavir.totalBucket).toBe('AT_RISK');
  });

  it('raises claimable by the portal figure, not the books figure', async () => {
    const before = (await getRun(ORG_ID, run.id)).totals;
    await confirmResult(ORG_ID, mahavir.id, { confirmedAction: 'ACCEPT' });
    const after = (await getRun(ORG_ID, run.id)).totals;

    expect(after.claimableItc - before.claimableItc).toBe(PORTAL_TAX);
    // The Rs 842.96 still being chased stays at risk; nothing else moves.
    expect(before.atRiskItc - after.atRiskItc).toBe(PORTAL_TAX);
    expect(after.expectedTotalItc).toBe(before.expectedTotalItc);
    expect(identityHolds(after)).toBe(true);

    expect(await rowOf(mahavir.id)).toMatchObject({
      confirmed_action: 'ACCEPT',
      total_bucket: 'CLAIMABLE',
      signed_itc: BOOKS_TAX,
      claimable_itc: PORTAL_TAX
    });
  });

  it('shows the split on the totals breakdown without counting the document twice', async () => {
    const { totalsBreakdown, totals } = await getRun(ORG_ID, run.id);
    expect(totalsBreakdown.CLAIMABLE.itc).toBe(totals.claimableItc);
    expect(totalsBreakdown.AT_RISK.itc).toBe(totals.atRiskItc);

    const [counted] = await pool.query(
      `SELECT total_bucket, COUNT(*) AS n FROM match_results
        WHERE org_id = ? AND run_id = ? GROUP BY total_bucket`,
      [ORG_ID, run.id]
    );
    for (const { total_bucket: bucket, n } of counted) {
      expect(totalsBreakdown[bucket].count).toBe(Number(n));
    }
  });

  it('keeps counting the decision at the portal figure after a re-run', async () => {
    // The re-run used to compute its totals before carrying decisions across, so
    // an accepted record kept its confirmation but fell back out of claimable.
    const before = (await getRun(ORG_ID, run.id)).totals;
    const rerun = await createRun({
      orgId: ORG_ID,
      taxPeriod: STORY_PERIOD,
      mode: 'REACTIVE',
      asOfDate: run.asOfDate
    });

    expect(rerun.totals).toEqual(before);
    const [rows] = await pool.query(
      `SELECT mr.total_bucket, mr.claimable_itc FROM match_results mr
         JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND ei.invoice_no = '06-17/AMD/3538'`,
      [ORG_ID, rerun.id]
    );
    expect(rows[0]).toEqual({ total_bucket: 'CLAIMABLE', claimable_itc: PORTAL_TAX });
  }, 60000);

  it('reverses an accepted credit note in full when the portal shows less', async () => {
    // Kiran Systems C/1477: the portal's note is Rs 9 smaller than the books'.
    const page = await listResults(ORG_ID, run.id, { bucket: 'VALUE_MISMATCH', pageSize: 100 });
    const note = page.results.find((result) => result.books?.docType === 'CREDIT_NOTE' && result.deltaTotalTax < 0);
    expect(note.recommendedAction).toBe('ACCEPT');

    const before = (await getRun(ORG_ID, run.id)).totals;
    await confirmResult(ORG_ID, note.id, { confirmedAction: 'ACCEPT' });
    const after = (await getRun(ORG_ID, run.id)).totals;

    // The full books reversal, not the portal's smaller one.
    expect(after.claimableItc - before.claimableItc).toBe(-note.books.totalTax);
    expect(after.atRiskItc - before.atRiskItc).toBe(note.books.totalTax);
    expect(identityHolds(after)).toBe(true);
  });
});
