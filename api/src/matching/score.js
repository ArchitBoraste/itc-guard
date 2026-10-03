// Pair scoring. PURE — no db, no fs, no network.
//
// Scores only fields that both sides genuinely carry. The purchase-register
// template has no place-of-supply and no invoice-value column, so those are null
// on every ExpectedInvoice and must never enter the score — a component that is
// null on one side would silently penalise every real match.
import { amountSimilarity, dateSimilarity, gstinSimilarity, jaroWinkler } from './similarity.js';

// Each weight is that component's share of the score, so they sum to exactly 1.0
// (the score popover shows them). Chosen with `node tools/sweep-weights.js --unit`:
// the build spec's 0.40/0.25/0.15/0.15/0.05 gets 2458 of 2461 fixture documents
// right — with the date at 15%, Feb's books 1-02661 pairs with the phantom
// 1-02667 eight days earlier (0.81) — and no unit-sum grid point with the date
// below 0.30 gets all 2461. This is the perfect point nearest the 1.2-sum weights
// it replaces, whose effective date share was already 29%.
export const DEFAULT_WEIGHTS = Object.freeze({
  invoiceNo: 0.35,
  taxableValue: 0.2,
  totalTax: 0.1,
  invoiceDate: 0.3,
  gstin: 0.05
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  autoMatch: 0.92,   // >= this is an automatic match
  suggest: 0.7       // >= this needs a human; below it is not a match at all
});

const COMPONENTS = [
  {
    key: 'invoiceNo',
    rule: 'jaro-winkler on invoiceNoNorm',
    valueOf: (side) => side.invoiceNoNorm ?? null,
    similarity: (a, b) => jaroWinkler(a, b)
  },
  {
    key: 'taxableValue',
    rule: '1 - |a-b|/max(a,b,1); exact within ₹1 or 0.5%',
    valueOf: (side) => side.taxableValue ?? null,
    similarity: (a, b) => amountSimilarity(a, b)
  },
  {
    key: 'totalTax',
    rule: '1 - |a-b|/max(a,b,1); exact within ₹1 or 0.5%',
    valueOf: (side) => side.totalTax ?? null,
    similarity: (a, b) => amountSimilarity(a, b)
  },
  {
    key: 'invoiceDate',
    rule: 'same day 1.0 · ±1d 0.8 · ±3d 0.6 · ±7d 0.3 · beyond 0',
    valueOf: (side) => side.invoiceDate ?? null,
    similarity: (a, b) => dateSimilarity(a, b)
  },
  {
    key: 'gstin',
    rule: 'exact only',
    valueOf: (side) => side.supplierGstin ?? null,
    similarity: (a, b) => gstinSimilarity(a, b)
  }
];

export const COMPONENT_KEYS = COMPONENTS.map((c) => c.key);

// Per-component similarities, unrounded and weight-independent. Separated out so
// a weight sweep can compute similarities once and then vary only the weights —
// and so there is exactly one definition of each comparison.
export function componentSimilarities(expected, portal) {
  const sims = {};
  for (const component of COMPONENTS) {
    const a = component.valueOf(expected);
    const b = component.valueOf(portal);
    const comparable = a !== null && a !== undefined && b !== null && b !== undefined;
    sims[component.key] = {
      expected: a,
      portal: b,
      comparable,
      similarity: comparable ? component.similarity(a, b) : null,
      rule: component.rule
    };
  }
  return sims;
}

// The weighted combination, in one place. Weights are renormalised across the
// components both sides actually carry, so a field that is null on one side
// cannot drag the score down.
export function combineSimilarities(sims, weights) {
  let weightUsed = 0;
  let weighted = 0;
  for (const key of COMPONENT_KEYS) {
    const component = sims[key];
    const weight = weights[key] ?? 0;
    if (!component?.comparable || weight <= 0) continue;
    weightUsed += weight;
    weighted += weight * component.similarity;
  }
  return {
    score: round4(weightUsed > 0 ? weighted / weightUsed : 0),
    weightUsed: round4(weightUsed)
  };
}

// scorePair(expected, portal, { weights }) ->
//   { score, weightUsed, weights, breakdown: { <component>: { expected, portal,
//     similarity, weight, contribution, comparable, rule } } }
export function scorePair(expected, portal, options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
  const sims = componentSimilarities(expected, portal);
  const { score, weightUsed } = combineSimilarities(sims, weights);

  const breakdown = {};
  for (const key of COMPONENT_KEYS) {
    const component = sims[key];
    const weight = weights[key] ?? 0;
    breakdown[key] = {
      expected: component.expected,
      portal: component.portal,
      similarity: component.similarity === null ? null : round4(component.similarity),
      weight,
      contribution: component.comparable ? round4(weight * component.similarity) : 0,
      comparable: component.comparable,
      rule: component.rule
    };
  }

  return { score, weightUsed, weights, breakdown };
}

export function isAutoMatch(score, thresholds = DEFAULT_THRESHOLDS) {
  return score >= thresholds.autoMatch;
}

export function isCandidateMatch(score, thresholds = DEFAULT_THRESHOLDS) {
  return score >= thresholds.suggest;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
