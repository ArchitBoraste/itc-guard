// The served risk model.
//
// Two things are being pinned here, and they fail in opposite directions:
//
//   * score.js must reproduce what train.py computed. A drift between the two —
//     a mis-ordered coefficient, a mean applied to the wrong column — would not
//     throw. It would quietly re-rank the chase list, and every band on screen
//     would still look like a plausible band.
//
//   * the model must not be able to overrule the two evidence guards. They are
//     claims about how much is KNOWN about a supplier, and a probability fitted
//     on 200 synthetic rows is in no position to argue with them.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANDS,
  MIN_PERIODS_FOR_HIGH,
  applyGuards,
  bandFor,
  loadModel,
  modelProvenance,
  outOfDistribution,
  probabilityOf,
  scoreSupplier
} from '../../src/risk/score.js';

const MODEL = loadModel();
const MODEL_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ml', 'model.json'
);

// A supplier who is habitually a bit late and often wrong on the amounts.
const PROBE = Object.freeze({
  mean_days_late: 1.5,
  max_days_late: 4,
  mismatch_rate: 0.25,
  periods_observed: 5
});

// Computed by sklearn itself — LogisticRegression + StandardScaler on
// ml/training-data.csv — not by this code. That is the whole point: a number
// produced in Node could not catch a Node-side arithmetic error.
const SKLEARN_PROBABILITY = 0.996064164687;

describe('model.json', () => {
  it('is committed and loadable, so serving needs no Python', () => {
    expect(MODEL).not.toBeNull();
    expect(() => JSON.parse(readFileSync(MODEL_PATH, 'utf8'))).not.toThrow();
  });

  it('carries one coefficient, mean and std per named feature', () => {
    expect(MODEL.coefficients).toHaveLength(MODEL.featureNames.length);
    expect(MODEL.means).toHaveLength(MODEL.featureNames.length);
    expect(MODEL.stds).toHaveLength(MODEL.featureNames.length);
    // A zero std would divide the whole vector into infinity.
    for (const std of MODEL.stds) expect(std).toBeGreaterThan(0);
  });

  it('says out loud that it was fitted on synthetic data', () => {
    expect(modelProvenance().synthetic).toBe(true);
    expect(MODEL.meta.trainedOn).toContain('synthetic');
    // Sample size travels with the weights so nobody has to go looking for it.
    expect(MODEL.meta.rows).toBeGreaterThan(0);
    expect(MODEL.meta.positives).toBeGreaterThan(0);
  });
});

describe('score.js reproduces train.py', () => {
  it('lands on the same probability for a known input', () => {
    const { probability } = probabilityOf(PROBE);
    // Tight: this is the same arithmetic, so anything past float noise is a bug.
    expect(probability).toBeCloseTo(SKLEARN_PROBABILITY, 9);
  });

  it('standardises rather than using the raw feature values', () => {
    // A feature sitting exactly at its training mean contributes nothing, however
    // large its coefficient. If the standardisation were skipped it would not.
    const atTheMean = Object.fromEntries(
      MODEL.featureNames.map((name, index) => [name, MODEL.means[index]])
    );
    const { probability, contributions } = probabilityOf(atTheMean);
    for (const entry of contributions) expect(entry.contribution).toBeCloseTo(0, 12);
    expect(probability).toBeCloseTo(1 / (1 + Math.exp(-MODEL.intercept)), 12);
  });
});

