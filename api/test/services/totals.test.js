import { describe, expect, it } from 'vitest';
import {
  TOTAL_BUCKETS,
  acceptedItc,
  allocate,
  assertTotalsBalance,
  computeRunTotals,
  itcSign,
  resultItc,
  signedTax,
  sumAllocations,
  totalBucketFor
} from '../../src/services/totals.js';
import { BUCKETS } from '../../src/matching/buckets.js';

function result(bucket, overrides = {}) {
  return {
    bucket,
    expected: { docType: 'INVOICE', totalTax: 1800000, supplierGstin: 'G1', taxPeriod: '2026-02' },
    portal: { docType: 'INVOICE', totalTax: 1800000, supplierGstin: 'G1', taxPeriod: '2026-02' },
    ...overrides
  };
}

describe('sign handling', () => {
  it('makes credit notes negative and everything else positive', () => {
    expect(itcSign('INVOICE')).toBe(1);
    expect(itcSign('DEBIT_NOTE')).toBe(1);
    expect(itcSign('CREDIT_NOTE')).toBe(-1);
    expect(itcSign('ISD_INVOICE')).toBe(1);
    expect(itcSign('ISD_CREDIT')).toBe(-1);
    expect(itcSign('BOE')).toBe(1);
  });

  it('subtracts a credit note even though the source reports it positive', () => {
    // Both the register templates and the portal JSON carry note amounts as
    // positive numbers. Adding one inflates claimable ITC and nothing looks wrong.
    expect(signedTax({ docType: 'CREDIT_NOTE', totalTax: 500000 })).toBe(-500000);
    expect(signedTax({ docType: 'DEBIT_NOTE', totalTax: 500000 })).toBe(500000);
    expect(signedTax({ docType: 'INVOICE', totalTax: 500000 })).toBe(500000);
    expect(signedTax(null)).toBe(0);
  });

  it('takes the books side when present and the portal side otherwise', () => {
    expect(resultItc(result(BUCKETS.MATCHED))).toBe(1800000);
    // A phantom in 2B is credit in play whether the trader asked for it or not.
    expect(resultItc(result(BUCKETS.MISSING_IN_BOOKS, { expected: null }))).toBe(1800000);
    expect(resultItc(result(BUCKETS.MISSING_IN_PORTAL, { portal: null }))).toBe(1800000);
  });

  it('keeps the sign when only the portal side exists', () => {
    const phantomNote = result(BUCKETS.MISSING_IN_BOOKS, {
      expected: null,
      portal: { docType: 'CREDIT_NOTE', totalTax: 500000 }
    });
    expect(resultItc(phantomNote)).toBe(-500000);
  });
});

