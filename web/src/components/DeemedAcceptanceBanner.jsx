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
import { RECOMMENDED_TO_IMS, actionability } from '../lib/vocab.js';

// The core risk this product exists to prevent: NO ACTION IN IMS IS DEEMED
// ACCEPTANCE at GSTR-3B. Nothing on the portal warns about it, so it is the one
// thing that stays on screen on every route.
//
// Two numbers, deliberately not merged:
//   * everything unactioned — what deemed acceptance will actually claim.
//   * the part of it the engine does NOT recommend accepting — the real exposure.
// One number alone is either alarmist (most of it is fine) or complacent (the
// dangerous slice disappears inside a large, mostly-clean total).
export function deemedAcceptanceSummary(run, results) {
  if (!run) return null;
  const asOf = runClock(run);
  const dueDate = gstr3bDueDate(run.taxPeriod);

  let unactionedCount = 0;
  let unactionedItc = 0;
  let riskyCount = 0;
  let riskyItc = 0;
  let confirmedCount = 0;
  let resetCount = 0;

  for (const result of results ?? []) {
    if ((result.flags ?? []).includes('CONFIRMATION_RESET')) resetCount += 1;

    if (actionability(result).kind !== 'IMS') continue;
    if (result.confirmedAction) {
      confirmedCount += 1;
      continue;
    }
    // imsAction 'N' is the portal's own "nothing recorded". That is the state
    // deemed acceptance acts on.
    if (result.portal.imsAction && result.portal.imsAction !== 'N') continue;

    unactionedCount += 1;
    unactionedItc += result.signedItc ?? 0;

    if (RECOMMENDED_TO_IMS[result.recommendedAction] !== 'ACCEPT') {
      riskyCount += 1;
      riskyItc += result.signedItc ?? 0;
    }
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
    riskyCount,
    riskyItc,
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
  const { daysToDue, riskyCount, unactionedCount } = summary;

  // Tone tracks consequence, not volume: past the due date nothing can be undone,
  // and a week out with open decisions is materially different from a week out
  // with none.
  const tone =
    daysToDue !== null && daysToDue < 0
      ? 'closed'
      : riskyCount === 0
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
        ) : unactionedCount === 0 ? (
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
            of credit at GSTR-3B.
            {riskyCount > 0 ? (
              <>
                {' '}Of those,{' '}
                <strong className="bad" data-testid="deemed-risky-count">
                  {riskyCount}
                </strong>{' '}
                {riskyCount === 1 ? 'is' : 'are'} not recommended for Accept —{' '}
                <strong className="mono bad" data-testid="deemed-risky-itc">
                  {rupees(summary.riskyItc)}
                </strong>
                .
              </>
            ) : (
              ' All of them are recommended for Accept anyway.'
            )}
          </p>
        )}
        <p className="banner-meta">
          As of {formatDate(summary.asOf)} · {WINDOW_LABEL[summary.window] ?? '—'} ·
          supplier cut-off was {formatDate(summary.cutOff)} ·{' '}
          {summary.confirmedCount} decision{summary.confirmedCount === 1 ? '' : 's'} recorded
        </p>
      </div>

      {riskyCount > 0 && tone !== 'closed' && onGoToActions ? (
        <button type="button" className="btn btn-primary" onClick={onGoToActions}>
          Review {riskyCount}
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