describe('missing features', () => {
  // gstr3b_filed_ratio is null for every row this app can produce: GSTR-2B carries
  // `cfs`, docs/gstr2b-schema.md records that it is unverified whether that means
  // GSTR-1 or GSTR-3B, and the fixture generator hard-codes it to 'Y' regardless.
  it('does not break scoring when gstr3b_filed_ratio is null', () => {
    const scored = scoreSupplier({ ...PROBE, gstr3b_filed_ratio: null });
    expect(scored).not.toBeNull();
    expect(Number.isFinite(scored.probability)).toBe(true);
    expect(scored.probability).toBeCloseTo(SKLEARN_PROBABILITY, 9);
  });

  it('treats null, undefined and absent identically', () => {
    const base = scoreSupplier(PROBE).probability;
    for (const value of [null, undefined, Number.NaN]) {
      expect(scoreSupplier({ ...PROBE, gstr3b_filed_ratio: value }).probability).toBeCloseTo(base, 12);
    }
  });

  // Unknown is imputed to the training mean, which standardises to 0 — the
  // feature contributes NOTHING, rather than contributing a fabricated zero that
  // would read as "no mismatches at all".
  it('imputes a missing known feature to its mean instead of to zero', () => {
    const missing = probabilityOf({ ...PROBE, mismatch_rate: null });
    const mismatch = missing.contributions.find((entry) => entry.name === 'mismatch_rate');
    expect(mismatch.contribution).toBeCloseTo(0, 12);

    const asZero = probabilityOf({ ...PROBE, mismatch_rate: 0 });
    // A real zero is well below the training mean, so it must NOT look the same.
    expect(asZero.probability).not.toBeCloseTo(missing.probability, 3);
  });
});

describe('the two guards hold whatever the probability says', () => {
  it('never bands a supplier with no history as LOW', () => {
    // Forced past the point of argument: a probability of 0 is as confident as
    // the model can be, and it still must not produce LOW.
    expect(applyGuards(bandFor(0), { periodsObserved: 0 }).band).toBe('MEDIUM');
    expect(applyGuards('LOW', { periodsObserved: 0 }).guard).toBe('NO_HISTORY');

    const scored = scoreSupplier({ periods_observed: 0 });
    expect(scored.band).toBe('MEDIUM');
  });

  it('never bands a supplier as HIGH on fewer than three observed periods', () => {
    for (let observed = 1; observed < MIN_PERIODS_FOR_HIGH; observed += 1) {
      const guarded = applyGuards(bandFor(0.99), { periodsObserved: observed });
      expect(guarded.band).toBe('MEDIUM');
      expect(guarded.guard).toBe('THIN_HISTORY');
      expect(guarded.note).toContain('provisional');
    }
    // And releases the cap the moment there is enough to see a pattern.
    expect(applyGuards(bandFor(0.99), { periodsObserved: MIN_PERIODS_FOR_HIGH }).band).toBe('HIGH');
  });

  it('keeps the model band visible alongside the guarded one', () => {
    // One month, egregious. The guard caps the band, and modelBand still records
    // what the model actually said, so the override is inspectable rather than
    // silent.
    const scored = scoreSupplier({ ...PROBE, periods_observed: 1 });
    expect(scored.modelBand).toBe('HIGH');
    expect(scored.band).toBe('MEDIUM');
    expect(scored.guard).toBe('THIN_HISTORY');
  });

  it('leaves an ordinary well-evidenced supplier alone', () => {
    const scored = scoreSupplier({ ...PROBE, periods_observed: 6 });
    expect(scored.guard).toBeNull();
    expect(scored.band).toBe(scored.modelBand);
  });
});

describe('bands', () => {
  it('splits at 0.15 and 0.40', () => {
    expect(bandFor(0.05)).toBe('LOW');
    expect(bandFor(BANDS.low)).toBe('MEDIUM');
    expect(bandFor(0.3)).toBe('MEDIUM');
    expect(bandFor(BANDS.high)).toBe('MEDIUM');
    expect(bandFor(0.41)).toBe('HIGH');
  });
});

