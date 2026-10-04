// Persisting the risk model's verdict to supplier_risk, and reading it back for
// the suppliers screen.
//
// The score is recomputed cheaply from supplier_periods on every request, so this
// table is not a cache the app depends on — it is the RECORD of what the trader
// was told and when. A band that moved between the 5th and the 12th is the sort
// of thing someone will want to look up after a credit goes missing, and
// recomputing from today's data cannot answer that.
//
// One row per (org, supplier, as_of_period), enforced by uq_supplier_risk. Re-run
// a period and its row is replaced, matching how runs behave.
import { pool } from '../db/pool.js';
import { insertInChunks, withTransaction } from '../db/tx.js';
import { FILING_SCHEMES } from '../matching/cutoff.js';
import {
  HISTORY_PERIODS,
  MIN_PERIODS_FOR_HIGH,
  STANDING,
  historyPeriodsThrough,
  riskReasons,
  scoreSupplierRisk,
  supplierStanding
} from './preventive.js';
import { phantomsBySupplier, rebuildSupplierPeriods, refreshSupplierMaster } from './supplierStats.js';
import { ServiceError } from './ingest.js';

// THE post-run rebuild. Both halves, in order, in one call.
//
// This exists because splitting them was a bug. rebuildSupplierPeriods had five
// call sites — the runs route, the demo seeder, tools/seed-demo.js,
// rerunPeriodIfRun (which fires on every upload commit) and the training export —
// while rebuildSupplierRisk had exactly one, on the runs route. So four of the
// five ways a run gets created left supplier_risk empty, and `npm run demo:reset`
// (which DELETEs the table and then reseeds through the demo path) left the
// Suppliers screen reading "not scored yet" for every supplier, underneath a
// panel explaining the model's ROC AUC.
//
// Anything that completes a reconciliation for a period calls THIS. A caller that
// remembers one rebuild and forgets the other is the failure this removes.
//
// Every period is rebuilt, not just this one (audit P17: after loading February
// last, July still read "5 months of history" with 6 loaded). A new month moves
// every later period's scoring window, and can change the scheme inferred for a
// supplier and so the days late of every period. Oldest first, so each period's
// risk reads an already-rebuilt history.
export async function rebuildSupplierStats(orgId, taxPeriod, { runId = null } = {}) {
  const periods = await statsPeriods(orgId, taxPeriod, runId);
  await refreshSupplierMaster(orgId);
  for (const period of periods) {
    await rebuildSupplierPeriods(orgId, period.taxPeriod, { runId: period.runId, refreshMaster: false });
  }
  const risk = {};
  for (const period of periods) risk[period.taxPeriod] = await rebuildSupplierRisk(orgId, period.taxPeriod);
  return { periods: periods.map((period) => period.taxPeriod), risk };
}

// Every period with a run or with supplier figures, plus taxPeriod, each with its
// run (whose verdicts give the mismatch counts), oldest first.
async function statsPeriods(orgId, taxPeriod, runId) {
  const [runs] = await pool.query('SELECT id, tax_period FROM runs WHERE org_id = ?', [orgId]);
  const [recorded] = await pool.query(
    'SELECT DISTINCT tax_period FROM supplier_periods WHERE org_id = ?',
    [orgId]
  );
  const runOf = new Map(runs.map((run) => [run.tax_period, run.id]));
  if (runId) runOf.set(taxPeriod, runId);
  const all = new Set([...runOf.keys(), ...recorded.map((row) => row.tax_period), taxPeriod]);
  return [...all].sort().map((period) => ({ taxPeriod: period, runId: runOf.get(period) ?? null }));
}

// The as-of period the Suppliers screen reads, and the one window every figure on
// a row is summed over: the requested period (or the latest scored before it; the
// latest of all when none is asked for), and the scoring window through it. The
// risk band was scored on exactly that window, so the counts beside it agree.
export async function supplierView(orgId, requestedPeriod = null) {
  const [rows] = await pool.query(
    `SELECT MAX(as_of_period) AS period FROM supplier_risk
      WHERE org_id = ? AND (? IS NULL OR as_of_period <= ?)`,
    [orgId, requestedPeriod, requestedPeriod]
  );
  const asOfPeriod = rows[0].period ?? null;
  return {
    asOfPeriod,
    window: asOfPeriod ? historyPeriodsThrough(asOfPeriod, HISTORY_PERIODS) : null
  };
}

