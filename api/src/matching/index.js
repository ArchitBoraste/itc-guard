// Reconciliation entry point. PURE — no db, no fs, no network, and no imports
// from services/, routes/ or adapters/.
//
//   expected[] (books)  +  portal[] (IMS and/or GSTR-2B)  ->  MatchResult[]
//
// Pipeline:
//   1. merge   the same document seen in both IMS and 2B is ONE portal document
//   2. block   candidate pairs, plus the GSTIN-typo fallback pass
//   3. score   weighted similarity with a full breakdown
//   4. assign  greedy one-to-one by descending score
//   5. classify into buckets
//   6. recommend an action, with cut-off awareness
import { assignOneToOne } from './assign.js';
import { blockingCoverage, candidatePairs } from './block.js';
import { BUCKETS, classify, pairFlags } from './buckets.js';
import { FILING_SCHEMES } from './cutoff.js';
import { normalizeGstin } from './normalize.js';
import { recommendAction } from './recommend.js';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, scorePair } from './score.js';

export const ENGINE_VERSION = '1.0.0';

export * from './normalize.js';
export * from './similarity.js';
export * from './score.js';
export * from './block.js';
export * from './assign.js';
export * from './buckets.js';
export * from './cutoff.js';
export * from './recommend.js';

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
//   asOfDate, taxPeriod, filingScheme,               // calendar context
//   merge = true                                     // pre-merge IMS + 2B
// }
export function reconcile(expected = [], portal = [], options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const context = {
    asOfDate: options.asOfDate ?? null,
    taxPeriod: options.taxPeriod ?? null,
    filingScheme: options.filingScheme ?? FILING_SCHEMES.MONTHLY
  };

  const portalRecords = options.merge === false ? [...portal] : mergePortalRecords(portal);

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

  const results = [];

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
  context
}) {
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
    deltaTotalTax: expected && portal ? portal.totalTax - expected.totalTax : null
  };

  const recommendation = recommendAction(result, context);
  result.recommendedAction = recommendation.action;
  result.imsActionCode = recommendation.imsActionCode;
  result.recommendationReason = recommendation.reason;
  result.remarks = recommendation.remarks;
  result.requiresConfirmation = recommendation.requiresConfirmation;
  result.itcAtRisk = recommendation.itcAtRisk;
  return result;
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
