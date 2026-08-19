// Pair scoring. PURE — no db, no fs, no network.
//
// Scores only fields that both sides genuinely carry. The purchase-register
// template has no place-of-supply and no invoice-value column, so those are null
// on every ExpectedInvoice and must never enter the score — a component that is
// null on one side would silently penalise every real match.
import { amountSimilarity, dateSimilarity, gstinSimilarity, jaroWinkler } from './similarity.js';

// Starting point from the build spec. Tunable — see tools/sweep-weights.js.
export const DEFAULT_WEIGHTS = Object.freeze({
  invoiceNo: 0.4,
  taxableValue: 0.25,
  totalTax: 0.15,
  invoiceDate: 0.35,
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
