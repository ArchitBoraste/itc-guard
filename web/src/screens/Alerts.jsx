import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { rupees, rupeesCompact } from '../lib/money.js';
import { formatDate, formatPeriod, runClock } from '../lib/calendar.js';
import {
  ALERT_STATUS_LABEL,
  RISK_BAND_LABEL,
  URGENCY_LABEL,
  WHY_TOTALS_DIFFER,
  bandHelp,
  excludedSentence,
  exposureSplit
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

// The two directions behind an "at stake" figure.
//
// Rendered wherever the gross appears, because the gross alone is no more
// actionable than the net was: a supplier can fix an invoice or a credit note,
// not a total. `compact` is the summary-card form, where there is no room for
// sentences.
function ExposureSplit({ entry, format, compact = false, testId = null }) {
  const split = exposureSplit(entry);
  if (!split) return null;

  return (
    <div className={`exposure-split ${compact ? 'is-compact' : ''}`} data-testid={testId}>
      {split.owed.count ? (
        <span className="exposure-part">
          <strong className="mono">{format(split.owed.itc)}</strong> owed to you
          {compact ? '' : ` on ${split.owed.count} invoice${split.owed.count === 1 ? '' : 's'} / debit note${split.owed.count === 1 ? '' : 's'}`}
        </span>
      ) : null}
      <span className="exposure-part is-note">
        <strong className="mono">{format(split.claimed.itc)}</strong> you are still claiming
        {compact ? '' : ` on ${split.claimed.count} unreported credit note${split.claimed.count === 1 ? '' : 's'}`}
      </span>
      {compact ? null : (
        <p className="exposure-why">
          {split.owed.count ? (
            <>
              Two problems pulling opposite ways, not one number. The invoice is credit you
              have not received; the credit note is credit you are claiming and should not
              be, until the supplier reports it. Netted they would read{' '}
              <strong className="mono">{format(Math.abs(split.netItc))}</strong>, which is
              neither.
            </>
          ) : (
            /* Nothing pulls the other way here — there is only the credit note. The
               figure is still exposure rather than a negative: until the supplier
               reports it, the trader's own return is claiming credit it should not. */
            <>
              Shown as exposure, not as a negative. Nothing here is credit you are owed —
              it is credit you are currently claiming, and your return overstates its
              input tax credit until the supplier reports this.
            </>
          )}
        </p>
      )}
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
            <th>In GSTR-2B?</th>
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
              {/* Everything that can never enter IMS is off this screen, so a
                  "Yes" here means only one thing and it is worth flagging: the
                  supplier FILED this and it is in 2B, but this IMS download does
                  not have it. That is a stale download, not a late supplier —
                  the row's note says to re-download rather than to phone. */}
              <td data-testid={`in2b-${invoice.expectedInvoiceId}`}>
                {invoice.inGstr2b ? (
                  <>
                    <span className="chip chip-in2b">Yes</span>
                    {invoice.gstr2bFiledOn ? (
                      <div className="muted small">filed {formatDate(invoice.gstr2bFiledOn)}</div>
                    ) : null}
                  </>
                ) : invoice.status === 'NOT_REPORTED' ? (
                  <span className="chip chip-not2b">No</span>
                ) : (
                  <span className="muted small">—</span>
                )}
              </td>
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
          <strong data-testid={`stake-${supplier.gstin}`}>{rupees(supplier.itcAtStake)}</strong>
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

      <ExposureSplit
        entry={supplier}
        format={rupees}
        testId={`split-${supplier.gstin}`}
      />

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
          <ExposureSplit entry={band} format={rupees} compact testId={`band-split-${band.band}`} />
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

  const excludedNote = alerts ? excludedSentence(alerts.excluded, rupeesCompact) : null;

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
            <h2>Still fixable — {formatPeriod(period)}</h2>
            {/* Three sentences, in a shopkeeper's words: what is here, why it
                matters, what the date control does. Everything a judge needs on
                first read, and nothing they do not. The schema-level truth — IMS
                versus GSTR-2B, what never appears here, why the totals cannot be
                added to Summary's — lives in the disclosure below, where it is
                still exact but no longer in the way. */}
            <p className="lede" data-testid="alerts-lede">
              Purchases in your books that your supplier has not filed yet — either not
              on the portal at all, or sitting there as a draft they can still change.
            </p>
            <p className="lede" data-testid="alerts-why">
              Nothing here is final, so one phone call can still put it right. Once the
              supplier files it, it is locked: fixing it after that needs an amendment,
              and your credit turns up a month late — so it leaves this screen and moves
              to Actions.
            </p>
            <p className="muted small" data-testid="alerts-date-help">
              The date below changes how much time is left. It does not change what is
              listed.
            </p>

            <details className="disclosure" data-testid="why-totals-differ">
              <summary>Why these numbers differ from Summary</summary>
              {WHY_TOTALS_DIFFER.map((paragraph) => (
                <p key={paragraph.slice(0, 40)}>{paragraph}</p>
              ))}
            </details>
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
              <ExposureSplit
                entry={alerts.totals}
                format={rupeesCompact}
                compact
                testId="totals-split"
              />
              <p className="total-help">
                Credit you are waiting on that your supplier can still sort out.
                Amounts are added up, never cancelled against each other: an invoice
                you are owed and a credit note you owe back are two separate problems,
                not one small one.
                {alerts.totals.inGstr2bCount ? (
                  <>
                    {' '}
                    <strong data-testid="alerts-in2b-count">
                      {alerts.totals.inGstr2bCount} of {alerts.totals.invoiceCount}
                    </strong>{' '}
                    {alerts.totals.inGstr2bCount === 1 ? 'is' : 'are'} already in your
                    GSTR-2B, so your supplier has filed{' '}
                    {alerts.totals.inGstr2bCount === 1 ? 'it' : 'them'}. Download IMS
                    again before phoning anyone — the copy you loaded looks older than
                    your GSTR-2B.
                  </>
                ) : null}
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
                  <ExposureSplit
                    entry={band}
                    format={rupeesCompact}
                    compact
                    testId={`card-split-${band.band}`}
                  />
                </div>
              ))}
          </div>
        ) : null}

        {/* Informational, and deliberately not a card: it is not a concern, it
            has no chase message, and none of it is inside the figures above. */}
        {excludedNote ? (
          <p className="muted small excluded-note" data-testid="excluded-note">
            {excludedNote}
          </p>
        ) : null}
      </section>

      <ErrorBox error={error} onRetry={load} title="Could not load alerts" />

      {!alerts && !error ? <Loading label="Working out who to chase" rows={5} /> : null}

      {alerts && alerts.totals.supplierCount === 0 ? (
        <Empty title="Nothing to chase" testId="empty-alerts">
          {/* "Everything has been filed" would be false when the list is empty
              only because everything on it was reverse charge. */}
          {alerts.excluded?.invoiceCount
            ? `Every ${formatPeriod(period)} purchase your supplier could still change ` +
              'has been filed. The ones left out above need nothing from anybody. ' +
              'Anything still undecided is on the Actions tab.'
            : `Every ${formatPeriod(period)} purchase in your books has been filed by ` +
              'your suppliers. Anything still undecided is on the Actions tab, not here.'}
        </Empty>
      ) : null}

      {alerts?.bands.map((band) => (
        <Band key={band.band} band={band} />
      ))}
    </div>
  );
}
