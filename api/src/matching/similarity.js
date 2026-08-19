// Similarity primitives. PURE — no db, no fs, no network.
import { daysBetween } from './normalize.js';

// ---------------------------------------------------------------------------
// Jaro-Winkler, implemented here rather than pulled in as a dependency.
// ---------------------------------------------------------------------------

const WINKLER_SCALE = 0.1;        // standard prefix weight
const WINKLER_THRESHOLD = 0.7;    // boost only applies above this Jaro score
const WINKLER_MAX_PREFIX = 4;

export function jaro(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  // A character can only match one within this many positions either side.
  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const matched1 = new Array(s1.length).fill(false);
  const matched2 = new Array(s2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < s1.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, s2.length);
    for (let j = start; j < end; j += 1) {
      if (matched2[j] || s1[i] !== s2[j]) continue;
      matched1[i] = true;
      matched2[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  // Half the number of matched characters that appear out of order.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i += 1) {
    if (!matched1[i]) continue;
    while (!matched2[k]) k += 1;
    if (s1[i] !== s2[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  return (
    matches / s1.length +
    matches / s2.length +
    (matches - transpositions) / matches
  ) / 3;
}

export function jaroWinkler(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  const base = jaro(s1, s2);
  if (base <= WINKLER_THRESHOLD) return base;

  let prefix = 0;
  const limit = Math.min(WINKLER_MAX_PREFIX, s1.length, s2.length);
  while (prefix < limit && s1[prefix] === s2[prefix]) prefix += 1;

  return base + prefix * WINKLER_SCALE * (1 - base);
}

// ---------------------------------------------------------------------------
// Amounts — integer paise in, similarity out
// ---------------------------------------------------------------------------

export const AMOUNT_TOLERANCE_PAISE = 100;  // ₹1
export const AMOUNT_TOLERANCE_PCT = 0.005;  // 0.5%

// 1 - min(1, |a-b| / max(a,b,1)), with small differences treated as identical:
// a rounding gap of a rupee is not evidence of a different invoice. Absorbing it
// is exactly what GSTN's own exact-equality matcher cannot do.
export function amountSimilarity(a, b, options = {}) {
  const {
    tolerancePaise = AMOUNT_TOLERANCE_PAISE,
    tolerancePct = AMOUNT_TOLERANCE_PCT
  } = options;

  const x = Number(a ?? 0);
  const y = Number(b ?? 0);
  const difference = Math.abs(x - y);
  if (difference === 0) return 1;

  const scale = Math.max(Math.abs(x), Math.abs(y), 1);
  if (difference <= tolerancePaise || difference / scale <= tolerancePct) return 1;

  return 1 - Math.min(1, difference / scale);
}

// True when two amounts differ by more than a rounding gap — the test that
// separates MATCHED from VALUE_MISMATCH. Absolute only: a percentage tolerance
// here would let a large invoice hide a real rupee difference.
export function amountsDiffer(a, b, tolerancePaise = AMOUNT_TOLERANCE_PAISE) {
  return Math.abs(Number(a ?? 0) - Number(b ?? 0)) > tolerancePaise;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// Same day 1.0 · ±1d 0.8 · ±3d 0.6 · ±7d 0.3 · beyond 0.
export const DATE_SIMILARITY_STEPS = [
  { withinDays: 0, similarity: 1 },
  { withinDays: 1, similarity: 0.8 },
  { withinDays: 3, similarity: 0.6 },
  { withinDays: 7, similarity: 0.3 }
];

export function dateSimilarity(isoA, isoB, steps = DATE_SIMILARITY_STEPS) {
  const days = daysBetween(isoA, isoB);
  if (days === null) return 0;
  const distance = Math.abs(days);
  for (const step of steps) {
    if (distance <= step.withinDays) return step.similarity;
  }
  return 0;
}

// GSTIN is exact-or-nothing: a single wrong character is a different legal
// entity, so there is no meaningful partial credit. The typo case is recovered by
// the fallback blocking pass and flagged, not scored as partially similar.
export function gstinSimilarity(a, b) {
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}
