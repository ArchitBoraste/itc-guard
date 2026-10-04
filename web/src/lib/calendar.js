// Filing-calendar arithmetic and date formatting for display. Mirrors
// api/src/matching/cutoff.js: cut-off on the 11th (monthly) or 13th (QRMP), 2B
// generates on the 14th, GSTR-3B falls due on the 20th — all in the month AFTER
// the tax period.
//
// Dates are ISO yyyy-mm-dd strings throughout. Nothing here parses a locale date.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function nextPeriod(taxPeriod) {
  const [year, month] = String(taxPeriod).split('-').map(Number);
  if (!year || !month) return null;
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
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
  const utc = (iso) => {
    const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86400000);
}

// '2026-05-16' -> '16 May 2026'. The one way a date is shown, everywhere: the
// API's messages use the same (workspaceClock.displayDate).
export function formatDate(iso) {
  if (!iso) return '—';
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(iso);
  return `${day} ${MONTHS[month - 1].slice(0, 3)} ${year}`;
}

// '2026-04' -> 'April 2026'
export function formatPeriod(taxPeriod) {
  if (!taxPeriod) return '—';
  const [year, month] = String(taxPeriod).split('-').map(Number);
  return `${MONTHS[month - 1] ?? month} ${year}`;
}

// '2026-04' -> 'Apr 2026'
export function formatPeriodShort(taxPeriod) {
  if (!taxPeriod) return '—';
  const [year, month] = String(taxPeriod).split('-').map(Number);
  return `${MONTHS[month - 1]?.slice(0, 3) ?? month} ${year}`;
}

// '2026-08' -> 'August'
export function monthOf(taxPeriod) {
  const month = Number(String(taxPeriod ?? '').split('-')[1]);
  return MONTHS[month - 1] ?? '';
}

// "3 days left", "1 day left", "Today" for a count of days to a deadline.
export function daysLeftText(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'Today';
  if (days < 0) return 'Passed';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

// An upload's timestamp ('2026-10-04 07:32:49', UTC from MySQL) as the trader
// reads it, in India: "Today, 1:02 pm", or "4 Oct 2026, 1:02 pm".
export function formatUploadTime(stamp, now = new Date()) {
  if (!stamp) return '—';
  const when = new Date(`${String(stamp).replace(' ', 'T')}Z`);
  if (Number.isNaN(when.getTime())) return String(stamp);
  const zone = { timeZone: 'Asia/Kolkata' };
  const day = (date) => date.toLocaleDateString('en-CA', zone);
  const time = when
    .toLocaleTimeString('en-IN', { ...zone, hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s?([ap])\.?m\.?/i, (_, half) => ` ${half.toLowerCase()}m`);
  if (day(when) === day(now)) return `Today, ${time}`;
  return `${formatDate(day(when))}, ${time}`;
}

// The calendar entry the API returns for a period (GET /workspace/clock), by key.
export function deadlineOf(calendar, key) {
  return calendar?.deadlines?.find((deadline) => deadline.key === key) ?? null;
}

// The top bar's deadline chip, from the period's calendar as of the workspace
// date: the supplier cut-off until it passes (info), then GSTR-3B (warn), then
// overdue (bad).
export function deadlineChip(calendar) {
  const cut = deadlineOf(calendar, 'CUTOFF_MONTHLY');
  const due = deadlineOf(calendar, 'GSTR3B_DUE');
  if (!cut || !due) return null;
  const left = (days) => (days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} left`);
  if (cut.daysLeft >= 0) return { tone: 'info', text: `Supplier cut-off ${formatDate(cut.date)} · ${left(cut.daysLeft)}` };
  if (due.daysLeft >= 0) return { tone: 'warn', text: `GSTR-3B due ${formatDate(due.date)} · ${left(due.daysLeft)}` };
  return { tone: 'bad', text: `GSTR-3B was due ${formatDate(due.date)}` };
}

// An ISO instant as the trader reads it, in India: "5 Oct 2026, 00:42".
export function formatSentTime(iso) {
  if (!iso) return '—';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return String(iso);
  const zone = { timeZone: 'Asia/Kolkata' };
  const time = when.toLocaleTimeString('en-GB', { ...zone, hour: '2-digit', minute: '2-digit', hour12: false });
  return `${formatDate(when.toLocaleDateString('en-CA', zone))}, ${time}`;
}
