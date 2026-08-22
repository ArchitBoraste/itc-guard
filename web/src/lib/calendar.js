// Filing-calendar arithmetic for display. Mirrors api/src/matching/cutoff.js:
// cut-off on the 11th (monthly) or 13th (QRMP), 2B generates on the 14th, GSTR-3B
// falls due on the 20th — all in the month AFTER the tax period.
//
// Dates are ISO yyyy-mm-dd strings throughout. Nothing here parses a locale date.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function nextPeriod(taxPeriod) {
  const [year, month] = String(taxPeriod).split('-').map(Number);
  if (!year || !month) return null;
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
}

function dayInFollowingMonth(taxPeriod, day) {
  const next = nextPeriod(taxPeriod);
  return next ? `${next}-${String(day).padStart(2, '0')}` : null;
}

export function cutOffDate(taxPeriod, filingScheme = 'MONTHLY') {
  return dayInFollowingMonth(taxPeriod, filingScheme === 'QRMP' ? 13 : 11);
}

export const twoBGenerationDate = (taxPeriod) => dayInFollowingMonth(taxPeriod, 14);
export const gstr3bDueDate = (taxPeriod) => dayInFollowingMonth(taxPeriod, 20);

// Whole days from `from` to `to`, both ISO. Positive = `to` is in the future.
export function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.UTC(...from.slice(0, 10).split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  const b = Date.UTC(...to.slice(0, 10).split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  return Math.round((b - a) / 86400000);
}

// '2026-05-16' -> '16 May 2026'
export function formatDate(iso) {
  if (!iso) return '—';
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(iso);
  return `${day} ${MONTHS[month - 1]?.slice(0, 3) ?? month} ${year}`;
}

// '2026-04' -> 'April 2026'
export function formatPeriod(taxPeriod) {
  if (!taxPeriod) return '—';
  const [year, month] = String(taxPeriod).split('-').map(Number);
  return `${MONTHS[month - 1] ?? month} ${year}`;
}

// The run's own as-of date is the clock everything on screen is measured against.
// Falling back to the real today would silently change what "3 days left" means
// depending on when the page was opened.
export function runClock(run) {
  const asOf = run?.asOfDate ? String(run.asOfDate).slice(0, 10) : null;
  return asOf ?? new Date().toISOString().slice(0, 10);
}

// Which half of the filing month the trader is in. Drives the banner's tone.
export function filingWindow(asOfDate, taxPeriod, filingScheme = 'MONTHLY') {
  if (!asOfDate || !taxPeriod) return null;
  if (asOfDate <= cutOffDate(taxPeriod, filingScheme)) return 'PREVENTIVE';
  if (asOfDate < twoBGenerationDate(taxPeriod)) return 'CUTOFF_PASSED';
  if (asOfDate <= gstr3bDueDate(taxPeriod)) return 'REACTIVE';
  return 'CLOSED';
}

export const WINDOW_LABEL = {
  PREVENTIVE: 'Before the cut-off',
  CUTOFF_PASSED: 'Cut-off passed, 2B not generated',
  REACTIVE: 'After 2B, before GSTR-3B',
  CLOSED: 'GSTR-3B due date passed'
};
