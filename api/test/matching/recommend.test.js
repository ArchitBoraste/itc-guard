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
import {
  ACTIONS,
  DEFAULT_MATERIALITY_TOLERANCE_PAISE,
  MISMATCH_RULES,
  formatPaise,
  itcAtRisk,
  recommendAction
} from '../../src/matching/recommend.js';
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

  it('assumes monthly for a supplier who reaches the 11th, and says it is an assumption', () => {
    // Filing by the 11th is not evidence of a monthly scheme: a QRMP supplier
    // using IFF who files early looks exactly the same (audit P9). Low confidence
    // is what makes the screens say "assumed".
    const inferred = inferFilingScheme([
      { taxPeriod: '2026-01', filedOn: '2026-02-08' },
      { taxPeriod: '2026-02', filedOn: '2026-03-10' },
      { taxPeriod: '2026-03', filedOn: '2026-04-06' }
    ]);
    expect(inferred.scheme).toBe(FILING_SCHEMES.MONTHLY);
    expect(inferred.confidence).toBe('LOW');
    expect(inferred.reason).toMatch(/^assumed monthly/);
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

  it('rejects a record that is not in the books, once a human has verified it', () => {
    // Left alone it is deemed accepted: credit for a purchase the books never saw.
    // A wrong reject does its damage here too, so it is never applied unconfirmed.
    const r = recommendAction(result(BUCKETS.MISSING_IN_BOOKS, { expected: null }), POST_CUTOFF);
    expect(r.action).toBe(ACTIONS.REJECT);
    expect(r.imsActionCode).toBe('R');
    expect(r.requiresConfirmation).toBe(true);
    expect(r.reason).toMatch(/Verify no goods or invoice were received, then reject/);
    expect(r.remarks).toBe('Not in our purchase register: no goods or document received against this record.');
    expect(r.remarks).toMatch(/^[ -~]*$/);
  });

  it('drops the phantom remark where the portal blocks remarks', () => {
    const r = recommendAction(
      result(BUCKETS.MISSING_IN_BOOKS, {
        expected: null,
        portal: { ...result(BUCKETS.MISSING_IN_BOOKS).portal, remarksBlocked: true }
      }),
      POST_CUTOFF
    );
    expect(r.action).toBe(ACTIONS.REJECT);
    expect(r.remarks).toBeNull();
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

  const mismatch = (portalAmounts, overrides = {}, context = POST_CUTOFF) =>
    recommendAction(
      {
        bucket: BUCKETS.VALUE_MISMATCH,
        expected: { ...BOOKS, docType: 'INVOICE', taxPeriod: '2026-02' },
        portal: {
          ...result(BUCKETS.VALUE_MISMATCH).portal,
          ...portalAmounts,
          ...overrides
        }
      },
      context
    );

  // Every amount this suite renders, so "never mentions a zero" is checked against
  // the actual output rather than one hand-picked substring.
  const amountsIn = (text) => [...String(text).matchAll(/(?:₹|Rs\.\s?)([\d,]+\.\d{2})/g)]
    .map((match) => Number(match[1].replace(/,/g, '')));

  it('names the taxable value when only the taxable value differs', () => {
    // The reported row: taxable differs by Rs. 5,000, tax identical on both sides.
    // The credit is the same either way, so it is accepted — but the sentence
    // still has to name the field that put it here, never "tax is Rs. 0.00".
    const r = mismatch({ taxableValue: 71291500, totalTax: BOOKS.totalTax });

    expect(r.action).toBe(ACTIONS.ACCEPT);
    expect(r.reason).toMatch(/taxable value/);
    expect(r.reason).toContain('₹5,000.00');
    expect(r.reason).not.toMatch(/tax is ₹0\.00/);
    expect(amountsIn(r.reason)).not.toContain(0);
    expect(r.remarks).toBeNull();
  });

  it('names the tax when only the tax differs', () => {
    const r = mismatch({ taxableValue: BOOKS.taxableValue, totalTax: 12193345 });

    expect(r.reason).toMatch(/the portal's tax is ₹900\.00 higher/);
    expect(r.reason).not.toMatch(/taxable value/);
    expect(amountsIn(r.reason)).not.toContain(0);

    // The remark names the field and both sides of it, because the supplier
    // reading it has to know which figure to correct.
    expect(r.remarks).toContain('tax Rs. 1,21,933.45 vs Rs. 1,21,033.45 (Rs. 900.00 higher)');
    expect(r.remarks).not.toContain('taxable value');
    expect(amountsIn(r.remarks)).not.toContain(0);
  });

  it('names both when both differ', () => {
    const r = mismatch({ taxableValue: 72291500, totalTax: 12193345 });

    expect(r.reason).toMatch(/taxable value is ₹5,000\.00 higher/);
    expect(r.reason).toMatch(/tax is ₹900\.00 higher/);

    expect(r.remarks).toContain('taxable value Rs. 7,22,915.00 vs Rs. 7,17,915.00 (Rs. 5,000.00 higher)');
    expect(r.remarks).toContain('tax Rs. 1,21,933.45 vs Rs. 1,21,033.45 (Rs. 900.00 higher)');
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
    const r = mismatch(
      { taxableValue: 71291500, totalTax: 12013345 },
      { filingStatus: 'SAVED' },
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
    expect(r.remarks).toBeNull();

    // Rejected on a gap the bucket's own tolerance does not measure: the remark
    // states the document and the fix, and no figure.
    const rejected = recommendAction(
      {
        bucket: BUCKETS.VALUE_MISMATCH,
        expected: { ...BOOKS, docType: 'INVOICE', taxPeriod: '2026-02' },
        portal: { ...result(BUCKETS.VALUE_MISMATCH).portal, ...BOOKS, totalTax: BOOKS.totalTax + 300 }
      },
      { ...POST_CUTOFF, tolerancePaise: 500 }
    );
    expect(rejected.action).toBe(ACTIONS.REJECT);
    expect(rejected.remarks).toBe('Invoice mismatch, portal vs our books. Please correct via GSTR-1A.');
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
      { taxableValue: 72291500, totalTax: BOOKS.totalTax + 500 },
      { taxableValue: BOOKS.taxableValue, totalTax: 12193345 },
      { taxableValue: 72291500, totalTax: 12193345 }
    ]) {
      const { remarks } = mismatch(portalAmounts);
      expect(remarks).toMatch(/^[ -~]*$/);
      expect(remarks).toContain('Rs.');
      expect(remarks).not.toContain('₹');
    }
  });
});

// The rule table (audit brief, rule 8), one row at a time. Fixed at the 16th:
// past every supplier's cut-off, where the brief's verdicts were taken.
describe('value-mismatch rule table', () => {
  const BOOKS_TAX = 1800000;

  const verdict = ({ docType = 'INVOICE', taxGap, filingStatus = 'FILED', context = POST_CUTOFF }) =>
    recommendAction(
      {
        bucket: BUCKETS.VALUE_MISMATCH,
        expected: { taxableValue: 10000000, totalTax: BOOKS_TAX, docType, taxPeriod: '2026-02' },
        portal: {
          ...result(BUCKETS.VALUE_MISMATCH).portal,
          docType,
          filingStatus,
          // Taxable moves with the tax, as a mistyped base does.
          taxableValue: 10000000 + taxGap * 5,
          totalTax: BOOKS_TAX + taxGap
        }
      },
      context
    );

  it('has exactly the four rows the brief describes, in order', () => {
    expect(MISMATCH_RULES.map((row) => [row.rule, row.action])).toEqual([
      ['WITHIN_TOLERANCE', ACTIONS.ACCEPT],
      ['SAVED_BEFORE_CUTOFF', ACTIONS.CHASE_SUPPLIER],
      ['PORTAL_LOWER', ACTIONS.ACCEPT],
      ['PORTAL_HIGHER', ACTIONS.REJECT]
    ]);
  });

  describe('within tolerance', () => {
    it('accepts either direction and says the gap is within tolerance', () => {
      for (const [taxGap, word] of [[-90, 'lower'], [90, 'higher'], [100, 'higher']]) {
        const r = verdict({ taxGap });
        expect(r.action).toBe(ACTIONS.ACCEPT);
        expect(r.reason).toContain(`The tax is ₹${(Math.abs(taxGap) / 100).toFixed(2)} ${word}, within the ₹1.00 tolerance`);
        expect(r.remarks).toBeNull();
      }
    });

    it('applies to every document type and filing state', () => {
      for (const docType of ['INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE']) {
        expect(verdict({ docType, taxGap: 100 }).action).toBe(ACTIONS.ACCEPT);
      }
      expect(verdict({ taxGap: -50, filingStatus: 'SAVED', context: PRE_CUTOFF }).action).toBe(ACTIONS.ACCEPT);
    });

    it('is configurable, and the brief\'s smallest reject sits just outside the default', () => {
      // Fortune Hardware A/2010: portal Rs. 1.35 higher, which the brief rejects.
      expect(verdict({ taxGap: 135 }).action).toBe(ACTIONS.REJECT);
      expect(
        verdict({ taxGap: 135, context: { ...POST_CUTOFF, materialityTolerancePaise: 135 } }).action
      ).toBe(ACTIONS.ACCEPT);
      // Zero tolerance still accepts a lower portal figure on the direction rule.
      expect(
        verdict({ taxGap: -90, context: { ...POST_CUTOFF, materialityTolerancePaise: 0 } }).reason
      ).toMatch(/chase the supplier for the ₹0\.90 difference/);
      expect(DEFAULT_MATERIALITY_TOLERANCE_PAISE).toBe(100);
    });
  });

  describe('saved, on or before the cut-off', () => {
    it('chases the supplier, whichever way the amounts differ', () => {
      for (const taxGap of [-90000, 90000]) {
        const r = verdict({ taxGap, filingStatus: 'SAVED', context: PRE_CUTOFF });
        expect(r.action).toBe(ACTIONS.CHASE_SUPPLIER);
        expect(r.imsActionCode).toBeNull();
        expect(r.reason).toMatch(/correct it for free before the cut-off/);
      }
    });

    it('falls through to the direction rule once the cut-off has passed', () => {
      expect(verdict({ taxGap: -90000, filingStatus: 'SAVED' }).action).toBe(ACTIONS.ACCEPT);
      const higher = verdict({ taxGap: 90000, filingStatus: 'SAVED' });
      expect(higher.action).toBe(ACTIONS.REJECT);
      // Not filed, so the fix is to the draft, not a GSTR-1A amendment.
      expect(higher.reason).toMatch(/correct the saved record before filing/);
      expect(higher.remarks).toMatch(/Please correct before filing\.$/);
    });
  });

  describe('invoice and debit note', () => {
    for (const [docType, label] of [['INVOICE', 'invoice'], ['DEBIT_NOTE', 'debit note']]) {
      it(`${label}, portal lower: accepts the portal amount and names the difference to chase`, () => {
        const r = verdict({ docType, taxGap: -84296 });
        expect(r.action).toBe(ACTIONS.ACCEPT);
        expect(r.imsActionCode).toBe('A');
        expect(r.reason).toContain(`On this ${label} the portal's`);
        expect(r.reason).toContain('tax is ₹842.96 lower');
        expect(r.reason).toContain("Accept the portal's ₹17,157.04 now and chase the supplier for the ₹842.96 difference.");
        expect(r.remarks).toBeNull();
        expect(r.requiresConfirmation).toBe(true);
      });

      it(`${label}, portal higher: rejects, and the remark says by how much`, () => {
        const r = verdict({ docType, taxGap: 225 });
        expect(r.action).toBe(ACTIONS.REJECT);
        expect(r.imsActionCode).toBe('R');
        expect(r.reason).toContain(`tax is ₹2.25 higher`);
        expect(r.reason).toContain(`accepting would claim ₹2.25 more credit than the ${label} carries`);
        expect(r.reason).toMatch(/GSTR-1A; the corrected credit arrives next period/);
        expect(r.remarks).toContain(`${label[0].toUpperCase()}${label.slice(1)} mismatch, portal vs our books`);
        expect(r.remarks).toContain('tax Rs. 18,002.25 vs Rs. 18,000.00 (Rs. 2.25 higher)');
        expect(r.remarks).toMatch(/Please correct via GSTR-1A\.$/);
      });
    }
  });

  describe('credit note', () => {
    it('portal lower: accepts, because the books reversal stands either way', () => {
      // Kiran Systems C/1477 (April): portal Rs. 9 lower on the note.
      const r = verdict({ docType: 'CREDIT_NOTE', taxGap: -900 });
      expect(r.action).toBe(ACTIONS.ACCEPT);
      expect(r.reason).toContain('On this credit note the portal\'s');
      expect(r.reason).toContain('tax is ₹9.00 lower');
      expect(r.reason).toContain('your books still reverse the full ₹18,000.00');
      // A note carries no credit to wait for.
      expect(r.reason).not.toMatch(/arrives|next period/);
      expect(r.remarks).toBeNull();
    });

    it('portal higher: rejects, because accepting reverses more than the books owe', () => {
      // National Supply Co Z3221 (February).
      const r = verdict({ docType: 'CREDIT_NOTE', taxGap: 756000 });
      expect(r.action).toBe(ACTIONS.REJECT);
      expect(r.reason).toContain('accepting would reverse ₹7,560.00 more credit than your books owe');
      expect(r.reason).not.toMatch(/arrives|next period/);
      expect(r.remarks).toContain('Credit note mismatch, portal vs our books');
      expect(r.remarks).toContain('(Rs. 7,560.00 higher)');
    });
  });

  it('keeps the longest remark it can build within 250 characters', () => {
    // Two fields, crore-scale figures, a debit note and the saved-record fix:
    // the widest every part of the remark can be at once.
    const r = recommendAction(
      {
        bucket: BUCKETS.VALUE_MISMATCH,
        expected: { taxableValue: 99999999999, totalTax: 17999999999, docType: 'DEBIT_NOTE', taxPeriod: '2026-02' },
        portal: {
          ...result(BUCKETS.VALUE_MISMATCH).portal,
          filingStatus: 'SAVED',
          taxableValue: 199999999999,
          totalTax: 35999999999
        }
      },
      POST_CUTOFF
    );
    expect(r.action).toBe(ACTIONS.REJECT);
    expect(r.remarks.length).toBeLessThanOrEqual(250);
    // Complete, not truncated mid-figure.
    expect(r.remarks).toMatch(/Please correct before filing\.$/);
    expect(r.remarks).toMatch(/^[ -~]*$/);
  });
});

describe('formatPaise', () => {
  it('groups rupees the Indian way from integer paise', () => {
    expect(formatPaise(0)).toBe('0.00');
    expect(formatPaise(5)).toBe('0.05');
    expect(formatPaise(84296)).toBe('842.96');
    expect(formatPaise(100000)).toBe('1,000.00');
    expect(formatPaise(12019049)).toBe('1,20,190.49');
    expect(formatPaise(7129150000)).toBe('7,12,91,500.00');
    expect(formatPaise(-557737)).toBe('-5,577.37');
  });
});
