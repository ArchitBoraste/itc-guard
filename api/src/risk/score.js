// Supplier risk model, served. Standardise -> dot product -> sigmoid.
//
// ml/train.py fits it offline in Python and writes ml/model.json, which is
// COMMITTED. There is no Python at runtime and no inference library — a logistic
// regression is four lines of arithmetic, and shipping the weights as JSON keeps
// the serving path something a reader can check by hand.
//
// The bands and the two guards below come from phase 7 and are deliberately
// applied AFTER the probability. See BANDS and applyGuards().
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The model lives at ml/model.json relative to the REPO root, but the API runs
// from two different layouts: a checkout, where this file is api/src/risk/ and
// the root is three levels up, and the container, where the Dockerfile's context
// is api/ so the same file is /app/src/risk/ and the root is two levels up.
//
// Assuming one of them resolved to /ml/model.json in the other, loadModel()
// returned null, and the API quietly served the phase 7 fallback — correct
// behaviour, entirely invisible. Hence: try both, and record which one answered
// so a fallback can be diagnosed instead of guessed at.
export const MODEL_PATHS = [
  process.env.RISK_MODEL_PATH,
  join(HERE, '..', '..', '..', 'ml', 'model.json'), // checkout: api/src/risk
  join(HERE, '..', '..', 'ml', 'model.json') // container: /app/src/risk
].filter(Boolean);

export const BANDS = Object.freeze({ low: 0.15, high: 0.4 });

// Phase 7's guards, unchanged. They sit OUTSIDE the model on purpose: they are
// not claims about probability, they are claims about EVIDENCE, and no amount of
// confidence from four features fitted on 200 synthetic rows should be able to
// overrule them.
//
//   1. No filing history at all -> MEDIUM, never LOW. Absence of data is not
//      evidence of reliability. The model would happily return 0.05 for a
//      supplier it knows nothing about, because every feature imputes to its
//      mean and the intercept is negative — that is the model saying "average",
//      not "safe".
//   2. HIGH needs 3+ observed periods. A supplier seen once who filed a day late
//      must not top the chase list; one observation is 100% of the evidence and
//      still almost none of it.
export const MIN_PERIODS_FOR_HIGH = 3;

let cached;
let resolvedFrom = null;
let loadError = null;

// null when model.json is missing or malformed — callers fall back to phase 7's
// hand-weighted scorer rather than failing. The model is an improvement on the
// heuristic, not a dependency of the product.
export function loadModel({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;

  cached = null;
  resolvedFrom = null;
  loadError = `no model.json at any of: ${MODEL_PATHS.join(', ')}`;

  for (const path of MODEL_PATHS) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // not here; try the next layout
    }
    try {
      const model = JSON.parse(raw);
      if (!model.featureNames?.length || model.featureNames.length !== model.coefficients?.length) {
        throw new Error('featureNames and coefficients disagree');
      }
      cached = model;
      resolvedFrom = path;
      loadError = null;
      break;
    } catch (error) {
      // Found but unusable is a DIFFERENT problem from absent, and the message
      // has to say which — a corrupt model.json silently reading as "no model"
      // is how a bad retrain ships without anyone noticing.
      loadError = `model.json at ${path} is unusable: ${error.message}`;
      break;
    }
  }
  return cached;
}

export const modelPath = () => resolvedFrom;
export const modelLoadError = () => loadError;

// What is actually scoring, and what it was fitted on. The suppliers screen shows
// this next to the bands, because a band produced by a model trained on data we
// generated ourselves must not be presented as though it came from experience of
// real filings.
export function modelProvenance() {
  const model = loadModel();
  if (!model) {
    return {
      source: 'HEURISTIC',
      synthetic: false,
      note: 'No trained model is loaded. Bands come from the hand-weighted score in services/preventive.js.',
      // Why, not just that. A silent fallback is the failure mode here.
      loadError: modelLoadError()
    };
  }
  const meta = model.meta ?? {};
  return {
    source: 'MODEL',
    // Always true of the shipped model, and the single most important caveat.
    synthetic: true,
    path: modelPath(),
    features: model.featureNames,
    droppedFeatures: meta.droppedFeatures ?? {},
    rows: meta.rows ?? null,
    positives: meta.positives ?? null,
    suppliers: meta.suppliers ?? null,
    labelPeriods: meta.labelPeriods ?? [],
    holdoutPeriod: meta.holdoutPeriod ?? null,
    metrics: meta.metrics ?? null,
    beatsHeuristic: meta.beatsHeuristic ?? null
  };
}

