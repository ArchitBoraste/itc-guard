// Earlier periods' documents arriving late (matching/link.js, through reconcile).
//
// September's portal data carries four August documents in the demo: MS-878's
// GSTR-1A amendment, PS-3401 added late, AE/177 saved then filed, KE-112 in a
// quarterly return. Each must join its August books row, never become a
// September phantom, and never take a September books row from its owner.
import { describe, expect, it } from 'vitest';
import { BUCKETS } from '../../src/matching/buckets.js';
import { asOriginal, isLateArrival, reconcile } from '../../src/matching/index.js';
import { normalizeInvoiceNo } from '../../src/matching/normalize.js';

const GSTIN = '24AAKFM5120D1ZR';

function books(invoiceNo, invoiceDate, taxPeriod, overrides = {}) {
  return {
    id: `${taxPeriod}:${invoiceNo}`,
    supplierGstin: GSTIN,
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo,
    invoiceNoNorm: normalizeInvoiceNo(invoiceNo),
    invoiceDate,
    taxPeriod,
    taxableValue: 4000000,
    igst: 720000,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 720000,
    reverseCharge: false,
    rateLines: [],
    ...overrides
  };
}

function record(invoiceNo, invoiceDate, overrides = {}) {
  return {
    id: `pr:${invoiceNo}`,
    source: 'IMS',
    section: 'b2b',
    supplierGstin: GSTIN,
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo,
    invoiceNoNorm: normalizeInvoiceNo(invoiceNo),
    invoiceDate,
    taxPeriod: '2026-09',
    taxableValue: 4000000,
    igst: 720000,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 720000,
    reverseCharge: false,
    filingStatus: 'FILED',
    imsAction: 'N',
    originalInvoiceNo: null,
    originalInvoiceDate: null,
    rateLines: [],
    ...overrides
  };
}

const amendment = (overrides = {}) =>
  record('MS-878', '2026-08-11', {
    section: 'b2ba',
    originalInvoiceNo: 'MS-878',
    originalInvoiceDate: '2026-08-11',
    ...overrides
  });

const august = (invoiceNo = 'MS-878', { open = true, claimedItc = 0, ...overrides } = {}) => ({
  expected: books(invoiceNo, '2026-08-11', '2026-08', overrides),
  open,
  claimedItc
});

const SEPTEMBER = { taxPeriod: '2026-09', asOfDate: '2026-10-05' };

describe('which records may be an earlier period’s document', () => {
  it('is an amendment, or a record dated before the period', () => {
    expect(isLateArrival(amendment(), '2026-09')).toBe(true);
    expect(isLateArrival(record('PS-3401', '2026-08-19'), '2026-09')).toBe(true);
    expect(isLateArrival(record('MS-951', '2026-09-12'), '2026-09')).toBe(false);
    expect(isLateArrival(record('BE/1', '2026-08-01', { portCode: 'INNSA1' }), '2026-09')).toBe(false);
    expect(isLateArrival(record('PS-3401', '2026-08-19'), null)).toBe(false);
  });

  it('matches an amendment as the document it amends', () => {
    const renumbered = amendment({ invoiceNo: 'MS-878A', invoiceNoNorm: 'MS878A', invoiceDate: '2026-09-02' });
    expect(asOriginal(renumbered)).toMatchObject({ invoiceNoNorm: 'MS878', invoiceDate: '2026-08-11', invoiceNo: 'MS-878' });
    const plain = record('MS-951', '2026-09-12');
    expect(asOriginal(plain)).toBe(plain);
  });
});

