import { useEffect, useState } from 'react';
import { Chip } from '../components/Chip.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { MessagePanel } from '../components/MessagePanel.jsx';
import { PromisedLine, SupplierBell, scrollToSelector } from '../components/SupplierBell.jsx';
import { docKey } from '../components/MailProvider.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { StatTile } from '../components/StatTile.jsx';
import { formatDate, monthOf } from '../lib/calendar.js';
import { rupees } from '../lib/money.js';

const shortMonth = (taxPeriod) => monthOf(taxPeriod).slice(0, 3);

// What the trader asked the supplier for, in a few words.
export function askedFor(item) {
  const { needed, document } = item;
  const note = document.docType === 'CREDIT_NOTE';
  if (needed.kind === 'NOT_FILED') return note ? 'Add missing credit note' : 'Add missing invoice';
  if (needed.kind === 'SAVED_NOT_FILED') return note ? 'File the saved credit note' : 'File the saved invoice';
  const gap = (needed.portal?.totalTax ?? 0) - document.totalTax;
  return gap < 0 ? `Report the ${rupees(-gap)} tax difference` : `Correct tax to ${rupees(document.totalTax)}`;
}

// Where an arrival was found, or why nothing has been.
export function foundIn(item, period) {
  if (item.status === 'ARRIVED') {
    const { arrival } = item;
    const how =
      arrival.via === 'AMENDMENT' ? 'GSTR-1A amendment' : arrival.sourceForm === 'R1A' ? 'Added through GSTR-1A' : 'Filed late';
    const where = [
      ...new Set(
        (arrival.seenIn ?? []).map((entry) =>
          entry.source === 'GSTR2B' ? `${shortMonth(period)} 2B` : `IMS ${entry.snapshotDate ? formatDate(entry.snapshotDate) : ''}`.trim()
        )
      )
    ];
    return [how, ...where].join(' · ');
  }
  if (item.waiting?.saved) return 'Saved, not filed yet';
  return `Not in ${monthOf(period)} files`;
}

export function CorrectionsScreen({ period, corrections, focus = null }) {
  const [selected, setSelected] = useState(null);
  const items = corrections?.items ?? [];

  // A reply picked in the top bar: open its reminder, which shows the thread.
  useEffect(() => {
    if (!focus) return;
    const item = items.find(
      (entry) =>
        entry.status === 'WAITING' &&
        entry.supplier.gstin === focus.gstin &&
        (!focus.invoiceNo || docKey(entry.document.invoiceNo) === docKey(focus.invoiceNo))
    );
    if (!item) return;
    setSelected(item.resultId);
    scrollToSelector('[data-testid="message-panel"]');
  }, [focus?.nonce, corrections]); // eslint-disable-line react-hooks/exhaustive-deps
  const months = [...new Set(items.map((item) => item.taxPeriod))];
  const from = months.length === 1 ? monthOf(months[0]) : 'earlier months';

  const header = (
    <PageHeader
      title="Corrections"
      subtitle={
        items.length
          ? `Fixes you asked suppliers for in ${from}, checked against ${monthOf(period)}'s files.`
          : 'Fixes you asked suppliers for, checked against later months.'
      }
    />
  );

  if (!items.length) {
    return (
      <>
        {header}
        <section className="card">
          <EmptyState title="Corrections appear once you load a second month." testId="no-corrections" />
        </section>
      </>
    );
  }

  const waiting = items.filter((item) => item.status === 'WAITING');
  const nextChance = waiting
    .map((item) => item.waiting?.nextChance?.date)
    .filter(Boolean)
    .sort()[0];
  const current = waiting.find((item) => item.resultId === selected) ?? null;

  return (
    <>
      {header}
      <section className="stat-grid is-three" aria-label="Totals">
        <StatTile card label="Asked for" value={items.length} sub={`from the ${from} review`} testId="asked" />
        <StatTile
          card
          label="Arrived"
          value={`${corrections.counts.arrived} · ${rupees(corrections.arrivedItc)}`}
          sub={`claimable in ${monthOf(period)}`}
          tone="ok"
          testId="arrived"
        />
        <StatTile
          card
          label="Still waiting"
          value={`${corrections.counts.waiting} · ${rupees(corrections.waitingItc)}`}
          sub={nextChance ? `next chance ${formatDate(nextChance)}` : 'nothing waiting'}
          tone="warn"
          testId="waiting"
        />
      </section>

      <section className="card card-table" aria-label="Corrections">
        <DataTable
          label="Corrections"
          testId="corrections-table"
          minWidth={960}
          rows={items}
          rowKey={(item) => item.resultId}
          rowClassName={(item) => (current && item.resultId === current.resultId ? 'is-selected' : null)}
          columns={[
            {
              key: 'supplier',
              header: 'Supplier',
              render: (item) => (
                <>
                  <div className="supplier-cell-head">
                    <div className="cell-main">{item.supplier.name}</div>
                    <SupplierBell gstin={item.supplier.gstin} name={item.supplier.name} />
                  </div>
                  <div className="cell-gstin">{item.supplier.gstin}</div>
                </>
              )
            },
            {
              key: 'invoice',
              header: 'Invoice',
              nowrap: true,
              render: (item) => (
                <>
                  <div className="cell-mono">{item.document.invoiceNo}</div>
                  <div className="cell-sub">{formatDate(item.document.invoiceDate)}</div>
                </>
              )
            },
            { key: 'asked', header: 'What you asked for', render: askedFor },
            {
              key: 'status',
              header: 'Status',
              nowrap: true,
              render: (item) =>
                item.status === 'ARRIVED' ? (
                  <Chip tone="ok" icon="check">
                    Arrived
                  </Chip>
                ) : (
                  <>
                    <Chip tone="warn">
                      Waiting · {item.waiting.monthsWaiting} month{item.waiting.monthsWaiting === 1 ? '' : 's'}
                    </Chip>
                    <PromisedLine gstin={item.supplier.gstin} invoiceNo={item.document.invoiceNo} />
                  </>
                )
            },
            {
              key: 'found',
              header: 'Found in',
              render: (item) => <span className={item.status === 'ARRIVED' ? undefined : 'muted'}>{foundIn(item, period)}</span>
            },
            {
              key: 'credit',
              header: 'Credit',
              align: 'right',
              render: (item) =>
                item.status === 'ARRIVED' ? (
                  <span className="num cell-main ok-text">{rupees(item.arrival.creditItc, { signed: true })}</span>
                ) : (
                  <span className="num">{rupees(item.needed.outstandingItc)}</span>
                )
            },
            {
              key: 'remind',
              header: 'Action',
              hideHeader: true,
              align: 'right',
              render: (item) =>
                item.status === 'WAITING' ? (
                  <button
                    type="button"
                    className={`btn${current?.resultId === item.resultId ? ' btn-primary' : ''}`}
                    aria-pressed={current?.resultId === item.resultId}
                    aria-label={`Remind ${item.supplier.name} about ${item.document.invoiceNo}`}
                    onClick={() => setSelected(current?.resultId === item.resultId ? null : item.resultId)}
                  >
                    Remind
                  </button>
                ) : null
            }
          ]}
        />
      </section>

      {current?.message ? (
        <MessagePanel
          card
          headingLevel={2}
          title={`Reminder to ${current.supplier.name}`}
          contact={current.supplier.contact}
          message={current.message}
          supplierGstin={current.supplier.gstin}
          documentRefs={[current.document.invoiceNo]}
          taxPeriod={period}
          context="corrections"
        />
      ) : null}
    </>
  );
}
