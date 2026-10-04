import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Chip } from '../components/Chip.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';
import { MessagePanel } from '../components/MessagePanel.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { StatTile } from '../components/StatTile.jsx';
import { ErrorBox, Loading } from '../components/States.jsx';
import { cutOffDate, daysLeftText, formatDate, monthOf, nextPeriod } from '../lib/calendar.js';
import { NOT_FILED_STATUS, schemeLabel } from '../lib/issues.js';
import { rupees } from '../lib/money.js';

const sign = (invoice) => (invoice.docType === 'CREDIT_NOTE' ? -1 : 1);

// The card above the table: whether suppliers can still fix this for free, by
// each one's own cut-off (11th monthly, 13th quarterly).
export function cutoffState(rows, period) {
  const suppliers = [...new Map(rows.map(({ supplier }) => [supplier.gstin, supplier])).values()];
  const before = suppliers.filter((supplier) => supplier.preCutOff !== false);
  const passed = suppliers.filter((supplier) => supplier.preCutOff === false);
  const schemes = new Set(suppliers.map((supplier) => supplier.filingScheme));
  const dates = [
    schemes.has('MONTHLY') || !schemes.size ? `Monthly filers: ${formatDate(cutOffDate(period, 'MONTHLY'))}` : null,
    schemes.has('QRMP') ? `Quarterly filers: ${formatDate(cutOffDate(period, 'QRMP'))}` : null
  ].filter(Boolean).join(' · ');
  const month = monthOf(period);
  const next = monthOf(nextPeriod(period));
  const returns = schemes.has('QRMP') ? 'GSTR-1 or IFF' : 'GSTR-1';
  const fewest = Math.min(...before.map((supplier) => supplier.daysToCutOff ?? 0));

  if (!passed.length) {
    return {
      tone: 'info',
      title: 'Suppliers can still fix this for free',
      chip: fewest === 0 ? 'Last day' : daysLeftText(fewest),
      dates,
      body: `Ask the supplier to include the invoice in ${month}'s ${returns}. You claim the credit in ${month}.`
    };
  }
  if (!before.length) {
    return {
      tone: 'bad',
      title: 'Supplier cut-off has passed',
      chip: 'Passed',
      dates,
      body: (
        <>
          Ask the supplier to add the invoice through <strong>GSTR-1A</strong>. The credit will reach you in {next}.
        </>
      )
    };
  }
  return {
    tone: 'info',
    title: 'Some suppliers can still fix this for free',
    chip: fewest === 0 ? 'Last day' : daysLeftText(fewest),
    dates,
    body: (
      <>
        Those inside their cut-off can still include it in {month}&apos;s {returns}. Ask the others for a{' '}
        <strong>GSTR-1A</strong>; that credit reaches you in {next}.
      </>
    )
  };
}

