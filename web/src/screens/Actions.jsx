import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { rupees } from '../lib/money.js';
import {
  ACTION_HELP,
  ACTION_LABEL,
  ACTION_ORDER,
  BUCKETS,
  BUCKET_LABEL,
  NEEDS_ATTENTION,
  RECOMMENDED_TO_IMS,
  actionability,
  isOverride
} from '../lib/vocab.js';
import { Empty, ErrorBox } from '../components/States.jsx';
import { GroupConfirm, ResultRow } from '../components/ResultRow.jsx';
import { ImsDownload } from '../components/ImsDownload.jsx';

const PAGE_STEP = 25;

// Grouping is by RECOMMENDED action, so the list keeps its shape while the trader
// works through it. Grouping by the confirmed action instead would make rows jump
// between sections the moment they were decided, and it would hide the one thing
// worth seeing at the end: which recommendations were overridden.
function groupResults(results) {
  const groups = {};
  for (const action of ACTION_ORDER) {
    groups[action] = { action, results: [], itc: 0, open: 0 };
  }
  for (const result of results ?? []) {
    const group = groups[result.recommendedAction] ?? groups.NO_ACTION;
    group.results.push(result);
    group.itc += result.signedItc ?? 0;
    if (!result.confirmedAction && actionability(result).kind !== 'NOT_IN_IMS') group.open += 1;
  }
  return groups;
}

// The scope is a predicate over ROWS, not over groups.
//
// Selecting whole groups that merely CONTAINED a match was the bug: overriding one
// row in Reject put all 8 Reject rows on screen under a header that said 8, while
// the toggle correctly said 1. A group is now nothing more than the rows that
// survived — if none survive, the group is not rendered at all.
const SCOPES = {
  ALL: () => true,

  // Still waiting on a human. A row whose recommendation is a workflow state the
  // trader has to resolve, that they have not resolved, and that IMS can actually
  // be told something about.
  ATTENTION: (result) =>
    NEEDS_ATTENTION.has(result.recommendedAction) &&
    !result.confirmedAction &&
    actionability(result).kind !== 'NOT_IN_IMS',

  // The trader chose something other than what the engine proposed.
  OVERRIDDEN: (result) => isOverride(result)
};

