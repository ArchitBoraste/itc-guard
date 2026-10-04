// Reconciliation entry point. PURE — no db, no fs, no network, and no imports
// from services/, routes/ or adapters/.
//
//   expected[] (books)  +  portal[] (IMS and/or GSTR-2B)  ->  MatchResult[]
//
// Pipeline:
//   1. merge   the same document seen in both IMS and 2B is ONE portal document
//      link    an earlier period's document arriving late joins its own books row
//   2. block   candidate pairs, plus the GSTIN-typo fallback pass
//   3. score   weighted similarity with a full breakdown
//   4. assign  greedy one-to-one by descending score
//   5. classify into buckets
//   6. recommend an action, with cut-off awareness
import { assignOneToOne } from './assign.js';
import { blockingCoverage, candidatePairs } from './block.js';
import { BUCKETS, FLAGS, classify, pairFlags } from './buckets.js';
import { FILING_SCHEMES, isBeforeCutoff, supplierSchemeFor } from './cutoff.js';
import { normalizeGstin } from './normalize.js';
import { recommendAction } from './recommend.js';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, scorePair } from './score.js';
import { LINK_VIA, linkEarlier } from './link.js';

// 1.1.0: scoring weights sum to 1.0 (see DEFAULT_WEIGHTS), so stored scores move.
// 1.2.0: a saved record that agrees, past its supplier's cut-off, is not filed.
// 1.3.0: earlier periods' documents arriving late link to their own books row.
export const ENGINE_VERSION = '1.3.0';

export * from './normalize.js';
export * from './similarity.js';
export * from './score.js';
export * from './block.js';
export * from './assign.js';
export * from './buckets.js';
export * from './cutoff.js';
export * from './recommend.js';
export * from './link.js';

// ---------------------------------------------------------------------------
// 1. Merge the portal sides
// ---------------------------------------------------------------------------

// A filed invoice appears in BOTH the IMS download and GSTR-2B. Left as two
// records, one would pair with the books row and the other would surface as
// MISSING_IN_BOOKS — a phantom exception on nearly every clean invoice.
//
// Identity is the same tuple contentHash covers, so two records merge only when
// they agree on supplier, number, date, doc type AND money. If a supplier amended
// between saving and filing, the two stay separate — which is the correct signal,
// not a merge to paper over.
export function portalIdentity(record) {
  if (record.portCode) {
    // Imports carry no GSTIN; port code + Bill of Entry is their key.
    return ['IMPORT', record.section, record.portCode, record.invoiceNo, record.invoiceDate].join('|');
  }
  return [
    normalizeGstin(record.supplierGstin) ?? '',
    record.invoiceNoNorm ?? '',
    record.invoiceDate ?? '',
    record.docType ?? '',
    record.taxableValue ?? 0,
    record.totalTax ?? 0
  ].join('|');
}

// IMS owns the action/filing-state fields; 2B owns eligibility and the supplier's
// filing date. Merging keeps whichever source actually carries each field.
export function mergePortalRecords(portal) {
  const groups = new Map();

  for (const record of portal) {
    const key = portalIdentity(record);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...record, sources: [record.source], sourceRecords: [record] });
      continue;
    }
    existing.sources.push(record.source);
    existing.sourceRecords.push(record);

    if (record.source === 'IMS') {
      // Only IMS knows SAVED vs FILED, the trader's action and the blocked flags.
      existing.filingStatus = record.filingStatus ?? existing.filingStatus;
      existing.imsAction = record.imsAction ?? existing.imsAction;
      existing.pendingBlocked = record.pendingBlocked || existing.pendingBlocked;
      existing.remarksBlocked = record.remarksBlocked || existing.remarksBlocked;
      existing.itcReductionBlocked = record.itcReductionBlocked || existing.itcReductionBlocked;
      existing.sourceForm = record.sourceForm ?? existing.sourceForm;
      existing.placeOfSupply = existing.placeOfSupply ?? record.placeOfSupply;
    } else {
      // Only 2B knows ITC eligibility, reverse charge and when the supplier filed.
      if (record.itcAvailable !== null && record.itcAvailable !== undefined) {
        existing.itcAvailable = record.itcAvailable;
      }
      existing.itcIneligibleReason = record.itcIneligibleReason ?? existing.itcIneligibleReason;
      existing.reverseCharge = existing.reverseCharge || record.reverseCharge;
      existing.supplierFiledOn = record.supplierFiledOn ?? existing.supplierFiledOn;
      existing.counterpartyFilingStatus =
        record.counterpartyFilingStatus ?? existing.counterpartyFilingStatus;
      existing.supplierReturnPeriod = record.supplierReturnPeriod ?? existing.supplierReturnPeriod;
      existing.differentialPercent = record.differentialPercent ?? existing.differentialPercent;
      if (record.rateLines?.length) existing.rateLines = record.rateLines;
      existing.placeOfSupply = existing.placeOfSupply ?? record.placeOfSupply;
    }
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// 2-6. reconcile
// ---------------------------------------------------------------------------

