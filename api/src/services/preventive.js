// Preventive mode — the workflow that runs BEFORE the cut-off.
//
// The pitch rests on this file. Everything else in the app reconciles what has
// already happened; this one looks at what has NOT happened yet and says who to
// phone while their return is still a draft.
//
// Three decisions shape it, and each is a correctness issue rather than a style
// one:
//
//   1. IMS, NOT GSTR-2B. IMS shows a record from the moment the supplier SAVES,
//      days before they file. 2B does not exist until the 14th. Waiting for 2B
//      would mean the alert arrives after the only window in which the fix is
//      free.
//
//   2. THE CUT-OFF IS PER SUPPLIER. The 11th for a monthly GSTR-1 filer, the
//      13th for QRMP/IFF. The scheme comes from suppliers.filing_scheme, which
//      services/supplierStats.js infers from observed filing cadence. Telling a
//      trader "chase by the 13th" when that supplier files monthly costs them the
//      credit; the reverse marks every QRMP supplier late every month until the
//      trader stops reading.
//
//   3. RANK BY SUPPLIER RISK, NOT BY AMOUNT. On the 5th, a missing invoice from a
//      reliable supplier is NORMAL — GSTR-1 is not due until the 11th. A product
//      that raises 40 alerts on the 5th, 35 of which resolve themselves, is a
//      product nobody opens on the 12th. So every unreported invoice is listed,
//      but banded: HIGH is "phone them", LOW is "this is what a normal month
//      looks like".
//
// The bands are explained in words, never as a bare number — "filed late in 4 of
// the last 6 months" is something a trader can check against their own memory,
// "risk 0.41" is not.
//
// NOTHING IS SENT from here. buildChaseMessage() RETURNS text. No email, no
// WhatsApp, no integration — the trader copies it and sends it themselves.
import { pool } from '../db/pool.js';
import { BUCKETS, NON_IMS_SECTIONS } from '../matching/buckets.js';
import {
  FILING_SCHEMES,
  cutoffDate,
  daysToCutoff,
  filingWindow,
  isBeforeCutoff
} from '../matching/cutoff.js';
import { reconcile } from '../matching/index.js';
import { addMonths, dateToIso } from '../matching/normalize.js';
import { formatRupeesAscii } from '../matching/recommend.js';
import { ServiceError } from './ingest.js';
import { loadExpected, loadPortal } from './reconcile.js';
import { itcSign } from './totals.js';
import { loadModel, outOfDistribution, scoreSupplier } from '../risk/score.js';

// How far back the risk model looks. Six months is what the fixtures carry and
// what a trader can sanity-check from memory.
export const HISTORY_PERIODS = 6;

export const RISK_BANDS = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' });
export const BAND_ORDER = Object.freeze([RISK_BANDS.HIGH, RISK_BANDS.MEDIUM, RISK_BANDS.LOW]);

// alertBandFor(riskBand, preCutOff) -> the band the supplier is GROUPED under.
//
// The risk band is a claim about the supplier's filing RECORD and is deliberately
// date-free. The GROUP is not: "Normal for this point in the month" is a claim
// about the calendar as much as the supplier, and it stops being true the moment
// their own cut-off passes with nothing reported. Grouping on the risk band alone
// meant the three groups held the same members on the 5th and the 16th, so
// "Normal" still contained suppliers whose deadline had gone.
//
// Past their cut-off moves a supplier up exactly ONE band. Not straight to HIGH:
// after the cut-off every supplier on this screen is past it, so promoting them
// all would collapse the ranking to a single group on the one day the screen
// matters most — the opposite of the design, which exists so the 12th does not
// look like the 5th. One step keeps the record-based ordering intact underneath
// the calendar, so a habitually late supplier still outranks a reliable one who
// is merely out of time.
//
// preCutOff is true / false / null, and null means the date could not be worked
// out. Only an explicit false escalates: guessing would move somebody into a
// concern group on the strength of a failed calculation.
export function alertBandFor(riskBand, preCutOff) {
  const index = BAND_ORDER.indexOf(riskBand);
  if (index === -1) return riskBand;
  if (preCutOff !== false) return riskBand;
  // BAND_ORDER runs HIGH -> MEDIUM -> LOW, so one step "up" is one index down.
  return BAND_ORDER[Math.max(0, index - 1)];
}

// Why an invoice is on the list. All three are things a PHONE CALL fixes for
// free, because the supplier's record is still a draft.
//
// A record the supplier has already FILED is deliberately absent: per
// docs/gst-lifecycle-reference.md a post-filing fix needs GSTR-1A and reaches the
// recipient's 2B in the NEXT period. That is the reactive workflow's problem, not
// this one, and listing it here would promise a same-month recovery that cannot
// happen.
export const ALERT_STATUS = Object.freeze({
  NOT_REPORTED: 'NOT_REPORTED',
  SAVED_NOT_FILED: 'SAVED_NOT_FILED',
  SAVED_VALUE_MISMATCH: 'SAVED_VALUE_MISMATCH'
});

// Escalation as the deadline closes. Six days out is not one day out.
export const URGENCY = Object.freeze({
  EARLY: 'EARLY',
  CHASE: 'CHASE',
  URGENT: 'URGENT',
  LAST_DAY: 'LAST_DAY',
  PAST_CUTOFF: 'PAST_CUTOFF'
});

// Sort weight, not severity of consequence. PAST_CUTOFF ranks highest because it
// is the one the trader must be told about explicitly — the credit has already
// moved to next period and nothing they do today brings it back.
const URGENCY_RANK = Object.freeze({
  PAST_CUTOFF: 5,
  LAST_DAY: 4,
  URGENT: 3,
  CHASE: 2,
  EARLY: 1
});

export function urgencyFor(daysRemaining) {
  if (daysRemaining === null || daysRemaining === undefined) return URGENCY.EARLY;
  if (daysRemaining < 0) return URGENCY.PAST_CUTOFF;
  if (daysRemaining === 0) return URGENCY.LAST_DAY;
  if (daysRemaining <= 2) return URGENCY.URGENT;
  if (daysRemaining <= 5) return URGENCY.CHASE;
  return URGENCY.EARLY;
}

export const urgencyRank = (urgency) => URGENCY_RANK[urgency] ?? 0;

// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------
//
// TWO SCORERS, ONE OF THEM PREFERRED.
//
// Phase 8 trained a logistic regression (ml/train.py) and serves its weights from
// ml/model.json through risk/score.js. It replaces the hand-weighted SUM below
// and nothing else: the bands, the guards, the plain-English reasons and the UI
// are phase 7's and stay exactly as they were.
//
// The heuristic is kept as the FALLBACK, not as dead code. It runs whenever
// model.json is missing or unreadable, so a checkout without the model still
// ranks suppliers sensibly instead of failing. On the held-out period the model
// ranked better (ROC AUC 0.935 vs 0.900; pooled leave-one-period-out 0.897 vs
// 0.795), which is the only reason it is preferred — see README limitations for
// what those numbers are and are not evidence of.
//
// The hand-weighted sum, kept below:
//
// The question being scored is ONE thing: "will this supplier's invoice reach my
// GSTR-2B for THIS period?" There are exactly two ways it fails — they never
// report it, or they report it after their own cut-off, at which point it lands
// next period. So the headline term is the rate of periods where either happened.
//
//   failureRate  0.60  periods where they missed entirely OR filed late
//   notIn2bRate  0.20  periods where nothing of theirs reached 2B at all
//                      (deliberately overlaps failureRate — never reporting is
//                      strictly worse than reporting late, and earns weight twice)
//   lateness     0.12  HOW late, from mean and worst days past their own cut-off
//   mismatchRate 0.08  documents whose amounts did not agree with the books
//
// The HIGH threshold is not a tuned decimal: it is exactly
// `failureRate weight x 0.5`, so "failed in HALF the months I have watched them"
// lands in HIGH on that fact alone, before any other term is added. That is the
// line docs/gst-lifecycle-reference.md draws too — its worked example puts a
// supplier who was "late 3 of last 6 months" on the chase list.
//
//   late in 3 of 6      ~0.32  -> HIGH
//   late in 2 of 6      ~0.21  -> MEDIUM
//   on time in all 6     0.00  -> LOW
export const RISK_WEIGHTS = Object.freeze({
  failureRate: 0.6,
  notIn2bRate: 0.2,
  lateness: 0.12,
  mismatchRate: 0.08
});

export const RISK_BAND_THRESHOLDS = Object.freeze({
  high: RISK_WEIGHTS.failureRate * 0.5,
  medium: 0.12
});

// HIGH is a claim about a PATTERN, and one month is not a pattern. A supplier
// seen once who was a day late scores 1.0 on failure rate and would otherwise
// come out top of the chase list on a single observation — the same
// cry-wolf failure the banding exists to prevent, arriving by a different route.
// Below this many observed periods the band is capped at MEDIUM and the reasons
// say how thin the evidence is.
export const MIN_PERIODS_FOR_HIGH = 3;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round4 = (value) => Math.round(value * 10000) / 10000;

function bandFor(score) {
  if (score >= RISK_BAND_THRESHOLDS.high) return RISK_BANDS.HIGH;
  if (score >= RISK_BAND_THRESHOLDS.medium) return RISK_BANDS.MEDIUM;
  return RISK_BANDS.LOW;
}

// heuristicRisk(periods, { scheme }) -> { band, score, reasons, features }
//
// PURE. `periods` is one entry per prior tax period in which the trader either
// booked a purchase from this supplier or observed something of theirs on the
// portal — see loadSupplierHistory().
//
// No history at all is MEDIUM, not LOW. A supplier nobody has ever watched file
// is not evidence of reliability, and calling them low risk is the one mistake
// here that silently loses money.
export function heuristicRisk(periods = [], { scheme = FILING_SCHEMES.MONTHLY } = {}) {
  const cutOffDay = scheme === FILING_SCHEMES.QRMP ? 13 : 11;

  if (!periods.length) {
    return {
      band: RISK_BANDS.MEDIUM,
      score: null,
      reasons: ['no filing history yet - this is the first period we have seen them'],
      features: { periodsObserved: 0, cutOffDay },
      guard: 'NO_HISTORY',
      source: 'HEURISTIC'
    };
  }

  const observed = periods.length;
  const notIn2b = periods.filter((entry) => !entry.appearedIn2b).length;
  const lateCount = periods.filter((entry) => entry.filedLate).length;
  const missedCount = periods.filter((entry) => entry.missed).length;
  const failed = periods.filter((entry) => entry.filedLate || !entry.appearedIn2b).length;

  const daysLateValues = periods
    .map((entry) => entry.daysLate)
    .filter((value) => value !== null && value !== undefined);
  const meanDaysLate = mean(daysLateValues);
  const maxDaysLate = daysLateValues.length ? Math.max(...daysLateValues) : null;

  const documents = periods.reduce((sum, entry) => sum + entry.invoiceCount, 0);
  const mismatches = periods.reduce((sum, entry) => sum + entry.mismatchCount, 0);
  const mismatchRate = documents ? mismatches / documents : 0;

  // Mean carries most of the weight; the worst month is the tail that separates
  // one bad month from a habit.
  const latenessMagnitude =
    clamp01(Math.max(meanDaysLate ?? 0, 0) / 7) * 0.6 +
    clamp01(Math.max(maxDaysLate ?? 0, 0) / 14) * 0.4;

  const failureRate = failed / observed;
  const notIn2bRate = notIn2b / observed;

  const score = round4(
    RISK_WEIGHTS.failureRate * failureRate +
      RISK_WEIGHTS.notIn2bRate * notIn2bRate +
      RISK_WEIGHTS.lateness * latenessMagnitude +
      RISK_WEIGHTS.mismatchRate * clamp01(mismatchRate)
  );

  const features = {
    periodsObserved: observed,
    notIn2bCount: notIn2b,
    lateCount,
    missedCount,
    failedCount: failed,
    meanDaysLate: meanDaysLate === null ? null : Math.round(meanDaysLate * 10) / 10,
    maxDaysLate,
    documents,
    mismatches,
    mismatchRate: round4(mismatchRate),
    cutOffDay
  };

  let band = bandFor(score);
  if (band === RISK_BANDS.HIGH && observed < MIN_PERIODS_FOR_HIGH) band = RISK_BANDS.MEDIUM;

  return { band, score, reasons: riskReasons(features), features, source: 'HEURISTIC' };
}

// ---------------------------------------------------------------------------
// The trained model
// ---------------------------------------------------------------------------

