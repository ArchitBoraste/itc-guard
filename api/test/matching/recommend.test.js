import { describe, expect, it } from 'vitest';
import {
  FILING_SCHEMES,
  cutoffDate,
  daysToCutoff,
  filingWindow,
  gstr3bDueDate,
  inferFilingScheme,
  isBeforeCutoff,
  twoBGenerationDate
} from '../../src/matching/cutoff.js';
import { ACTIONS, itcAtRisk, recommendAction } from '../../src/matching/recommend.js';
import { BUCKETS } from '../../src/matching/buckets.js';

describe('filing calendar', () => {
  it('puts the cut-off on the 11th for monthly filers and the 13th for QRMP', () => {
    expect(cutoffDate('2026-02')).toBe('2026-03-11');
    expect(cutoffDate('2026-02', FILING_SCHEMES.MONTHLY)).toBe('2026-03-11');
    expect(cutoffDate('2026-02', FILING_SCHEMES.QRMP)).toBe('2026-03-13');
  });

  it('rolls into the next year correctly', () => {
    expect(cutoffDate('2026-12')).toBe('2027-01-11');
    expect(gstr3bDueDate('2026-12')).toBe('2027-01-20');
  });

  it('generates 2B on the 14th and dues GSTR-3B on the 20th', () => {
    expect(twoBGenerationDate('2026-02')).toBe('2026-03-14');
    expect(gstr3bDueDate('2026-02')).toBe('2026-03-20');
  });

  it('treats the cut-off day itself as still open', () => {
    expect(isBeforeCutoff('2026-03-10', '2026-02')).toBe(true);
    expect(isBeforeCutoff('2026-03-11', '2026-02')).toBe(true);
    expect(isBeforeCutoff('2026-03-12', '2026-02')).toBe(false);
    // A QRMP supplier still has two more days.
    expect(isBeforeCutoff('2026-03-12', '2026-02', FILING_SCHEMES.QRMP)).toBe(true);
  });

  it('counts days to the cut-off', () => {
    expect(daysToCutoff('2026-03-05', '2026-02')).toBe(6);
    expect(daysToCutoff('2026-03-16', '2026-02')).toBe(-5);
  });

  it('names the window the trader is in', () => {
    expect(filingWindow('2026-03-05', '2026-02')).toBe('PREVENTIVE');
    expect(filingWindow('2026-03-12', '2026-02')).toBe('CUTOFF_PASSED');
    expect(filingWindow('2026-03-16', '2026-02')).toBe('REACTIVE');
    expect(filingWindow('2026-03-21', '2026-02')).toBe('CLOSED');
  });
});

describe('inferFilingScheme', () => {
  it('defaults to monthly, with low confidence, when there is barely any history', () => {
    const inferred = inferFilingScheme([{ taxPeriod: '2026-02', filedOn: '2026-03-09' }]);
    expect(inferred.scheme).toBe(FILING_SCHEMES.MONTHLY);
    expect(inferred.confidence).toBe('LOW');
  });

  it('calls a supplier QRMP when only quarter-end periods ever appear', () => {
    const inferred = inferFilingScheme([
      { taxPeriod: '2025-12', filedOn: '2026-01-12' },
      { taxPeriod: '2026-03', filedOn: '2026-04-12' },
      { taxPeriod: '2026-06', filedOn: '2026-07-12' }
    ]);
    expect(inferred.scheme).toBe(FILING_SCHEMES.QRMP);
    expect(inferred.confidence).toBe('HIGH');
  });

  it('calls a supplier QRMP when every filing lands after the 11th but by the 13th', () => {
    const inferred = inferFilingScheme([
      { taxPeriod: '2026-01', filedOn: '2026-02-13' },
      { taxPeriod: '2026-02', filedOn: '2026-03-12' },
      { taxPeriod: '2026-03', filedOn: '2026-04-13' }
    ]);
    expect(inferred.scheme).toBe(FILING_SCHEMES.QRMP);
    expect(inferred.confidence).toBe('MEDIUM');
  });

  it('stays monthly for a supplier who reaches the 11th', () => {
    const inferred = inferFilingScheme([
      { taxPeriod: '2026-01', filedOn: '2026-02-08' },
      { taxPeriod: '2026-02', filedOn: '2026-03-10' },
      { taxPeriod: '2026-03', filedOn: '2026-04-06' }
    ]);
    expect(inferred.scheme).toBe(FILING_SCHEMES.MONTHLY);
  });

  it('does not mistake a habitually late monthly filer for QRMP', () => {
    // Filing on the 14th-15th is late, not quarterly. Calling this QRMP would tell
    // the trader they have more time than they do.
    const inferred = inferFilingScheme([
      { taxPeriod: '2026-01', filedOn: '2026-02-15' },
      { taxPeriod: '2026-02', filedOn: '2026-03-14' },
      { taxPeriod: '2026-03', filedOn: '2026-04-16' }
    ]);
    expect(inferred.scheme).toBe(FILING_SCHEMES.MONTHLY);
  });
});

