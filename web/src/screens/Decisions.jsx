import { useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Chip } from '../components/Chip.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { FromChip } from '../components/FromChip.jsx';
import { NoRun } from '../components/NoRun.jsx';
import { Icon } from '../components/Icon.jsx';
import { ImsDownloadButton } from '../components/ImsDownload.jsx';
import { MessagePanel } from '../components/MessagePanel.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { SegmentedDecision } from '../components/SegmentedDecision.jsx';
import { InlineError } from '../components/States.jsx';
import { deadlineOf, formatDate } from '../lib/calendar.js';
import {
  TABS,
  acceptAllIds,
  decisionOf,
  decisionRows,
  defaultTab,
  rowsForTab,
  tabCounts
} from '../lib/decisionTabs.js';
import { DOC_TYPE_LABEL, issueOf, recommendationOf, whyLine } from '../lib/issues.js';
import { rupees } from '../lib/money.js';

const DECISION_LABEL = { ACCEPT: 'Accept', REJECT: 'Reject', PENDING: 'Pending' };
const signed = (side) => (side?.docType === 'CREDIT_NOTE' ? -side.totalTax : side?.totalTax);
const signedTaxable = (side) => (side?.docType === 'CREDIT_NOTE' ? -side.taxableValue : side?.taxableValue);
const identityOf = (result) => result.books ?? result.portal ?? {};
// The document a row's message is about: the portal's for a record not in the
// books, else the books' (services/supplierMessages.js messageForResult).
const messageDocument = (result) =>
  (result.bucket === 'MISSING_IN_BOOKS' ? result.portal : identityOf(result)) ?? {};

// How a suggested match was found, from the score the engine stored.
function matchLine(result) {
  const similarity = result.scoreBreakdown?.invoiceNo?.similarity;
  if (result.bucket !== 'SUGGESTED' || typeof similarity !== 'number') return null;
  return `Matched on supplier, date and amount; the two numbers are ${Math.round(similarity * 100)}% alike.`;
}

function Details({ result, period = null }) {
  const books = result.books;
  const portal = result.portal;
  const remark =
    result.confirmedAction === 'REJECT' && result.remarks && !portal?.remarksBlocked ? result.remarks : null;
  const match = matchLine(result);
  return (
    <div className="detail-row" data-testid="details">
      <div className="compare">
        <div className="compare-grid">
          <div />
          <div className="caption">Your books</div>
          <div className="caption">Portal</div>
          <div className="muted">Invoice no.</div>
          <div className="mono">{books?.invoiceNo ?? '—'}</div>
          <div className="mono">{portal?.invoiceNo ?? '—'}</div>
          <div className="muted">Taxable</div>
          <div className="num">{books ? rupees(signedTaxable(books)) : '—'}</div>
          <div className="num">{portal ? rupees(signedTaxable(portal)) : '—'}</div>
          <div className="muted">Tax</div>
          <div className="num">{books ? rupees(signed(books)) : '—'}</div>
          <div className="num">{portal ? rupees(signed(portal)) : '—'}</div>
        </div>
        <div className="compare-why">
          {whyLine(result)}
          {match ? <div className="caption">{match}</div> : null}
        </div>
        {remark ? (
          <div className="compare-why" data-testid="remark">
            <div className="caption">Remark sent with the rejection</div>
            {remark}
          </div>
        ) : null}
      </div>
      {result.message ? (
        <MessagePanel
          headingLevel={2}
          contact={result.supplierContact}
          message={result.message}
          supplierGstin={messageDocument(result).supplierGstin}
          documentRefs={[messageDocument(result).invoiceNo]}
          taxPeriod={period}
          context="decisions"
          noContactText={books ? 'No contact on file' : 'No contact on file: not in your purchase register'}
        />
      ) : null}
    </div>
  );
}