// Phase 7's rich feature object -> the vector ml/model.json was fitted on.
//
// Deliberately derived from the SAME numbers the heuristic uses, so the two
// scorers are two weightings of one description of a supplier rather than two
// competing descriptions. That is also what makes the train.py comparison fair.
//
// filed_ratio_6m, amendment_rate and gstr3b_filed_ratio are still produced here
// even though train.py dropped all three from THIS model — the vector is the
// stable contract, and score.js simply ignores names the model does not carry.
// A retrained model on a corpus where they vary would pick them up with no
// change on this side.
export function modelFeatures(features) {
  const observed = features.periodsObserved ?? 0;
  return {
    filed_ratio_6m: observed ? (observed - (features.notIn2bCount ?? 0)) / observed : 0,
    mean_days_late: features.meanDaysLate ?? 0,
    max_days_late: features.maxDaysLate ?? 0,
    mismatch_rate: features.mismatchRate ?? 0,
    // Not derivable from anything this app ingests; see train.py. Passed as null
    // rather than 0 so score.js imputes it instead of reading "no amendments".
    amendment_rate: null,
    periods_observed: observed,
    gstr3b_filed_ratio: null
  };
}

// A model factor -> what a trader reads, plus whether it is ADVERSE.
//
// Two jobs, and they were conflated. The model ranks by |contribution|, which is
// distance from the AVERAGE SUPPLIER — so a supplier who averages exactly 0 days
// late comes top of the list, because the corpus average is 3.7 days early and 0
// is two standard deviations worse than that. True, and unreadable: "0 days late
// is the main reason this supplier is risky" is not a sentence anyone can act on.
//
// So a factor now yields:
//   sentence  always a statement of the underlying COUNTS, in phase 7's style
//   adverse   whether that sentence asserts something bad about the supplier
//
// When a RAISES factor is not adverse, the sentence is COMPARATIVE and names the
// comparison out loud — "closer to their deadline than most suppliers manage" —
// so the direction makes sense instead of looking like a mistake. And adverse
// readings are ordered ahead of comparative ones, so a supplier is never headed
// by a fact that is not a problem.
function factorReading({ feature, direction, mean }, features) {
  const observed = features.periodsObserved ?? 0;
  const window = `the last ${plural(observed, 'month')}`;
  const deadline = ordinal(features.cutOffDay);

  // "most suppliers file about 4 days early" — the corpus average, in words, so
  // a comparative sentence says what it is comparing against.
  const averageHabit = (average) => {
    if (average === null || average === undefined) return 'most suppliers';
    const days = Math.round(Math.abs(average));
    if (average < 0) return `most file about ${plural(days, 'day')} early`;
    if (average > 0) return `most run about ${plural(days, 'day')} over`;
    return 'most file on the deadline';
  };

  switch (feature) {
    case 'mean_days_late':
      // Adversity is judged on whether they were ACTUALLY late in a month, not on
      // where their average sits against the corpus. A supplier can be above the
      // corpus average while never having missed a deadline.
      if (features.lateCount > 0) {
        return { sentence: `filed late in ${features.lateCount} of ${window}`, adverse: true };
      }
      // The comparative framing is reserved for a supplier who actually sits ON or
      // PAST their deadline on average. Below that it over-reaches: filing three
      // days early against a corpus average of four is a real nudge to the
      // probability and a ridiculous thing to narrate, and "less room if anything
      // slips" would be noise on a supplier who has never once been late.
      if (direction === 'RAISES' && (features.meanDaysLate ?? -1) >= 0) {
        const own =
          features.meanDaysLate === 0
            ? 'files on the deadline itself'
            : `averages ${plural(Math.round(features.meanDaysLate), 'day')} past it`;
        return {
          sentence:
            `never missed their ${deadline} in ${window}, but ${own} — ` +
            `${averageHabit(mean)}, so there is no room if anything slips`,
          adverse: false
        };
      }
      return {
        sentence: `filed on time in all of ${window}, by their ${deadline}`,
        adverse: false
      };

    case 'max_days_late':
      return features.maxDaysLate > 0
        ? {
            sentence: `worst month was ${plural(features.maxDaysLate, 'day')} past their ${deadline}`,
            adverse: true
          }
        : { sentence: `never later than their ${deadline} in ${window}`, adverse: false };

    case 'mismatch_rate':
      return features.mismatches > 0
        ? {
            sentence:
              `amounts differed from your books on ${features.mismatches} of ` +
              `${plural(features.documents, 'document')}`,
            adverse: true
          }
        : {
            sentence: `amounts matched your books on all ${plural(features.documents, 'document')}`,
            adverse: false
          };

    case 'periods_observed':
      // Never adverse. How much has been seen is a statement about the EVIDENCE,
      // not about the supplier.
      return {
        sentence:
          direction === 'LOWERS'
            ? `${plural(observed, 'month')} of filing history to judge from`
            : `only ${plural(observed, 'month')} of history so far`,
        adverse: false
      };

    case 'filed_ratio_6m':
      return features.notIn2bCount > 0
        ? {
            sentence:
              `nothing of theirs reached your GSTR-2B in ${features.notIn2bCount} of ${window}`,
            adverse: true
          }
        : {
            sentence: `something of theirs reached your GSTR-2B in every one of ${window}`,
            adverse: false
          };

    default:
      return null;
  }
}

