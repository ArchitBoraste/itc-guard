import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { rupees } from '../lib/money.js';
import { formatDate, formatPeriod } from '../lib/calendar.js';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

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

export function SuppliersScreen() {
  const [suppliers, setSuppliers] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setSuppliers(null);
    api.listSuppliers().then(setSuppliers).catch(setError);
  }, []);

  useEffect(load, [load]);

  const rows = useMemo(() => {
    if (!suppliers) return [];
    const needle = query.trim().toLowerCase();
    return suppliers.filter((supplier) => {
      if (onlyProblems && !supplier.stats.lateCount && !supplier.stats.missedCount && !supplier.stats.mismatchCount) {
        return false;
      }
      if (!needle) return true;
      return [supplier.tradeName, supplier.legalName, supplier.gstin]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle));
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
              Ranked by filing behaviour — who has been late, who has missed a period
              entirely, and who keeps sending amounts that do not match your books.
            </p>
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
                const avg =
                  supplier.stats.avgDaysLate === null
                    ? null
                    : Math.round(supplier.stats.avgDaysLate);
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
                      <span className="pill pill-idle" title={supplier.filingSchemeReason ?? ''}>
                        {supplier.filingScheme}
                        {supplier.filingSchemeConfidence === 'LOW' ? ' (assumed)' : ''}
                      </span>
                    </td>
                    <td className="num mono">{supplier.stats.periodsObserved}</td>
                    <td className="num mono">{supplier.stats.invoiceCount}</td>
                    <td className={`num mono ${supplier.stats.lateCount ? 'bad' : 'muted'}`}>
                      {supplier.stats.lateCount || '—'}
                    </td>
                    <td className={`num mono ${supplier.stats.missedCount ? 'bad' : 'muted'}`}>
                      {supplier.stats.missedCount || '—'}
                    </td>
                    <td className={`num mono ${supplier.stats.mismatchCount ? 'warn-text' : 'muted'}`}>
                      {supplier.stats.mismatchCount || '—'}
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
