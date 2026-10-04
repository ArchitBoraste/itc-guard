import { useState } from 'react';
import { api } from '../api.js';
import { Chip } from '../components/Chip.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';
import { ImsDownloadButton } from '../components/ImsDownload.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { StatTile } from '../components/StatTile.jsx';
import { InlineError } from '../components/States.jsx';
import { deadlineOf, formatDay, formatPeriod, monthOf } from '../lib/calendar.js';
import { issueOf } from '../lib/issues.js';
import { rupees } from '../lib/money.js';
import {
  barSegments,
  exactMatchCount,
  foundRows,
  notFiledRows,
  outsideImsRows,
  overviewFigures,
  portalDocumentCount
} from '../lib/overview.js';
import { isImsActionable } from '../lib/decisionTabs.js';

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// "From August" for an earlier period's document arriving in this one.
export function FromChip({ taxPeriod }) {
  return <Chip tone="info">From {monthOf(taxPeriod)}</Chip>;
}

// What a period needs, for screens that cannot show anything without a run.
export function NoRun({ period, inventory, navigate, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const canRun = Boolean(inventory?.hasBooks && inventory?.hasPortal);

  const reconcile = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createRun(period);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <EmptyState
        title={period ? `${formatPeriod(period)} is not reconciled yet` : 'Nothing uploaded yet'}
        action={
          canRun ? (
            <button type="button" className="btn btn-primary" onClick={reconcile} disabled={busy}>
              {busy ? 'Reconciling…' : `Reconcile ${formatPeriod(period)}`}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => navigate('upload')}>
              Upload files
            </button>
          )
        }
      >
        {canRun
          ? 'Your books and the portal files are in. Reconcile to see what matches.'
          : 'Upload your purchase register and the latest IMS download to start.'}
        <InlineError error={error} />
      </EmptyState>
    </section>
  );
}

function taxCell(result, issue) {
  if (issue.key === 'HIGHER' || issue.key === 'LOWER') {
    return rupees(result.portal.totalTax - result.books.totalTax, { signed: true });
  }
  return rupees(result.signedItc);
}

function invoiceCell(result, issue) {
  if (issue.key === 'INVOICE_NO_DIFFERS') {
    return (
      <>
        {result.books.invoiceNo} <span className="muted">vs</span> {result.portal.invoiceNo}
      </>
    );
  }
  return (result.books ?? result.portal)?.invoiceNo ?? '—';
}

function TodoStep({ number, tone, title, sub, children }) {
  return (
    <li className="todo-item">
      <span className={`todo-number${tone ? ` is-${tone}` : ''}`} aria-hidden="true">
        {number}
      </span>
      <div className="todo-text">
        <div className="todo-title">{title}</div>
        <div className="small muted">{sub}</div>
      </div>
      {children}
    </li>
  );
}

