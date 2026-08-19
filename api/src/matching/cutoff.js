// Filing-calendar arithmetic. PURE — no db, no fs, no network.
//
// The whole preventive/reactive split hangs off these dates:
//   * GSTR-1 / IFF cut-off — 11th for monthly filers, 13th for QRMP.
//     Before it, a supplier's saved record can still be edited for free.
//     After it, the same fix needs GSTR-1A and lands in NEXT month's 2B.
//   * GSTR-2B generates on the 14th.
//   * GSTR-3B is due on the 20th — the moment no-action becomes deemed acceptance.
//
// All dates are ISO yyyy-mm-dd strings and land in the month AFTER the tax period.
import { addMonths, dateToIso, daysBetween } from './normalize.js';

export const FILING_SCHEMES = Object.freeze({ MONTHLY: 'MONTHLY', QRMP: 'QRMP' });

export const CALENDAR = Object.freeze({
  MONTHLY: { cutOffDay: 11 },
  QRMP: { cutOffDay: 13 },
  twoBGenerationDay: 14,
  gstr3bDueDay: 20
});

function dayInFollowingMonth(taxPeriod, day) {
  const next = addMonths(taxPeriod, 1);
  if (!next) return null;
  return `${next}-${String(day).padStart(2, '0')}`;
}

// The date after which a supplier-side fix can no longer reach this period's 2B.
export function cutoffDate(taxPeriod, filingScheme = FILING_SCHEMES.MONTHLY) {
  const scheme = CALENDAR[filingScheme] ?? CALENDAR.MONTHLY;
  return dayInFollowingMonth(taxPeriod, scheme.cutOffDay);
}

export function twoBGenerationDate(taxPeriod) {
  return dayInFollowingMonth(taxPeriod, CALENDAR.twoBGenerationDay);
}

export function gstr3bDueDate(taxPeriod) {
  return dayInFollowingMonth(taxPeriod, CALENDAR.gstr3bDueDay);
}

// Strictly before the cut-off: on the cut-off day itself the supplier is filing,
// so treat it as still open.
export function isBeforeCutoff(asOfDate, taxPeriod, filingScheme = FILING_SCHEMES.MONTHLY) {
  const asOf = dateToIso(asOfDate);
  const cutOff = cutoffDate(taxPeriod, filingScheme);
  if (!asOf || !cutOff) return null;
  return asOf <= cutOff;
}

export function daysToCutoff(asOfDate, taxPeriod, filingScheme = FILING_SCHEMES.MONTHLY) {
  return daysBetween(asOfDate, cutoffDate(taxPeriod, filingScheme));
}

export function daysToGstr3b(asOfDate, taxPeriod) {
  return daysBetween(asOfDate, gstr3bDueDate(taxPeriod));
}

// Which half of the month the trader is in. Drives which mode the UI opens in.
export function filingWindow(asOfDate, taxPeriod, filingScheme = FILING_SCHEMES.MONTHLY) {
  const asOf = dateToIso(asOfDate);
  if (!asOf) return null;
  if (asOf <= cutoffDate(taxPeriod, filingScheme)) return 'PREVENTIVE';
  if (asOf < twoBGenerationDate(taxPeriod)) return 'CUTOFF_PASSED';
  if (asOf <= gstr3bDueDate(taxPeriod)) return 'REACTIVE';
  return 'CLOSED';
}

// ---------------------------------------------------------------------------
// Scheme inference
// ---------------------------------------------------------------------------

// inferFilingScheme(history, options) -> { scheme, confidence, reason, evidence }
//
// history: [{ taxPeriod, filedOn }] — the supplier's filing dates per period, as
// the GSTR-2B adapter reports them on PortalRecord.
//
// Honest about its limits. A QRMP supplier who uses the Invoice Furnishing
// Facility files every month, just on the 13th instead of the 11th, so the only
// reliable signals are:
//
//   * periods reported: if only quarter-end months ever appear, the supplier is
//     quarterly and is not using IFF — strong evidence.
//   * filing day: consistently landing in the 12th-13th window, never by the
//     11th, points to QRMP — weaker, because a habitually late monthly filer
//     looks identical.
//
// Defaults to MONTHLY with low confidence rather than guessing, because the
// consequence of the wrong scheme is a cut-off date two days out, and calling a
// monthly filer QRMP would tell the trader they have more time than they do.
export function inferFilingScheme(history = [], options = {}) {
  const minObservations = options.minObservations ?? 3;
  const observations = history
    .map((entry) => ({ taxPeriod: entry.taxPeriod, filedOn: dateToIso(entry.filedOn) }))
    .filter((entry) => entry.taxPeriod);

  const fallback = {
    scheme: FILING_SCHEMES.MONTHLY,
    confidence: 'LOW',
    reason: 'not enough filing history to tell the schemes apart',
    evidence: { observations: observations.length }
  };
  if (observations.length < minObservations) return fallback;

  const months = observations
    .map((entry) => Number(String(entry.taxPeriod).slice(5, 7)))
    .filter((month) => month >= 1 && month <= 12);
  const quarterEndOnly = months.length > 0 && months.every((month) => month % 3 === 0);

  if (quarterEndOnly) {
    return {
      scheme: FILING_SCHEMES.QRMP,
      confidence: 'HIGH',
      reason: 'only quarter-end periods reported, so no monthly IFF upload',
      evidence: { observations: observations.length, months: [...new Set(months)].sort() }
    };
  }

  const filedDays = observations
    .filter((entry) => entry.filedOn)
    .map((entry) => Number(entry.filedOn.slice(8, 10)));

  if (filedDays.length >= minObservations) {
    const monthlyCutOff = CALENDAR.MONTHLY.cutOffDay;
    const qrmpCutOff = CALENDAR.QRMP.cutOffDay;
    const inQrmpWindow = filedDays.filter((d) => d > monthlyCutOff && d <= qrmpCutOff).length;
    const byMonthlyCutOff = filedDays.filter((d) => d <= monthlyCutOff).length;

    // Every observed filing lands after the 11th but by the 13th.
    if (byMonthlyCutOff === 0 && inQrmpWindow === filedDays.length) {
      return {
        scheme: FILING_SCHEMES.QRMP,
        confidence: 'MEDIUM',
        reason: 'every filing landed after the 11th but by the 13th',
        evidence: { observations: observations.length, filedDays }
      };
    }
  }

  return {
    scheme: FILING_SCHEMES.MONTHLY,
    confidence: filedDays.length >= minObservations ? 'MEDIUM' : 'LOW',
    reason: 'filings appear monthly and reach the 11th cut-off',
    evidence: { observations: observations.length, filedDays }
  };
}