function matchesQuery(result, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const sides = [result.books, result.portal].filter(Boolean);
  return sides.some((side) =>
    [side.supplierName, side.supplierGstin, side.invoiceNo]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}

export function ActionsScreen({ run, results, onConfirmed, onRefresh }) {
  const [scope, setScope] = useState('ATTENTION');
  const [bucketFilter, setBucketFilter] = useState('');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState({});
  const [busyGroup, setBusyGroup] = useState(null);
  const [error, setError] = useState(null);

  const confirmOne = useCallback(
    async (result, action) => {
      await api.confirmResult(result.id, action);
      onConfirmed(result.id, action);
      onRefresh();
    },
    [onConfirmed, onRefresh]
  );

  // Bucket + search first. Every scope count is measured against THIS set, so a
  // toggle label never promises rows that the active search has already excluded.
  const searched = useMemo(
    () =>
      (results ?? []).filter(
        (result) =>
          (!bucketFilter || result.bucket === bucketFilter) && matchesQuery(result, query)
      ),
    [results, bucketFilter, query]
  );

  const visibleResults = useMemo(
    () => searched.filter(SCOPES[scope] ?? SCOPES.ALL),
    [searched, scope]
  );

  const scopeCounts = useMemo(
    () => ({
      ATTENTION: searched.filter(SCOPES.ATTENTION).length,
      ALL: searched.length,
      OVERRIDDEN: searched.filter(SCOPES.OVERRIDDEN).length
    }),
    [searched]
  );

  // Grouped from the surviving rows only, so every header count and rupee total
  // describes exactly what is rendered beneath it.
  const groups = useMemo(() => groupResults(visibleResults), [visibleResults]);
  // The strip above the list is the period-wide picture and stays unfiltered.
  const allGroups = useMemo(() => groupResults(results), [results]);

  const confirmGroup = useCallback(
    async (action) => {
      setBusyGroup(action);
      setError(null);
      try {
        // Only rows that are still open AND actually actionable. Re-confirming a
        // decided row would silently overwrite an override the trader made.
        const targets = groups[action].results.filter(
          (result) => !result.confirmedAction && actionability(result).kind !== 'NOT_IN_IMS'
        );
        for (const result of targets) {
          const imsAction = RECOMMENDED_TO_IMS[result.recommendedAction] ?? 'NO_ACTION';
          const gate = actionability(result);
          if (!gate.allowed.includes(imsAction)) continue;
          await api.confirmResult(result.id, imsAction);
          onConfirmed(result.id, imsAction);
        }
        await onRefresh();
      } catch (err) {
        setError(err);
      } finally {
        setBusyGroup(null);
      }
    },
    [groups, onConfirmed, onRefresh]
  );

  if (!run) {
    return (
      <Empty title="No run for this period" testId="empty-run">
        Load a purchase register and a portal file, then run the reconciliation.
      </Empty>
    );
  }

  if (!results?.length) {
    return (
      <Empty title="This run produced no results" testId="empty-results">
        Nothing was matched or flagged. Check that both sides were committed for{' '}
        {run.taxPeriod}.
      </Empty>
    );
  }

  const shown = ACTION_ORDER.filter((action) => groups[action].results.length > 0);

  // Why the list is empty depends on which filter emptied it. Telling someone
  // "every confirmed row matches the recommendation" when in fact their bucket
  // filter excluded the overrides is a wrong answer to the question they asked.
  const narrowed = Boolean(query.trim() || bucketFilter);
  const emptyState = narrowed && scopeCounts[scope] === 0 && scopeCounts.ALL !== results.length
    ? {
        title: 'Nothing matches both filters',
        body:
          'No row satisfies the search or verdict filter AND this tab at the same time. ' +
          'Widen one of them.'
      }
    : scope === 'ATTENTION'
      ? {
          title: 'Nothing is waiting on you',
          body: 'Every record that needs a human decision has one. Download the IMS file below.'
        }
      : scope === 'OVERRIDDEN'
        ? {
            title: 'You have not overridden anything',
            body: 'Every confirmed row matches what the engine recommended.'
          }
        : {
            title: 'No rows match this filter',
            body: 'Try a different supplier, invoice number or verdict.'
          };

  return (
    <div className="screen screen-actions">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>What to do</h2>
            <p className="muted">
              Grouped by what the engine recommends. Every row can be overridden — the
              engine proposes, you decide, and the IMS file carries your decision wherever
              you made one.
            </p>
          </div>
          <div className="scope-toggle" role="group" aria-label="Which rows to show">
            {[
              ['ATTENTION', `Needs a decision (${scopeCounts.ATTENTION})`],
              ['ALL', `All (${scopeCounts.ALL})`],
              ['OVERRIDDEN', `Overridden (${scopeCounts.OVERRIDDEN})`]
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`toggle ${scope === value ? 'is-active' : ''}`}
                data-testid={`scope-${value}`}
                onClick={() => setScope(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="group-strip" data-testid="group-strip">
          {ACTION_ORDER.map((action) => {
            const group = allGroups[action];
            if (!group.results.length) return null;
            return (
              <div
                key={action}
                className={`strip-item action-${action} ${group.open ? 'has-open' : ''}`}
                data-testid={`strip-${action}`}
                title={ACTION_HELP[action]}
              >
                <span className="strip-name">{ACTION_LABEL[action]}</span>
                <span className="strip-count mono">{group.results.length}</span>
                <span className={`strip-itc mono ${group.itc < 0 ? 'bad' : ''}`}>
                  {rupees(group.itc)}
                </span>
                {group.open ? <span className="strip-open">{group.open} open</span> : null}
              </div>
            );
          })}
        </div>

        <div className="filters">
          <input
            type="search"
            className="search"
            placeholder="Filter by supplier, GSTIN or invoice number"
            value={query}
            data-testid="actions-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            value={bucketFilter}
            data-testid="bucket-filter"
            onChange={(event) => setBucketFilter(event.target.value)}
          >
            <option value="">Every verdict</option>
            {BUCKETS.map((bucket) => (
              <option key={bucket} value={bucket}>
                {BUCKET_LABEL[bucket]} ({run.bucketCounts?.[bucket] ?? 0})
              </option>
            ))}
          </select>
          {(query || bucketFilter) && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setQuery('');
                setBucketFilter('');
              }}
            >
              clear
            </button>
          )}
          <span className="muted small" data-testid="shown-count">
            {visibleResults.length} of {results.length} shown
          </span>
        </div>

        <ErrorBox error={error} title="A decision could not be saved" />
      </section>

      {shown.length === 0 ? (
        <Empty
          title={emptyState.title}
          testId="empty-groups"
          action={
            <div className="empty-actions">
              {narrowed ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="clear-filters"
                  onClick={() => {
                    setQuery('');
                    setBucketFilter('');
                  }}
                >
                  Clear the filter
                </button>
              ) : null}
              {scope !== 'ALL' ? (
                <button type="button" className="btn" onClick={() => setScope('ALL')}>
                  Show all {scopeCounts.ALL}
                </button>
              ) : null}
            </div>
          }
        >
          {emptyState.body}
        </Empty>
      ) : (
        shown.map((action) => {
          const group = groups[action];
          const limit = visible[action] ?? PAGE_STEP;
          const rows = group.results.slice(0, limit);
          return (
            <section
              className={`panel group group-${action}`}
              key={action}
              data-testid={`group-${action}`}
            >
              <header className="panel-head group-head">
                <div>
                  <h2>
                    <span className={`chip chip-action action-${action}`}>
                      {ACTION_LABEL[action]}
                    </span>
                    <span className="group-count">
                      {group.results.length} record{group.results.length === 1 ? '' : 's'}
                    </span>
                    <span className={`group-itc mono ${group.itc < 0 ? 'bad' : ''}`}>
                      {rupees(group.itc)}
                    </span>
                  </h2>
                  <p className="muted">{ACTION_HELP[action]}</p>
                </div>
                <GroupConfirm
                  action={action}
                  count={group.open}
                  busy={busyGroup === action}
                  onConfirmAll={() => confirmGroup(action)}
                />
              </header>

              <div className="rows">
                {rows.map((result) => (
                  <ResultRow
                    key={result.id}
                    result={result}
                    busy={busyGroup === action}
                    onConfirm={confirmOne}
                  />
                ))}
              </div>

              {group.results.length > rows.length ? (
                <button
                  type="button"
                  className="btn btn-wide"
                  data-testid={`more-${action}`}
                  onClick={() =>
                    setVisible((current) => ({ ...current, [action]: limit + PAGE_STEP }))
                  }
                >
                  Show {Math.min(PAGE_STEP, group.results.length - rows.length)} more of{' '}
                  {group.results.length - rows.length}
                </button>
              ) : null}
            </section>
          );
        })
      )}

      <ImsDownload run={run} />
    </div>
  );
}