export function OverviewScreen({ period, inventory, run, results, corrections, calendar, navigate, href, refresh, rerun, rerunning }) {
  if (!run || !results) return <NoRun period={period} inventory={inventory} navigate={navigate} refresh={refresh} />;

  const figures = overviewFigures(run, results);
  const segments = barSegments(figures);
  const barTotal = segments.reduce((total, segment) => total + segment.itc, 0);
  const due = deadlineOf(calendar, 'GSTR3B_DUE');
  const found = foundRows(results, issueOf);
  const exact = exactMatchCount(results);
  const outside = outsideImsRows(results);
  const carried = run.carriedIn ?? { claimableItc: 0, byPeriod: {} };
  const carriedFrom = Object.keys(carried.byPeriod ?? {});
  const waiting = corrections?.counts?.waiting ?? 0;
  const hasImsRecords = results.some(isImsActionable);
  const allInvoices = (rows) => rows.every((result) => result.books?.docType === 'INVOICE');
  const notFiledDocs = notFiledRows(results);

  const steps = [];
  if (figures.decision.count) {
    steps.push({
      key: 'decide',
      tone: 'warn',
      title: `Decide ${plural(figures.decision.count, 'IMS record')}`,
      sub: figures.decision.itc > 0 ? `${rupees(figures.decision.itc)} is waiting on you` : 'Each one goes to the portal as Not decided until you choose',
      action: (
        <a className="btn btn-primary" href={href('decisions')}>
          Review
        </a>
      )
    });
  }
  if (figures.notFiled.count) {
    steps.push({
      key: 'chase',
      tone: 'neutral',
      title: `Chase ${plural(figures.notFiled.suppliers, 'supplier')}`,
      sub: figures.notFiled.count === 1 ? "Their invoice isn't filed yet" : "Their invoices aren't filed yet",
      action: (
        <a className="btn" href={href('notfiled')}>
          Open
        </a>
      )
    });
  }
  if (waiting) {
    steps.push({
      key: 'remind',
      tone: 'neutral',
      title: `Remind suppliers about ${plural(waiting, 'correction')}`,
      sub: `${rupees(corrections.waitingItc)} from earlier months is still waiting`,
      action: (
        <a className="btn" href={href('corrections')}>
          Open
        </a>
      )
    });
  }
  if (hasImsRecords) {
    steps.push({
      key: 'upload',
      tone: null,
      title: 'Upload the IMS file on the portal',
      sub: 'Download it once everything is decided',
      action: (
        <ImsDownloadButton run={run} dueDate={due?.date} className="btn">
          Download
        </ImsDownloadButton>
      )
    });
  }

  return (
    <>
      <PageHeader
        title={formatPeriod(period)}
        subtitle={`${plural(figures.books.count, 'document')} in your books · ${plural(
          portalDocumentCount(results),
          'record'
        )} on the portal`}
      >
        <button type="button" className="btn btn-large" onClick={rerun} disabled={rerunning}>
          {rerunning ? 'Re-running…' : 'Re-run'}
        </button>
      </PageHeader>

      <section className="card totals-card" aria-label="Totals">
        <div className="stat-grid">
          <StatTile
            label="Credit in your books"
            value={rupees(figures.books.itc)}
            sub={plural(figures.books.count, 'document')}
            testId="tile-books"
          />
          <StatTile
            label="Ready to claim"
            value={rupees(figures.ready.itc)}
            sub={figures.ready.allExact ? `${figures.ready.count} match exactly` : plural(figures.ready.count, 'document')}
            tone="ok"
            testId="tile-ready"
          />
          <StatTile
            label="Needs your decision"
            value={rupees(figures.decision.itc)}
            sub={plural(figures.decision.count, 'record')}
            tone="warn"
            testId="tile-decision"
          />
          <StatTile
            label="Not filed by suppliers"
            value={rupees(figures.notFiled.itc)}
            sub={plural(figures.notFiled.count, allInvoices(notFiledDocs) ? 'invoice' : 'document')}
            tone="neutral"
            testId="tile-notfiled"
          />
        </div>
        {barTotal > 0 ? (
          <div
            className="segbar"
            role="img"
            aria-label={segments.map((segment) => `${segment.label} ${rupees(segment.itc)}`).join(', ')}
            data-testid="segbar"
          >
            {segments.map((segment) => (
              <span key={segment.key} className={`seg-${segment.tone}`} style={{ flex: `${segment.itc} 1 0` }} title={`${segment.label}: ${rupees(segment.itc)}`} />
            ))}
          </div>
        ) : null}
        {figures.rest.itc > 0 ? (
          <div className="caption" data-testid="rest-line">
            {rupees(figures.rest.itc)} waiting on a supplier&apos;s correction
          </div>
        ) : null}
      </section>

      {carried.claimableItc > 0 ? (
        <div className="card inline-note" data-testid="carried-in">
          <Icon name="corrections" size={16} />
          <span>
            <strong>{rupees(carried.claimableItc)}</strong> arrived from{' '}
            {carriedFrom.length === 1 ? monthOf(carriedFrom[0]) : 'earlier months'}
          </span>{' '}
          <span className="muted">·</span>{' '}
          <a href={href('corrections')}>see Corrections</a>
        </div>
      ) : null}

      <div className="split">
        <section className="card todo" aria-labelledby="todo-title">
          <h2 className="card-title" id="todo-title">
            {due ? `Before ${formatDay(due.date)}` : 'To do'}
          </h2>
          {steps.length ? (
            <ol className="plain-list" data-testid="todo">
              {steps.map((step, index) => (
                <TodoStep key={step.key} number={index + 1} tone={step.tone} title={step.title} sub={step.sub}>
                  {step.action}
                </TodoStep>
              ))}
            </ol>
          ) : (
            <p className="small muted">Nothing to do for this period.</p>
          )}
        </section>

        <section className="card card-table found" aria-labelledby="found-title">
          <div className="card-head">
            <h2 className="card-title" id="found-title">
              What we found
            </h2>
            <span className="small muted" data-testid="exact-count">
              {found.length ? `${plural(exact, 'other document')} match exactly` : `All ${plural(exact, 'document')} match exactly`}
            </span>
          </div>
          {found.length ? (
            <DataTable
              label="What we found"
              testId="found"
              minWidth={520}
              rows={found}
              rowKey={({ result }) => result.id}
              columns={[
                {
                  key: 'issue',
                  header: 'Issue',
                  nowrap: true,
                  render: ({ result, issue }) => (
                    <span className="row-flags" style={{ marginTop: 0 }}>
                      <Chip tone={issue.tone}>{issue.key === 'ROUNDING' ? `${issue.label} · accepted` : issue.label}</Chip>
                      {result.linkedFrom ? <FromChip taxPeriod={result.linkedFrom.taxPeriod} /> : null}
                    </span>
                  )
                },
                {
                  key: 'supplier',
                  header: 'Supplier',
                  render: ({ result }) => (result.books ?? result.portal)?.supplierName ?? '—'
                },
                { key: 'invoice', header: 'Invoice', className: 'cell-mono', nowrap: true, render: ({ result, issue }) => invoiceCell(result, issue) },
                { key: 'tax', header: 'Tax', align: 'right', render: ({ result, issue }) => <span className="num">{taxCell(result, issue)}</span> }
              ]}
            />
          ) : (
            <EmptyState title="Nothing to look at" testId="nothing-found">
              Every document matches the portal.
            </EmptyState>
          )}
        </section>
      </div>

      {outside.length ? (
        <details className="card disclosure" data-testid="outside-ims">
          <summary>
            <span>
              {plural(outside.length, 'record')} outside IMS (reverse charge, ineligible, ISD, imports) ·{' '}
              {rupees(figures.outside.itc)}
            </span>
            <Icon name="chevronDown" size={16} className="chevron" />
          </summary>
          <DataTable
            label="Records outside IMS"
            minWidth={520}
            rows={outside}
            rowKey={(result) => result.id}
            columns={[
              { key: 'kind', header: 'Kind', nowrap: true, render: (result) => <Chip tone="neutral">{issueOf(result).label}</Chip> },
              { key: 'supplier', header: 'Supplier', render: (result) => (result.books ?? result.portal)?.supplierName ?? '—' },
              { key: 'invoice', header: 'Invoice', className: 'cell-mono', render: (result) => (result.books ?? result.portal)?.invoiceNo ?? '—' },
              { key: 'tax', header: 'Tax', align: 'right', render: (result) => <span className="num">{rupees(result.signedItc)}</span> }
            ]}
          />
        </details>
      ) : null}
    </>
  );
}
