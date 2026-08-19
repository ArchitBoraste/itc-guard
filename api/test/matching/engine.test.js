import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dateToIso,
  daysBetween,
  gstinStateCode,
  normalizeGstin,
  normalizeInvoiceNo,
  periodsApart
} from '../../src/matching/normalize.js';
import { jaroWinkler } from '../../src/matching/similarity.js';
import { FALLBACK_PASS, PRIMARY_PASS, candidatePairs } from '../../src/matching/block.js';
import { assignOneToOne, comparePairs } from '../../src/matching/assign.js';
import { BUCKETS, classify } from '../../src/matching/buckets.js';
import { mergePortalRecords, reconcile, summarizeResults } from '../../src/matching/index.js';

// --- builders --------------------------------------------------------------

function books(overrides = {}) {
  return {
    id: null,
    supplierGstin: '27AABCU9603R1ZM',
    supplierName: 'Dell India',
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo: 'INV/DEL/2026/4471',
    invoiceNoNorm: normalizeInvoiceNo('INV/DEL/2026/4471'),
    invoiceDate: '2026-02-08',
    taxPeriod: '2026-02',
    placeOfSupply: null,
    invoiceValue: null,
    taxableValue: 10000000,
    igst: 1800000,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 1800000,
    reverseCharge: false,
    rateLines: [],
    ...overrides
  };
}

function portal(overrides = {}) {
  const base = {
    id: null,
    source: 'IMS',
    section: 'b2b',
    supplierGstin: '27AABCU9603R1ZM',
    supplierName: 'Dell India',
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo: 'INV/DEL/2026/4471',
    invoiceDate: '2026-02-08',
    taxPeriod: '2026-02',
    placeOfSupply: '27',
    taxableValue: 10000000,
    igst: 1800000,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 1800000,
    invoiceValue: 11800000,
    reverseCharge: false,
    itcAvailable: null,
    itcIneligibleReason: null,
    supplierFiledOn: null,
    filingStatus: 'FILED',
    imsAction: 'N',
    pendingBlocked: false,
    remarksBlocked: false,
    itcReductionBlocked: false,
    portCode: null,
    sourceForm: 'R1',
    contentHash: 'hash',
    rateLines: [],
    ...overrides
  };
  base.invoiceNoNorm = overrides.invoiceNoNorm ?? normalizeInvoiceNo(base.invoiceNo);
  return base;
}

// --- normalize -------------------------------------------------------------

