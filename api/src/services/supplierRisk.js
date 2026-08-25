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
import { HISTORY_PERIODS, historyPeriodsFor, scoreSupplierRisk } from './preventive.js';
import { rebuildSupplierPeriods } from './supplierStats.js';
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
export async function rebuildSupplierStats(orgId, taxPeriod, { runId = null } = {}) {
  const periods = await rebuildSupplierPeriods(orgId, taxPeriod, { runId });
  const risk = await rebuildSupplierRisk(orgId, taxPeriod);
  return { periods, risk };
}

// Every supplier the behaviour table knows about, each with whatever of their
// history falls in the scoring window.
//
// The window is the periods BEFORE the one being worked on — a band for period P
// has to be built from what was knowable before P, the same rule ml/train.py was
// trained under. But membership is NOT decided by the window.
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
async function loadHistories(orgId, periods) {
  const inWindow = new Set(periods);

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
    // Seen, so they are scored. Only the periods inside the window feed the score.
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
// asOfPeriod is the period being worked on. History is the periods BEFORE it —
// the same window the model was trained against, and the same one preventive.js
// scores from, so the stored band is the band the trader actually saw.
export async function rebuildSupplierRisk(orgId, asOfPeriod) {
  if (!/^\d{4}-\d{2}$/.test(String(asOfPeriod ?? ''))) {
    throw new ServiceError('asOfPeriod must be YYYY-MM');
  }

  const priorPeriods = historyPeriodsFor(asOfPeriod, HISTORY_PERIODS);
  const histories = await loadHistories(orgId, priorPeriods);
  if (!histories.size) return { scored: 0, bands: {}, source: null };

  const bands = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  let source = null;
  const values = [];

  for (const entry of histories.values()) {
    const risk = scoreSupplierRisk(entry.periods, { scheme: entry.scheme });
    bands[risk.band] = (bands[risk.band] ?? 0) + 1;
    source = risk.source;

    const features = risk.features ?? {};
    const observed = features.periodsObserved ?? 0;

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
        reasons: risk.reasons,
        features
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
    out.set(gstin, {
      asOfPeriod: row.as_of_period,
      band: row.risk_band,
      // risk_score is deliberately NOT surfaced to the UI as a number. It is here
      // for ordering and for anyone reading the table directly.
      periodsObserved: Number(row.periods_observed ?? 0),
      lateCount: Number(row.late_count ?? 0),
      missedCount: Number(row.missed_count ?? 0),
      avgDaysLate: row.avg_days_late === null ? null : Number(row.avg_days_late),
      source: features.source ?? null,
      guard: features.guard ?? null,
      reasons: features.reasons ?? [],
      topFactors: features.topFactors ?? null,
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