describe('topFactors', () => {
  it('names real features, in the direction each actually pushed', () => {
    const scored = scoreSupplier({
      mean_days_late: 6,      // well above the training mean: raises risk
      max_days_late: 9,
      mismatch_rate: 0.6,     // well above: raises risk
      periods_observed: 6     // above the mean: the model reads it as lowering
    });

    expect(scored.topFactors).toHaveLength(3);
    for (const factor of scored.topFactors) {
      expect(MODEL.featureNames).toContain(factor.feature);
      expect(['RAISES', 'LOWERS']).toContain(factor.direction);
    }

    const byFeature = Object.fromEntries(scored.topFactors.map((f) => [f.feature, f]));
    expect(byFeature.mismatch_rate.direction).toBe('RAISES');
    expect(byFeature.mean_days_late.direction).toBe('RAISES');
  });

  it('flips direction when the same feature moves the other way', () => {
    const good = scoreSupplier({
      mean_days_late: -6, max_days_late: -6, mismatch_rate: 0, periods_observed: 6
    });
    const byFeature = Object.fromEntries(good.topFactors.map((f) => [f.feature, f]));
    expect(byFeature.mismatch_rate.direction).toBe('LOWERS');
  });

  // Ranked by |contribution|, not by coefficient: the question is what is unusual
  // about THIS supplier, not which feature matters most in general.
  it('ranks by how far this supplier is from average, biggest first', () => {
    const scored = scoreSupplier(PROBE);
    const magnitudes = scored.topFactors.map((factor) => Math.abs(factor.contribution));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
  });

  // The tuple has to be self-describing. A supplier averaging exactly 0 days late
  // came back as { value: 0, direction: 'RAISES', contribution: 2.38 } — the
  // largest thing raising their risk — with nothing on the object saying 0 is two
  // standard deviations worse than a corpus that averages 3.7 days EARLY. Right
  // arithmetic, and it read as a broken model.
  it('says what each factor was compared against', () => {
    const meanDaysLateIndex = MODEL.featureNames.indexOf('mean_days_late');
    const onTheDeadline = scoreSupplier({ ...PROBE, mean_days_late: 0 });
    const factor = onTheDeadline.topFactors.find((f) => f.feature === 'mean_days_late');

    expect(factor.value).toBe(0);
    // The average supplier files EARLY, so 0 really is above average.
    expect(factor.mean).toBeCloseTo(MODEL.means[meanDaysLateIndex], 9);
    expect(factor.mean).toBeLessThan(0);
    expect(factor.relative).toBe('ABOVE_AVERAGE');
    expect(factor.direction).toBe('RAISES');
    // And the standardised distance is carried, so the size of the gap is
    // inspectable rather than only its sign.
    expect(factor.standardised).toBeGreaterThan(0);
  });

  it('marks a value better than average as below it, whatever the raw number', () => {
    const early = scoreSupplier({ ...PROBE, mean_days_late: -8 });
    const factor = early.topFactors.find((f) => f.feature === 'mean_days_late');
    expect(factor.relative).toBe('BELOW_AVERAGE');
    expect(factor.direction).toBe('LOWERS');
  });

  it('omits a feature that contributed nothing', () => {
    const atTheMean = Object.fromEntries(
      MODEL.featureNames.map((name, index) => [name, MODEL.means[index]])
    );
    expect(scoreSupplier(atTheMean).topFactors).toHaveLength(0);
  });
});

// The gap held-out metrics cannot show: the training corpus contains no supplier
// who failed to reach 2B, so filed_ratio_6m was dropped and the model has no term
// for that failure at all.
describe('out-of-distribution detection', () => {
  it('spots a supplier whose dropped-feature value the corpus never contained', () => {
    const outlier = outOfDistribution({ ...PROBE, filed_ratio_6m: 1 / 6 });
    expect(outlier.feature).toBe('filed_ratio_6m');
    expect(outlier.trainedConstant).toBe(1);
  });

  it('says nothing for a supplier who matches the corpus', () => {
    expect(outOfDistribution({ ...PROBE, filed_ratio_6m: 1, amendment_rate: 0 })).toBeNull();
  });

  it('does not treat unknown as different', () => {
    expect(outOfDistribution({ ...PROBE, filed_ratio_6m: null })).toBeNull();
    expect(outOfDistribution({ ...PROBE, gstr3b_filed_ratio: 0.5 })).toBeNull();
  });
});
