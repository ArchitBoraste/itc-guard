// Run totals in integer paise. No floats, no intermediate division — formatting
// happens at the UI boundary only.
//
// Pure functions: no db, no fs. Kept in services/ rather than matching/ because
// the CLAIMABLE decision reads confirmed_action, which is a persistence concept.
import { BUCKETS } from '../matching/buckets.js';
import { isBeforeCutoff, supplierSchemeFor } from '../matching/cutoff.js';
import { currentImsAction } from './decisions.js';

// Which run total a result feeds.
export const TOTAL_BUCKETS = Object.freeze({
  CLAIMABLE: 'CLAIMABLE',
  AT_RISK: 'AT_RISK',
  DEFERRED: 'DEFERRED',
  INELIGIBLE: 'INELIGIBLE',
  NON_IMS: 'NON_IMS'
});

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

// A CREDIT NOTE REDUCES the credit available. Both the purchase-register
// templates and the portal JSON carry note amounts as POSITIVE numbers — in the
// fixtures all 141 credit notes have positive totalTax — so the sign has to be
// applied here. Adding a credit note instead of subtracting it inflates claimable
// ITC and nothing downstream looks wrong, which is why this is its own function
// with its own tests.
//
// Debit notes increase the taxable value, so they stay positive.
export function itcSign(docType) {
  return docType === 'CREDIT_NOTE' || docType === 'ISD_CREDIT' ? -1 : 1;
}

export function signedTax(document) {
  if (!document) return 0;
  return itcSign(document.docType) * (document.totalTax ?? 0);
}

// The amount a single result contributes to the run totals.
//
// Books side when we have it — it is the trader's own claim, and for MATCHED the
// two sides agree to within the ₹1 rounding tolerance by construction. Portal
// side when there is no books row (MISSING_IN_BOOKS), because that is credit in
// play whether the trader asked for it or not: left untouched it is deemed
// accepted at GSTR-3B.
export function resultItc(result) {
  return result.expected ? signedTax(result.expected) : signedTax(result.portal);
}

// ---------------------------------------------------------------------------
// What an accepted result is worth
// ---------------------------------------------------------------------------

// The signed amount accepting a result claims.
//
// A value mismatch is claimed at the smaller of the two figures: the portal's is
// all 2B will carry, the books' all the invoice supports. A credit note runs the
// other way — it REVERSES credit — so it is reversed at the larger of the two and
// the books amount is never under-reversed. Anything else is claimed whole.
//
// Reads the persisted shape: signedItc is the books side of a two-sided result
// and deltaTotalTax is portal minus books, so the portal figure is recovered
// without re-reading a portal row that may have moved since the run.
export function acceptedItc({ bucket, docType, signedItc, deltaTotalTax }) {
  if (bucket !== BUCKETS.VALUE_MISMATCH || !deltaTotalTax) return signedItc;
  const sign = itcSign(docType);
  const books = Math.abs(signedItc);
  const portal = books + deltaTotalTax;
  return sign * (sign < 0 ? Math.max(books, portal) : Math.min(books, portal));
}

// ---------------------------------------------------------------------------
// Bucket -> total
// ---------------------------------------------------------------------------

// claimable  = every record whose current IMS action is ACCEPT
//              (services/decisions.js): a clean match on its own, anything else
//              once the trader accepts it. An accepted mismatch counts only
//              acceptedItc(); the rest of its books amount stays at risk.
// atRisk     = open decisions, anything rejected or held as PENDING, the
//              unclaimed part of an accepted mismatch (the difference being
//              chased), and MISSING_IN_PORTAL still inside the cut-off.
// deferred   = MISSING_IN_PORTAL once the cut-off has passed. No IMS record
//              exists to act on, so the credit cannot arrive this period.
// ineligible = INELIGIBLE. ITC was never available on these.
// nonIms     = NON_IMS. INFORMATIONAL ONLY and deliberately NOT part of
//              expectedTotalItc: reverse-charge credit is self-assessed by the
//              recipient rather than accepted in IMS, and ISD/import records have
//              no purchase-register counterpart and no IMS action at all. Folding
//              them into "expected" would mix three different claim mechanisms
//              into one number. Reported separately so nothing goes missing:
//              expectedTotalItc + nonImsItc = grandTotalItc.
export function totalBucketFor(result, context = {}) {
  const { bucket } = result;

  if (bucket === BUCKETS.NON_IMS) return TOTAL_BUCKETS.NON_IMS;
  if (bucket === BUCKETS.INELIGIBLE) return TOTAL_BUCKETS.INELIGIBLE;

  if (bucket === BUCKETS.MISSING_IN_PORTAL) {
    return isPreCutOff(result, context) ? TOTAL_BUCKETS.AT_RISK : TOTAL_BUCKETS.DEFERRED;
  }

  return currentImsAction(result) === 'ACCEPT' ? TOTAL_BUCKETS.CLAIMABLE : TOTAL_BUCKETS.AT_RISK;
}