describe('normalize', () => {
  it('normalises invoice numbers per the engine contract', () => {
    expect(normalizeInvoiceNo('inv-2024-891')).toBe('INV2024891');
    expect(normalizeInvoiceNo('5-3886')).toBe('53886');
    expect(normalizeInvoiceNo('06-17/LKO/1052')).toBe('617LKO1052');
    expect(normalizeInvoiceNo('A/1003')).toBe('A1003');
  });

  // KNOWN CONTRACT CONFLICT — needs a decision, see the note in normalize.js.
  //
  // CLAUDE.md states the order as "strip non-alphanumeric -> strip leading zeros
  // per numeric group" and gives 'INV/2024/0891' -> 'INV2024891' as the example.
  // Those two disagree: stripping punctuation first merges 2024 and 0891 into the
  // single run 20240891, which has no leading zero to strip.
  //
  // This asserts the stated ORDER, which is also what tools/generate-fixtures.js
  // implements and therefore what every invoiceNoNorm and contentHash in
  // fixtures/ was built with. The cost is that the documented flagship case does
  // not collapse to one value.
  it('follows the documented order, which does not reproduce the documented example', () => {
    expect(normalizeInvoiceNo('INV/2024/0891')).toBe('INV20240891');
    expect(normalizeInvoiceNo('INV-2024-891')).toBe('INV2024891');
    // So the pair the docs cite as the headline win does NOT normalise equal...
    expect(normalizeInvoiceNo('INV/2024/0891')).not.toBe(normalizeInvoiceNo('INV-2024-891'));
    // ...but it is still recovered as a near-match rather than lost: the scorer
    // rates it far above the match floor, so it lands in SUGGESTED for a human
    // rather than in the unmatched pile GSTN's exact matcher would leave it in.
    expect(jaroWinkler('INV20240891', 'INV2024891')).toBeGreaterThan(0.95);
  });

  it('collapses the documented collision cases, which is why value and date carry weight', () => {
    expect(normalizeInvoiceNo('A/1003')).toBe(normalizeInvoiceNo('A1003'));
    expect(normalizeInvoiceNo('1-10010')).toBe(normalizeInvoiceNo('1/10010'));
  });

  it('keeps branch codes, which often are the only distinguishing part', () => {
    expect(normalizeInvoiceNo('A-KNP/1000/06-17')).toBe('AKNP10000617');
    expect(normalizeInvoiceNo('A-LKO/1000/06-17')).not.toBe(
      normalizeInvoiceNo('A-KNP/1000/06-17')
    );
  });

  it('normalises GSTINs without validating them, so a typo stays matchable', () => {
    expect(normalizeGstin(' 27aabcu9603r1zm ')).toBe('27AABCU9603R1ZM');
    expect(normalizeGstin('27-AABCU9603R1ZM')).toBe('27AABCU9603R1ZM');
    expect(normalizeGstin(null)).toBe(null);
    expect(normalizeGstin('')).toBe(null);
    expect(gstinStateCode('27AABCU9603R1ZM')).toBe('27');
  });

  it('accepts only unambiguous dates', () => {
    expect(dateToIso('2026-03-02')).toBe('2026-03-02');
    expect(dateToIso(new Date(Date.UTC(2026, 2, 2)))).toBe('2026-03-02');
    // dd-mm-yyyy is locale-ambiguous here: adapters convert, matching refuses.
    expect(dateToIso('02-03-2026')).toBe(null);
    expect(dateToIso('rubbish')).toBe(null);
    expect(dateToIso(null)).toBe(null);
  });

  it('does period and day arithmetic', () => {
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-02-28')).toBe(-1);
    expect(periodsApart('2026-02', '2026-03')).toBe(1);
    expect(periodsApart('2025-12', '2026-01')).toBe(1);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

// --- blocking --------------------------------------------------------------

describe('blocking', () => {
  it('pairs on supplier GSTIN within ±1 tax period', () => {
    const expected = [books()];
    const records = [
      portal(),
      portal({ taxPeriod: '2026-03' }),
      portal({ taxPeriod: '2026-05' })
    ];
    const pairs = candidatePairs(expected, records);
    expect(pairs.map((p) => p.portalIndex).sort()).toEqual([0, 1]);
    expect(pairs.every((p) => p.via === PRIMARY_PASS)).toBe(true);
  });

  it('does not pair different suppliers on the primary pass', () => {
    const pairs = candidatePairs(
      [books()],
      [portal({ supplierGstin: '29ESVUJ8812E1Z8', invoiceNo: 'OTHER/1' })]
    );
    expect(pairs).toHaveLength(0);
  });

  it('recovers a GSTIN typo through the fallback pass and flags it', () => {
    // Same invoice number and value; one character out in the GSTIN.
    const pairs = candidatePairs(
      [books({ supplierGstin: '08ZGWPN9226C9ZK' })],
      [portal({ supplierGstin: '08ZGWPN9266C9ZK' })]
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].via).toBe(FALLBACK_PASS);
    expect(pairs[0].flags).toContain('GSTIN_MISMATCH');
  });

  it('will not use the fallback when the value disagrees by more than 1%', () => {
    const pairs = candidatePairs(
      [books({ supplierGstin: '08ZGWPN9226C9ZK', taxableValue: 10000000 })],
      [portal({ supplierGstin: '08ZGWPN9266C9ZK', taxableValue: 12000000 })]
    );
    expect(pairs).toHaveLength(0);
  });

  it('gives imports no candidates — they carry no GSTIN to block on', () => {
    const pairs = candidatePairs(
      [books()],
      [portal({ section: 'impg', supplierGstin: null, portCode: 'INMAA4', invoiceNo: '9751374' })]
    );
    expect(pairs).toHaveLength(0);
  });
});

// --- assignment ------------------------------------------------------------

describe('one-to-one assignment', () => {
  it('takes the best pair first and consumes both of its sides', () => {
    const pairs = [
      { expectedIndex: 0, portalIndex: 0, score: 0.95, flags: [] },
      { expectedIndex: 1, portalIndex: 1, score: 0.97, flags: [] },
      { expectedIndex: 1, portalIndex: 0, score: 0.99, flags: [] }
    ];
    const { assigned, unassignedExpected, unassignedPortal } = assignOneToOne(pairs, {
      expectedCount: 2,
      portalCount: 2
    });
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ expectedIndex: 1, portalIndex: 0, score: 0.99 });
    expect(unassignedExpected).toEqual([0]);
    expect(unassignedPortal).toEqual([1]);
  });

  it('is greedy, not globally optimal — a documented trade-off', () => {
    // Taking 0.99 first blocks the 0.95 + 0.97 pairing that would have scored
    // higher in total. The build spec specifies greedy, and in practice the pairs
    // that matter score 1.0 (exact on number, date and amount), so they are taken
    // before any weaker competitor can consume a side. Pinned so that swapping in
    // a global assignment later is a visible, deliberate change.
    const pairs = [
      { expectedIndex: 0, portalIndex: 0, score: 0.95, flags: [] },
      { expectedIndex: 0, portalIndex: 1, score: 0.99, flags: [] },
      { expectedIndex: 1, portalIndex: 1, score: 0.97, flags: [] }
    ];
    const { assigned } = assignOneToOne(pairs, { expectedCount: 2, portalCount: 2 });
    expect(assigned).toHaveLength(1);
    expect(assigned[0].score).toBe(0.99);
  });

  it('drops pairs below the suggest floor', () => {
    const { assigned, unassignedExpected } = assignOneToOne(
      [{ expectedIndex: 0, portalIndex: 0, score: 0.5, flags: [] }],
      { expectedCount: 1, portalCount: 1 }
    );
    expect(assigned).toHaveLength(0);
    expect(unassignedExpected).toEqual([0]);
  });

  it('breaks ties deterministically, so re-ordered input gives the same answer', () => {
    const pairs = [
      { expectedIndex: 1, portalIndex: 0, score: 0.95, flags: [] },
      { expectedIndex: 0, portalIndex: 1, score: 0.95, flags: [] }
    ];
    const forward = assignOneToOne(pairs, { expectedCount: 2, portalCount: 2 });
    const reversed = assignOneToOne([...pairs].reverse(), { expectedCount: 2, portalCount: 2 });
    expect(forward.assigned).toEqual(reversed.assigned);
    expect(comparePairs(pairs[1], pairs[0])).toBeLessThan(0);
  });

  it('resolves a repeated invoice number on date and value instead of giving up', () => {
    // Two books rows share (supplier, invoice number) but differ in date.
    const expected = [
      books({ invoiceNo: 'U/1892', invoiceNoNorm: 'U1892', invoiceDate: '2026-03-24', taxableValue: 39363900, totalTax: 6208902 }),
      books({ invoiceNo: 'U/1892', invoiceNoNorm: 'U1892', invoiceDate: '2026-03-06', taxableValue: 26623400, totalTax: 4822136 })
    ];
    const records = [
      portal({ invoiceNo: 'U/1892', invoiceDate: '2026-03-06', taxPeriod: '2026-03', taxableValue: 26623400, totalTax: 4822136, igst: 4822136 }),
      portal({ invoiceNo: 'U/1892', invoiceDate: '2026-03-24', taxPeriod: '2026-03', taxableValue: 39363900, totalTax: 6208902, igst: 6208902 })
    ];
    const results = reconcile(expected, records, { taxPeriod: '2026-03' });
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.bucket).toBe(BUCKETS.MATCHED);
      // paired with its own date, not crossed
      expect(result.expected.invoiceDate).toBe(result.portal.invoiceDate);
    }
  });
});