function CutoffCard({ state, stats }) {
  return (
    <section className="card cutoff-card" aria-labelledby="cutoff-title" data-testid="cutoff-card" data-tone={state.tone}>
      <div className="cutoff-main">
        <div className={`cutoff-icon is-${state.tone}`}>
          <Icon name="clock" size={22} />
        </div>
        <div className="cutoff-copy">
          <div className="cutoff-title">
            <h2 id="cutoff-title">{state.title}</h2>
            <Chip tone={state.tone === 'bad' ? 'bad' : 'info'}>{state.chip}</Chip>
          </div>
          <div className="small muted">{state.dates}</div>
          <div className="cutoff-body">{state.body}</div>
        </div>
      </div>
      <div className="cutoff-stats">
        {stats.map(([label, value]) => (
          <StatTile key={label} label={label} value={value} compact testId={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`} />
        ))}
      </div>
    </section>
  );
}

export function NotFiledScreen({ period, dataVersion }) {
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!period) return undefined;
    let cancelled = false;
    setError(null);
    api
      .listAlerts(period)
      .then((body) => !cancelled && setAlerts(body))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [period, dataVersion]);

  const header = <PageHeader title="Not filed yet" subtitle="Invoices in your books that the supplier hasn't filed on the portal." />;

  if (!period) {
    return (
      <>
        {header}
        <section className="card">
          <EmptyState title="Nothing uploaded yet">Upload your purchase register and an IMS download to see what is not filed.</EmptyState>
        </section>
      </>
    );
  }
  if (error) {
    return (
      <>
        {header}
        <ErrorBox error={error} title="Cannot load this list" />
      </>
    );
  }
  if (!alerts) {
    return (
      <>
        {header}
        <Loading rows={5} />
      </>
    );
  }

  const rows = alerts.suppliers.flatMap((supplier) => supplier.invoices.map((invoice) => ({ supplier, invoice })));
  const key = ({ invoice }) => `${invoice.supplierGstin}:${invoice.invoiceNo}:${invoice.invoiceDate}`;
  const current = rows.find((row) => key(row) === selected) ?? rows[0] ?? null;

  if (!rows.length) {
    return (
      <>
        {header}
        <section className="card">
          <EmptyState title="Every invoice in your books is filed" testId="all-filed" />
        </section>
      </>
    );
  }

  return (
    <>
      {header}
      <CutoffCard
        state={cutoffState(rows, period)}
        stats={[
          ['Invoices', rows.length],
          ['Tax waiting', rupees(alerts.totals.itcAtStake)],
          ['Suppliers', alerts.suppliers.length]
        ]}
      />

      <section className="card card-table" aria-label="Documents not filed">
        <DataTable
          label="Documents not filed"
          testId="notfiled-table"
          minWidth={1000}
          rows={rows}
          rowKey={key}
          rowClassName={(row) => (current && key(row) === key(current) ? 'is-selected' : null)}
          columns={[
            {
              key: 'supplier',
              header: 'Supplier',
              render: ({ supplier }) => (
                <>
                  <div className="cell-main">{supplier.tradeName}</div>
                  <div className="cell-gstin">{supplier.gstin}</div>
                  <div className="cell-sub">{schemeLabel(supplier)}</div>
                </>
              )
            },
            {
              key: 'invoice',
              header: 'Invoice',
              nowrap: true,
              render: ({ invoice }) => (
                <>
                  <div className="cell-mono">{invoice.invoiceNo}</div>
                  <div className="cell-sub">
                    {formatDate(invoice.invoiceDate)}
                    {invoice.docType === 'CREDIT_NOTE' ? ' · credit note' : ''}
                  </div>
                </>
              )
            },
            {
              key: 'taxable',
              header: 'Taxable',
              align: 'right',
              render: ({ invoice }) => <span className="num">{rupees(sign(invoice) * invoice.taxableValue)}</span>
            },
            {
              key: 'tax',
              header: 'Tax',
              align: 'right',
              render: ({ invoice }) => (
                <span className="num cell-main">{rupees(sign(invoice) * invoice.totalTax)}</span>
              )
            },
            {
              key: 'portal',
              header: 'On the portal',
              nowrap: true,
              render: ({ invoice }) => {
                const status = NOT_FILED_STATUS[invoice.status] ?? NOT_FILED_STATUS.NOT_REPORTED;
                return <Chip tone={status.tone}>{status.label}</Chip>;
              }
            },
            {
              key: 'cutoff',
              header: 'Cut-off',
              nowrap: true,
              render: ({ supplier }) => (
                <>
                  <div>{formatDate(supplier.cutOffDate)}</div>
                  <div className={`cell-sub${supplier.preCutOff === false ? ' bad-text' : ''}`}>
                    {supplier.preCutOff === false ? 'Passed' : daysLeftText(supplier.daysToCutOff)}
                  </div>
                </>
              )
            },
            {
              key: 'contact',
              header: 'Contact',
              render: ({ supplier }) =>
                supplier.contact ? (
                  <>
                    <div>{supplier.contact.person ?? supplier.contact.email ?? '—'}</div>
                    {supplier.contact.phone ? <div className="cell-sub num">{supplier.contact.phone}</div> : null}
                  </>
                ) : (
                  <span className="muted">Not on file</span>
                )
            },
            {
              key: 'message',
              header: 'Action',
              hideHeader: true,
              align: 'right',
              render: (row) => {
                const isCurrent = current && key(row) === key(current);
                return (
                  <button
                    type="button"
                    className={`btn${isCurrent ? ' btn-primary' : ''}`}
                    aria-pressed={Boolean(isCurrent)}
                    aria-label={`Message ${row.supplier.tradeName} about ${row.invoice.invoiceNo}`}
                    onClick={() => setSelected(key(row))}
                  >
                    Message
                  </button>
                );
              }
            }
          ]}
        />
      </section>

      {current?.invoice.message ? (
        <MessagePanel
          card
          headingLevel={2}
          title={`Message to ${current.supplier.tradeName}`}
          contact={current.supplier.contact}
          message={current.invoice.message}
          supplierGstin={current.supplier.gstin}
          documentRefs={[current.invoice.invoiceNo]}
          taxPeriod={period}
          context="notfiled"
        />
      ) : null}
    </>
  );
}
