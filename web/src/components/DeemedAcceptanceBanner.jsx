import { rupees } from '../lib/money.js';
import {
  WINDOW_LABEL,
  cutOffDate,
  daysBetween,
  filingWindow,
  formatDate,
  formatPeriod,
  gstr3bDueDate,
  runClock
} from '../lib/calendar.js';
import { IMS_DECISIONS, actionability } from '../lib/vocab.js';

// The core risk this product exists to prevent: NO ACTION IN IMS IS DEEMED
// ACCEPTANCE at GSTR-3B. Nothing on the portal warns about it, so it is the one
// thing that stays on screen on every route.
//
// Two numbers, deliberately not merged:
//   * everything unactioned — what deemed acceptance will actually claim.
//   * the part of it still waiting on a decision — the real exposure. That one is
//     the API's run.openDecisions, the same count Summary and Actions show.
// One number alone is either alarmist (most of it is fine) or complacent (the
// dangerous slice disappears inside a large, mostly-clean total).
export function deemedAcceptanceSummary(run, results) {
  if (!run) return null;
  const asOf = runClock(run);
  const dueDate = gstr3bDueDate(run.taxPeriod);

  let unactionedCount = 0;
  let unactionedItc = 0;
  let confirmedCount = 0;
  let resetCount = 0;

  for (const result of results ?? []) {
    if ((result.flags ?? []).includes('CONFIRMATION_RESET')) resetCount += 1;

    if (actionability(result).kind !== 'IMS') continue;
    if (IMS_DECISIONS.has(result.confirmedAction)) {
      confirmedCount += 1;
      continue;
    }
    // imsAction 'N' is the portal's own "nothing recorded". That is the state
    // deemed acceptance acts on.
    if (result.portal.imsAction && result.portal.imsAction !== 'N') continue;

    unactionedCount += 1;
    unactionedItc += result.signedItc ?? 0;
  }

  return {
    asOf,
    dueDate,
    cutOff: cutOffDate(run.taxPeriod, run.filingScheme),
    daysToDue: daysBetween(asOf, dueDate),
    daysToCutOff: daysBetween(asOf, cutOffDate(run.taxPeriod, run.filingScheme)),
    window: filingWindow(asOf, run.taxPeriod, run.filingScheme),
    unactionedCount,
    unactionedItc,
    openCount: run.openDecisions?.count ?? 0,
    openItc: run.openDecisions?.itc ?? 0,
    confirmedCount,
    resetCount
  };
}