describe('linking to an earlier period', () => {
  it('joins an amendment to its August books row, never a September phantom', () => {
    const [result] = reconcile([], [amendment()], { ...SEPTEMBER, earlier: [august()] });
    expect(result.bucket).toBe(BUCKETS.MATCHED);
    expect(result.expected.taxPeriod).toBe('2026-08');
    expect(result.portal.section).toBe('b2ba');
    expect(result.linkedFrom).toEqual({ taxPeriod: '2026-08', via: 'AMENDMENT', claimedItc: 0, open: true });
    expect(result.flags).toContain('FROM_EARLIER_PERIOD');
    expect(result.recommendedAction).toBe('ACCEPT');
    expect(result.recommendationReason).toMatch(/^An August 2026 document, amended by the supplier/);
  });

  it('carries what August already claimed, for the credit September adds', () => {
    const [result] = reconcile([], [amendment()], { ...SEPTEMBER, earlier: [august('MS-878', { claimedItc: 630000 })] });
    expect(result.linkedFrom.claimedItc).toBe(630000);
  });

  it('joins a late filing dated in August to an open August document', () => {
    const late = record('PS-3401', '2026-08-19', { sourceForm: 'R1A' });
    const [result] = reconcile([], [late], {
      ...SEPTEMBER,
      earlier: [{ expected: books('PS-3401', '2026-08-19', '2026-08'), open: true, claimedItc: 0 }]
    });
    expect(result.bucket).toBe(BUCKETS.MATCHED);
    expect(result.linkedFrom.via).toBe('LATE_FILING');
    expect(result.recommendationReason).toMatch(/^An August 2026 document the supplier reported late/);
  });

  it('keeps a saved late record as saved: a match, but not yet safe', () => {
    const saved = record('AE/177', '2026-08-21', { filingStatus: 'SAVED' });
    const [result] = reconcile([], [saved], {
      ...SEPTEMBER,
      earlier: [{ expected: books('AE/177', '2026-08-21', '2026-08'), open: true, claimedItc: 0 }]
    });
    expect(result.bucket).toBe(BUCKETS.MATCHED);
    expect(result.flags).toEqual(expect.arrayContaining(['SUPPLIER_UNFILED', 'FROM_EARLIER_PERIOD']));
  });

  it('judges a late record that still differs with the ordinary rule table', () => {
    const lower = amendment({ taxableValue: 3800000, igst: 684000, totalTax: 684000 });
    const [result] = reconcile([], [lower], { ...SEPTEMBER, earlier: [august()] });
    expect(result.bucket).toBe(BUCKETS.VALUE_MISMATCH);
    expect(result.recommendedAction).toBe('ACCEPT');
  });

  it('links an amendment to a settled original by its number, but nothing else to one', () => {
    const settled = august('MS-878', { open: false, claimedItc: 720000 });
    const [byAmendment] = reconcile([], [amendment()], { ...SEPTEMBER, earlier: [settled] });
    expect(byAmendment.linkedFrom).toMatchObject({ open: false, claimedItc: 720000 });

    const late = record('MS-878', '2026-08-11');
    const [plain] = reconcile([], [late], { ...SEPTEMBER, earlier: [settled] });
    expect(plain.bucket).toBe(BUCKETS.MISSING_IN_BOOKS);
    expect(plain.linkedFrom).toBeNull();
  });

  it('only links on the matcher’s own score: an unrelated open document stays open', () => {
    const unrelated = { expected: books('ZZ-1', '2026-08-02', '2026-08', { taxableValue: 900000, igst: 162000, totalTax: 162000 }), open: true, claimedItc: 0 };
    const results = reconcile([], [record('PS-3401', '2026-08-29')], { ...SEPTEMBER, earlier: [unrelated] });
    expect(results).toHaveLength(1);
    expect(results[0].bucket).toBe(BUCKETS.MISSING_IN_BOOKS);
  });

  it('hands a late record that links to nothing on to this period’s books', () => {
    // Dated 31 Aug, booked in September (date drift): no August document wants it.
    const drifted = record('MS-951', '2026-08-31');
    const results = reconcile([books('MS-951', '2026-09-01', '2026-09')], [drifted], {
      ...SEPTEMBER,
      earlier: [august('MS-878')]
    });
    const matched = results.find((result) => result.portal);
    expect(matched.bucket).toBe(BUCKETS.MATCHED);
    expect(matched.expected.taxPeriod).toBe('2026-09');
    expect(matched.linkedFrom).toBeNull();
    // ...and August's MS-878 is simply not in September's results.
    expect(results.some((result) => result.expected?.taxPeriod === '2026-08')).toBe(false);
  });

  it('never offers a record of this period’s own dates to an earlier document', () => {
    const results = reconcile([], [record('MS-878', '2026-09-03')], { ...SEPTEMBER, earlier: [august()] });
    expect(results[0].bucket).toBe(BUCKETS.MISSING_IN_BOOKS);
  });

  it('changes nothing without earlier documents', () => {
    const results = reconcile([books('MS-951', '2026-09-12', '2026-09')], [record('MS-951', '2026-09-12')], SEPTEMBER);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ bucket: BUCKETS.MATCHED, linkedFrom: null });
  });
});