describe('bucket -> total mapping', () => {
  const preCutOff = { asOfDate: '2026-03-05', taxPeriod: '2026-02' };
  const postCutOff = { asOfDate: '2026-03-16', taxPeriod: '2026-02' };

  it('puts MATCHED in claimable', () => {
    expect(totalBucketFor(result(BUCKETS.MATCHED), postCutOff)).toBe(TOTAL_BUCKETS.CLAIMABLE);
  });

  it('holds SUGGESTED at risk until a human confirms it', () => {
    expect(totalBucketFor(result(BUCKETS.SUGGESTED), postCutOff)).toBe(TOTAL_BUCKETS.AT_RISK);
    expect(
      totalBucketFor(result(BUCKETS.SUGGESTED, { confirmedAction: 'ACCEPT' }), postCutOff)
    ).toBe(TOTAL_BUCKETS.CLAIMABLE);
  });

  it('drops a matched record out of claimable when a human rejects it', () => {
    expect(
      totalBucketFor(result(BUCKETS.MATCHED, { confirmedAction: 'REJECT' }), postCutOff)
    ).toBe(TOTAL_BUCKETS.AT_RISK);
  });

  it('puts value mismatches and phantoms at risk', () => {
    expect(totalBucketFor(result(BUCKETS.VALUE_MISMATCH), postCutOff)).toBe(TOTAL_BUCKETS.AT_RISK);
    expect(totalBucketFor(result(BUCKETS.MISSING_IN_BOOKS), postCutOff)).toBe(
      TOTAL_BUCKETS.AT_RISK
    );
  });

  it('moves a missing record from at-risk to deferred at the cut-off', () => {
    const missing = result(BUCKETS.MISSING_IN_PORTAL, { portal: null });
    // Still chaseable today.
    expect(totalBucketFor(missing, preCutOff)).toBe(TOTAL_BUCKETS.AT_RISK);
    // No IMS record exists to act on any more.
    expect(totalBucketFor(missing, postCutOff)).toBe(TOTAL_BUCKETS.DEFERRED);
  });

  it('uses the supplier’s own cut-off, not a global one', () => {
    const missing = result(BUCKETS.MISSING_IN_PORTAL, { portal: null });
    const onThe12th = { asOfDate: '2026-03-12', taxPeriod: '2026-02' };
    // A monthly filer was due on the 11th, so this is already late.
    expect(totalBucketFor(missing, onThe12th)).toBe(TOTAL_BUCKETS.DEFERRED);
    // A QRMP supplier has until the 13th and is still chaseable.
    expect(
      totalBucketFor(missing, { ...onThe12th, schemeFor: () => 'QRMP' })
    ).toBe(TOTAL_BUCKETS.AT_RISK);
  });

  it('settles ineligible and non-IMS by what they are', () => {
    expect(totalBucketFor(result(BUCKETS.INELIGIBLE), postCutOff)).toBe(TOTAL_BUCKETS.INELIGIBLE);
    expect(totalBucketFor(result(BUCKETS.NON_IMS), postCutOff)).toBe(TOTAL_BUCKETS.NON_IMS);
    // Even a confirmation cannot make ineligible credit claimable.
    expect(
      totalBucketFor(result(BUCKETS.INELIGIBLE, { confirmedAction: 'ACCEPT' }), postCutOff)
    ).toBe(TOTAL_BUCKETS.INELIGIBLE);
  });

  it('treats nothing as provably late without an as-of date', () => {
    const missing = result(BUCKETS.MISSING_IN_PORTAL, { portal: null });
    expect(totalBucketFor(missing, {})).toBe(TOTAL_BUCKETS.AT_RISK);
  });
});