// reconcile(expected[], portal[], options) -> MatchResult[]
//
// options: {
//   weights, thresholds, blocking, tolerancePaise,   // engine tuning
//   materialityTolerancePaise,                       // mismatch accepted as immaterial
//   asOfDate, taxPeriod, filingScheme,               // calendar context
//   schemeFor,                                       // gstin -> that supplier's scheme
//   earlier,                                         // earlier periods' documents (link.js)
//   merge = true                                     // pre-merge IMS + 2B
// }
//
// filingScheme is the default; schemeFor, when given, decides each supplier's own
// cut-off. A QRMP supplier's saved record is still a free fix on the 12th.
export function reconcile(expected = [], portal = [], options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const context = {
    asOfDate: options.asOfDate ?? null,
    taxPeriod: options.taxPeriod ?? null,
    filingScheme: options.filingScheme ?? FILING_SCHEMES.MONTHLY,
    schemeFor: options.schemeFor ?? null,
    // Passed through so recommendAction() measures a difference with the same
    // tolerance classify() used to decide the bucket.
    tolerancePaise: options.tolerancePaise,
    materialityTolerancePaise: options.materialityTolerancePaise
  };

  const merged = options.merge === false ? [...portal] : mergePortalRecords(portal);

  // An earlier period's document arriving now is tried against that period's
  // documents first (link.js). Only what links to nothing meets this period's books.
  const { links, rest: portalRecords } = linkEarlier(options.earlier ?? [], merged, {
    taxPeriod: context.taxPeriod,
    weights,
    thresholds,
    blocking: options.blocking,
    tolerancePaise: options.tolerancePaise
  });

  const pairs = candidatePairs(expected, portalRecords, options);

  const scored = pairs.map((pair) => {
    const result = scorePair(expected[pair.expectedIndex], portalRecords[pair.portalIndex], {
      weights
    });
    return { ...pair, score: result.score, scoreDetail: result };
  });

  const { assigned, unassignedExpected, unassignedPortal } = assignOneToOne(scored, {
    thresholds,
    expectedCount: expected.length,
    portalCount: portalRecords.length
  });

  const results = links.map((link) => buildResult({ ...link, context }));

  for (const pair of assigned) {
    const books = expected[pair.expectedIndex];
    const record = portalRecords[pair.portalIndex];
    const flags = [...new Set([...pair.flags, ...pairFlags({ expected: books, portal: record })])];
    const { bucket, flags: bucketFlags } = classify(
      { expected: books, portal: record, score: pair.score, flags },
      { thresholds, tolerancePaise: options.tolerancePaise }
    );
    results.push(
      buildResult({
        expected: books,
        portal: record,
        bucket,
        flags: bucketFlags,
        score: pair.score,
        scoreDetail: pair.scoreDetail,
        via: pair.via,
        context
      })
    );
  }

  for (const index of unassignedExpected) {
    const books = expected[index];
    const { bucket, flags } = classify({ expected: books, portal: null }, { thresholds });
    results.push(buildResult({ expected: books, portal: null, bucket, flags, context }));
  }

  for (const index of unassignedPortal) {
    const record = portalRecords[index];
    const { bucket, flags } = classify({ expected: null, portal: record }, { thresholds });
    results.push(buildResult({ expected: null, portal: record, bucket, flags, context }));
  }

  return results;
}

