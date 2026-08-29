import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { rupees, rupeesCompact } from '../lib/money.js';
import { formatDate, formatPeriod, runClock } from '../lib/calendar.js';
import {
  ALERT_STATUS_LABEL,
  RISK_BAND_LABEL,
  URGENCY_LABEL,
  bandHelp
} from '../lib/vocab.js';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

// Who to chase BEFORE the cut-off.
//
// The screen is grouped by SUPPLIER RISK rather than by amount, and that is the
// whole design. On the 5th, most unreported invoices resolve themselves — GSTR-1
// is not due until the 11th. A screen that shouts about all of them is a screen
// nobody opens on the 12th, which is the day it matters. So: HIGH first with the
// reasons spelled out, LOW last and visibly calm.
//
// Two clocks are deliberately separate. The BAND is about the supplier's filing
// record; the URGENCY is about the calendar. They move independently, and a
// reliable supplier who is out of time needs a different sentence from an
// unreliable one who is not.

const BAND_TONE = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'good' };

// ---------------------------------------------------------------------------

// Copy to clipboard, with the message itself as the fallback.
//
// navigator.clipboard is unavailable over plain http on anything but localhost,
// which is exactly how this gets demoed from another machine. Silently failing
// there would look like the button is broken, so a failure reveals the text for
// manual selection instead.
function CopyMessage({ text, testId }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('manual');
    }
  }, [text]);

  return (
    <div className="copy-message">
      <button type="button" className="btn btn-primary" data-testid={testId} onClick={copy}>
        {state === 'copied' ? 'Copied' : 'Copy message'}
      </button>
      {state === 'manual' ? (
        <p className="muted small">
          Your browser blocked the clipboard. Select the text below and copy it.
        </p>
      ) : null}
      <details open={state === 'manual'}>
        <summary className="link">show message</summary>
        <pre className="chase-message" data-testid={`${testId}-text`}>
          {text}
        </pre>
      </details>
    </div>
  );
}