// --- recommendations -------------------------------------------------------

function result(bucket, overrides = {}) {
  return {
    bucket,
    expected: { taxableValue: 10000000, totalTax: 1800000, taxPeriod: '2026-02' },
    portal: {
      taxableValue: 10000000,
      totalTax: 1800000,
      taxPeriod: '2026-02',
      filingStatus: 'FILED',
      imsAction: 'N',
      pendingBlocked: false,
      remarksBlocked: false,
      section: 'b2b',
      reverseCharge: false,
      itcAvailable: true
    },
    ...overrides
  };
}

const PRE_CUTOFF = { asOfDate: '2026-03-05', taxPeriod: '2026-02' };
const POST_CUTOFF = { asOfDate: '2026-03-16', taxPeriod: '2026-02' };

describe('recommendAction', () => {
  it('accepts a clean match', () => {
    const r = recommendAction(result(BUCKETS.MATCHED), PRE_CUTOFF);
    expect(r.action).toBe(ACTIONS.ACCEPT);
    expect(r.imsActionCode).toBe('A');
    expect(r.remarks).toBeNull();
    expect(r.requiresConfirmation).toBe(false);
  });

  it('sends a suggested match to a human', () => {
    const r = recommendAction(result(BUCKETS.SUGGESTED), PRE_CUTOFF);
    expect(r.action).toBe(ACTIONS.VERIFY);
    expect(r.requiresConfirmation).toBe(true);
  });

  it('chases the supplier for a value mismatch on a saved record before the cut-off', () => {
    // The golden window: the supplier can still edit the draft for free.
    const r = recommendAction(
      result(BUCKETS.VALUE_MISMATCH, {
        portal: { ...result(BUCKETS.VALUE_MISMATCH).portal, filingStatus: 'SAVED', totalTax: 1890000 }
      }),
      PRE_CUTOFF
    );
    expect(r.action).toBe(ACTIONS.CHASE_SUPPLIER);
    expect(r.reason).toMatch(/correct it for free/);
  });

  it('rejects a value mismatch on a filed record, and demands confirmation', () => {
    const r = recommendAction(
      result(BUCKETS.VALUE_MISMATCH, {
        portal: { ...result(BUCKETS.VALUE_MISMATCH).portal, totalTax: 1890000 }
      }),
      POST_CUTOFF
    );
    expect(r.action).toBe(ACTIONS.REJECT);
    expect(r.imsActionCode).toBe('R');
    expect(r.requiresConfirmation).toBe(true);
    expect(r.reason).toMatch(/GSTR-1A/);
    expect(r.remarks).toBeTruthy();
    expect(r.remarks.length).toBeLessThanOrEqual(250);
  });

  it('chases a missing record before the cut-off and defers it after', () => {
    const missing = result(BUCKETS.MISSING_IN_PORTAL, { portal: null });
    expect(recommendAction(missing, PRE_CUTOFF).action).toBe(ACTIONS.CHASE_SUPPLIER);

    const after = recommendAction(missing, POST_CUTOFF);
    expect(after.action).toBe(ACTIONS.DEFERRED);
    expect(after.reason).toMatch(/no IMS record exists/);
  });

  it('asks for verification of a record that is not in the books, never an auto-reject', () => {
    // This is precisely where a wrong reject does its damage.
    const r = recommendAction(result(BUCKETS.MISSING_IN_BOOKS, { expected: null }), POST_CUTOFF);
    expect(r.action).toBe(ACTIONS.VERIFY);
    expect(r.action).not.toBe(ACTIONS.REJECT);
  });

  it('leaves ineligible and non-IMS records alone', () => {
    const ineligible = recommendAction(
      result(BUCKETS.INELIGIBLE, {
        portal: { ...result(BUCKETS.INELIGIBLE).portal, itcAvailable: false, itcIneligibleReason: 'POS' }
      }),
      POST_CUTOFF
    );
    expect(ineligible.action).toBe(ACTIONS.NO_ACTION);
    expect(ineligible.reason).toMatch(/POS/);

    const rcm = recommendAction(
      result(BUCKETS.NON_IMS, {
        portal: { ...result(BUCKETS.NON_IMS).portal, reverseCharge: true }
      }),
      POST_CUTOFF
    );
    expect(rcm.action).toBe(ACTIONS.NO_ACTION);
    expect(rcm.reason).toMatch(/Reverse-charge/);

    for (const section of ['isd', 'impg']) {
      const r = recommendAction(
        result(BUCKETS.NON_IMS, { portal: { ...result(BUCKETS.NON_IMS).portal, section } }),
        POST_CUTOFF
      );
      expect(r.action).toBe(ACTIONS.NO_ACTION);
    }
  });

  it('drops remarks on a remarks-blocked record but keeps the action', () => {
    const r = recommendAction(
      result(BUCKETS.VALUE_MISMATCH, {
        portal: {
          ...result(BUCKETS.VALUE_MISMATCH).portal,
          totalTax: 1890000,
          remarksBlocked: true
        }
      }),
      POST_CUTOFF
    );
    expect(r.action).toBe(ACTIONS.REJECT);
    expect(r.remarks).toBeNull();
  });

  it('warns about deemed acceptance in the reactive window', () => {
    const r = recommendAction(result(BUCKETS.MATCHED), POST_CUTOFF);
    expect(r.reason).toMatch(/deemed accepted/);
  });

  it('gives a timing-independent answer when no as-of date is supplied', () => {
    const missing = result(BUCKETS.MISSING_IN_PORTAL, { portal: null });
    const r = recommendAction(missing, {});
    expect(r.action).toBe(ACTIONS.CHASE_SUPPLIER);
    expect(r.preCutOff).toBeNull();
  });
});

