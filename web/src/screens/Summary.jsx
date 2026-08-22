import { rupees, rupeesCompact, shareOf } from '../lib/money.js';
import { formatDate, formatPeriod } from '../lib/calendar.js';
import {
  BUCKETS,
  BUCKET_HELP,
  BUCKET_LABEL,
  DOC_TYPE_LABEL
} from '../lib/vocab.js';
import { Empty } from '../components/States.jsx';
import { ImsDownload } from '../components/ImsDownload.jsx';

// A net figure that HIDES its components is not one number.
//
// 2026-04's deferred total nets to −₹5,577 out of an unreported credit note of
// −₹28,428 and an unreported invoice of +₹22,850. Rendered as a single card it
// reads as a rounding artefact, and the trader misses two separate real problems
// worth ₹51,000 between them.
//
// The test is whether the net MISLEADS, not merely whether credit notes exist. A
// claimable pile of ₹1.29 Cr containing ₹2 lakh of credit notes is an ordinary
// month, and splitting its headline would cry wolf on every card. So the split
// only takes over when the net has gone negative, or when it has collapsed to
// less than half the larger side — the two shapes where reading the net alone
// gives the wrong answer. Either way the per-document-type list below still
// itemises every credit note, so nothing is ever hidden.
function netMisleads(breakdown, total) {
  if (!breakdown?.creditNotes?.count || !breakdown?.otherDocuments?.count) return false;
  const larger = Math.max(
    Math.abs(breakdown.creditNotes.itc),
    Math.abs(breakdown.otherDocuments.itc)
  );
  return total < 0 || Math.abs(total) * 2 < larger;
}

function DocTypeList({ byDocType }) {
  const entries = Object.entries(byDocType ?? {}).sort((a, b) => b[1].count - a[1].count);
  if (!entries.length) return null;
  return (
    <ul className="doctype-list">
      {entries.map(([docType, part]) => (
        <li key={docType}>
          <span>{DOC_TYPE_LABEL[docType] ?? docType}</span>
          <span className="mono muted">×{part.count}</span>
          <span className={`mono ${part.itc < 0 ? 'bad' : ''}`}>{rupees(part.itc)}</span>
        </li>
      ))}
    </ul>
  );
}

function TotalCard({ id, label, help, total, breakdown, tone = 'neutral', denominator = null }) {
  const split = netMisleads(breakdown, total);
  const share = denominator ? shareOf(total, denominator) : null;

  return (
    <article className={`total-card tone-${tone} ${split ? 'is-split' : ''}`} data-testid={`total-${id}`}>
      <h3>{label}</h3>

      {split ? (
        <>
          <div className="split-figures">
            <div className="split-side">
              <div className="split-amount mono" data-testid={`total-${id}-other`}>
                {rupees(breakdown.otherDocuments.itc)}
              </div>
              <div className="split-label">
                {breakdown.otherDocuments.count} invoice
                {breakdown.otherDocuments.count === 1 ? '' : 's'} / debit note
                {breakdown.otherDocuments.count === 1 ? '' : 's'}
              </div>
            </div>
            <div className="split-side">
              <div className="split-amount mono bad" data-testid={`total-${id}-credit`}>
                {rupees(breakdown.creditNotes.itc)}
              </div>
              <div className="split-label">
                {breakdown.creditNotes.count} credit note
                {breakdown.creditNotes.count === 1 ? '' : 's'}
              </div>
            </div>
          </div>
          <div className="split-net">
            These net to{' '}
            <strong className={`mono ${total < 0 ? 'bad' : ''}`} data-testid={`total-${id}-net`}>
              {rupees(total)}
            </strong>
            , which is why the net is not the headline — that is two separate problems
            worth{' '}
            <strong className="mono">
              {rupees(
                Math.abs(breakdown.creditNotes.itc) + Math.abs(breakdown.otherDocuments.itc)
              )}
            </strong>{' '}
            between them, not one small number.
          </div>
        </>
      ) : (
        <div className="total-amount mono" data-testid={`total-${id}-amount`}>
          {rupees(total)}
        </div>
      )}

      <div className="total-meta">
        {breakdown ? (
          <span>
            {breakdown.count} record{breakdown.count === 1 ? '' : 's'}
          </span>
        ) : null}
        {share !== null ? <span>{share}% of expected</span> : null}
      </div>

      <p className="total-help">{help}</p>
      {breakdown ? <DocTypeList byDocType={breakdown.byDocType} /> : null}
    </article>
  );
}