// Every supplier the behaviour table knows about, each with whatever of their
// history falls in the scoring window.
//
// Membership is NOT decided by the window. Which periods FEED the score is one
// question; which suppliers get scored at all is another.
//
// The bug that forced this apart: the query used to filter on the window itself,
// so a supplier with no row before P simply did not come back, got no
// supplier_risk row, and rendered as "not scored yet". In org 1 that was 10 of 64
// suppliers — every one of them present in the behaviour table, just first seen
// in the current period. A supplier we have never watched file is exactly the
// cold-start case phase 7 settled: MEDIUM, never LOW, and never a blank. They now
// come back with an EMPTY periods array, and scoreSupplierRisk answers with
// "no filing history yet - this is the first period we have seen them".
//
// Only a supplier with no supplier_periods row at all is left unscored, which is
// the one state where the app genuinely has nothing to say.
//
// A month is history once its GSTR-2B is in. Before that its outcome is not
// known: on the 5th a supplier who has not reported yet has missed nothing, and
// no invoice has "never reached" a 2B that does not exist yet.
async function loadHistories(orgId, periods) {
  const [settled] = await pool.query(
    `SELECT DISTINCT tax_period FROM portal_records
      WHERE org_id = ? AND source = 'GSTR2B' AND tax_period IN (?)`,
    [orgId, periods]
  );
  const inWindow = new Set(settled.map((row) => row.tax_period));

  const [rows] = await pool.query(
    `SELECT s.id AS supplier_id, s.gstin, s.filing_scheme, sp.tax_period,
            sp.expected_count, sp.invoice_count, sp.appeared_in_2b, sp.appeared_in_ims,
            sp.mismatch_count, sp.days_late, sp.filed_late, sp.missed
       FROM supplier_periods sp
       JOIN suppliers s ON s.id = sp.supplier_id AND s.org_id = sp.org_id
      WHERE sp.org_id = ?
      ORDER BY s.gstin, sp.tax_period`,
    [orgId]
  );

  const histories = new Map();
  for (const row of rows) {
    if (!histories.has(row.gstin)) {
      histories.set(row.gstin, {
        supplierId: row.supplier_id,
        gstin: row.gstin,
        scheme: row.filing_scheme ?? FILING_SCHEMES.MONTHLY,
        periods: []
      });
    }
    // Seen, so they are scored. Only the settled periods inside the window feed
    // the score.
    if (!inWindow.has(row.tax_period)) continue;

    histories.get(row.gstin).periods.push({
      taxPeriod: row.tax_period,
      expectedCount: Number(row.expected_count),
      invoiceCount: Number(row.invoice_count),
      appearedIn2b: Boolean(row.appeared_in_2b),
      appearedInIms: Boolean(row.appeared_in_ims),
      mismatchCount: Number(row.mismatch_count),
      daysLate: row.days_late === null ? null : Number(row.days_late),
      filedLate: Boolean(row.filed_late),
      missed: Boolean(row.missed)
    });
  }
  return histories;
}

