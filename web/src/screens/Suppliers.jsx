import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { rupees } from '../lib/money.js';
import { formatDate, formatPeriod } from '../lib/calendar.js';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { RISK_BAND_LABEL } from '../lib/vocab.js';

// Who to chase, ranked by how reliably they file.
//
// days_late is measured against THAT supplier's own cut-off — the 11th for a
// monthly filer, the 13th for QRMP. Using one deadline for everybody would mark
// every QRMP supplier two days late every month and train the trader to ignore
// the column entirely.

function lateness(days) {
  if (days === null || days === undefined) return { label: 'not filed', tone: 'unknown' };
  if (days > 0) return { label: `${days}d late`, tone: 'bad' };
  if (days === 0) return { label: 'on the deadline', tone: 'warn' };
  return { label: `${Math.abs(days)}d early`, tone: 'good' };
}

// A sparkline of days-late per period, drawn against the cut-off as the zero line.
// Bars above the line are late; below is early. No library — it is six rectangles.
function LateTrend({ periods }) {
  const points = (periods ?? []).filter((entry) => entry.daysLate !== null);
  if (!points.length) {
    return <span className="muted small">no filing dates observed</span>;
  }
  // One point is not a trend. Drawn, it becomes a single full-width bar that
  // reads as a strong signal — the widest mark in the column, from one month.
  if (points.length < 2) {
    return <span className="muted small">one month only</span>;
  }

  const magnitude = Math.max(3, ...points.map((entry) => Math.abs(entry.daysLate)));
  const height = 34;
  const width = Math.max(60, points.length * 14);
  const step = width / points.length;
  const mid = height / 2;

  return (
    <svg className="trend" width={width} height={height} role="img" aria-label="days late by period">
      <line x1={0} y1={mid} x2={width} y2={mid} className="trend-axis" />
      {points.map((entry, index) => {
        const scaled = (entry.daysLate / magnitude) * (mid - 3);
        const y = scaled >= 0 ? mid - scaled : mid;
        return (
          <rect
            key={entry.taxPeriod}
            x={index * step + 2}
            y={y}
            width={Math.max(step - 4, 4)}
            height={Math.max(Math.abs(scaled), 1.5)}
            className={entry.daysLate > 0 ? 'trend-late' : 'trend-early'}
          >
            <title>
              {formatPeriod(entry.taxPeriod)}: {lateness(entry.daysLate).label}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

// The band, and the sentences behind it.
//
// The probability NEVER appears. A trader cannot check "0.61", and a number
// carries an air of precision that a model fitted on 200 synthetic rows has not
// earned. What they can check is "filed late in 4 of the last 6 months" — they
// were there.
// The counts a row shows, taken from the SAME feature object the risk reasons
// were generated from.
//
// These used to come from listSuppliers' own aggregate over every observed
// period, while the reasons beside them came from the risk scoring window. The
// two spans differed and nothing said so: Deepak Sales Corp filed two days early
// in March and two days late in April, and the row read "Late 1" next to "filed
// on time in all of the last 1 month". Both were true. Neither was legible.
//
// Falling back to the aggregate keeps a supplier with no risk row rendering
// something rather than blanking three columns.
// Sort order for the bands.
//
// UNPROVEN sits ABOVE Low and below the two real concern bands. Absence of
// history is not evidence of reliability — the phase 7 call — so an unproven
// supplier should not be filed under "normal"; but there is nothing to act on
// either, so they must not push a genuine concern down the page.
const SORT_BAND_ORDER = ['HIGH', 'MEDIUM', 'UNPROVEN', 'LOW', null];

function rowCounts(supplier) {
  const features = supplier.risk?.features;
  if (!features) {
    return {
      periodsObserved: supplier.stats.periodsObserved,
      lateCount: supplier.stats.lateCount,
      missedCount: supplier.stats.missedCount,
      mismatchCount: supplier.stats.mismatchCount,
      avgDaysLate: supplier.stats.avgDaysLate,
      fromRisk: false
    };
  }
  return {
    periodsObserved: features.periodsObserved ?? 0,
    lateCount: features.lateCount ?? 0,
    missedCount: features.missedCount ?? 0,
    mismatchCount: features.mismatches ?? 0,
    avgDaysLate: features.meanDaysLate ?? null,
    fromRisk: true
  };
}

// A single month is one observation. It cannot support a concern and it cannot
// support a clean bill of health either — "Normal for this point in the month"
// off one document is the phase 7 mistake pointing the other way.
const MIN_PERIODS_FOR_A_VERDICT = 2;

// Display band. UNPROVEN is not a fourth risk level — the stored band is
// untouched, and the phase 7 call that absence of history means MEDIUM rather
// than LOW still holds in the data. This is a different SENTENCE about the same
// band, used in exactly two situations:
//
//   * a guard fired, so the band on screen is NOT the band the model computed —
//     the app is withholding a judgement and should say so rather than dressing
//     the cap up as a verdict. "Worth a look" over three clean facts and "only 1
//     month of history" reads as a model that has gone wrong.
//   * there is only one month to go on, whichever way it points.
//
// Deliberately NOT extended to every thin history: with two months and no guard
// the model has made an actual call, and burying it under "too early to say"
// would throw away the only signal on the screen.
function displayBand(risk) {
  if (!risk) return null;
  if (risk.guard) return 'UNPROVEN';
  if ((risk.periodsObserved ?? 0) < MIN_PERIODS_FOR_A_VERDICT) return 'UNPROVEN';
  return risk.band;
}

function RiskCell({ risk }) {
  if (!risk) return <span className="muted small">not scored yet</span>;
  const band = displayBand(risk);
  return (
    <div className="risk-cell" data-testid={`risk-${band}`}>
      <span className={`chip risk-chip risk-${band}`}>{RISK_BAND_LABEL[band] ?? band}</span>
      <ul className="risk-reasons">
        {(risk.reasons ?? []).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

// Where the bands come from, stated on the screen that shows them.
//
// This is not a disclaimer bolted on for form. The model was fitted on fixtures
// this repo generates from rules we wrote, so it has largely learned our own
// generator — and a band presented without that context reads as experience of
// real filings, which it is not.
function ModelNote({ model }) {
  if (!model) return null;

  if (model.source !== 'MODEL') {
    return (
      <p className="model-note" data-testid="model-note">
        Bands come from a hand-weighted score, not a trained model — no model file is
        loaded.
      </p>
    );
  }

  const metrics = model.metrics ?? {};
  // Collapsed to one line, expanded on demand. NOT shortened: every word below is
  // the same text that used to sit open above the table. The caveat has to stay
  // reachable and intact — it is the difference between a band a reader trusts
  // and a band a reader knows the provenance of — but a five-line disclaimer
  // permanently above the data reads as boilerplate and stops being read at all.
  return (
    <details className="model-note" data-testid="model-note">
      <summary data-testid="model-note-summary">
        Trained on synthetic data <span className="muted">· how this is scored</span>
      </summary>
      <p>
        <strong>These bands come from a model trained on synthetic data.</strong> It is a
        logistic regression fitted on {model.rows} supplier-months ({model.positives} of
        them failures) across {model.suppliers} suppliers — all of it generated by this
        repo&rsquo;s own fixture script from rules we wrote. It has largely learned that
        generator. Nothing here has seen a real GST filing, and the figures below are not
        evidence that it works on one.
      </p>
      <p className="muted small">
        Held out {model.holdoutPeriod}, never trained on: ranking ROC AUC{' '}
        {metrics.holdoutRocAuc} against {metrics.holdoutRocAucHeuristic} for the
        hand-weighted score it replaced. Pooled leave-one-period-out:{' '}
        {metrics.cvRocAuc} against {metrics.cvRocAucHeuristic}. Those are small samples —
        one held-out period is about 40 suppliers.
      </p>
      {Object.keys(model.droppedFeatures ?? {}).length ? (
        <p className="muted small">
          Features dropped for carrying no signal in this corpus:{' '}
          {Object.entries(model.droppedFeatures)
            .map(([name, info]) => `${name} (${info.reason ?? info})`)
            .join('; ')}
          . A supplier whose behaviour differs on one of those is scored by the
          hand-weighted fallback instead, because the model has no term for it.
        </p>
      ) : null}
    </details>
  );
}

function SupplierDetail({ gstin, onClose }) {
  const [supplier, setSupplier] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setSupplier(null);
    setError(null);
    api
      .getSupplier(gstin)
      .then((found) => live && setSupplier(found))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [gstin]);

  return (
    <section className="panel supplier-detail" data-testid="supplier-detail">
      <header className="panel-head">
        <div>
          <h2>{supplier?.tradeName ?? gstin}</h2>
          <p className="muted mono">{gstin}</p>
        </div>
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </header>

      <ErrorBox error={error} title="Could not load this supplier" />

      {!supplier && !error ? (
        <Loading label="Loading filing history" rows={3} />
      ) : supplier ? (
        <>
          <p className="muted small">
            Treated as a <strong>{supplier.filingScheme}</strong> filer (
            {String(supplier.filingSchemeConfidence ?? '').toLowerCase()} confidence) —{' '}
            {supplier.filingSchemeReason}. That choice sets the cut-off every days-late
            figure below is measured against.
          </p>

          {supplier.periods.length === 0 ? (
            <Empty title="No periods recorded" testId="empty-supplier-periods">
              Nothing of theirs has been observed on the portal yet.
            </Empty>
          ) : (
            <div className="table-wrap">
            <table className="table dense" data-testid="supplier-periods">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Booked</th>
                  <th className="num">Reported</th>
                  <th>Reached</th>
                  <th>GSTR-1 filed</th>
                  <th>Cut-off</th>
                  <th>Timing</th>
                  <th className="num">Expected tax</th>
                  <th className="num">Observed tax</th>
                  <th className="num">Mismatches</th>
                </tr>
              </thead>
              <tbody>
                {supplier.periods.map((period) => {
                  const late = lateness(period.daysLate);
                  return (
                    <tr key={period.taxPeriod} className={period.missed ? 'is-missed' : ''}>
                      <td>{formatPeriod(period.taxPeriod)}</td>
                      <td className="num mono">{period.expectedCount}</td>
                      <td className="num mono">{period.invoiceCount}</td>
                      <td>
                        <span className={`pill ${period.appearedIn2b ? 'pill-ok' : 'pill-idle'}`}>
                          2B
                        </span>{' '}
                        <span className={`pill ${period.appearedInIms ? 'pill-ok' : 'pill-idle'}`}>
                          IMS
                        </span>
                      </td>
                      <td>{formatDate(period.gstr1FiledOn)}</td>
                      <td className="muted">{formatDate(period.cutOffDate)}</td>
                      <td>
                        <span className={`pill pill-${late.tone}`}>{late.label}</span>
                      </td>
                      <td className="num mono">{rupees(period.expectedTotalTax)}</td>
                      <td className="num mono">{rupees(period.observedTotalTax)}</td>
                      <td className="num mono">{period.mismatchCount || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

export function SuppliersScreen({ run = null }) {
  const [suppliers, setSuppliers] = useState(null);
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  const taxPeriod = run?.taxPeriod ?? null;
  const load = useCallback(() => {
    setError(null);
    setSuppliers(null);
    api
      .listSuppliers(taxPeriod)
      .then((body) => {
        setSuppliers(body.suppliers);
        setModel(body.model ?? null);
      })
      .catch(setError);
  }, [taxPeriod]);

  useEffect(load, [load]);

  const rows = useMemo(() => {
    if (!suppliers) return [];
    const needle = query.trim().toLowerCase();
    const filtered = suppliers.filter((supplier) => {
      const counts = rowCounts(supplier);
      if (onlyProblems && !counts.lateCount && !counts.missedCount && !counts.mismatchCount) {
        return false;
      }
      if (!needle) return true;
      return [supplier.tradeName, supplier.legalName, supplier.gstin]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle));
    });

    // Risk band first, then the three counts the subtitle names — in that order.
    //
    // The order used to be late-count then average timing, with mismatches never
    // entering it at all, under a subtitle promising all three. Deepak Sales Corp
    // with zero mismatches outranked Trident Cables with four.
    return [...filtered].sort((a, b) => {
      const ca = rowCounts(a);
      const cb = rowCounts(b);
      return (
        SORT_BAND_ORDER.indexOf(displayBand(a.risk)) - SORT_BAND_ORDER.indexOf(displayBand(b.risk)) ||
        cb.lateCount - ca.lateCount ||
        cb.missedCount - ca.missedCount ||
        cb.mismatchCount - ca.mismatchCount ||
        String(a.tradeName ?? a.gstin).localeCompare(String(b.tradeName ?? b.gstin))
      );
    });
  }, [suppliers, query, onlyProblems]);

  if (error) return <ErrorBox error={error} onRetry={load} title="Could not load suppliers" />;
  if (!suppliers) return <Loading label="Loading suppliers" rows={6} />;

  if (suppliers.length === 0) {
    return (
      <Empty title="No suppliers yet" testId="empty-suppliers">
        Suppliers are derived from what appears on the portal. Load an IMS or GSTR-2B file
        and they will show up here with their filing history.
      </Empty>
    );
  }

  return (
    <div className="screen screen-suppliers">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Suppliers</h2>
            <p className="muted">
              Ranked by risk band, then by how often each supplier filed late, missed a
              period entirely, and sent amounts that did not match your books — the same
              counts the band was built from, over the same months.
            </p>
            <ModelNote model={model} />
          </div>
          <div className="filters">
            <input
              type="search"
              className="search"
              placeholder="Filter by name or GSTIN"
              value={query}
              data-testid="suppliers-search"
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="checkline">
              <input
                type="checkbox"
                checked={onlyProblems}
                data-testid="only-problems"
                onChange={(event) => setOnlyProblems(event.target.checked)}
              />
              only ones with a problem
            </label>
          </div>
        </header>

        {rows.length === 0 ? (
          <Empty title="No supplier matches that" testId="empty-supplier-filter">
            Clear the filter to see all {suppliers.length}.
          </Empty>
        ) : (
          <div className="table-wrap">
          <table className="table suppliers-table" data-testid="suppliers-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Risk</th>
                <th>Scheme</th>
                <th className="num">Periods</th>
                <th className="num">Docs</th>
                <th className="num">Late</th>
                <th className="num">Missed</th>
                <th className="num">Mismatches</th>
                <th className="num">Avg timing</th>
                <th>Days-late trend</th>
                <th className="num">Tax observed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((supplier) => {
                const counts = rowCounts(supplier);
                const avg =
                  counts.avgDaysLate === null ? null : Math.round(counts.avgDaysLate);
                const late = lateness(avg);
                return (
                  <tr
                    key={supplier.gstin}
                    className={`is-clickable ${selected === supplier.gstin ? 'is-selected' : ''}`}
                    data-testid={`supplier-${supplier.gstin}`}
                    onClick={() =>
                      setSelected((current) => (current === supplier.gstin ? null : supplier.gstin))
                    }
                  >
                    <td>
                      <div className="cell-strong">{supplier.tradeName ?? supplier.legalName}</div>
                      <div className="mono muted small">{supplier.gstin}</div>
                    </td>
                    <td>
                      <RiskCell risk={supplier.risk} />
                    </td>
                    <td>
                      <span className="pill pill-idle" title={supplier.filingSchemeReason ?? ''}>
                        {supplier.filingScheme}
                        {supplier.filingSchemeConfidence === 'LOW' ? ' (assumed)' : ''}
                      </span>
                    </td>
                    <td className="num mono">{counts.periodsObserved}</td>
                    <td className="num mono">{supplier.stats.invoiceCount}</td>
                    <td className={`num mono ${counts.lateCount ? 'bad' : 'muted'}`}>
                      {counts.lateCount || '—'}
                    </td>
                    <td className={`num mono ${counts.missedCount ? 'bad' : 'muted'}`}>
                      {counts.missedCount || '—'}
                    </td>
                    <td className={`num mono ${counts.mismatchCount ? 'warn-text' : 'muted'}`}>
                      {counts.mismatchCount || '—'}
                    </td>
                    <td className="num">
                      <span className={`pill pill-${late.tone}`}>{late.label}</span>
                    </td>
                    <td>
                      <LateTrend periods={supplier.stats.trend} />
                    </td>
                    <td className="num mono">{rupees(supplier.stats.observedTotalTax)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {selected ? <SupplierDetail gstin={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