describe('itcAtRisk', () => {
  it('prices each bucket by what going wrong would cost', () => {
    expect(itcAtRisk(result(BUCKETS.MATCHED))).toBe(0);
    expect(itcAtRisk(result(BUCKETS.NON_IMS))).toBe(0);
    expect(itcAtRisk(result(BUCKETS.INELIGIBLE))).toBe(0);
    // Credit expected and not received.
    expect(itcAtRisk(result(BUCKETS.MISSING_IN_PORTAL, { portal: null }))).toBe(1800000);
    // Credit that doing nothing would wrongly claim.
    expect(itcAtRisk(result(BUCKETS.MISSING_IN_BOOKS, { expected: null }))).toBe(1800000);
    // Only the difference is at stake.
    expect(
      itcAtRisk(
        result(BUCKETS.VALUE_MISMATCH, {
          portal: { ...result(BUCKETS.VALUE_MISMATCH).portal, totalTax: 1890000 }
        })
      )
    ).toBe(90000);
  });
});

// The bug: every VALUE_MISMATCH sentence was built from the TAX delta alone. A
// mismatch that lived purely in the taxable value — same tax on both sides, which
// is what a mistyped base plus the same rate arithmetic produces — was explained
// as "Portal tax is Rs. 0.00 lower than books", and the remark uploaded to GSTN
// read "books tax differs from portal by Rs. 0.00".
//
// Seen on Mahavir Sales Corp 06-17/AMD/3538, April 2026. The bucket was right;
// only the words were wrong. A rejection filed with a stated reason of zero
// rupees is a rejection with no stated reason at all.
describe('a value mismatch is explained by the amounts that actually differ', () => {
  // Books figures from the reported row, in paise.
  const BOOKS = { taxableValue: 71791500, totalTax: 12103345 };

  const mismatch = (portalAmounts, overrides = {}) =>
    recommendAction(
      {
        bucket: BUCKETS.VALUE_MISMATCH,
        expected: { ...BOOKS, taxPeriod: '2026-02' },
        portal: {
          ...result(BUCKETS.VALUE_MISMATCH).portal,
          ...portalAmounts,
          ...overrides
        }
      },
      POST_CUTOFF
    );

  // Every amount this suite renders, so "never mentions a zero" is checked against
  // the actual output rather than one hand-picked substring.
  const amountsIn = (text) => [...String(text).matchAll(/(?:₹|Rs\.\s?)([\d,]+\.\d{2})/g)]
    .map((match) => Number(match[1].replace(/,/g, '')));

  it('names the taxable value when only the taxable value differs', () => {
    // The reported row: taxable differs by Rs. 5,000, tax identical on both sides.
    const r = mismatch({ taxableValue: 71291500, totalTax: BOOKS.totalTax });

    expect(r.action).toBe(ACTIONS.REJECT);
    expect(r.reason).toMatch(/taxable value/);
    expect(r.reason).toContain('₹5,000.00');
    // The old sentence, and the thing that must never come back.
    expect(r.reason).not.toMatch(/tax is ₹0\.00/);
    expect(amountsIn(r.reason)).not.toContain(0);

    // The remark names the field and both sides of it, because the supplier
    // reading it has to know which figure to correct.
    expect(r.remarks).toContain('taxable value');
    expect(r.remarks).toContain('Rs. 7,12,915.00');
    expect(r.remarks).toContain('Rs. 7,17,915.00');
    expect(amountsIn(r.remarks)).not.toContain(0);
    // Tax agrees, so the remark must not claim anything about it. Field clauses
    // are "<label> Rs. <portal> on portal vs ...", so a tax clause would read
    // "tax Rs.".
    expect(r.remarks).not.toContain('tax Rs.');
  });

  it('names the tax when only the tax differs', () => {
    const r = mismatch({ taxableValue: BOOKS.taxableValue, totalTax: 12013345 });

    expect(r.reason).toMatch(/Portal tax is ₹900\.00 lower/);
    expect(r.reason).not.toMatch(/taxable value/);
    expect(amountsIn(r.reason)).not.toContain(0);

    expect(r.remarks).toContain('tax Rs. 1,20,133.45 on portal');
    expect(r.remarks).toContain('Rs. 1,21,033.45 in books');
    expect(r.remarks).not.toContain('taxable value');
    expect(amountsIn(r.remarks)).not.toContain(0);
  });

  it('names both when both differ', () => {
    const r = mismatch({ taxableValue: 71291500, totalTax: 12013345 });

    expect(r.reason).toMatch(/taxable value is ₹5,000\.00 lower/);
    expect(r.reason).toMatch(/tax is ₹900\.00 lower/);
    expect(amountsIn(r.reason)).toEqual([500000 / 100, 90000 / 100]);

    expect(r.remarks).toContain('taxable value Rs. 7,12,915.00 on portal');
    expect(r.remarks).toContain('tax Rs. 1,20,133.45 on portal');
    expect(amountsIn(r.remarks)).not.toContain(0);
    expect(r.remarks.length).toBeLessThanOrEqual(250);
  });

  it('gets the direction right when the portal reports more, not less', () => {
    const r = mismatch({ taxableValue: 72291500, totalTax: BOOKS.totalTax });
    expect(r.reason).toMatch(/taxable value is ₹5,000\.00 higher/);
    expect(amountsIn(r.reason)).not.toContain(0);
  });

  it('explains a saved-record mismatch by the same fields', () => {
    // The pre-cut-off branch had its own copy of the same broken sentence.
    const r = recommendAction(
      {
        bucket: BUCKETS.VALUE_MISMATCH,
        expected: { ...BOOKS, taxPeriod: '2026-02' },
        portal: {
          ...result(BUCKETS.VALUE_MISMATCH).portal,
          taxableValue: 71291500,
          totalTax: BOOKS.totalTax,
          filingStatus: 'SAVED'
        }
      },
      PRE_CUTOFF
    );
    expect(r.action).toBe(ACTIONS.CHASE_SUPPLIER);
    expect(r.reason).toMatch(/taxable value is ₹5,000\.00 lower/);
    expect(r.reason).toMatch(/correct it for free/);
    expect(amountsIn(r.reason)).not.toContain(0);
  });

  it('quotes no figure at all rather than a zero when nothing measurably differs', () => {
    // Only reachable by classifying on one tolerance and explaining on another.
    // The honest answer names no amount; it must never fall back to Rs. 0.00.
    const r = mismatch({ ...BOOKS });
    expect(r.reason).toMatch(/disagree on the amount/);
    expect(r.reason).not.toMatch(/0\.00/);
    expect(r.remarks).toBe('Value mismatch between books and portal.');
  });

  it('ignores a sub-tolerance rounding gap the bucket would also ignore', () => {
    // 50 paise is inside the Rs. 1 tolerance classify() uses, so naming it would
    // explain the row by a difference that did not cause it.
    const r = mismatch({ taxableValue: BOOKS.taxableValue + 50, totalTax: 12013345 });
    expect(r.reason).not.toMatch(/taxable value/);
    expect(r.reason).toMatch(/tax is ₹900\.00 lower/);
  });

  it('keeps the remark ASCII, because it is uploaded to the portal', () => {
    // The schema documents 250 chars and says nothing about the character set.
    // A rupee sign the offline utility refuses fails the WHOLE upload, not just
    // this record, so it is not worth sending to save two characters.
    for (const portalAmounts of [
      { taxableValue: 71291500, totalTax: BOOKS.totalTax },
      { taxableValue: BOOKS.taxableValue, totalTax: 12013345 },
      { taxableValue: 71291500, totalTax: 12013345 }
    ]) {
      const { remarks } = mismatch(portalAmounts);
      expect(remarks).toMatch(/^[ -~]*$/);
      expect(remarks).toContain('Rs.');
      expect(remarks).not.toContain('₹');
    }
  });
});