// --- buckets ---------------------------------------------------------------

describe('bucket classification', () => {
  it('sends reverse-charge and 2B-only sections to NON_IMS before anything else', () => {
    // These never enter IMS, so they are settled by what they are — not by
    // whether a books row happened to match.
    expect(classify({ expected: books(), portal: portal({ reverseCharge: true }) }).bucket)
      .toBe(BUCKETS.NON_IMS);
    for (const section of ['isd', 'isda', 'impg', 'impgsez']) {
      expect(classify({ expected: null, portal: portal({ section }) }).bucket)
        .toBe(BUCKETS.NON_IMS);
    }
  });

  it('sends ITC-ineligible records to INELIGIBLE', () => {
    const result = classify({
      expected: books(),
      portal: portal({ itcAvailable: false, itcIneligibleReason: 'POS' })
    });
    expect(result.bucket).toBe(BUCKETS.INELIGIBLE);
    expect(result.flags).toContain('ITC_INELIGIBLE');
  });

  it('classifies one-sided results', () => {
    expect(classify({ expected: books(), portal: null }).bucket).toBe(BUCKETS.MISSING_IN_PORTAL);
    expect(classify({ expected: null, portal: portal() }).bucket).toBe(BUCKETS.MISSING_IN_BOOKS);
  });

  it('calls a real money difference VALUE_MISMATCH', () => {
    expect(
      classify({
        expected: books({ taxableValue: 45841500, totalTax: 6183015 }),
        portal: portal({ taxableValue: 46021500, totalTax: 6192015 }),
        score: 1
      }).bucket
    ).toBe(BUCKETS.VALUE_MISMATCH);
  });

  it('still calls a rupee of rounding MATCHED', () => {
    expect(
      classify({
        expected: books({ taxableValue: 10000000, totalTax: 1800000 }),
        portal: portal({ taxableValue: 10000100, totalTax: 1800100 }),
        score: 1
      }).bucket
    ).toBe(BUCKETS.MATCHED);
  });

  it('calls a residual invoice-number difference SUGGESTED even at a high score', () => {
    // Normalisation has already absorbed punctuation and leading zeros, so what
    // is left is a genuinely different string. A human confirms.
    const result = classify({
      expected: books({ invoiceNo: 'D1360', invoiceNoNorm: 'D1360' }),
      portal: portal({ invoiceNo: 'D3360', invoiceNoNorm: 'D3360' }),
      score: 0.99
    });
    expect(result.bucket).toBe(BUCKETS.SUGGESTED);
    expect(result.flags).toContain('FUZZY_INV_NO');
  });

  it('keeps a GSTIN typo in MATCHED but flags it', () => {
    const result = classify({
      expected: books({ supplierGstin: '08ZGWPN9226C9ZK' }),
      portal: portal({ supplierGstin: '08ZGWPN9266C9ZK' }),
      score: 0.95,
      flags: ['GSTIN_MISMATCH']
    });
    expect(result.bucket).toBe(BUCKETS.MATCHED);
    expect(result.flags).toContain('GSTIN_MISMATCH');
  });
});

