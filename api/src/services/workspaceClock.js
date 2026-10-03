// The workspace's as-of date: the one clock every recommendation, cut-off state,
// "days left" and deadline in the app is read against.
//
// Stored per workspace (organizations.as_of_date). NULL means "today", read in
// India's time zone every time it is asked for: a trader in Pune at 00:30 on the
// 12th is past an 11th cut-off even though UTC still says the 11th. A set date
// stays until it is changed or cleared, which is how the demo walks through a
// filing month without touching the system clock.
//
// Moving the date re-evaluates every reconciled period (services/workspace.js);
// this file only reads and writes it.
import { pool } from '../db/pool.js';
import { dateToIso } from '../matching/normalize.js';
import { ServiceError } from './ingest.js';

export const CLOCK_TIME_ZONE = 'Asia/Kolkata';

// en-CA formats a date as yyyy-mm-dd.
const INDIA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLOCK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function todayInIndia(now = new Date()) {
  return INDIA_DATE.format(now);
}

// -> { asOfDate, today, followsToday }
export async function readWorkspaceClock(orgId) {
  const [rows] = await pool.query('SELECT as_of_date FROM organizations WHERE id = ?', [orgId]);
  if (!rows.length) throw new ServiceError('workspace not found', 404, 'not_found');
  const today = todayInIndia();
  const pinned = rows[0].as_of_date ?? null;
  return { asOfDate: pinned ?? today, today, followsToday: pinned === null };
}

export async function workspaceAsOf(orgId) {
  return (await readWorkspaceClock(orgId)).asOfDate;
}

// A real calendar date, yyyy-mm-dd, or the trader is told what was wrong with it.
export function parseAsOfDate(value) {
  const iso = dateToIso(value);
  const [year, month, day] = (iso ?? '').split('-').map(Number);
  const real = iso && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (!real) {
    throw new ServiceError(`asOfDate must be a real date, yyyy-mm-dd (got ${JSON.stringify(value)})`);
  }
  return iso;
}

// asOfDate: yyyy-mm-dd, or null to follow today again.
export async function writeWorkspaceClock(orgId, asOfDate) {
  const value = asOfDate === null ? null : parseAsOfDate(asOfDate);
  await pool.query('UPDATE organizations SET as_of_date = ? WHERE id = ?', [value, orgId]);
  return readWorkspaceClock(orgId);
}
