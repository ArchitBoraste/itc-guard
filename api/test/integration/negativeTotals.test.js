// A negative run total is correct arithmetic that reads like a bug.
//
// 2026-04 deferred comes out at -Rs 5,577.37, and that figure is worse than
// merely surprising: it is a NET of two unreported documents pulling opposite
// ways, so it describes neither of them.
//
//   unreported credit note   -Rs 28,427.65   a reduction the portal has not applied
//   unreported invoice       +Rs 22,850.28   credit that is not arriving
//   -----------------------------------------
//   net                       -Rs 5,577.37   the number a dashboard would show
//
// Both documents are real problems worth ~Rs 25,000 between them, and the headline
// hides both behind a small negative. Worse, a small negative invites someone to
// hunt for a sign error and eventually "fix" it with an absolute value, which
// would inflate claimable ITC.
//
// So the API has to expose the components, not just the net.
//
// Owns org 4.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { createRun, getRun, listResults } from '../../src/services/reconcile.js';
import {
  TEST_ORGS,
  ensureOrg,
  ingestPeriod,
  requireDatabase,
  resetOrg
} from '../helpers/db.js';
import { FIXTURES_PRESENT } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.negativeTotals;
const TRADER_GSTIN = '27AABCS1429F4Z5';
// The period whose deferred total is negative.
const PERIOD = '2026-04';
// Past the 11th cut-off, so an unreported document is DEFERRED rather than at risk.
const AS_OF = '2026-05-16';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

describe('a negative total is explicable, not just negative', () => {
  let run;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);
    await ingestPeriod(ORG_ID, PERIOD);
    run = await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });
    run = await getRun(ORG_ID, run.id);
  }, 180000);

  afterAll(async () => {
    await closePool();
  });

  it('produces the negative deferred total this suite exists for', () => {
    expect(run.totals.deferredItc).toBeLessThan(0);
    // Guard the specific figure so a silent sign regression is visible.
    expect(run.totals.deferredItc).toBe(-557737);
  });

  it('separates the net into the documents behind it', () => {
    const deferred = run.totalsBreakdown.DEFERRED;
    expect(deferred).toBeTruthy();
    expect(deferred.itc).toBe(run.totals.deferredItc);

    // The headline figure is a NET of two unreported documents pulling opposite
    // ways, so on its own it describes neither of them:
    //   an unreported credit note   -Rs 28,427.65  reduction not yet applied
    //   an unreported invoice       +Rs 22,850.28  credit not arriving
    //   net                          -Rs 5,577.37  meaningless as a headline
    expect(deferred.creditNotes.count).toBeGreaterThan(0);
    expect(deferred.creditNotes.itc).toBeLessThan(0);
    expect(deferred.otherDocuments.count).toBeGreaterThan(0);
    expect(deferred.otherDocuments.itc).toBeGreaterThan(0);

    // Both components are recoverable, and they reconstruct the net exactly.
    expect(deferred.creditNotes.itc + deferred.otherDocuments.itc).toBe(deferred.itc);
    expect(deferred.byDocType.CREDIT_NOTE.itc).toBe(deferred.creditNotes.itc);

    // The net is NOT either component, which is exactly why the bare number
    // cannot be rendered on its own.
    expect(deferred.itc).not.toBe(deferred.creditNotes.itc);
    expect(deferred.itc).not.toBe(deferred.otherDocuments.itc);
    expect(Math.abs(deferred.creditNotes.itc)).toBeGreaterThan(Math.abs(deferred.itc));
  });

  it('exposes the underlying document so the UI can name it', async () => {
    const page = await listResults(ORG_ID, run.id, { bucket: 'MISSING_IN_PORTAL', pageSize: 50 });
    const deferredRows = page.results.filter((row) => row.totalBucket === 'DEFERRED');
    const deferredNotes = deferredRows.filter((row) => row.books?.docType === 'CREDIT_NOTE');
    expect(deferredNotes.length).toBe(run.totalsBreakdown.DEFERRED.creditNotes.count);
    expect(deferredRows.length).toBe(run.totalsBreakdown.DEFERRED.count);

    for (const note of deferredNotes) {
      // Everything a "1 unreported credit note, Rs 5,577.37 not yet reduced" card
      // needs: who, which document, how much, and why nothing can be done.
      expect(note.books.supplierName).toBeTruthy();
      expect(note.books.invoiceNo).toBeTruthy();
      expect(note.books.docType).toBe('CREDIT_NOTE');
      expect(note.signedItc).toBeLessThan(0);
      expect(note.portal).toBeNull();
      expect(note.recommendedAction).toBe('DEFERRED');
      expect(note.recommendationReason).toMatch(/no IMS record exists/i);
    }

    // Credit notes alone account for the credit-note component...
    expect(deferredNotes.reduce((sum, note) => sum + note.signedItc, 0)).toBe(
      run.totalsBreakdown.DEFERRED.creditNotes.itc
    );
    // ...and every deferred row together accounts for the net.
    expect(deferredRows.reduce((sum, row) => sum + row.signedItc, 0)).toBe(
      run.totals.deferredItc
    );
  });

  it('keeps the breakdown consistent with every stored total', () => {
    // The breakdown is a second view of the same money; if the two disagree the
    // UI would show one number in the header and another in the detail.
    const map = {
      CLAIMABLE: run.totals.claimableItc,
      AT_RISK: run.totals.atRiskItc,
      DEFERRED: run.totals.deferredItc,
      INELIGIBLE: run.totals.ineligibleItc,
      NON_IMS: run.totals.nonImsItc
    };
    for (const [bucket, total] of Object.entries(map)) {
      const entry = run.totalsBreakdown[bucket];
      if (!entry) {
        expect(total).toBe(0);
        continue;
      }
      expect(entry.itc).toBe(total);
      expect(entry.creditNotes.itc + entry.otherDocuments.itc).toBe(entry.itc);
      expect(entry.creditNotes.count + entry.otherDocuments.count).toBe(entry.count);
    }
  });

  it('the identity still holds with a negative component', () => {
    // A negative term must not be special-cased out of the balance.
    const t = run.totals;
    expect(t.claimableItc + t.atRiskItc + t.deferredItc + t.ineligibleItc).toBe(
      t.expectedTotalItc
    );
    expect(t.expectedTotalItc + t.nonImsItc).toBe(t.grandTotalItc);
  });

  it('credit notes reduce claimable ITC in this period too', async () => {
    // The same sign rule, in the bucket that actually carries most of the money.
    const claimable = run.totalsBreakdown.CLAIMABLE;
    expect(claimable.creditNotes.count).toBeGreaterThan(0);
    expect(claimable.creditNotes.itc).toBeLessThan(0);
    expect(claimable.itc).toBe(claimable.otherDocuments.itc + claimable.creditNotes.itc);
    // Ignoring the sign would overstate the claim by twice the note total.
    expect(claimable.itc).toBeLessThan(claimable.otherDocuments.itc);
  });

  it('stores every total as an integer number of paise', async () => {
    for (const value of Object.values(run.totals)) expect(Number.isInteger(value)).toBe(true);
    const [rows] = await pool.query(
      'SELECT deferred_itc FROM runs WHERE org_id = ? AND id = ?',
      [ORG_ID, run.id]
    );
    // BIGINT holds the sign; nothing is stored as an unsigned magnitude.
    expect(Number(rows[0].deferred_itc)).toBe(run.totals.deferredItc);
  });
});
