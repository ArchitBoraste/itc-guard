// One-to-one assignment. PURE — no db, no fs, no network.
//
// A books row matches at most one portal record and vice versa. Greedy by
// descending score: take the best remaining pair, consume both sides, repeat.
//
// This is what resolves a repeated invoice number. Two books rows sharing
// (supplier, invoice number) but differing in date or amount produce four
// candidate pairs; the two correct ones score higher than the two crossed ones,
// so greedy consumes the right pairing first and the crossed pairs are left with
// no free side. Giving up on the group instead would strand real credit.
import { DEFAULT_THRESHOLDS } from './score.js';

// Deterministic ordering: score desc, then the two indices asc. Without the
// tie-break, two identical-scoring pairs would be resolved by array order, and a
// re-run on re-ordered input would produce a different result.
export function comparePairs(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.expectedIndex !== b.expectedIndex) return a.expectedIndex - b.expectedIndex;
  return a.portalIndex - b.portalIndex;
}

// assignOneToOne(scoredPairs, { thresholds }) ->
//   { assigned: [pair], unassignedExpected: Set, unassignedPortal: Set }
export function assignOneToOne(scoredPairs, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const expectedCount = options.expectedCount ?? 0;
  const portalCount = options.portalCount ?? 0;

  const eligible = scoredPairs
    .filter((pair) => pair.score >= thresholds.suggest)
    .sort(comparePairs);

  const takenExpected = new Set();
  const takenPortal = new Set();
  const assigned = [];

  for (const pair of eligible) {
    if (takenExpected.has(pair.expectedIndex) || takenPortal.has(pair.portalIndex)) continue;
    takenExpected.add(pair.expectedIndex);
    takenPortal.add(pair.portalIndex);
    assigned.push(pair);
  }

  const unassignedExpected = [];
  for (let i = 0; i < expectedCount; i += 1) {
    if (!takenExpected.has(i)) unassignedExpected.push(i);
  }
  const unassignedPortal = [];
  for (let i = 0; i < portalCount; i += 1) {
    if (!takenPortal.has(i)) unassignedPortal.push(i);
  }

  return { assigned, unassignedExpected, unassignedPortal };
}
