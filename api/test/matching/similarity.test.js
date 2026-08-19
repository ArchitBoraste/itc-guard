import { describe, expect, it } from 'vitest';
import {
  amountSimilarity,
  amountsDiffer,
  dateSimilarity,
  gstinSimilarity,
  jaro,
  jaroWinkler
} from '../../src/matching/similarity.js';

// Reference values for the canonical Jaro / Jaro-Winkler test pairs. Worth
// pinning exactly: this is a hand-rolled implementation, and a subtly wrong
// transposition count would quietly skew every invoice-number comparison.
const REFERENCE = [
  { a: 'MARTHA', b: 'MARHTA', jaro: 0.944444, jw: 0.961111 },
  { a: 'DIXON', b: 'DICKSONX', jaro: 0.766667, jw: 0.813333 },
  { a: 'JELLYFISH', b: 'SMELLYFISH', jaro: 0.896296, jw: 0.896296 },
  { a: 'CRATE', b: 'TRACE', jaro: 0.733333, jw: 0.733333 },
  { a: 'DWAYNE', b: 'DUANE', jaro: 0.822222, jw: 0.84 }
];

describe('jaro / jaroWinkler', () => {
  it.each(REFERENCE)('matches the published value for $a vs $b', ({ a, b, jaro: j, jw }) => {
    expect(jaro(a, b)).toBeCloseTo(j, 5);
    expect(jaroWinkler(a, b)).toBeCloseTo(jw, 5);
  });

  it('is 1 for identical strings and 0 when one side is empty', () => {
    expect(jaroWinkler('INV2024891', 'INV2024891')).toBe(1);
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('ABC', '')).toBe(0);
    expect(jaroWinkler('', 'ABC')).toBe(0);
  });

  it('is symmetric', () => {
    for (const { a, b } of REFERENCE) {
      expect(jaroWinkler(a, b)).toBeCloseTo(jaroWinkler(b, a), 10);
    }
  });

  it('never leaves [0, 1]', () => {
    const samples = ['', 'A', '5-3886', '53886', 'LKNP27360617', 'ZZZZZZZZZZZZ', '1'];
    for (const a of samples) {
      for (const b of samples) {
        const value = jaroWinkler(a, b);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('withholds the prefix boost below the Jaro threshold', () => {
    // CRATE/TRACE shares no prefix and sits under 0.7 after boosting anyway.
    expect(jaroWinkler('CRATE', 'TRACE')).toBe(jaro('CRATE', 'TRACE'));
  });

  it('scores a one-digit change high but short of exact', () => {
    // The MODERATE_INV_NO case: same length, one digit different.
    const score = jaroWinkler('D1360', 'D3360');
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThan(1);
  });
});

describe('amountSimilarity', () => {
  it('is 1 for equal amounts', () => {
    expect(amountSimilarity(25399200, 25399200)).toBe(1);
    expect(amountSimilarity(0, 0)).toBe(1);
  });

  it('absorbs a rupee of rounding, which the official matcher cannot', () => {
    expect(amountSimilarity(25399200, 25399300)).toBe(1); // ₹1
    expect(amountSimilarity(10000000, 10004000)).toBe(1); // 0.04%, inside 0.5%
  });

  it('falls away in proportion to the gap', () => {
    // 50% apart
    expect(amountSimilarity(10000000, 5000000)).toBeCloseTo(0.5, 6);
    // a 10x transposition
    expect(amountSimilarity(7021000, 721000)).toBeCloseTo(0.10269, 4);
  });

  it('is symmetric and bounded', () => {
    expect(amountSimilarity(100, 900)).toBeCloseTo(amountSimilarity(900, 100), 10);
    expect(amountSimilarity(1, 1e12)).toBeGreaterThanOrEqual(0);
  });
});

describe('amountsDiffer', () => {
  it('ignores a rounding gap but catches a real difference', () => {
    expect(amountsDiffer(25399200, 25399200)).toBe(false);
    expect(amountsDiffer(25399200, 25399300)).toBe(false); // exactly ₹1
    expect(amountsDiffer(25399200, 25399301)).toBe(true);
    // The smallest value transposition in the fixtures is ₹9 of taxable value.
    expect(amountsDiffer(45841500, 46021500)).toBe(true);
  });

  it('uses an absolute tolerance so a large invoice cannot hide a rupee', () => {
    // 0.002% of a big number is still a real difference in money.
    expect(amountsDiffer(1000000000, 1000000900)).toBe(true);
  });
});

describe('dateSimilarity', () => {
  it('steps down with distance', () => {
    expect(dateSimilarity('2026-03-02', '2026-03-02')).toBe(1);
    expect(dateSimilarity('2026-03-02', '2026-03-03')).toBe(0.8);
    expect(dateSimilarity('2026-03-02', '2026-03-01')).toBe(0.8);
    expect(dateSimilarity('2026-03-02', '2026-03-05')).toBe(0.6);
    expect(dateSimilarity('2026-03-02', '2026-03-09')).toBe(0.3);
    expect(dateSimilarity('2026-03-02', '2026-03-10')).toBe(0);
  });

  it('is symmetric and spans month and year boundaries', () => {
    expect(dateSimilarity('2026-03-01', '2026-02-28')).toBe(0.8);
    expect(dateSimilarity('2026-01-01', '2025-12-31')).toBe(0.8);
    expect(dateSimilarity('2026-02-28', '2026-03-01')).toBe(0.8);
  });

  it('is 0 when either date is unusable', () => {
    expect(dateSimilarity(null, '2026-03-02')).toBe(0);
    expect(dateSimilarity('not-a-date', '2026-03-02')).toBe(0);
  });
});

describe('gstinSimilarity', () => {
  it('is exact-or-nothing', () => {
    expect(gstinSimilarity('27AABCU9603R1ZM', '27AABCU9603R1ZM')).toBe(1);
    // One character out is a different legal entity — no partial credit.
    expect(gstinSimilarity('08ZGWPN9226C9ZK', '08ZGWPN9266C9ZK')).toBe(0);
    expect(gstinSimilarity(null, '27AABCU9603R1ZM')).toBe(0);
  });
});