export function DecisionsScreen({ period, inventory, run, results, calendar, navigate, refresh, reloadPeriod }) {
  const rows = useMemo(() => decisionRows(results ?? []), [results]);
  const counts = tabCounts(rows);
  // Opens on whatever needs the trader first, and stays put once they act, so
  // deciding the last open record shows "All caught up" rather than jumping.
  const [chosen, setChosen] = useState(null);
  const tab = chosen ?? defaultTab(counts);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState(null);
  const tabRefs = useRef({});

  if (!run || !results) return <NoRun period={period} inventory={inventory} navigate={navigate} refresh={refresh} />;

  const due = deadlineOf(calendar, 'GSTR3B_DUE');
  const current = TABS.find((entry) => entry.key === tab) ?? TABS[0];
  const visible = rowsForTab(rows, tab);
  const readyIds = acceptAllIds(rows);

  const decide = async (result, action) => {
    setChosen(tab);
    setBusy((value) => ({ ...value, [result.id]: true }));
    setErrors((value) => ({ ...value, [result.id]: null }));
    try {
      // Clearing a choice sends the record back to Not decided.
      await api.confirmResult(result.id, action ?? 'NO_ACTION');
      await reloadPeriod();
    } catch (err) {
      setErrors((value) => ({ ...value, [result.id]: err }));
    } finally {
      setBusy((value) => ({ ...value, [result.id]: false }));
    }
  };

  const dismissReset = async (result) => {
    setErrors((value) => ({ ...value, [result.id]: null }));
    try {
      await api.dismissReset(result.id);
      await reloadPeriod();
    } catch (err) {
      setErrors((value) => ({ ...value, [result.id]: err }));
    }
  };

  const acceptAll = async () => {
    setChosen(tab);
    setBulkBusy(true);
    setBulkError(null);
    try {
      await api.confirmRecommendations(run.id, readyIds);
      await reloadPeriod();
    } catch (err) {
      setBulkError(err);
    } finally {
      setBulkBusy(false);
    }
  };

  const onTabKey = (event, index) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    setChosen(next.key);
    tabRefs.current[next.key]?.focus();
  };

  const columns = [
    {
      key: 'supplier',
      header: 'Supplier',
      render: ({ result }) => {
        const identity = identityOf(result);
        const reset = (result.flags ?? []).includes('CONFIRMATION_RESET');
        return (
          <>
            <div className="cell-main">{identity.supplierName ?? 'Unknown supplier'}</div>
            <div className="cell-gstin">{identity.supplierGstin}</div>
            {result.linkedFrom || reset ? (
              <div className="row-flags">
                {result.linkedFrom ? <FromChip taxPeriod={result.linkedFrom.taxPeriod} /> : null}
                {reset ? (
                  <>
                    <Chip tone="warn" testId="changed-chip" title="The supplier changed this record after you decided it">
                      Changed by supplier
                    </Chip>
                    <button type="button" className="btn-link" onClick={() => dismissReset(result)}>
                      Dismiss
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        );
      }
    },
    {
      key: 'invoice',
      header: 'Invoice',
      nowrap: true,
      render: ({ result }) => {
        const identity = identityOf(result);
        return (
          <>
            <div className="cell-mono">{identity.invoiceNo ?? '—'}</div>
            <div className="cell-sub">
              {formatDate(identity.invoiceDate)}
              {identity.docType && identity.docType !== 'INVOICE' ? ` · ${DOC_TYPE_LABEL[identity.docType].toLowerCase()}` : ''}
            </div>
          </>
        );
      }
    },
    {
      key: 'issue',
      header: 'Issue',
      nowrap: true,
      render: ({ result }) => {
        const issue = issueOf(result);
        return <Chip tone={issue.tone}>{issue.label}</Chip>;
      }
    },
    {
      key: 'books',
      header: 'Books tax',
      align: 'right',
      render: ({ result }) => <span className="num">{result.books ? rupees(signed(result.books)) : '—'}</span>
    },
    {
      key: 'portal',
      header: 'Portal tax',
      align: 'right',
      render: ({ result }) => <span className="num">{result.portal ? rupees(signed(result.portal)) : '—'}</span>
    },
    {
      key: 'recommended',
      header: 'Recommended',
      nowrap: true,
      render: ({ result, status }) => {
        const recommendation = recommendationOf(result);
        const decision = decisionOf(result);
        return (
          <>
            <Chip tone={recommendation.tone}>{recommendation.label}</Chip>
            {status === 'overridden' ? <div className="decided-note">You chose {DECISION_LABEL[decision]}</div> : null}
          </>
        );
      }
    },
    {
      key: 'decision',
      header: 'Your decision',
      render: ({ result }) => (
        <>
          <SegmentedDecision
            value={decisionOf(result)}
            onChange={(action) => decide(result, action)}
            busy={Boolean(busy[result.id])}
            disabled={Boolean(result.stale)}
            disabledReason="The supplier changed this record. Re-run first."
            pendingBlocked={Boolean(result.portal?.pendingBlocked)}
            label={`Decision for ${identityOf(result).invoiceNo ?? 'this record'}`}
          />
          <InlineError error={errors[result.id]} />
        </>
      )
    },
    {
      key: 'toggle',
      header: 'Details',
      hideHeader: true,
      render: ({ result }) => {
        const isOpen = open === result.id;
        return (
          <button
            type="button"
            className="icon-button"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${identityOf(result).invoiceNo ?? 'this record'}`}
            onClick={() => setOpen(isOpen ? null : result.id)}
          >
            <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={14} strokeWidth={2} />
          </button>
        );
      }
    }
  ];

  return (
    <>
      <PageHeader title="IMS decisions" subtitle="Your choices go into the IMS file. Uploading that file on the portal applies them.">
        <ol className="flow" aria-label="How decisions reach the portal">
          <li className="flow-step is-current">1 · Decide here</li>
          <li className="flow-arrow" aria-hidden="true">
            →
          </li>
          <li className="flow-step">2 · Download IMS file</li>
          <li className="flow-arrow" aria-hidden="true">
            →
          </li>
          <li className="flow-step">3 · Upload it in IMS on the portal</li>
        </ol>
      </PageHeader>

      <div className="tabs" role="tablist" aria-label="Filter records">
        {TABS.map((entry, index) => {
          const selected = entry.key === tab;
          return (
            <button
              key={entry.key}
              ref={(node) => {
                tabRefs.current[entry.key] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${entry.key}`}
              aria-selected={selected}
              aria-controls="decision-panel"
              tabIndex={selected ? 0 : -1}
              className="tab"
              onClick={() => setChosen(entry.key)}
              onKeyDown={(event) => onTabKey(event, index)}
              data-testid={`tab-${entry.key}`}
            >
              {entry.label}
              <span className="tab-count">{counts[entry.key]}</span>
            </button>
          );
        })}
      </div>

      <section className="card" id="decision-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <div className="table-toolbar">
          <span>{current.hint}</span>
          {tab === 'ready' && readyIds.length ? (
            <button type="button" className="btn btn-primary" onClick={acceptAll} disabled={bulkBusy} data-testid="accept-all">
              {bulkBusy ? 'Accepting…' : `Accept all ${readyIds.length}`}
            </button>
          ) : null}
        </div>
        <InlineError error={bulkError} />
        {visible.length ? (
          <DataTable
            label={current.label}
            testId="decision-table"
            minWidth={1080}
            rows={visible}
            rowKey={({ result }) => result.id}
            rowProps={({ result }) => ({ 'data-result-id': result.id })}
            columns={columns}
            isExpanded={({ result }) => open === result.id}
            renderDetail={({ result }) => <Details result={result} period={period} />}
          />
        ) : (
          <EmptyState title={current.empty} testId="tab-empty" />
        )}
      </section>

      <section className="card footer-bar" aria-label="IMS file" data-testid="decisions-footer">
        <div className="footer-status">
          <span className={`status-dot${counts.needs ? '' : ' is-ok'}`} aria-hidden="true" />
          <div>
            <div className="strong-line">
              {counts.needs
                ? `${counts.needs} record${counts.needs === 1 ? '' : 's'} not decided yet`
                : 'Everything is decided'}
            </div>
            <div className="small muted">
              {counts.needs
                ? `They go to the portal as Not decided, which is accepted automatically${due ? ` on ${formatDate(due.date)}` : ''}.`
                : 'Download the IMS file and upload it in IMS on the GST portal.'}
            </div>
          </div>
        </div>
        <ImsDownloadButton run={run} dueDate={due?.date} className="btn btn-primary btn-large" />
      </section>
    </>
  );
}