function InvoiceLines({ supplier }) {
  return (
    <div className="table-wrap">
      <table className="table dense alert-invoices">
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Date</th>
            <th className="num">Taxable</th>
            <th className="num">Tax</th>
            <th>State on the portal</th>
          </tr>
        </thead>
        <tbody>
          {supplier.invoices.map((invoice) => (
            <tr key={invoice.expectedInvoiceId}>
              <td className="mono">{invoice.invoiceNo}</td>
              <td>{formatDate(invoice.invoiceDate)}</td>
              <td className="num mono">{rupees(invoice.taxableValue)}</td>
              <td className="num mono">{rupees(invoice.totalTax)}</td>
              <td>
                <span className={`chip status-${invoice.status}`}>
                  {ALERT_STATUS_LABEL[invoice.status] ?? invoice.status}
                </span>
                <div className="muted small">{invoice.note}</div>
                {invoice.deltaTotalTax ? (
                  <div className="small warn-text">
                    Portal tax {rupees(invoice.portalTotalTax)} vs {rupees(invoice.totalTax)} in
                    your books
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SupplierAlert({ supplier }) {
  return (
    // The card carries `is-past-cutoff`, NOT `urgency-PAST_CUTOFF`. The chip
    // classes live in the same `urgency-*` namespace, so putting one on the
    // container let a chip rule inherit down the whole card — which is how a
    // line-through meant for one chip ended up struck through the supplier name,
    // the reasons, the invoice table and the amounts. A passed cut-off makes
    // these worse, not settled; nothing here is ever crossed out.
    <article
      className={`alert-card alert-${supplier.risk.band} ${
        supplier.preCutOff === false ? 'is-past-cutoff' : ''
      }`}
      data-testid={`alert-${supplier.gstin}`}
    >
      <header className="alert-head">
        <div className="alert-who">
          <div className="cell-strong">{supplier.tradeName}</div>
          <div className="mono muted small">{supplier.gstin}</div>
          <div className="row-tags">
            <span className="chip" title={supplier.filingSchemeReason ?? ''}>
              {supplier.filingScheme}
              {supplier.filingSchemeConfidence === 'LOW' ? ' (assumed)' : ''} · cut-off{' '}
              {formatDate(supplier.cutOffDate)}
            </span>
            <span
              className={`chip urgency-chip urgency-${supplier.urgency}`}
              data-testid={`urgency-${supplier.gstin}`}
            >
              {URGENCY_LABEL[supplier.urgency] ?? supplier.urgency}
              {supplier.preCutOff && supplier.daysToCutOff >= 0
                ? ` · ${supplier.daysToCutOff} day${supplier.daysToCutOff === 1 ? '' : 's'} left`
                : ''}
            </span>
          </div>
        </div>
        <div className="alert-amount">
          <div className="impact-label">ITC at stake</div>
          <strong>{rupees(supplier.itcAtStake)}</strong>
          <div className="muted small">
            {supplier.invoiceCount} document{supplier.invoiceCount === 1 ? '' : 's'}
          </div>
        </div>
      </header>

      {/* Never a bare score. The trader has to be able to disagree with the
          reason, which means reading it in words they can check. */}
      <ul className="alert-reasons" data-testid={`reasons-${supplier.gstin}`}>
        {supplier.risk.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <p className={`alert-consequence ${supplier.preCutOff === false ? 'is-past' : ''}`}>
        {supplier.consequence}
      </p>

      <InvoiceLines supplier={supplier} />

      <CopyMessage text={supplier.chaseMessage} testId={`copy-${supplier.gstin}`} />
    </article>
  );
}

function Band({ band }) {
  if (!band.supplierCount) return null;
  return (
    <section
      className={`panel band-panel band-${band.band} tone-${BAND_TONE[band.band]}`}
      data-testid={`band-${band.band}`}
    >
      <header className="panel-head">
        <div>
          <h2>
            {RISK_BAND_LABEL[band.band] ?? band.band}
            <span className="group-count">
              {band.supplierCount} supplier{band.supplierCount === 1 ? '' : 's'} ·{' '}
              {band.invoiceCount} document{band.invoiceCount === 1 ? '' : 's'}
            </span>
          </h2>
          {/* Counted from the suppliers actually in this group, not looked up
              from a table. Their cut-offs differ — 11th monthly, 13th QRMP — so
              a group genuinely can hold both, and a fixed sentence would be
              wrong for whichever half it did not describe. */}
          <p className="muted" data-testid={`band-help-${band.band}`}>
            {bandHelp(band.band, band.suppliers)}
          </p>
        </div>
        <div className="change-total">
          <strong data-testid={`band-itc-${band.band}`}>{rupees(band.itcAtStake)}</strong>
          <span className="muted small">at stake in this group</span>
        </div>
      </header>

      <div className="alert-list">
        {band.suppliers.map((supplier) => (
          <SupplierAlert key={supplier.gstin} supplier={supplier} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function AlertsScreen({ run, taxPeriod, asOf: asOfProp = null, onAsOfChange = null }) {
  const period = taxPeriod ?? run?.taxPeriod ?? null;

  // The run's own as-of date is the default, so this screen and the rest of the
  // app agree on what day it is. Selectable so the demo can walk through the
  // month — the 5th, the 10th, the 12th, the 16th — without touching the clock.
  const defaultAsOf = useMemo(() => runClock(run), [run]);

  // Controlled by App, which keeps the chosen date in the URL so it survives
  // navigating to Actions and back. The local state is the fallback for
  // rendering this screen on its own; without it the two would fight over which
  // one owns the value.
  const [localAsOf, setLocalAsOf] = useState(null);
  const asOf = asOfProp ?? localAsOf ?? defaultAsOf;
  const setAsOf = onAsOfChange ?? setLocalAsOf;

  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!period) return undefined;
    let live = true;
    setError(null);
    setAlerts(null);
    api
      .listAlerts(period, asOf)
      .then((body) => live && setAlerts(body))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [period, asOf]);

  useEffect(load, [load]);

  if (!period) {
    return (
      <Empty title="No period selected" testId="empty-alerts-period">
        Load a purchase register and an IMS download, then pick a tax period.
      </Empty>
    );
  }

  return (
    <div className="screen screen-alerts">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Before the cut-off — {formatPeriod(period)}</h2>
            <p className="muted">
              What your books expect that has not safely reached IMS yet, ranked by how
              reliably each supplier files. Compared against IMS rather than GSTR-2B on
              purpose: IMS shows a record the moment a supplier saves it, days before 2B
              exists.
            </p>
          </div>
          <div className="filters">
            <label className="checkline" htmlFor="as-of">
              As of
            </label>
            <input
              id="as-of"
              type="date"
              value={asOf}
              data-testid="as-of-date"
              onChange={(event) => setAsOf(event.target.value || null)}
            />
            {asOf !== defaultAsOf ? (
              // Clears the override rather than setting the default as a value,
              // so the URL goes back to carrying no date at all and the run's own
              // clock takes over again.
              <button
                type="button"
                className="link"
                data-testid="reset-as-of"
                onClick={() => setAsOf(null)}
              >
                back to {formatDate(defaultAsOf)}
              </button>
            ) : null}
          </div>
        </header>

        {alerts ? (
          <div className="alert-summary" data-testid="alert-summary">
            <div className="total-card">
              <h3>Not yet safe</h3>
              <div className="total-amount">{rupeesCompact(alerts.totals.itcAtStake)}</div>
              <div className="total-meta">
                <span>{alerts.totals.invoiceCount} documents</span>
                <span>{alerts.totals.supplierCount} suppliers</span>
              </div>
              <p className="total-help">
                Credit your books expect that is not in IMS, or is in IMS as a draft the
                supplier can still change.
              </p>
            </div>
            {alerts.bands
              .filter((band) => band.supplierCount)
              .map((band) => (
                <div key={band.band} className={`total-card tone-${BAND_TONE[band.band]}`}>
                  <h3>{RISK_BAND_LABEL[band.band]}</h3>
                  <div className="total-amount">{rupeesCompact(band.itcAtStake)}</div>
                  <div className="total-meta">
                    <span>{band.supplierCount} suppliers</span>
                    <span>{band.invoiceCount} documents</span>
                  </div>
                </div>
              ))}
          </div>
        ) : null}
      </section>

      <ErrorBox error={error} onRetry={load} title="Could not load alerts" />

      {!alerts && !error ? <Loading label="Working out who to chase" rows={5} /> : null}

      {alerts && alerts.totals.supplierCount === 0 ? (
        <Empty title="Nothing to chase" testId="empty-alerts">
          Every {formatPeriod(period)} purchase in your books has been reported in IMS and
          filed. Anything still unresolved is on the Actions screen, not here.
        </Empty>
      ) : null}

      {alerts?.bands.map((band) => (
        <Band key={band.band} band={band} />
      ))}
    </div>
  );
}