function daysPhrase(days) {
  if (days === null) return 'due date unknown';
  if (days < 0) return `${Math.abs(days)} days past due`;
  if (days === 0) return 'due today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

// How many decisions stand, and what happened to the ones that do not.
//
// A reset decision is neither recorded nor never-made: the count is of decisions
// that still STAND. Presenting the two as independent tallies put
// "0 decisions recorded · 1 was reset" directly above a panel reading
// "1 decision you made was dropped" — every clause true, the whole reading as
// though one of the two were broken.
//
// So they stop being two numbers side by side. With nothing reset it is a plain
// count. With something reset the sentence says what is left and what happened
// to the rest, as one statement, and the wording changes with the count so
// "no decisions still stand" is never followed by "another was dropped".
function decisionTally({ confirmedCount, resetCount }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (!resetCount) {
    return { stand: `${plural(confirmedCount, 'decision')} recorded`, dropped: null };
  }
  if (confirmedCount === 0) {
    return {
      stand: 'no decisions still stand',
      dropped:
        resetCount === 1
          ? 'the one you made was dropped when the supplier changed that record'
          : `all ${resetCount} you made were dropped when suppliers changed those records`
    };
  }
  return {
    stand: `${plural(confirmedCount, 'decision')} still stand${confirmedCount === 1 ? 's' : ''}`,
    dropped:
      resetCount === 1
        ? 'another was dropped when the supplier changed that record'
        : `${resetCount} others were dropped when suppliers changed those records`
  };
}

export function DeemedAcceptanceBanner({ run, results, loading, onGoToActions }) {
  if (loading && !run) {
    return (
      <div className="banner banner-idle" data-testid="deemed-banner-loading">
        <span className="muted">Checking the filing calendar…</span>
      </div>
    );
  }
  if (!run) return null;

  const summary = deemedAcceptanceSummary(run, results);
  const { daysToDue, openCount, unactionedCount } = summary;
  const tally = decisionTally(summary);

  // Tone tracks consequence, not volume: past the due date nothing can be undone,
  // and a week out with open decisions is materially different from a week out
  // with none.
  const tone =
    daysToDue !== null && daysToDue < 0
      ? 'closed'
      : openCount === 0
        ? 'clear'
        : daysToDue !== null && daysToDue <= 5
          ? 'urgent'
          : 'warn';

  return (
    <div className={`banner banner-${tone}`} data-testid="deemed-banner" data-tone={tone}>
      <div className="banner-clock">
        <div className="banner-days">{daysPhrase(daysToDue)}</div>
        <div className="banner-sub">
          GSTR-3B for {formatPeriod(run.taxPeriod)} due {formatDate(summary.dueDate)}
        </div>
      </div>

      <div className="banner-message">
        {tone === 'closed' ? (
          <p>
            <strong>The GSTR-3B due date has passed.</strong> Anything left unactioned in
            IMS was deemed accepted. This run is a record of what happened, not a
            list you can still act on.
          </p>
        ) : openCount === 0 ? (
          <p>
            <strong>Every IMS record has a decision.</strong> Nothing will be deemed
            accepted by default for {formatPeriod(run.taxPeriod)}.
          </p>
        ) : (
          <p>
            <strong data-testid="deemed-unactioned-count">{unactionedCount}</strong>{' '}
            {unactionedCount === 1 ? 'record has' : 'records have'} no action recorded in
            IMS. Doing nothing accepts{' '}
            <strong className="mono" data-testid="deemed-unactioned-itc">
              {rupees(summary.unactionedItc)}
            </strong>{' '}
            of credit at GSTR-3B. Of those,{' '}
            <strong className="bad" data-testid="deemed-open-count">
              {openCount}
            </strong>{' '}
            still {openCount === 1 ? 'needs' : 'need'} a decision —{' '}
            <strong className="mono bad" data-testid="deemed-open-itc">
              {rupees(summary.openItc)}
            </strong>
            .
          </p>
        )}
        <p className="banner-meta">
          As of {formatDate(summary.asOf)} · {WINDOW_LABEL[summary.window] ?? '—'} ·
          supplier cut-off was {formatDate(summary.cutOff)} ·{' '}
          <span data-testid="deemed-confirmed-count">{tally.stand}</span>
          {tally.dropped ? (
            <span data-testid="deemed-reset-count">
              {' — '}
              {tally.dropped}
            </span>
          ) : null}
        </p>
      </div>

      {openCount > 0 && tone !== 'closed' && onGoToActions ? (
        <button type="button" className="btn btn-primary" onClick={onGoToActions}>
          Review {openCount}
        </button>
      ) : null}
    </div>
  );
}

// A decision the trader already made has been invalidated because the supplier
// amended the record it was about. That is not a row-level detail — it is the
// app telling someone their answer no longer counts.
export function ConfirmationResetBanner({ results, onGoToActions }) {
  const affected = (results ?? []).filter((result) =>
    (result.flags ?? []).includes('CONFIRMATION_RESET')
  );
  if (!affected.length) return null;

  const itc = affected.reduce((sum, result) => sum + (result.signedItc ?? 0), 0);

  return (
    <div className="banner banner-reset" data-testid="confirmation-reset-banner" role="alert">
      <div className="banner-clock">
        <div className="banner-days">{affected.length} reset</div>
        <div className="banner-sub">decisions dropped</div>
      </div>
      <div className="banner-message">
        <p>
          <strong>
            {affected.length} {affected.length === 1 ? 'decision you made was' : 'decisions you made were'}{' '}
            dropped.
          </strong>{' '}
          The supplier changed what they reported after you confirmed, so the decision is
          no longer about the same record — IMS resets the action in exactly this case.
          These need deciding again, and{' '}
          <strong className="mono">{rupees(itc)}</strong> rides on them.
        </p>
        <p className="banner-meta">
          {affected
            .slice(0, 4)
            .map((result) => result.books?.invoiceNo ?? result.portal?.invoiceNo ?? `#${result.id}`)
            .join(' · ')}
          {affected.length > 4 ? ` · and ${affected.length - 4} more` : ''}
        </p>
      </div>
      {onGoToActions ? (
        <button type="button" className="btn btn-primary" onClick={onGoToActions}>
          Decide again
        </button>
      ) : null}
    </div>
  );
}