// scoreSupplierRisk(periods, { scheme }) -> { band, score, reasons, features, ... }
//
// The model when it is loadable, the phase 7 heuristic when it is not. Same
// return shape either way, so nothing downstream has to know which ran — only
// `source` differs, and the UI uses it to say which one produced the ranking.
//
// THE TWO GUARDS ARE APPLIED AFTER THE PROBABILITY, in risk/score.js:
//   no history      -> MEDIUM, never LOW
//   fewer than 3 observed periods -> capped at MEDIUM, never HIGH
// They are not part of the model and must not be. They are statements about how
// much EVIDENCE exists, and a probability fitted on 200 synthetic rows is in no
// position to overrule them — a supplier we know nothing about scores near the
// base rate, which is the model saying "average", not "safe".
export function scoreSupplierRisk(periods = [], { scheme = FILING_SCHEMES.MONTHLY } = {}) {
  const heuristic = heuristicRisk(periods, { scheme });

  // Nothing observed means there is no feature vector worth standardising: every
  // value would impute to its own training mean, and the model would answer with
  // the base rate dressed up as a prediction about this supplier. The guard's
  // answer — MEDIUM, and say the history is empty — is the whole of what can
  // honestly be said here, so it is returned directly.
  if (!periods.length) return heuristic;

  if (!loadModel()) return heuristic;

  const vector = modelFeatures(heuristic.features);

  // This supplier shows something the training corpus never contained, so the
  // model has no term for it — see outOfDistribution(). The heuristic reads the
  // fact directly and is the better answer here, however confident the model is.
  //
  // Concretely: every supplier in the fixtures reaches 2B every month, so
  // filed_ratio_6m was dropped for having no variance. Without this the model
  // rates a supplier who reached 2B in one month of six at 0.03 — LOW — because
  // the only feature that could tell them apart is not in the model at all.
  const outlier = outOfDistribution(vector);
  if (outlier) {
    return {
      ...heuristic,
      source: 'HEURISTIC',
      fallbackReason: 'OUT_OF_DISTRIBUTION',
      outOfDistribution: outlier
    };
  }

  const scored = scoreSupplier(vector);
  if (!scored) return heuristic;

  // Top factors become the reasons — but ADVERSE ONES FIRST, not most-influential
  // first.
  //
  // The model ranks by distance from the average supplier, which is the right way
  // to rank a probability and the wrong way to order an explanation. Deepak Sales
  // Corp averages exactly 0 days late; the corpus average is 3.7 days EARLY, so
  // mean_days_late was their largest RAISES factor and led the list. "0 days late
  // is the main reason this supplier is risky" is correct arithmetic and an
  // unreadable sentence.
  //
  // So the reading decides the order: something actually wrong leads, and a
  // merely-worse-than-average fact follows, phrased comparatively so the
  // direction makes sense when it is shown at all.
  const readings = [];
  for (const factor of scored.topFactors) {
    // When a guard fired it already says how thin the history is, and better —
    // "only 1 month of history so far, so this is a provisional read" against the
    // factor's bare "only 1 month of history so far". Printing both reads as a
    // stutter and neither sentence is doing the other's work.
    if (factor.feature === 'periods_observed' && scored.guard) continue;
    const reading = factorReading(factor, heuristic.features);
    if (reading) readings.push({ ...factor, ...reading });
  }

  // Stable within each group, so the model's ranking still decides the order of
  // two adverse facts — it only cannot promote a non-adverse one above them.
  const ordered = [
    ...readings.filter((entry) => entry.adverse),
    ...readings.filter((entry) => !entry.adverse)
  ];

  const reasons = [];
  for (const entry of ordered) {
    if (!reasons.includes(entry.sentence)) reasons.push(entry.sentence);
  }
  if (!reasons.length) reasons.push(...heuristic.reasons);
  if (scored.guardNote && !reasons.includes(scored.guardNote)) reasons.push(scored.guardNote);

  return {
    band: scored.band,
    // The probability, for persistence and ranking. It is NEVER rendered as a
    // number — see the UI, which shows the band and the sentences only.
    score: Math.round(scored.probability * 10000) / 10000,
    probability: scored.probability,
    reasons,
    features: heuristic.features,
    topFactors: ordered,
    guard: scored.guard,
    modelBand: scored.modelBand,
    heuristicScore: heuristic.score,
    source: 'MODEL'
  };
}

// Plain words, in the order that would matter on a phone call. Never a bare
// score — a sentence the trader can disagree with is worth more than a number
// they can only accept.
export function riskReasons(features) {
  const observed = features.periodsObserved;
  const window = `the last ${plural(observed, 'month')}`;
  const deadline = ordinal(features.cutOffDay);
  const reasons = [];

  if (features.missedCount > 0) {
    reasons.push(`reported nothing at all in ${features.missedCount} of ${window}`);
  }
  if (features.notIn2bCount > features.missedCount) {
    const savedOnly = features.notIn2bCount - features.missedCount;
    reasons.push(`reported but never reached your GSTR-2B in ${savedOnly} of ${window}`);
  }
  if (features.lateCount > 0) {
    reasons.push(`filed late in ${features.lateCount} of ${window}`);
  }
  if (features.maxDaysLate !== null && features.maxDaysLate > 0) {
    // Mean and worst are only worth saying separately when they differ. On a
    // single late month they are the same number, and printing it twice reads
    // like padding.
    reasons.push(
      features.meanDaysLate !== null && features.meanDaysLate !== features.maxDaysLate
        ? `on average ${plural(features.meanDaysLate, 'day')} past their ${deadline}, ` +
            `worst was ${plural(features.maxDaysLate, 'day')}`
        : `${plural(features.maxDaysLate, 'day')} past their ${deadline}`
    );
  }
  if (features.mismatches > 0) {
    reasons.push(
      `amounts differed from your books on ${features.mismatches} of ` +
        `${plural(features.documents, 'document')}`
    );
  }

  if (!reasons.length) {
    reasons.push(`filed on time in all of ${window}, by their ${deadline}`);
  }

  // Said last, and only when it applies: the reader has to know the sample is
  // thin before acting on anything above.
  if (observed < MIN_PERIODS_FOR_HIGH) {
    reasons.push(
      `only ${plural(observed, 'month')} of history so far, so this is a provisional read`
    );
  }
  return reasons;
}