// --- merging the two portal sources ---------------------------------------

describe('portal source merge', () => {
  it('folds the same document seen in IMS and 2B into one record', () => {
    const merged = mergePortalRecords([
      portal({ source: 'IMS', filingStatus: 'FILED', imsAction: 'N', pendingBlocked: true }),
      portal({
        source: 'GSTR2B',
        section: 'b2b',
        itcAvailable: true,
        supplierFiledOn: '2026-03-11',
        counterpartyFilingStatus: 'Y',
        rateLines: [{ hsn: '8471', rate: 18, taxableValue: 10000000, igst: 1800000, cgst: 0, sgst: 0, cess: 0 }]
      })
    ]);

    expect(merged).toHaveLength(1);
    const record = merged[0];
    expect(record.sources.sort()).toEqual(['GSTR2B', 'IMS']);
    // IMS owns filing state, action and the blocked flags
    expect(record.filingStatus).toBe('FILED');
    expect(record.pendingBlocked).toBe(true);
    // 2B owns eligibility, the supplier's filing date and the rate detail
    expect(record.itcAvailable).toBe(true);
    expect(record.supplierFiledOn).toBe('2026-03-11');
    expect(record.rateLines).toHaveLength(1);
  });

  it('keeps records apart when the money differs — that is a real signal', () => {
    const merged = mergePortalRecords([
      portal({ source: 'IMS', taxableValue: 10000000 }),
      portal({ source: 'GSTR2B', taxableValue: 12000000 })
    ]);
    expect(merged).toHaveLength(2);
  });

  it('keys imports on port code and Bill of Entry, not on a GSTIN', () => {
    const merged = mergePortalRecords([
      portal({ source: 'GSTR2B', section: 'impg', supplierGstin: null, portCode: 'INMAA4', invoiceNo: '9751374', invoiceNoNorm: '9751374' }),
      portal({ source: 'GSTR2B', section: 'impg', supplierGstin: null, portCode: 'INMAA4', invoiceNo: '9751375', invoiceNoNorm: '9751375' })
    ]);
    expect(merged).toHaveLength(2);
  });

  it('without the merge, one clean invoice would raise a phantom exception', () => {
    const records = [portal({ source: 'IMS' }), portal({ source: 'GSTR2B' })];
    const unmerged = reconcile([books()], records, { merge: false });
    expect(unmerged.filter((r) => r.bucket === BUCKETS.MISSING_IN_BOOKS)).toHaveLength(1);

    const merged = reconcile([books()], records);
    expect(merged).toHaveLength(1);
    expect(merged[0].bucket).toBe(BUCKETS.MATCHED);
  });
});

