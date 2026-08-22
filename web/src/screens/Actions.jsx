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
  effectiveAction,
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
    groups[action] = { action, results: [], itc: 0, open: 0, overridden: 0 };
  }
  for (const result of results ?? []) {
    const group = groups[result.recommendedAction] ?? groups.NO_ACTION;
    group.results.push(result);
    group.itc += result.signedItc ?? 0;
    if (!result.confirmedAction && actionability(result).kind !== 'NOT_IN_IMS') group.open += 1;
    if (isOverride(result)) group.overridden += 1;
  }
  return groups;
}

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

  const filtered = useMemo(
    () =>
      (results ?? []).filter(
        (result) =>
          (!bucketFilter || result.bucket === bucketFilter) && matchesQuery(result, query)
      ),
    [results, bucketFilter, query]
  );

  const groups = useMemo(() => groupResults(filtered), [filtered]);
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

  const shown = ACTION_ORDER.filter((action) => {
    if (!groups[action].results.length) return false;
    if (scope === 'ATTENTION') return NEEDS_ATTENTION.has(action);
    if (scope === 'OVERRIDDEN') return groups[action].overridden > 0;
    return true;
  });

  // Only the groups the ATTENTION scope actually shows. Counting ACCEPT's open
  // rows here would put 386 on a toggle that reveals 31 — and those rows do not
  // need a decision anyway: leaving them alone produces the recommended outcome,
  // because no action in IMS IS acceptance.
  const openTotal = ACTION_ORDER.filter((action) => NEEDS_ATTENTION.has(action)).reduce(
    (sum, action) => sum + allGroups[action].open,
    0
  );
  const overriddenTotal = ACTION_ORDER.reduce(
    (sum, action) => sum + allGroups[action].overridden,
    0
  );

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
              ['ATTENTION', `Needs a decision (${openTotal})`],
              ['ALL', `All (${results.length})`],
              ['OVERRIDDEN', `Overridden (${overriddenTotal})`]
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
          <span className="muted small">
            {filtered.length} of {results.length} shown
          </span>
        </div>

        <ErrorBox error={error} title="A decision could not be saved" />
      </section>

      {shown.length === 0 ? (
        <Empty
          title={
            scope === 'ATTENTION'
              ? 'Nothing is waiting on you'
              : scope === 'OVERRIDDEN'
                ? 'You have not overridden anything'
                : 'No rows match this filter'
          }
          testId="empty-groups"
          action={
            scope !== 'ALL' ? (
              <button type="button" className="btn" onClick={() => setScope('ALL')}>
                Show all {results.length}
              </button>
            ) : null
          }
        >
          {scope === 'ATTENTION'
            ? 'Every record that needs a human decision has one. Download the IMS file below.'
            : scope === 'OVERRIDDEN'
              ? 'Every confirmed row matches what the engine recommended.'
              : 'Try a different supplier, invoice number or verdict.'}
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

// Exported for the summary strip and any future test that wants the same counts.
export { groupResults, effectiveAction };