// "1 day" / "2 days". Mean days late can be fractional, and 1.5 takes the plural.
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function ordinal(day) {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th';
  return `${day}${suffix}`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

// The periods BEFORE taxPeriod. Used by preventiveAlerts(), where the trader is
// standing in the middle of taxPeriod and it has not finished yet — a supplier
// who has not filed on the 5th has not filed LATE, they simply have not filed.
export function historyPeriodsFor(taxPeriod, count = HISTORY_PERIODS) {
  const periods = [];
  for (let back = count; back >= 1; back -= 1) {
    const period = addMonths(taxPeriod, -back);
    if (period) periods.push(period);
  }
  return periods;
}

// The periods UP TO AND INCLUDING taxPeriod. Used by rebuildSupplierRisk(), where
// the period is complete and the question is "what do I now know about this
// supplier", not "what could I have known before the month started".
//
// The two windows exist because the two questions are different, and confusing
// them is what put a contradiction on the Suppliers screen: the Late column
// counted every observed period while the risk reasons counted only the periods
// before the one on screen. Deepak Sales Corp filed two days EARLY in March and
// two days LATE in April, so the row read "Late 1" beside "filed on time in all
// of the last 1 month" — both true, about different spans, neither saying which.
//
// Nothing about training changes: ml/train.py still learns features-before-P
// against a label-at-P. Serving with features through P predicts P+1, which is
// the same shape pointed one month forward.
export function historyPeriodsThrough(taxPeriod, count = HISTORY_PERIODS) {
  return [...historyPeriodsFor(taxPeriod, count - 1), taxPeriod].filter(Boolean);
}

// gstin -> [{ taxPeriod, expectedCount, invoiceCount, appearedIn2b, appearedInIms,
//             daysLate, filedLate, missed, mismatchCount }]
//
// Two sources, because supplier_periods only knows about suppliers who have been
// SEEN on the portal — syncSuppliers derives the master from portal_records. A
// supplier the trader has bought from for six months who has never reported
// anything has no supplier_periods rows at all, and they are the single highest
// risk there is. Reading the books side separately is what tells them apart from
// a brand-new supplier with no history either way.
async function loadSupplierHistory(orgId, periods) {
  const history = new Map();
  if (!periods.length) return history;

  const ensure = (gstin, taxPeriod) => {
    if (!history.has(gstin)) history.set(gstin, new Map());
    const byPeriod = history.get(gstin);
    if (!byPeriod.has(taxPeriod)) {
      byPeriod.set(taxPeriod, {
        taxPeriod,
        expectedCount: 0,
        invoiceCount: 0,
        appearedIn2b: false,
        appearedInIms: false,
        daysLate: null,
        filedLate: false,
        missed: false,
        mismatchCount: 0
      });
    }
    return byPeriod.get(taxPeriod);
  };

  const [portalRows] = await pool.query(
    `SELECT s.gstin, sp.tax_period, sp.expected_count, sp.invoice_count,
            sp.appeared_in_2b, sp.appeared_in_ims, sp.mismatch_count,
            sp.days_late, sp.filed_late, sp.missed
       FROM supplier_periods sp
       JOIN suppliers s ON s.id = sp.supplier_id AND s.org_id = sp.org_id
      WHERE sp.org_id = ? AND sp.tax_period IN (?)`,
    [orgId, periods]
  );
  for (const row of portalRows) {
    const entry = ensure(row.gstin, row.tax_period);
    entry.expectedCount = Number(row.expected_count);
    entry.invoiceCount = Number(row.invoice_count);
    entry.appearedIn2b = Boolean(row.appeared_in_2b);
    entry.appearedInIms = Boolean(row.appeared_in_ims);
    entry.mismatchCount = Number(row.mismatch_count);
    entry.daysLate = row.days_late === null ? null : Number(row.days_late);
    entry.filedLate = Boolean(row.filed_late);
    entry.missed = Boolean(row.missed);
  }

  const [booksRows] = await pool.query(
    `SELECT supplier_gstin, tax_period, COUNT(*) AS expected_count
       FROM expected_invoices
      WHERE org_id = ? AND tax_period IN (?)
      GROUP BY supplier_gstin, tax_period`,
    [orgId, periods]
  );
  for (const row of booksRows) {
    const entry = ensure(row.supplier_gstin, row.tax_period);
    entry.expectedCount = Math.max(entry.expectedCount, Number(row.expected_count));
    // Booked a purchase and nothing of theirs was observed on the portal: that
    // period is a miss, whether or not a supplier_periods row exists to say so.
    if (entry.invoiceCount === 0) entry.missed = true;
  }

  const ordered = new Map();
  for (const [gstin, byPeriod] of history) {
    ordered.set(
      gstin,
      [...byPeriod.values()].sort((a, b) => a.taxPeriod.localeCompare(b.taxPeriod))
    );
  }
  return ordered;
}

async function loadSupplierMaster(orgId) {
  const [rows] = await pool.query(
    `SELECT gstin, trade_name, legal_name, filing_scheme, filing_scheme_confidence,
            filing_scheme_reason, contact_phone
       FROM suppliers WHERE org_id = ?`,
    [orgId]
  );
  return new Map(rows.map((row) => [row.gstin, row]));
}

async function loadOrg(orgId) {
  const [rows] = await pool.query(
    'SELECT id, gstin, legal_name, trade_name, filer_type FROM organizations WHERE id = ?',
    [orgId]
  );
  if (!rows.length) throw new ServiceError('organization not found', 404, 'not_found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// The alert set
// ---------------------------------------------------------------------------

// preventiveAlerts(orgId, { taxPeriod, asOfDate }) -> alert set
//
// asOfDate is the clock the whole answer is measured against. It is a PARAMETER
// rather than `new Date()` so the demo can walk through the month — the 5th, the
// 10th, the 12th, the 16th — without touching the system clock, and so a test can
// assert what the trader is told on each of those days.
export async function preventiveAlerts(
  orgId,
  { taxPeriod, asOfDate = null, historyPeriods = HISTORY_PERIODS } = {}
) {
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod ?? ''))) {
    throw new ServiceError('taxPeriod must be YYYY-MM');
  }
  if (asOfDate && !dateToIso(asOfDate)) {
    throw new ServiceError('asOf must be an ISO date, yyyy-mm-dd');
  }
  const asOf = dateToIso(asOfDate) ?? new Date().toISOString().slice(0, 10);

  const org = await loadOrg(orgId);
  const priorPeriods = historyPeriodsFor(taxPeriod, historyPeriods);

  const [expected, portal, master, history] = await Promise.all([
    loadExpected(orgId, taxPeriod),
    loadPortal(orgId, taxPeriod),
    loadSupplierMaster(orgId),
    loadSupplierHistory(orgId, priorPeriods)
  ]);

  // IMS ONLY. 2B does not exist before the 14th, and a record that has merely
  // been SAVED — exactly what this mode looks for — never appears in 2B at all.
  const imsRecords = portal.filter((record) => record.source === 'IMS');

  // The 2B side is NOT matched against — it is only read, per invoice, to say
  // what the row's absence from IMS actually means.
  //
  // Without it every books row with no IMS record was told "the supplier has not
  // even saved it yet", and on the April sample that sentence was false on 32 of
  // 34 rows: those documents were filed weeks earlier and were sitting in 2B.
  // Most of them are reverse-charge or Sec 17(5) records, which per
  // docs/gst-lifecycle-reference.md NEVER enter IMS at all — absence from IMS is
  // their correct and permanent state, not a supplier who is late.
  //
  // Nothing here changes which rows are listed or what any total comes to. It
  // changes what the row is allowed to claim about why it is there.
  const twoB = twoBIndex(portal);

  const results = reconcile(expected, imsRecords, { asOfDate: asOf, taxPeriod });

  const bySupplier = new Map();
  for (const result of results) {
    const item = alertItemFor(result, twoB);
    if (!item) continue;
    const gstin = result.expected.supplierGstin;
    if (!bySupplier.has(gstin)) bySupplier.set(gstin, []);
    bySupplier.get(gstin).push(item);
  }

  const suppliers = [];
  for (const [gstin, invoices] of bySupplier) {
    const supplier = master.get(gstin) ?? null;
    const scheme = supplier?.filing_scheme ?? FILING_SCHEMES.MONTHLY;
    const risk = scoreSupplierRisk(history.get(gstin) ?? [], { scheme });

    const cutOff = cutoffDate(taxPeriod, scheme);
    const daysRemaining = daysToCutoff(asOf, taxPeriod, scheme);
    const preCutOff = isBeforeCutoff(asOf, taxPeriod, scheme);
    const urgency = urgencyFor(daysRemaining);

    invoices.sort(
      (a, b) =>
        Math.abs(b.itcAtStake) - Math.abs(a.itcAtStake) ||
        String(a.invoiceNo).localeCompare(String(b.invoiceNo))
    );

    const itcAtStake = invoices.reduce((sum, invoice) => sum + invoice.itcAtStake, 0);
    const name = supplier?.trade_name ?? supplier?.legal_name ?? invoices[0].supplierName ?? gstin;

    const entry = {
      gstin,
      tradeName: name,
      legalName: supplier?.legal_name ?? null,
      contactPhone: supplier?.contact_phone ?? null,
      filingScheme: scheme,
      filingSchemeConfidence: supplier?.filing_scheme_confidence ?? null,
      filingSchemeReason: supplier?.filing_scheme_reason ?? null,
      cutOffDate: cutOff,
      daysToCutOff: daysRemaining,
      preCutOff,
      urgency,
      urgencyRank: urgencyRank(urgency),
      risk,
      // Which group they appear under. risk.band is untouched — the model's
      // verdict on their record — and alertBand is that verdict read against
      // today's date. They differ exactly when the cut-off has passed, and
      // `escalated` says so, so the UI can explain why a reliable supplier is
      // sitting in a concern group.
      alertBand: alertBandFor(risk.band, preCutOff),
      escalated: alertBandFor(risk.band, preCutOff) !== risk.band,
      invoiceCount: invoices.length,
      itcAtStake,
      statusCounts: countStatuses(invoices),
      invoices,
      headline: headlineFor({ name, invoices, daysRemaining, urgency, band: risk.band }),
      consequence: consequenceFor({ taxPeriod, cutOff, daysRemaining, preCutOff, itcAtStake })
    };
    entry.chaseMessage = buildChaseMessage({ org, supplier: entry, taxPeriod, asOf });
    suppliers.push(entry);
  }

  // Band first — that is the whole point of the ranking. Amount only breaks ties
  // inside a band, never lifts a reliable supplier above an unreliable one.
  suppliers.sort(
    (a, b) =>
      BAND_ORDER.indexOf(a.alertBand) - BAND_ORDER.indexOf(b.alertBand) ||
      b.urgencyRank - a.urgencyRank ||
      Math.abs(b.itcAtStake) - Math.abs(a.itcAtStake) ||
      a.gstin.localeCompare(b.gstin)
  );

  const bands = BAND_ORDER.map((band) => {
    const members = suppliers.filter((entry) => entry.alertBand === band);
    return {
      band,
      supplierCount: members.length,
      invoiceCount: members.reduce((sum, entry) => sum + entry.invoiceCount, 0),
      itcAtStake: members.reduce((sum, entry) => sum + entry.itcAtStake, 0),
      // How many are here because their cut-off passed rather than because of
      // their filing record. The group header says so rather than applying a
      // record-based sentence to somebody whose record is clean.
      escalatedCount: members.filter((entry) => entry.escalated).length,
      pastCutOffCount: members.filter((entry) => entry.preCutOff === false).length,
      suppliers: members
    };
  });

  return {
    taxPeriod,
    asOfDate: asOf,
    // The trader's OWN window, for the screen's headline. Each supplier still
    // carries their own cut-off, which is what any individual decision uses.
    window: filingWindow(asOf, taxPeriod, org.filer_type ?? FILING_SCHEMES.MONTHLY),
    orgCutOffDate: cutoffDate(taxPeriod, org.filer_type ?? FILING_SCHEMES.MONTHLY),
    nextTaxPeriod: addMonths(taxPeriod, 1),
    historyPeriods: priorPeriods,
    totals: {
      supplierCount: suppliers.length,
      invoiceCount: suppliers.reduce((sum, entry) => sum + entry.invoiceCount, 0),
      itcAtStake: suppliers.reduce((sum, entry) => sum + entry.itcAtStake, 0),
      expectedInvoices: expected.length,
      imsRecords: imsRecords.length,
      // How many of the listed documents GSTR-2B already carries, and how many of
      // those can never enter IMS at all. This is what makes this screen's count
      // reconcile with the Summary screen's — see the note both screens carry.
      inGstr2bCount: countInvoices(suppliers, (invoice) => invoice.inGstr2b),
      neverEntersImsCount: countInvoices(
        suppliers,
        (invoice) => invoice.neverEntersImsReason !== null
      )
    },
    bands,
    suppliers
  };
}