export function SummaryScreen({ run, results, onGoToActions }) {
  if (!run) {
    return (
      <Empty title="No run for this period" testId="empty-run">
        Load a purchase register and a portal file, then run the reconciliation.
      </Empty>
    );
  }

  const { totals, totalsBreakdown = {}, bucketCounts = {}, bucketItc = {} } = run;
  const exceptions = BUCKETS.filter(
    (bucket) => bucket !== 'MATCHED' && (bucketCounts[bucket] ?? 0) > 0
  ).reduce((sum, bucket) => sum + (bucketCounts[bucket] ?? 0), 0);

  return (
    <div className="screen screen-summary">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>{formatPeriod(run.taxPeriod)}</h2>
            <p className="muted">
              Reconciled as of {formatDate(run.asOfDate)} · supplier cut-off{' '}
              {formatDate(run.cutOffDate)} · {run.filingScheme.toLowerCase()} filer ·{' '}
              {(results?.length ?? 0).toLocaleString('en-IN')} documents compared
            </p>
          </div>
          {exceptions > 0 ? (
            <button type="button" className="btn btn-primary" onClick={onGoToActions}>
              {exceptions} need a decision
            </button>
          ) : null}
        </header>

        <div className="headline">
          <div className="headline-main" data-testid="headline-expected">
            <div className="headline-label">Expected input tax credit</div>
            <div className="headline-amount mono">{rupees(totals.expectedTotalItc)}</div>
            <div className="headline-sub">
              {rupeesCompact(totals.expectedTotalItc)} across{' '}
              {(
                (totalsBreakdown.CLAIMABLE?.count ?? 0) +
                (totalsBreakdown.AT_RISK?.count ?? 0) +
                (totalsBreakdown.DEFERRED?.count ?? 0) +
                (totalsBreakdown.INELIGIBLE?.count ?? 0)
              ).toLocaleString('en-IN')}{' '}
              documents. Reverse charge, ISD and imports are counted separately below —
              they reach 2B by a different route and folding them in would mix three
              claim mechanisms into one figure.
            </div>
          </div>

          <div className="headline-bar" aria-hidden="true">
            {[
              ['CLAIMABLE', totals.claimableItc, 'good'],
              ['AT_RISK', totals.atRiskItc, 'bad'],
              ['INELIGIBLE', totals.ineligibleItc, 'muted']
            ].map(([key, value, tone]) => {
              const share = shareOf(value, totals.expectedTotalItc) ?? 0;
              return (
                <span
                  key={key}
                  className={`bar-seg seg-${tone}`}
                  style={{ flexGrow: Math.max(share, 0.4) }}
                  title={`${key}: ${rupees(value)}`}
                />
              );
            })}
          </div>
        </div>

        <div className="total-cards">
          <TotalCard
            id="claimable"
            label="Claimable"
            tone="good"
            total={totals.claimableItc}
            breakdown={totalsBreakdown.CLAIMABLE}
            denominator={totals.expectedTotalItc}
            help="Matched, or confirmed by you as Accept. This is what the period's GSTR-3B can safely claim."
          />
          <TotalCard
            id="atrisk"
            label="At risk"
            tone="bad"
            total={totals.atRiskItc}
            breakdown={totalsBreakdown.AT_RISK}
            denominator={totals.expectedTotalItc}
            help="Open decisions: amounts that disagree, records not in your books, and matches still waiting on you."
          />
          <TotalCard
            id="deferred"
            label="Deferred"
            tone="warn"
            total={totals.deferredItc}
            breakdown={totalsBreakdown.DEFERRED}
            help="Nothing on the portal to act on and the cut-off has passed. These move to a later period."
          />
          <TotalCard
            id="ineligible"
            label="Ineligible"
            tone="muted"
            total={totals.ineligibleItc}
            breakdown={totalsBreakdown.INELIGIBLE}
            denominator={totals.expectedTotalItc}
            help="The portal marks ITC as unavailable. Never claimable, so never a problem to solve."
          />
          <TotalCard
            id="nonims"
            label="Outside IMS"
            tone="info"
            total={totals.nonImsItc}
            breakdown={totalsBreakdown.NON_IMS}
            help="Reverse charge, ISD and imports. Reported in 2B only, with no IMS record to accept or reject. Informational — deliberately not part of expected ITC."
          />
        </div>

        <p className="identity mono" data-testid="totals-identity">
          {[
            ['Claimable', totals.claimableItc],
            ['At risk', totals.atRiskItc],
            ['Deferred', totals.deferredItc],
            ['Ineligible', totals.ineligibleItc]
          ].map(([label, value], index) => (
            <span key={label}>
              {index > 0 ? (value < 0 ? ' − ' : ' + ') : ''}
              {label} {rupees(Math.abs(value))}
            </span>
          ))}
          {' = '}
          {rupees(totals.expectedTotalItc)} expected &nbsp;·&nbsp; plus{' '}
          {rupees(totals.nonImsItc)} outside IMS = {rupees(totals.grandTotalItc)} in total
        </p>

      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>How every document landed</h2>
            <p className="muted">
              The matcher's verdict per document. Codes are kept as-is in the data; the
              headings are the plain-English version.
            </p>
          </div>
        </header>

        <div className="bucket-cards">
          {BUCKETS.map((bucket) => {
            const count = bucketCounts[bucket] ?? 0;
            const itc = bucketItc[bucket] ?? 0;
            return (
              <article
                key={bucket}
                className={`bucket-card ${count ? '' : 'is-empty'} bucket-${bucket}`}
                data-testid={`bucket-${bucket}`}
              >
                <div className="bucket-count mono">{count}</div>
                <div className="bucket-body">
                  <h4>{BUCKET_LABEL[bucket]}</h4>
                  <div className={`bucket-itc mono ${itc < 0 ? 'bad' : ''}`}>{rupees(itc)}</div>
                  <p>{BUCKET_HELP[bucket]}</p>
                  <code className="bucket-code">{bucket}</code>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <ImsDownload run={run} compact />
    </div>
  );
}