// outOfDistribution(features, model) -> the offending feature, or null.
//
// train.py drops a feature that never varied in the training corpus, because a
// constant column has no coefficient worth fitting. That is correct — and it
// leaves a hole. A supplier whose value for a DROPPED feature is not the value
// the corpus always had is exhibiting something the model has never seen and
// cannot represent, so its probability for them is not a prediction, it is an
// extrapolation with a missing term.
//
// The case that made this concrete: `filed_ratio_6m` is 1 for all 200 training
// rows — in the fixtures every supplier reaches 2B every month. A supplier who
// reached 2B in ONE of six months therefore scores identically to a perfect one,
// 0.03, LOW. Held-out metrics cannot catch it, because the held-out period has no
// such supplier either. Callers use this to fall back to the hand-weighted
// scorer, which reads that fact directly.
//
// A NULL value never triggers this: unknown is not the same as different.
export function outOfDistribution(features, model = loadModel()) {
  const dropped = model?.meta?.droppedFeatures;
  if (!dropped) return null;

  for (const [name, info] of Object.entries(dropped)) {
    const constant = info?.constantValue;
    if (constant === null || constant === undefined) continue;
    const value = features?.[name];
    if (value === null || value === undefined || Number.isNaN(Number(value))) continue;
    if (Math.abs(Number(value) - constant) > 1e-9) {
      return { feature: name, value: Number(value), trainedConstant: constant };
    }
  }
  return null;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// probabilityOf(features, model) -> { probability, contributions }
//
// contributions[i] is coefficient x standardised value: the signed amount this
// feature moved THIS supplier's log-odds away from the average supplier. That is
// what topFactors ranks, and it is why a feature sitting exactly at the mean
// contributes nothing however large its coefficient.
export function probabilityOf(features, model = loadModel()) {
  if (!model) return null;

  const contributions = model.featureNames.map((name, index) => {
    const raw = features?.[name];
    // Unknown -> the training mean, which standardises to 0. Same rule train.py
    // used, so a missing feature contributes nothing rather than a fabricated 0.
    const value = raw === null || raw === undefined || Number.isNaN(raw)
      ? model.means[index]
      : Number(raw);
    // std can be 0 only if a constant column slipped past train.py's drop; 1
    // keeps the arithmetic finite instead of producing NaN for every supplier.
    const standardised = (value - model.means[index]) / (model.stds[index] || 1);
    return {
      name,
      value,
      // The average supplier in the training corpus. Carried through because
      // every statement about direction is relative to it — see scoreSupplier().
      mean: model.means[index],
      standardised,
      contribution: model.coefficients[index] * standardised
    };
  });

  const logOdds = contributions.reduce((sum, entry) => sum + entry.contribution, model.intercept);
  return { probability: sigmoid(logOdds), contributions };
}

export function bandFor(probability) {
  if (probability > BANDS.high) return 'HIGH';
  if (probability >= BANDS.low) return 'MEDIUM';
  return 'LOW';
}

// The guards, applied after the band. Returns the band plus the reason it was
// overridden, so the UI can say why rather than silently disagreeing with itself.
export function applyGuards(band, { periodsObserved }) {
  if (!periodsObserved) {
    return {
      band: 'MEDIUM',
      guard: 'NO_HISTORY',
      note: 'no filing history yet - this is the first period we have seen them'
    };
  }
  if (band === 'HIGH' && periodsObserved < MIN_PERIODS_FOR_HIGH) {
    return {
      band: 'MEDIUM',
      guard: 'THIN_HISTORY',
      note: `only ${periodsObserved} month${periodsObserved === 1 ? '' : 's'} of history so far, so this is a provisional read`
    };
  }
  return { band, guard: null, note: null };
}

// scoreSupplier(features) -> { probability, band, topFactors, guard, model } | null
//
// topFactors: the three features that moved THIS supplier's score most, with the
// direction each pushed. Ranked by |contribution|, not by coefficient — the
// question is what is unusual about this supplier, not which feature matters most
// in general.
export function scoreSupplier(features, { model = loadModel(), limit = 3 } = {}) {
  const scored = probabilityOf(features, model);
  if (!scored) return null;

  const periodsObserved = Number(features?.periods_observed ?? 0);
  const guarded = applyGuards(bandFor(scored.probability), { periodsObserved });

  const topFactors = [...scored.contributions]
    .filter((entry) => Math.abs(entry.contribution) > 1e-9)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, limit)
    .map((entry) => ({
      feature: entry.name,
      value: entry.value,
      // Everything below is RELATIVE TO `mean`, and the payload now says so
      // rather than leaving a reader to infer it.
      //
      // The failure this closes: a supplier averaging exactly 0 days late came
      // back as { value: 0, direction: 'RAISES', contribution: 2.38 } — the
      // largest thing raising their risk, with nothing on the object explaining
      // that 0 is two standard deviations WORSE than the corpus average of 3.7
      // days early. The arithmetic was right and the tuple read as broken.
      mean: entry.mean,
      standardised: entry.standardised,
      relative: entry.standardised > 0 ? 'ABOVE_AVERAGE' : 'BELOW_AVERAGE',
      // The effect on RISK, not a verdict on the raw value. A benign value can
      // raise risk simply by being less good than most.
      direction: entry.contribution > 0 ? 'RAISES' : 'LOWERS',
      contribution: entry.contribution
    }));

  return {
    probability: scored.probability,
    band: guarded.band,
    modelBand: bandFor(scored.probability),
    guard: guarded.guard,
    guardNote: guarded.note,
    topFactors,
    modelMeta: model.meta ?? null
  };
}