// One match result -> one alert item, or null when there is nothing to chase.
//
// Skipped on purpose:
//   * anything with no books side. MISSING_IN_BOOKS is a reactive-mode problem;
//     there is nothing for the supplier to do about it.
//   * reverse-charge and ITC-ineligible purchases. Per docs/, RCM records never
//     enter IMS at all, so "not in IMS" is their correct state and an alert on
//     them would be permanently wrong.
//   * anything the supplier has already FILED. Their fix now needs GSTR-1A and
//     lands next period; see consequenceFor().
function alertItemFor(result, twoB = null) {
  const { expected, portal, bucket } = result;
  if (!expected) return null;
  if (expected.reverseCharge) return null;
  if (String(expected.itcEligibility ?? '').toLowerCase().startsWith('ineligible')) return null;
  if (portal?.reverseCharge || portal?.itcAvailable === false) return null;

  let status = null;
  if (bucket === BUCKETS.MISSING_IN_PORTAL) {
    status = ALERT_STATUS.NOT_REPORTED;
  } else if (portal && portal.filingStatus !== 'FILED') {
    status =
      bucket === BUCKETS.VALUE_MISMATCH
        ? ALERT_STATUS.SAVED_VALUE_MISMATCH
        : ALERT_STATUS.SAVED_NOT_FILED;
  }
  if (!status) return null;

  const inTwoB = status === ALERT_STATUS.NOT_REPORTED ? lookupTwoB(twoB, expected) : null;

  return {
    expectedInvoiceId: expected.id,
    portalRecordId: portal?.id ?? null,
    status,
    supplierName: expected.supplierName ?? null,
    docType: expected.docType,
    invoiceNo: expected.invoiceNo,
    invoiceDate: expected.invoiceDate,
    taxableValue: expected.taxableValue,
    totalTax: expected.totalTax,
    // Signed, matching services/totals.js: a credit note REDUCES credit, so an
    // unreported one is not credit the trader is waiting for. Keeping the sign
    // means a supplier's figure is the net effect of chasing them rather than a
    // total that quietly overstates what is owed.
    itcAtStake: itcSign(expected.docType) * expected.totalTax,
    bucket,
    filingStatus: portal?.filingStatus ?? null,
    portalTaxableValue: portal?.taxableValue ?? null,
    portalTotalTax: portal?.totalTax ?? null,
    deltaTaxableValue: portal ? portal.taxableValue - expected.taxableValue : null,
    deltaTotalTax: portal ? portal.totalTax - expected.totalTax : null,
    // What GSTR-2B says about the same document. Only ever populated for
    // NOT_REPORTED — for the SAVED_* statuses an IMS record exists and 2B adds
    // nothing to the row.
    inGstr2b: Boolean(inTwoB),
    gstr2bFiledOn: inTwoB?.supplierFiledOn ?? null,
    gstr2bSection: inTwoB?.section ?? null,
    // Why it can never appear in IMS, or null when it simply has not yet.
    neverEntersImsReason: inTwoB ? neverEntersImsReason(inTwoB) : null,
    // Said in words on the row, because the three statuses look identical to
    // anyone who does not already know what srcfilstatus means.
    note: noteFor(status, inTwoB)
  };
}