// rebuildSupplierRisk(orgId, asOfPeriod) -> { scored, bands, source }
//
// asOfPeriod is the completed period being recorded against. The score reads the
// last six periods THROUGH it, inclusive, those whose GSTR-2B is in (see
// loadHistories). Phantoms count from any of them. risk_band keeps the scorer's verdict;
// what the screen shows (supplierStanding: New, or High for a document not in the
// books) is recorded beside it in `features`, and `bands` counts that.
export async function rebuildSupplierRisk(orgId, asOfPeriod) {
  if (!/^\d{4}-\d{2}$/.test(String(asOfPeriod ?? ''))) {
    throw new ServiceError('asOfPeriod must be YYYY-MM');
  }

  // INCLUSIVE of asOfPeriod — see historyPeriodsThrough(). The Suppliers screen is
  // a retrospective view of completed months, so the band there has to be built
  // from everything observed, including the month being looked at. Excluding it
  // threw away the most recent evidence and made the Late column disagree with
  // the reasons printed beside it.
  const scoringWindow = historyPeriodsThrough(asOfPeriod, HISTORY_PERIODS);
  const histories = await loadHistories(orgId, scoringWindow);
  if (!histories.size) return { scored: 0, bands: {}, source: null };
  const phantoms = await phantomsBySupplier(orgId, scoringWindow);

  const bands = { LOW: 0, MEDIUM: 0, HIGH: 0, NEW: 0 };
  let source = null;
  const values = [];

  for (const entry of histories.values()) {
    const risk = scoreSupplierRisk(entry.periods, { scheme: entry.scheme });
    const notInBooks = phantoms.get(entry.gstin) ?? [];
    const { standing, standingReason } = supplierStanding(risk, { phantoms: notInBooks });
    bands[standing] = (bands[standing] ?? 0) + 1;
    source = risk.source;

    const features = risk.features ?? {};
    const observed = features.periodsObserved ?? 0;
    // Too little history for a band: the facts in plain words, without the
    // "provisional read" caveat a band would have carried.
    const reasons = observed > 0 && observed < MIN_PERIODS_FOR_HIGH
      ? riskReasons(features, { provisional: false })
      : risk.reasons;

    values.push([
      orgId,
      entry.supplierId,
      asOfPeriod,
      risk.band,
      risk.score,
      observed,
      Math.max(observed - (features.lateCount ?? 0) - (features.missedCount ?? 0), 0),
      features.lateCount ?? 0,
      features.missedCount ?? 0,
      features.meanDaysLate ?? null,
      0,
      // Everything needed to explain the band later, including which scorer
      // produced it. Without `source` a stored band is unreadable after a
      // retrain — there would be no way to tell a model verdict from a fallback.
      JSON.stringify({
        source: risk.source,
        guard: risk.guard ?? null,
        modelBand: risk.modelBand ?? null,
        heuristicScore: risk.heuristicScore ?? null,
        topFactors: risk.topFactors ?? null,
        reasons,
        features,
        standing,
        standingReason,
        phantoms: notInBooks
      })
    ]);
  }

  await withTransaction((connection) =>
    insertInChunks(
      connection,
      `INSERT INTO supplier_risk
         (org_id, supplier_id, as_of_period, risk_band, risk_score, periods_observed,
          on_time_count, late_count, missed_count, avg_days_late, amount_at_risk,
          features, computed_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         risk_band = VALUES(risk_band),
         risk_score = VALUES(risk_score),
         periods_observed = VALUES(periods_observed),
         on_time_count = VALUES(on_time_count),
         late_count = VALUES(late_count),
         missed_count = VALUES(missed_count),
         avg_days_late = VALUES(avg_days_late),
         features = VALUES(features),
         computed_at = NOW()`,
      values.map((row) => [...row, new Date()])
    )
  );

  return { scored: values.length, bands, source };
}

// gstin -> stored risk, for the suppliers screen. Falls back to the most recent
// period on record when the requested one has not been scored, so opening a
// period that has not been run does not blank the column.
export async function supplierRiskMap(orgId, asOfPeriod = null) {
  const [rows] = await pool.query(
    `SELECT s.gstin, sr.as_of_period, sr.risk_band, sr.risk_score, sr.periods_observed,
            sr.late_count, sr.missed_count, sr.avg_days_late, sr.features, sr.computed_at
       FROM supplier_risk sr
       JOIN suppliers s ON s.id = sr.supplier_id AND s.org_id = sr.org_id
      WHERE sr.org_id = ?
      ORDER BY s.gstin, sr.as_of_period`,
    [orgId]
  );

  const latest = new Map();
  for (const row of rows) {
    // Rows arrive oldest-first per supplier. Keep the requested period when it
    // exists, otherwise the newest one at or before it.
    if (asOfPeriod && row.as_of_period > asOfPeriod) continue;
    latest.set(row.gstin, row);
  }

  const out = new Map();
  for (const [gstin, row] of latest) {
    const features = parseJson(row.features) ?? {};
    const periodsObserved = Number(row.periods_observed ?? 0);
    out.set(gstin, {
      asOfPeriod: row.as_of_period,
      // The scorer's verdict. `standing` is what the screen shows: this band, NEW
      // under MIN_PERIODS_FOR_HIGH months, or HIGH for a document not in the books.
      // A row stored before standing existed falls back on the history rule.
      band: row.risk_band,
      standing:
        features.standing ?? (periodsObserved < MIN_PERIODS_FOR_HIGH ? STANDING.NEW : row.risk_band),
      standingReason: features.standingReason ?? null,
      phantoms: features.phantoms ?? [],
      // risk_score is deliberately NOT surfaced to the UI as a number. It is here
      // for ordering and for anyone reading the table directly.
      periodsObserved,
      lateCount: Number(row.late_count ?? 0),
      missedCount: Number(row.missed_count ?? 0),
      avgDaysLate: row.avg_days_late === null ? null : Number(row.avg_days_late),
      source: features.source ?? null,
      guard: features.guard ?? null,
      reasons: features.reasons ?? [],
      topFactors: features.topFactors ?? null,
      // The counts the reasons were generated from. The Suppliers table renders
      // its Late / Missed / Mismatches columns from THESE rather than from its
      // own aggregate, so a column and the sentence beside it cannot describe
      // different spans of history again.
      features: features.features ?? null,
      computedAt: row.computed_at
    });
  }
  return out;
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