describe('computeRunTotals', () => {
  const context = { asOfDate: '2026-03-16', taxPeriod: '2026-02' };

  it('balances the identity exactly, in integer paise', () => {
    const totals = computeRunTotals(
      [
        result(BUCKETS.MATCHED),
        result(BUCKETS.VALUE_MISMATCH, {
          portal: { docType: 'INVOICE', totalTax: 1890000, taxPeriod: '2026-02' }
        }),
        result(BUCKETS.MISSING_IN_PORTAL, { portal: null }),
        result(BUCKETS.MISSING_IN_BOOKS, { expected: null }),
        result(BUCKETS.INELIGIBLE),
        result(BUCKETS.NON_IMS),
        result(BUCKETS.SUGGESTED)
      ],
      context
    );

    expect(
      totals.claimableItc + totals.atRiskItc + totals.deferredItc + totals.ineligibleItc
    ).toBe(totals.expectedTotalItc);
    expect(totals.expectedTotalItc + totals.nonImsItc).toBe(totals.grandTotalItc);
    expect(assertTotalsBalance(totals)).toBe(true);

    for (const value of [
      totals.claimableItc, totals.atRiskItc, totals.deferredItc,
      totals.ineligibleItc, totals.nonImsItc, totals.expectedTotalItc, totals.grandTotalItc
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('keeps NON_IMS out of expected but inside the grand total', () => {
    const totals = computeRunTotals([result(BUCKETS.NON_IMS)], context);
    expect(totals.expectedTotalItc).toBe(0);
    expect(totals.nonImsItc).toBe(1800000);
    expect(totals.grandTotalItc).toBe(1800000);
  });

  it('reduces claimable when a credit note is matched', () => {
    const invoiceOnly = computeRunTotals([result(BUCKETS.MATCHED)], context);
    const withNote = computeRunTotals(
      [
        result(BUCKETS.MATCHED),
        result(BUCKETS.MATCHED, {
          expected: { docType: 'CREDIT_NOTE', totalTax: 500000, taxPeriod: '2026-02' },
          portal: { docType: 'CREDIT_NOTE', totalTax: 500000, taxPeriod: '2026-02' }
        })
      ],
      context
    );
    // Claimable must FALL, not rise, when a credit note joins the run.
    expect(withNote.claimableItc).toBe(invoiceOnly.claimableItc - 500000);
    expect(withNote.claimableItc).toBeLessThan(invoiceOnly.claimableItc);
  });

  it('reports both bucket counts and total counts', () => {
    const totals = computeRunTotals(
      [result(BUCKETS.MATCHED), result(BUCKETS.MATCHED), result(BUCKETS.NON_IMS)],
      context
    );
    expect(totals.bucketCounts.MATCHED).toBe(2);
    expect(totals.bucketCounts.NON_IMS).toBe(1);
    expect(totals.totalCounts.CLAIMABLE).toBe(2);
    expect(totals.totalCounts.NON_IMS).toBe(1);
    expect(totals.perResult).toHaveLength(3);
  });

  it('handles an empty run', () => {
    const totals = computeRunTotals([], context);
    expect(totals.expectedTotalItc).toBe(0);
    expect(totals.grandTotalItc).toBe(0);
    expect(assertTotalsBalance(totals)).toBe(true);
  });

  it('throws when a total is inconsistent, rather than reporting a wrong number', () => {
    expect(() =>
      assertTotalsBalance({
        claimableItc: 100, atRiskItc: 0, deferredItc: 0, ineligibleItc: 0,
        nonImsItc: 0, expectedTotalItc: 999, grandTotalItc: 999
      })
    ).toThrow(/do not balance/);
  });
});

// Accepting a mismatch claims only what both sides agree on (audit P5). The
// trader's books said Rs 1,21,033 for Mahavir 06-17/AMD/3538; the portal carries
// Rs 1,20,190, and that is all 2B will ever give.
describe('accepting a value mismatch', () => {
  const context = { asOfDate: '2026-03-16', taxPeriod: '2026-02' };
  const BOOKS = 12103345;

  const mismatch = (docType, portalTax, overrides = {}) =>
    result(BUCKETS.VALUE_MISMATCH, {
      expected: { docType, totalTax: BOOKS, supplierGstin: 'G1', taxPeriod: '2026-02' },
      portal: { docType, totalTax: portalTax, supplierGstin: 'G1', taxPeriod: '2026-02' },
      deltaTotalTax: portalTax - BOOKS,
      confirmedAction: 'ACCEPT',
      ...overrides
    });

  it('claims the smaller figure on an invoice or debit note', () => {
    for (const docType of ['INVOICE', 'DEBIT_NOTE']) {
      expect(acceptedItc({ bucket: BUCKETS.VALUE_MISMATCH, docType, signedItc: BOOKS, deltaTotalTax: -84296 }))
        .toBe(12019049);
      expect(acceptedItc({ bucket: BUCKETS.VALUE_MISMATCH, docType, signedItc: BOOKS, deltaTotalTax: 84296 }))
        .toBe(BOOKS);
    }
  });

  it('reverses the larger figure on a credit note', () => {
    // Portal lower: the books reversal stands.
    expect(acceptedItc({ bucket: BUCKETS.VALUE_MISMATCH, docType: 'CREDIT_NOTE', signedItc: -381200, deltaTotalTax: -900 }))
      .toBe(-381200);
    // Portal higher: accepting reverses the portal's larger figure.
    expect(acceptedItc({ bucket: BUCKETS.VALUE_MISMATCH, docType: 'CREDIT_NOTE', signedItc: -381200, deltaTotalTax: 900 }))
      .toBe(-382100);
  });

  it('claims anything that is not a mismatch whole', () => {
    expect(acceptedItc({ bucket: BUCKETS.SUGGESTED, docType: 'INVOICE', signedItc: 500, deltaTotalTax: 0 })).toBe(500);
    expect(acceptedItc({ bucket: BUCKETS.MISSING_IN_BOOKS, docType: 'INVOICE', signedItc: 500, deltaTotalTax: null })).toBe(500);
    expect(acceptedItc({ bucket: BUCKETS.VALUE_MISMATCH, docType: 'INVOICE', signedItc: 500, deltaTotalTax: 0 })).toBe(500);
  });

  it('splits the books amount: the portal figure claimable, the difference at risk', () => {
    const totals = computeRunTotals([mismatch('INVOICE', 12019049)], context);
    expect(totals.claimableItc).toBe(12019049);
    expect(totals.atRiskItc).toBe(84296);
    expect(totals.expectedTotalItc).toBe(BOOKS);
    expect(assertTotalsBalance(totals)).toBe(true);
    expect(totals.perResult[0]).toMatchObject({ totalBucket: 'CLAIMABLE', signedItc: BOOKS, claimableItc: 12019049 });
  });

  it('leaves nothing at risk when the books figure is the one claimed', () => {
    const totals = computeRunTotals([mismatch('INVOICE', BOOKS + 84296)], context);
    expect(totals.claimableItc).toBe(BOOKS);
    expect(totals.atRiskItc).toBe(0);
  });

  it('reverses a credit note in full whichever side is larger', () => {
    const lower = computeRunTotals([mismatch('CREDIT_NOTE', BOOKS - 900)], context);
    expect(lower.claimableItc).toBe(-BOOKS);
    expect(lower.atRiskItc).toBe(0);

    const higher = computeRunTotals([mismatch('CREDIT_NOTE', BOOKS + 900)], context);
    expect(higher.claimableItc).toBe(-(BOOKS + 900));
    // Reversing more than the books owe is credit the trader stands to lose.
    expect(higher.atRiskItc).toBe(900);
    expect(assertTotalsBalance(higher)).toBe(true);
  });

  it('is the same whether the trader confirmed it or the portal already holds an Accept', () => {
    const confirmed = computeRunTotals([mismatch('INVOICE', 12019049)], context);
    const onPortal = computeRunTotals(
      [mismatch('INVOICE', 12019049, {
        confirmedAction: null,
        portal: { docType: 'INVOICE', totalTax: 12019049, imsAction: 'A', supplierGstin: 'G1', taxPeriod: '2026-02' }
      })],
      context
    );
    expect(onPortal.claimableItc).toBe(confirmed.claimableItc);
  });

  it('keeps an unaccepted mismatch whole at risk', () => {
    for (const confirmedAction of [null, 'REJECT', 'PENDING', 'NO_ACTION']) {
      const totals = computeRunTotals([mismatch('INVOICE', 12019049, { confirmedAction })], context);
      expect(totals.claimableItc).toBe(0);
      expect(totals.atRiskItc).toBe(BOOKS);
    }
  });

  it('reads persisted amounts when they are given, not the two sides', () => {
    // recomputeRunTotals passes signed_itc and delta_total_tax from the row.
    const allocation = allocate(
      { bucket: BUCKETS.VALUE_MISMATCH, docType: 'INVOICE', signedItc: BOOKS, deltaTotalTax: -84296, confirmedAction: 'ACCEPT' },
      context
    );
    expect(allocation).toEqual({ totalBucket: 'CLAIMABLE', signedItc: BOOKS, claimableItc: 12019049 });
    expect(sumAllocations([allocation])).toMatchObject({ claimableItc: 12019049, atRiskItc: 84296, expectedTotalItc: BOOKS });
  });
});