function buildResult({
  expected,
  portal,
  bucket,
  flags,
  score = null,
  scoreDetail = null,
  via = null,
  linkedFrom = null,
  context
}) {
  const gstin = expected?.supplierGstin ?? portal?.supplierGstin ?? null;
  const filingScheme = supplierSchemeFor(gstin, context);

  // Past its supplier's cut-off a record that is only SAVED cannot reach this
  // period's GSTR-2B, so a pair that agrees on everything is not a match: the
  // document was not filed, and the saved record stays beside it to say so. One
  // whose amount differs keeps its bucket, because the trader's IMS verdict on the
  // amount is still the decision (MISMATCH_RULES).
  if (bucket === BUCKETS.MATCHED && isSavedPastCutOff(portal, expected, { ...context, filingScheme })) {
    bucket = BUCKETS.MISSING_IN_PORTAL;
    flags = [...new Set([...flags, FLAGS.SUPPLIER_UNFILED])];
  }

  const result = {
    engineVersion: ENGINE_VERSION,
    expectedInvoiceId: expected?.id ?? null,
    portalRecordId: portal?.id ?? null,
    expected: expected ?? null,
    portal: portal ?? null,
    bucket,
    flags,
    score,
    // Always persisted: the UI has to be able to show WHY something matched.
    scoreBreakdown: scoreDetail?.breakdown ?? null,
    matchedVia: via,
    deltaTaxableValue:
      expected && portal ? portal.taxableValue - expected.taxableValue : null,
    deltaTotalTax: expected && portal ? portal.totalTax - expected.totalTax : null,
    // Set when this is an earlier period's document arriving in this one.
    linkedFrom
  };

  const recommendation = recommendAction(result, { ...context, filingScheme });
  // The calendar verdict the recommendation was built on, kept as a flag so it
  // survives to the UI. It is the difference between "chase them, the fix is
  // free" and "chase them, but the credit now lands next period", and only the
  // engine is in a position to say which — the cut-off is per supplier.
  if (recommendation.preCutOff === false) {
    result.flags = [...new Set([...result.flags, FLAGS.CUTOFF_PASSED])];
  }
  result.recommendedAction = recommendation.action;
  result.imsActionCode = recommendation.imsActionCode;
  result.recommendationReason = linkedFrom
    ? `${arrivalSentence(linkedFrom)} ${recommendation.reason}`
    : recommendation.reason;
  result.remarks = recommendation.remarks;
  result.requiresConfirmation = recommendation.requiresConfirmation;
  result.itcAtRisk = recommendation.itcAtRisk;
  return result;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// "An August 2026 document, amended by the supplier and arriving in this period."
function arrivalSentence({ taxPeriod, via }) {
  const [year, month] = String(taxPeriod).split('-').map(Number);
  const document = `An ${MONTHS[month - 1]} ${year} document`;
  return via === LINK_VIA.AMENDMENT
    ? `${document}, amended by the supplier and arriving in this period.`
    : `${document} the supplier reported late, arriving in this period.`;
}

// Saved, not filed, and its supplier's cut-off is behind the as-of date. False
// without a calendar: nothing is provably late then.
export function isSavedPastCutOff(portal, expected, context = {}) {
  if (portal?.filingStatus !== 'SAVED' || !context.asOfDate) return false;
  const taxPeriod = context.taxPeriod ?? expected?.taxPeriod ?? portal?.taxPeriod;
  if (!taxPeriod) return false;
  return isBeforeCutoff(context.asOfDate, taxPeriod, context.filingScheme ?? FILING_SCHEMES.MONTHLY) === false;
}

// ---------------------------------------------------------------------------
// Run-level summary
// ---------------------------------------------------------------------------

export function summarizeResults(results) {
  const summary = {
    total: results.length,
    buckets: {},
    actions: {},
    claimableTax: 0,
    atRiskTax: 0
  };
  for (const bucket of Object.values(BUCKETS)) summary.buckets[bucket] = 0;

  for (const result of results) {
    summary.buckets[result.bucket] = (summary.buckets[result.bucket] ?? 0) + 1;
    summary.actions[result.recommendedAction] =
      (summary.actions[result.recommendedAction] ?? 0) + 1;
    if (result.bucket === BUCKETS.MATCHED) summary.claimableTax += result.portal?.totalTax ?? 0;
    summary.atRiskTax += result.itcAtRisk ?? 0;
  }
  return summary;
}

export { blockingCoverage };