// The cut-off that matters is the SUPPLIER's: a QRMP supplier has until the 13th
// while a monthly filer had until the 11th.
function isPreCutOff(result, context) {
  const { asOfDate, taxPeriod } = context;
  if (!asOfDate) return true; // no calendar context: nothing is provably late yet

  const gstin = result.expected?.supplierGstin ?? result.portal?.supplierGstin ?? null;
  const scheme = supplierSchemeFor(gstin, context);
  const period = taxPeriod ?? result.expected?.taxPeriod ?? result.portal?.taxPeriod;
  if (!period) return true;

  return isBeforeCutoff(asOfDate, period, scheme) !== false;
}

// How one result divides between the run totals: which total it feeds, its
// signed amount, and the part of that which is claimable.
//
// signedItc, deltaTotalTax and docType are read off the result when the caller
// has them persisted (recomputeRunTotals), and derived from the two sides of a
// fresh engine result otherwise.
export function allocate(result, context = {}) {
  const signedItc = result.signedItc ?? resultItc(result);
  const totalBucket = totalBucketFor(result, context);
  const claimableItc = totalBucket === TOTAL_BUCKETS.CLAIMABLE
    ? acceptedItc({
        bucket: result.bucket,
        docType: result.docType ?? result.expected?.docType ?? result.portal?.docType,
        signedItc,
        deltaTotalTax: result.deltaTotalTax
      })
    : 0;
  return { totalBucket, signedItc, claimableItc };
}

// ---------------------------------------------------------------------------
// Run totals
// ---------------------------------------------------------------------------

// sumAllocations(allocations) -> { claimableItc, atRiskItc, deferredItc,
//   ineligibleItc, nonImsItc, expectedTotalItc, grandTotalItc }
//
// All arithmetic is integer addition on paise. Nothing is divided, so nothing
// rounds, so the identity holds exactly rather than approximately.
export function sumAllocations(allocations) {
  const totals = {
    claimableItc: 0,
    atRiskItc: 0,
    deferredItc: 0,
    ineligibleItc: 0,
    nonImsItc: 0
  };

  for (const { totalBucket, signedItc, claimableItc } of allocations) {
    switch (totalBucket) {
      case TOTAL_BUCKETS.CLAIMABLE:
        totals.claimableItc += claimableItc;
        totals.atRiskItc += signedItc - claimableItc;
        break;
      case TOTAL_BUCKETS.AT_RISK: totals.atRiskItc += signedItc; break;
      case TOTAL_BUCKETS.DEFERRED: totals.deferredItc += signedItc; break;
      case TOTAL_BUCKETS.INELIGIBLE: totals.ineligibleItc += signedItc; break;
      default: totals.nonImsItc += signedItc; break;
    }
  }

  const expectedTotalItc =
    totals.claimableItc + totals.atRiskItc + totals.deferredItc + totals.ineligibleItc;
  return { ...totals, expectedTotalItc, grandTotalItc: expectedTotalItc + totals.nonImsItc };
}

// computeRunTotals(results, context) -> {
//   expectedTotalItc, claimableItc, atRiskItc, deferredItc, ineligibleItc,
//   nonImsItc, grandTotalItc, bucketCounts, totalCounts, perResult
// }
export function computeRunTotals(results, context = {}) {
  const bucketCounts = {};
  const totalCounts = {};
  for (const bucket of Object.values(BUCKETS)) bucketCounts[bucket] = 0;
  for (const key of Object.values(TOTAL_BUCKETS)) totalCounts[key] = 0;

  const perResult = results.map((result) => {
    const allocation = allocate(result, context);
    bucketCounts[result.bucket] = (bucketCounts[result.bucket] ?? 0) + 1;
    totalCounts[allocation.totalBucket] += 1;
    return { result, ...allocation };
  });

  return { ...sumAllocations(perResult), bucketCounts, totalCounts, perResult };
}

// Guard for the caller: if this ever fails, a bucket has no home in the mapping
// above. Fix the classification, never the arithmetic.
export function assertTotalsBalance(totals) {
  const sum =
    totals.claimableItc + totals.atRiskItc + totals.deferredItc + totals.ineligibleItc;
  if (sum !== totals.expectedTotalItc) {
    throw new Error(
      `run totals do not balance: claimable+atRisk+deferred+ineligible = ${sum} ` +
        `but expectedTotalItc = ${totals.expectedTotalItc}`
    );
  }
  if (totals.expectedTotalItc + totals.nonImsItc !== totals.grandTotalItc) {
    throw new Error(
      `grand total does not balance: ${totals.expectedTotalItc} + ${totals.nonImsItc} ` +
        `!= ${totals.grandTotalItc}`
    );
  }
  return true;
}