// The 2B record for the same document, or null.
//
// Keyed on supplier GSTIN + normalised invoice number — the same identity the
// engine blocks on. This is a lookup for an explanation, not a match: a near
// miss is left as "not in 2B either", which is the cautious answer.
function twoBIndex(portal) {
  const index = new Map();
  for (const record of portal) {
    if (record.source !== 'GSTR2B') continue;
    index.set(`${record.supplierGstin}|${record.invoiceNoNorm}`, record);
  }
  return index;
}

function lookupTwoB(index, expected) {
  if (!index) return null;
  return index.get(`${expected.supplierGstin}|${expected.invoiceNoNorm}`) ?? null;
}

// Per CLAUDE.md domain fact 5 and docs/gstr2b-schema.md: reverse charge, records
// the portal marks ITC-unavailable, and the ISD/import sections reach 2B directly
// and never pass through IMS. For these, "not in IMS" is the correct end state.
function neverEntersImsReason(record) {
  if (record.reverseCharge) return 'REVERSE_CHARGE';
  if (record.itcAvailable === false) return 'ITC_INELIGIBLE';
  if (NON_IMS_SECTIONS.has(record.section)) return 'NON_IMS_SECTION';
  return null;
}

const NEVER_IN_IMS_NOTE = Object.freeze({
  REVERSE_CHARGE:
    'Reverse charge — the tax is yours to pay and self-assess, so this reaches ' +
    'GSTR-2B directly and never enters IMS. Nothing to chase.',
  ITC_INELIGIBLE:
    'The portal marks ITC as unavailable on this record, so it reaches GSTR-2B ' +
    'directly and never enters IMS. It was never claimable. Nothing to chase.',
  NON_IMS_SECTION:
    'An ISD or import record. These reach GSTR-2B directly and never enter IMS. ' +
    'Nothing to chase.'
});

// The row's own sentence. NOT_REPORTED means "no IMS record", and that has three
// quite different causes — only one of which is a supplier who has not saved it.
function noteFor(status, inTwoB) {
  if (status !== ALERT_STATUS.NOT_REPORTED || !inTwoB) return STATUS_NOTE[status];

  const filed = inTwoB.supplierFiledOn ? ` on ${formatDate(inTwoB.supplierFiledOn)}` : '';
  const reason = neverEntersImsReason(inTwoB);
  if (reason) {
    return `Already in your GSTR-2B — the supplier filed it${filed}. ${NEVER_IN_IMS_NOTE[reason]}`;
  }
  // Filed, in 2B, and an ordinary IMS-eligible document. The IMS download is
  // simply older than the 2B one, which is the usual cause and is fixed by
  // re-downloading rather than by phoning anybody.
  return (
    `Already in your GSTR-2B — the supplier filed it${filed} — but missing from ` +
    'this IMS download. The IMS file is most likely older than the 2B one; ' +
    're-download IMS before chasing.'
  );
}

export const STATUS_NOTE = Object.freeze({
  NOT_REPORTED: 'Not in IMS at all — the supplier has not even saved it yet.',
  SAVED_NOT_FILED:
    'Saved in IMS but not filed. Not safe yet: a saved record can still be edited ' +
    'or deleted, and only filed records reach your GSTR-2B.',
  SAVED_VALUE_MISMATCH:
    'Saved in IMS with different amounts, and not filed yet. While it is a draft ' +
    'the supplier can correct it for free.'
});

function countInvoices(suppliers, predicate) {
  let n = 0;
  for (const supplier of suppliers) for (const invoice of supplier.invoices) if (predicate(invoice)) n += 1;
  return n;
}

function countStatuses(invoices) {
  const counts = { NOT_REPORTED: 0, SAVED_NOT_FILED: 0, SAVED_VALUE_MISMATCH: 0 };
  for (const invoice of invoices) counts[invoice.status] += 1;
  return counts;
}

