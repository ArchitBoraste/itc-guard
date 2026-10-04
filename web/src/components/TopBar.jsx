import { useEffect, useRef, useState } from 'react';
import { deadlineChip, formatPeriod } from '../lib/calendar.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Typing a date fires a change per segment; only the settled value moves the clock.
const SETTLE_MS = 500;

// Tax period, the workspace's As of date, the next deadline, and a quiet notice
// when the period's results are out of date.
export function TopBar({
  periods = [],
  period = null,
  onPeriodChange,
  asOfDate = null,
  onAsOfChange,
  clockBusy = false,
  clockError = null,
  calendar = null,
  stale = false,
  onRerun,
  rerunning = false
}) {
  const [draft, setDraft] = useState(asOfDate ?? '');
  const timer = useRef(null);

  useEffect(() => setDraft(asOfDate ?? ''), [asOfDate]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const changeDate = (value) => {
    setDraft(value);
    clearTimeout(timer.current);
    if (value !== '' && !ISO_DATE.test(value)) return;
    timer.current = setTimeout(() => {
      if ((value || null) !== (asOfDate || null)) onAsOfChange(value || null);
    }, SETTLE_MS);
  };

  const chip = deadlineChip(calendar);

  return (
    <header className="topbar" data-testid="topbar">
      <label className="topbar-field">
        Tax period
        <select
          className="select"
          value={period ?? ''}
          disabled={!periods.length}
          onChange={(event) => onPeriodChange(event.target.value)}
          data-testid="period-select"
        >
          {periods.length ? (
            periods.map((entry) => (
              <option key={entry} value={entry}>
                {formatPeriod(entry)}
              </option>
            ))
          ) : (
            <option value="">No data yet</option>
          )}
        </select>
      </label>

      <label className="topbar-field">
        As of
        <input
          type="date"
          className="input input-date"
          value={draft}
          onChange={(event) => changeDate(event.target.value)}
          disabled={clockBusy}
          aria-describedby={clockError ? 'clock-error' : undefined}
          data-testid="as-of"
        />
      </label>
      {clockError ? (
        <span id="clock-error" className="inline-error" role="alert">
          {clockError.message}
        </span>
      ) : null}

      <div className="topbar-right">
        {stale ? (
          <span className="stale-notice" data-testid="stale-notice">
            Results are out of date
            <button type="button" className="btn" onClick={onRerun} disabled={rerunning}>
              {rerunning ? 'Re-running…' : 'Re-run'}
            </button>
          </span>
        ) : null}
        {chip ? (
          <span className={`deadline is-${chip.tone}`} data-testid="deadline">
            {chip.text}
          </span>
        ) : null}
      </div>
    </header>
  );
}