// --- reconcile -------------------------------------------------------------

describe('reconcile', () => {
  it('returns one result per document with a persisted score breakdown', () => {
    const results = reconcile([books()], [portal()], { taxPeriod: '2026-02' });
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.bucket).toBe(BUCKETS.MATCHED);
    expect(result.score).toBe(1);
    expect(result.recommendedAction).toBe('ACCEPT');
    expect(result.deltaTaxableValue).toBe(0);
    expect(result.scoreBreakdown.invoiceNo.similarity).toBe(1);
    expect(result.scoreBreakdown.invoiceNo.rule).toMatch(/jaro-winkler/);
    expect(result.matchedVia).toBe(PRIMARY_PASS);
  });

  it('never scores fields the purchase-register template does not carry', () => {
    // placeOfSupply and invoiceValue are null on every ExpectedInvoice.
    const [result] = reconcile([books()], [portal()]);
    expect(Object.keys(result.scoreBreakdown).sort()).toEqual([
      'gstin', 'invoiceDate', 'invoiceNo', 'taxableValue', 'totalTax'
    ]);
    expect(result.score).toBe(1);
  });

  it('handles empty inputs', () => {
    expect(reconcile([], [])).toEqual([]);
    expect(reconcile([books()], [])).toHaveLength(1);
    expect(reconcile([], [portal()])).toHaveLength(1);
  });

  it('summarises a run', () => {
    const results = reconcile(
      [books(), books({ invoiceNo: 'GONE/1', invoiceNoNorm: 'GONE1' })],
      [portal()],
      { taxPeriod: '2026-02' }
    );
    const summary = summarizeResults(results);
    expect(summary.total).toBe(2);
    expect(summary.buckets.MATCHED).toBe(1);
    expect(summary.buckets.MISSING_IN_PORTAL).toBe(1);
    expect(summary.claimableTax).toBe(1800000);
    expect(summary.atRiskTax).toBe(1800000);
  });

  it('accepts alternative weights without touching the shipped defaults', () => {
    const weights = { invoiceNo: 0.4, taxableValue: 0.25, totalTax: 0.15, invoiceDate: 0.35, gstin: 0.05 };
    const [result] = reconcile([books()], [portal()], { weights });
    expect(result.scoreBreakdown.invoiceDate.weight).toBe(0.35);
  });
});