function headlineFor({ name, invoices, daysRemaining, urgency, band }) {
  const count = `${invoices.length} document${invoices.length === 1 ? '' : 's'}`;
  if (urgency === URGENCY.PAST_CUTOFF) {
    return `${name} — ${count} still not safe, and their cut-off has passed.`;
  }
  if (urgency === URGENCY.LAST_DAY) {
    return `${name} — ${count} to fix today. Their cut-off is today.`;
  }
  const days = `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left`;
  if (band === RISK_BANDS.LOW && urgency === URGENCY.EARLY) {
    return `${name} — ${count} not reported yet, ${days}. Normal at this point in the month.`;
  }
  return `${name} — ${count} to chase, ${days}.`;
}

// The whole product in two sentences. Before the cut-off the supplier's return is
// a draft and a phone call costs nothing; after it, per
// docs/gst-lifecycle-reference.md, the GSTR-1A correction reaches the recipient's
// 2B in the NEXT tax period and never this one.
function consequenceFor({ taxPeriod, cutOff, daysRemaining, preCutOff, itcAtStake }) {
  const nextPeriod = addMonths(taxPeriod, 1);
  if (preCutOff === false) {
    return (
      `Their cut-off (${formatDate(cutOff)}) has passed. A correction now needs GSTR-1A, ` +
      `and a GSTR-1A amendment reaches your GSTR-2B in ${monthName(nextPeriod)} — the NEXT ` +
      `tax period, never ${monthName(taxPeriod)}. That is a month of cash flow on ` +
      `${formatRupeesAscii(Math.abs(itcAtStake))}.`
    );
  }
  const days = `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
  return (
    `Their return is still a draft until ${formatDate(cutOff)} — ${days} away. A fix now is ` +
    `free: they edit the saved record, file on time, and the credit lands in your ` +
    `${monthName(taxPeriod)} GSTR-2B. After that date it needs GSTR-1A and slips to ` +
    `${monthName(nextPeriod)}.`
  );
}

// ---------------------------------------------------------------------------
// Chase message
// ---------------------------------------------------------------------------

// Plain text, RETURNED — never sent. There is no email, WhatsApp or SMS
// integration in this product and there is not meant to be one: the trader owns
// the relationship, copies the text and sends it however they already talk to
// this supplier.
//
// ASCII ONLY, "Rs." rather than the rupee sign, consistent with the IMS remarks
// writer. This text gets pasted into WhatsApp, SMS gateways and ERP note fields,
// any of which may mangle a non-Latin-1 byte, and a garbled invoice number in a
// chase message is worse than no message at all.
export function buildChaseMessage({ org, supplier, taxPeriod, asOf }) {
  const traderName = ascii(org.trade_name ?? org.legal_name ?? '');
  const lines = [];

  lines.push(`To: ${ascii(supplier.tradeName)} (${supplier.gstin})`);
  lines.push(`From: ${traderName} (${org.gstin})`);
  lines.push(
    `Subject: GSTR-1 for ${monthName(taxPeriod)} - ${supplier.invoiceCount} document(s) pending`
  );
  lines.push('');
  lines.push('Hello,');
  lines.push('');
  lines.push(
    `As of ${formatDate(asOf)}, the following ${monthName(taxPeriod)} document(s) from you ` +
      'have not yet reached our GST portal data (IMS):'
  );
  lines.push('');

  supplier.invoices.forEach((invoice, index) => {
    lines.push(
      `  ${index + 1}. ${ascii(invoice.invoiceNo)}  dated ${formatDate(invoice.invoiceDate)}  ` +
        `taxable ${formatRupeesAscii(invoice.taxableValue)}  ` +
        `tax ${formatRupeesAscii(invoice.totalTax)}`
    );
    lines.push(`     ${statusLine(invoice)}`);
  });

  lines.push('');
  lines.push(`Input tax credit at stake: ${formatRupeesAscii(Math.abs(supplier.itcAtStake))}`);
  lines.push('');

  if (supplier.preCutOff === false) {
    lines.push(
      `Your cut-off for this period was ${formatDate(supplier.cutOffDate)} and it has passed. ` +
        'A correction now needs GSTR-1A, and that credit would only reach our GSTR-2B in ' +
        `${monthName(addMonths(taxPeriod, 1))} - the next tax period, not ` +
        `${monthName(taxPeriod)}. Please still report it so the credit is not lost altogether.`
    );
  } else {
    const days = supplier.daysToCutOff;
    lines.push(
      `Your GSTR-1 cut-off for this period is ${formatDate(supplier.cutOffDate)}` +
        (days === 0 ? ' - that is today.' : ` - ${days} day(s) from now.`)
    );
    lines.push(
      'If these are saved and filed by then, the credit reaches our GSTR-2B for ' +
        `${monthName(taxPeriod)} at no cost to either of us. After that date the fix needs ` +
        `GSTR-1A and the credit slips to ${monthName(addMonths(taxPeriod, 1))}.`
    );
  }

  lines.push('');
  lines.push('Please confirm once done. Thank you,');
  lines.push(traderName);
  lines.push(`GSTIN ${org.gstin}`);

  return ascii(lines.join('\n'));
}

function statusLine(invoice) {
  switch (invoice.status) {
    case ALERT_STATUS.SAVED_VALUE_MISMATCH:
      return (
        `saved on the portal as taxable ${formatRupeesAscii(invoice.portalTaxableValue)} / ` +
        `tax ${formatRupeesAscii(invoice.portalTotalTax)} - please check before filing`
      );
    case ALERT_STATUS.SAVED_NOT_FILED:
      return 'saved but not filed yet - please file it';
    default:
      return 'not on the portal at all';
  }
}

// Anything outside printable ASCII is replaced rather than dropped, so a name
// that was entirely non-Latin does not silently become an empty string.
function ascii(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/₹/g, 'Rs.')
    .replace(/[^\x20-\x7e\n]/g, '?');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function monthName(taxPeriod) {
  const [year, month] = String(taxPeriod ?? '').split('-').map(Number);
  if (!year || !month) return String(taxPeriod ?? '');
  return `${MONTHS[month - 1]} ${year}`;
}

// '2026-08-11' -> '11 Aug 2026'. ASCII, and unambiguous about day vs month in a
// way dd-mm-yyyy is not when a supplier reads it in a hurry.
function formatDate(iso) {
  const normalized = dateToIso(iso);
  if (!normalized) return String(iso ?? '');
  const [year, month, day] = normalized.split('-').map(Number);
  return `${day} ${MONTHS[month - 1].slice(0, 3)} ${year}`;
}
