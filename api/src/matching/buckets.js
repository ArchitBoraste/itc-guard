// Bucket classification. PURE — no db, no fs, no network.
import { amountsDiffer, AMOUNT_TOLERANCE_PAISE } from './similarity.js';
import { DEFAULT_THRESHOLDS } from './score.js';

export const BUCKETS = Object.freeze({
  MATCHED: 'MATCHED',
  VALUE_MISMATCH: 'VALUE_MISMATCH',
  SUGGESTED: 'SUGGESTED',
  MISSING_IN_PORTAL: 'MISSING_IN_PORTAL',
  MISSING_IN_BOOKS: 'MISSING_IN_BOOKS',
  INELIGIBLE: 'INELIGIBLE',
  NON_IMS: 'NON_IMS'
});

export const FLAGS = Object.freeze({
  GSTIN_MISMATCH: 'GSTIN_MISMATCH',
  FUZZY_INV_NO: 'FUZZY_INV_NO',
  DATE_DRIFT: 'DATE_DRIFT',
  DUPLICATE_INV_NO: 'DUPLICATE_INV_NO',
  RCM: 'RCM',
  ITC_INELIGIBLE: 'ITC_INELIGIBLE',
  NON_IMS_SECTION: 'NON_IMS_SECTION',
  SUPPLIER_UNFILED: 'SUPPLIER_UNFILED',
  LATE_FILING: 'LATE_FILING',
  CHANGED_AFTER_REVIEW: 'CHANGED_AFTER_REVIEW'
});

// The two GSTR-2B sections that never pass through IMS. Records here are
// informational: there is no IMS row to accept or reject.
export const NON_IMS_SECTIONS = new Set(['isd', 'isda', 'impg', 'impgsez']);

// classify({ expected, portal, score, flags }, options) -> { bucket, flags }
//
// Order matters, and mirrors how the credit actually behaves:
//
//   1. Records that never enter IMS are settled by what they are, not by whether
//      they matched. Reverse charge, ITC-ineligible, ISD and import records all
//      appear in 2B only — surfacing them as unmatched exceptions would bury the
//      real ones. This is the 'IMS ≠ 2B' rule.
//   2. One-sided results.
//   3. Matched pairs, cheapest-to-verify distinction first: a real money
//      difference outranks a cosmetic one.
export function classify({ expected, portal, score = null, flags = [] }, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const tolerancePaise = options.tolerancePaise ?? AMOUNT_TOLERANCE_PAISE;
  const out = new Set(flags);

  // --- 1. never-in-IMS records -------------------------------------------
  if (portal) {
    if (NON_IMS_SECTIONS.has(portal.section)) {
      out.add(FLAGS.NON_IMS_SECTION);
      return { bucket: BUCKETS.NON_IMS, flags: [...out] };
    }
    if (portal.reverseCharge) {
      out.add(FLAGS.RCM);
      return { bucket: BUCKETS.NON_IMS, flags: [...out] };
    }
    if (portal.itcAvailable === false) {
      out.add(FLAGS.ITC_INELIGIBLE);
      return { bucket: BUCKETS.INELIGIBLE, flags: [...out] };
    }
  }

  // --- 2. one-sided ------------------------------------------------------
  if (!portal) return { bucket: BUCKETS.MISSING_IN_PORTAL, flags: [...out] };
  if (!expected) return { bucket: BUCKETS.MISSING_IN_BOOKS, flags: [...out] };

  // --- 3. matched pair ---------------------------------------------------
  // Real money difference: the trader's books and the portal disagree on what
  // the credit is worth. Absolute tolerance only — a percentage would let a
  // large invoice hide a rupee difference.
  const taxableDiffers = amountsDiffer(expected.taxableValue, portal.taxableValue, tolerancePaise);
  const taxDiffers = amountsDiffer(expected.totalTax, portal.totalTax, tolerancePaise);
  if (taxableDiffers || taxDiffers) {
    return { bucket: BUCKETS.VALUE_MISMATCH, flags: [...out] };
  }

  // A residual difference in the invoice number AFTER normalisation is the
  // definition of an uncertain match: normalisation has already absorbed
  // punctuation and leading zeros, so what is left is a genuinely different
  // string. The money agrees to the rupee, so this is cheap for a human to
  // confirm and dangerous to auto-accept.
  if (expected.invoiceNoNorm !== portal.invoiceNoNorm) {
    out.add(FLAGS.FUZZY_INV_NO);
    return { bucket: BUCKETS.SUGGESTED, flags: [...out] };
  }

  if (score !== null && score < thresholds.autoMatch) {
    return { bucket: BUCKETS.SUGGESTED, flags: [...out] };
  }

  return { bucket: BUCKETS.MATCHED, flags: [...out] };
}

// Flags that describe a pair but do not change its bucket. Kept separate so the
// bucket decision stays readable.
export function pairFlags({ expected, portal }) {
  const flags = [];
  if (!expected || !portal) return flags;

  if (expected.supplierGstin && portal.supplierGstin &&
      expected.supplierGstin !== portal.supplierGstin) {
    flags.push(FLAGS.GSTIN_MISMATCH);
  }
  if (expected.invoiceDate !== portal.invoiceDate) flags.push(FLAGS.DATE_DRIFT);
  if (portal.filingStatus === 'SAVED') flags.push(FLAGS.SUPPLIER_UNFILED);
  return flags;
}

export function isExceptionBucket(bucket) {
  return bucket !== BUCKETS.MATCHED && bucket !== BUCKETS.NON_IMS;
}
