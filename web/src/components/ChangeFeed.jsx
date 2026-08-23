import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { rupees } from '../lib/money.js';
import { formatDate } from '../lib/calendar.js';
import {
  ACTION_LABEL,
  CHANGE_FIELD_LABEL,
  CHANGE_MONEY_FIELDS,
  CHANGE_TYPE_HELP,
  CHANGE_TYPE_LABEL,
  DOC_TYPE_LABEL
} from '../lib/vocab.js';

// "Changed since your review" — what the portal did between two downloads.
//
// The screen has exactly two audiences and they need opposite treatment:
//
//   * A change that INVALIDATED A DECISION the trader already made. That is not
//     news about a supplier, it is the app saying an answer they gave no longer
//     counts and the record is back on their desk. It gets an alert region, its
//     own panel, and it renders above the action list — never behind a toggle,
//     never collapsed, never merged into a count.
//
//   * A change on a record they never reviewed. Useful, but it is background:
//     nothing has been undone and nothing is owed. Quiet, collapsed, and out of
//     the way of the work.
//
// Merging the two into one list is the failure mode. Four hundred rows of "the
// supplier filed" with two dropped decisions somewhere inside is the same as not
// showing the dropped decisions at all.

function valueOf(field, value) {
  if (value === null || value === undefined) return '—';
  if (CHANGE_MONEY_FIELDS.has(field)) return rupees(value);
  if (field === 'invoiceDate') return formatDate(value);
  if (field === 'docType') return DOC_TYPE_LABEL[value] ?? value;
  if (field === 'filingStatus') return value === 'FILED' ? 'Filed' : 'Saved';
  return String(value);
}

function FieldDiff({ field }) {
  const money = CHANGE_MONEY_FIELDS.has(field.field);
  return (
    <li className="diff-line">
      <span className="diff-field">{CHANGE_FIELD_LABEL[field.field] ?? field.field}</span>
      <span className="diff-old mono">{valueOf(field.field, field.oldValue)}</span>
      <span className="diff-arrow" aria-label="became">→</span>
      <span className="diff-new mono">{valueOf(field.field, field.newValue)}</span>
      {money && field.delta ? (
        <span className={`diff-delta mono ${field.delta < 0 ? 'bad' : 'good'}`}>
          {field.delta > 0 ? '+' : '−'}
          {rupees(Math.abs(field.delta))}
        </span>
      ) : null}
    </li>
  );
}

function ChangeRow({ change, loud }) {
  const { record, review } = change;
  return (
    <article
      className={`change ${loud ? 'change-loud' : 'change-quiet'} change-${change.changeType}`}
      data-testid={`change-${change.id}`}
      data-change-type={change.changeType}
    >
      <div className="change-head">
        <span className={`chip chip-change change-chip-${change.changeType}`}>
          {CHANGE_TYPE_LABEL[change.changeType] ?? change.changeType}
        </span>
        <span className="change-supplier ellipsis">{record.supplierName ?? record.supplierGstin}</span>
        <span className="mono small muted">{record.invoiceNo}</span>
        <span className="small muted">{formatDate(record.invoiceDate)}</span>
        <span className="small muted">{record.source === 'IMS' ? 'IMS' : 'GSTR-2B'}</span>
      </div>

      {loud ? (
        <p className="change-verdict">
          <strong>
            {/* A reset decision is already gone, so the app no longer knows what it
                was; a decision on a withdrawn record is still on file and can be
                named. Both need saying, and they are different sentences. */}
            {review.confirmedAction
              ? `You confirmed ${ACTION_LABEL[review.confirmedAction] ?? review.confirmedAction} on this record.`
              : 'Your decision on this record was dropped.'}
          </strong>{' '}
          {CHANGE_TYPE_HELP[change.changeType]} Decide again below.
        </p>
      ) : null}

      {change.fields?.length ? (
        <ul className="change-diff">
          {change.fields.map((field) => (
            <FieldDiff key={field.field} field={field} />
          ))}
        </ul>
      ) : (
        <p className="change-verdict muted small">{CHANGE_TYPE_HELP[change.changeType]}</p>
      )}

      {change.deltaTotalTax ? (
        <p className="change-money">
          Tax on this record moved{' '}
          <strong className={`mono ${change.deltaTotalTax < 0 ? 'bad' : 'good'}`}>
            {change.deltaTotalTax > 0 ? '+' : '−'}
            {rupees(Math.abs(change.deltaTotalTax))}
          </strong>
          .
        </p>
      ) : null}
    </article>
  );
}

export function ChangeFeed({ run }) {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  const [showQuiet, setShowQuiet] = useState(false);

  const load = useCallback(async (runId) => {
    setError(null);
    try {
      setFeed(await api.listChanges(runId));
    } catch (err) {
      setFeed(null);
      setError(err);
    }
  }, []);

  useEffect(() => {
    if (run?.id) load(run.id);
    else setFeed(null);
  }, [run?.id, load]);

  // A feed that cannot load is not worth a red box of its own — the action list
  // below is still correct and still usable. Say so once, quietly.
  if (error) {
    return (
      <section className="panel change-panel" data-testid="change-feed-error">
        <p className="muted small">
          Could not load what changed since your last download ({error.message}).
        </p>
      </section>
    );
  }

  if (!feed || feed.total === 0) return null;

  const invalidated = feed.changes.filter((change) => change.review.invalidatedDecision);
  const informational = feed.changes.filter((change) => !change.review.invalidatedDecision);

  return (
    <>
      {invalidated.length ? (
        <section
          className="panel change-panel change-panel-alert"
          role="alert"
          data-testid="changes-invalidated"
        >
          <header className="panel-head">
            <div>
              <h2>
                <span className="chip chip-alarm">{invalidated.length}</span>
                {invalidated.length === 1
                  ? 'A decision you made no longer applies'
                  : 'Decisions you made no longer apply'}
              </h2>
              <p className="muted">
                The supplier changed these records after you decided about them, so the
                decision was about something that is no longer there. IMS resets the
                recipient's action in exactly this case — these are back on your desk.
              </p>
            </div>
            {feed.invalidatedItc ? (
              <div className="change-total">
                <span className="impact-label">Credit riding on them</span>
                <strong className="mono">{rupees(feed.invalidatedItc)}</strong>
              </div>
            ) : null}
          </header>

          <div className="change-list">
            {invalidated.map((change) => (
              <ChangeRow key={change.id} change={change} loud />
            ))}
          </div>
        </section>
      ) : null}

      {informational.length ? (
        <section className="panel change-panel" data-testid="changes-informational">
          <header className="panel-head">
            <div>
              <h3>
                {informational.length} other change{informational.length === 1 ? '' : 's'} since
                your last download
              </h3>
              <p className="muted small">
                Nothing here undoes a decision you made — you had not decided about these
                records yet.
              </p>
            </div>
            <button
              type="button"
              className="btn"
              data-testid="toggle-quiet-changes"
              onClick={() => setShowQuiet((current) => !current)}
            >
              {showQuiet ? 'Hide' : 'Show'} {informational.length}
            </button>
          </header>

          {showQuiet ? (
            <div className="change-list">
              {informational.map((change) => (
                <ChangeRow key={change.id} change={change} loud={false} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
