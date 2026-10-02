import { useState } from 'react';
import { rupees } from '../lib/money.js';
import { formatDate } from '../lib/calendar.js';
import {
  ACTION_LABEL,
  BUCKET_LABEL,
  FLAG_LABEL,
  rowFlags,
  IMS_ACTIONS,
  IMS_DECISIONS,
  RECOMMENDED_TO_IMS,
  STALE_HELP,
  WITHDRAWN_HELP,
  actionability,
  isOverride
} from '../lib/vocab.js';
import { ScoreBreakdown } from './ScoreBreakdown.jsx';
import { SideBySide } from './SideBySide.jsx';
import { InlineError } from './States.jsx';

// One reconciliation result, with its decision controls.
//
// Two rules the controls exist to enforce, both of which the API also enforces
// with a 409 — the UI must simply never get there:
//   * a record the portal blocks Pending on cannot be sent as Pending; the portal
//     rejects the ENTIRE upload over one bad record.
//   * a record that never entered IMS has nothing to accept or reject at all.
export function ResultRow({ result, onConfirm, busy }) {
  const [error, setError] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);

  const gate = actionability(result);
  const overridden = isOverride(result);
  // N is never a decision, so it is never the recommended control either.
  const recommendedIms = RECOMMENDED_TO_IMS[result.recommendedAction] ?? 'NO_ACTION';
  const starred = IMS_DECISIONS.has(recommendedIms) ? recommendedIms : null;
  const wasReset = (result.flags ?? []).includes('CONFIRMATION_RESET');
  // The verdict beside these numbers was computed against portal figures that have
  // since moved. The API refuses a decision here with a 409; the controls must not
  // offer one. Accepting a row that reads "Agrees with the portal" while the two
  // sides visibly disagree is how a trader waives a discrepancy they never saw.
  const stale = Boolean(result.stale);
  // Withdrawn is a different state, not a worse one: the record is gone from the
  // portal, so no decision applies — and unlike a stale verdict, re-running does
  // not fix it. Both block the controls; only one prompts a rebuild.
  const withdrawn = Boolean(result.withdrawn);
  const blocked = stale || withdrawn;

  const identity = result.books ?? result.portal ?? {};

  const choose = async (action) => {
    setError(null);
    setPendingAction(action);
    try {
      await onConfirm(result, action);
    } catch (err) {
      setError(err);
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <article
      className={`row ${result.confirmedAction ? 'is-confirmed' : ''} ${overridden ? 'is-overridden' : ''} ${wasReset ? 'is-reset' : ''} ${blocked ? 'is-stale' : ''}`}
      data-testid="result-row"
      data-stale={stale ? 'true' : 'false'}
      data-withdrawn={withdrawn ? 'true' : 'false'}
      data-bucket={result.bucket}
      data-recommended={result.recommendedAction}
      data-confirmed={result.confirmedAction ?? ''}
      data-result-id={result.id}
    >
      <div className="row-identity">
        <div className="row-supplier" title={identity.supplierGstin ?? ''}>
          {identity.supplierName ?? 'Unknown supplier'}
        </div>
        <div className="row-gstin mono">{identity.supplierGstin ?? '—'}</div>
        <div className="row-doc">
          <strong className="mono">{identity.invoiceNo ?? '—'}</strong>
          <span className="muted">{formatDate(identity.invoiceDate)}</span>
        </div>
        <div className="row-tags">
          <span
            className={`chip chip-bucket bucket-${result.bucket} ${blocked ? 'is-stale' : ''}`}
            data-testid={`chip-${result.bucket}`}
            title={blocked ? 'This verdict no longer describes the portal record' : undefined}
          >
            {BUCKET_LABEL[result.bucket] ?? result.bucket}
          </span>
          {stale ? (
            <span className="chip chip-stale" data-testid="stale-chip">
              out of date
            </span>
          ) : null}
          {withdrawn ? (
            <span className="chip chip-stale" data-testid="withdrawn-chip">
              withdrawn
            </span>
          ) : null}
          <ScoreBreakdown
            score={result.score}
            breakdown={result.scoreBreakdown}
            matchedVia={result.matchedVia}
          />
        </div>
        {rowFlags(result.flags ?? []).length ? (
          <div className="row-flags">
            {rowFlags(result.flags).map((flag) => (
              <span
                key={flag}
                className={`flag ${flag === 'CONFIRMATION_RESET' || flag === 'CHANGED_AFTER_REVIEW' ? 'flag-alert' : ''}`}
                data-testid={`flag-${flag}`}
              >
                {FLAG_LABEL[flag] ?? flag}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="row-compare">
        <SideBySide
          books={result.books}
          portal={result.portal}
          deltaTaxableValue={result.deltaTaxableValue}
          deltaTotalTax={result.deltaTotalTax}
        />
      </div>

      <div className="row-decision">
        <div className="row-impact">
          <span className="impact-label">Credit at stake</span>
          <strong className={`mono ${(result.signedItc ?? 0) < 0 ? 'bad' : ''}`}>
            {rupees(result.signedItc)}
          </strong>
          {result.itcImpact ? (
            <span className="muted small">
              {rupees(Math.abs(result.itcImpact))} of it is the disputed part
            </span>
          ) : null}
        </div>

        <div className="row-recommendation">
          <span className="rec-label">Recommended</span>
          <span className={`chip chip-action action-${result.recommendedAction}`}>
            {ACTION_LABEL[result.recommendedAction] ?? result.recommendedAction}
          </span>
          {result.needsDecision ? (
            <span className="chip chip-open" data-testid="open-badge">
              not decided
            </span>
          ) : overridden ? (
            <span className="chip chip-override" data-testid="override-badge">
              you chose {ACTION_LABEL[result.confirmedAction]}
            </span>
          ) : result.confirmedAction ? (
            <span className="chip chip-agreed" data-testid="agreed-badge">
              confirmed
            </span>
          ) : (
            <span className="chip chip-open" data-testid="open-badge">
              not decided
            </span>
          )}
        </div>

        {gate.kind !== 'IMS' ? (
          <p className="no-action-note" data-testid="no-ims-note">
            No IMS record to act on. {gate.why}
          </p>
        ) : (
          <div className="row-controls" role="group" aria-label="IMS action">
            {IMS_ACTIONS.map((action) => {
              const allowed = gate.allowed.includes(action);
              const selected = result.confirmedAction === action;
              const recommended = starred === action;
              return (
                <button
                  key={action}
                  type="button"
                  className={`ctl ctl-${action} ${selected ? 'is-selected' : ''} ${recommended ? 'is-recommended' : ''}`}
                  data-testid={`action-${action}`}
                  disabled={!allowed || blocked || busy || pendingAction !== null}
                  title={
                    withdrawn
                      ? 'The supplier withdrew this record — there is nothing to act on'
                      : stale
                        ? 'Re-run the reconciliation before acting on this row'
                        : allowed
                        ? recommended
                          ? 'What the engine recommends'
                            : undefined
                          : gate.why ?? 'Not available on this record'
                  }
                  aria-pressed={selected}
                  onClick={() => choose(action)}
                >
                  {pendingAction === action ? '…' : ACTION_LABEL[action]}
                  {recommended ? <span className="ctl-star" aria-hidden="true">★</span> : null}
                </button>
              );
            })}
          </div>
        )}

        {gate.kind === 'IMS' && result.portal?.pendingBlocked ? (
          <p className="blocked-note" data-testid="pending-blocked-note">
            Pending is blocked on this record by the portal.
          </p>
        ) : null}
      </div>

      <div className="row-reason">
        {stale ? (
          <p className="stale-note" data-testid="stale-note" role="alert">
            <strong>
              {result.staleReason === 'UNVERIFIABLE'
                ? 'This run cannot be verified.'
                : 'This run is out of date.'}
            </strong>{' '}
            {STALE_HELP[result.staleReason] ?? STALE_HELP.PORTAL_CHANGED}
          </p>
        ) : null}
        {withdrawn ? (
          <p className="stale-note" data-testid="withdrawn-note" role="alert">
            <strong>The supplier withdrew this record.</strong> {WITHDRAWN_HELP}
          </p>
        ) : null}
        {wasReset ? (
          <p className="reset-note" data-testid="reset-note">
            <strong>Your earlier decision was dropped.</strong> The supplier changed this
            record after you confirmed it, so the decision was no longer about the same
            thing. Decide again.
          </p>
        ) : null}
        <p>{result.recommendationReason}</p>
        {result.remarks ? (
          <p className="remarks">
            <span className="remarks-label">Remarks sent to the portal</span>
            <span className="mono">{result.remarks}</span>
          </p>
        ) : null}
        {result.portal?.remarksBlocked ? (
          <p className="muted small">
            This record does not accept remarks, so none are sent with the action.
          </p>
        ) : null}
        <InlineError error={error} onDismiss={() => setError(null)} />
      </div>
    </article>
  );
}

// Present in the group header: a way to accept the engine's whole proposal at
// once. Rejects are deliberately harder — a wrong reject costs the trader a month
// of credit and raises the supplier's liability, so it takes a second click.
//
// `bulk` is false for a group whose recommendation is not an IMS decision (Verify
// and the other workflow states): those rows are decided one at a time, and the
// API refuses a bulk confirm on them.
export function GroupConfirm({ action, count, bulk = true, onConfirmAll, busy }) {
  const [armed, setArmed] = useState(false);
  const dangerous = action === 'REJECT';

  if (!count) return null;

  if (!bulk) {
    return (
      <button
        type="button"
        className="btn"
        data-testid="group-confirm"
        disabled
        title="Decide each of these on its own row"
      >
        Confirm all {count}
      </button>
    );
  }

  if (dangerous && !armed) {
    return (
      <button
        type="button"
        className="btn btn-danger-ghost"
        data-testid="group-confirm-arm"
        disabled={busy}
        onClick={() => setArmed(true)}
      >
        Reject all {count}…
      </button>
    );
  }

  return (
    <span className="group-confirm">
      {dangerous ? (
        <span className="danger-warn">
          Rejecting delays this credit by a month and raises the supplier's liability.
        </span>
      ) : null}
      <button
        type="button"
        className={`btn ${dangerous ? 'btn-danger' : 'btn-primary'}`}
        data-testid="group-confirm"
        disabled={busy}
        onClick={async () => {
          await onConfirmAll();
          setArmed(false);
        }}
      >
        {busy ? 'Confirming…' : dangerous ? `Yes, reject ${count}` : `Confirm all ${count}`}
      </button>
      {dangerous ? (
        <button type="button" className="link" onClick={() => setArmed(false)}>
          cancel
        </button>
      ) : null}
    </span>
  );
}
