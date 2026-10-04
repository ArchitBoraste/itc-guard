import { useEffect, useId, useRef, useState } from 'react';
import { deadlineChip, formatDate, formatPeriod } from '../lib/calendar.js';
import { Icon } from './Icon.jsx';
import { TopBarBell } from './SupplierBell.jsx';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A picker can fire a change per keystroke as it moves; only the settled value
// moves the clock, which re-runs every period.
const SETTLE_MS = 500;

// The native picker, opened from the date button. The input itself is never seen,
// so the browser's own mm/dd/yyyy never shows. Without showPicker (or where the
// browser refuses it) focusing and clicking the input is the fallback.
function openPicker(input) {
  if (!input) return;
  try {
    if (typeof input.showPicker === 'function') {
      input.showPicker();
      return;
    }
  } catch {
    // fall through
  }
  input.focus();
  input.click();
}

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
  rerunning = false,
  onOpenReply = null
}) {
  const [draft, setDraft] = useState(asOfDate ?? '');
  const timer = useRef(null);
  const picker = useRef(null);
  const labelId = useId();

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

      <div className="topbar-field">
        <span id={labelId}>As of</span>
        <span className="date-field">
          <button
            type="button"
            className="btn date-button"
            onClick={() => openPicker(picker.current)}
            disabled={clockBusy}
            aria-labelledby={`${labelId} ${labelId}-value`}
            aria-describedby={clockError ? 'clock-error' : undefined}
            aria-haspopup="dialog"
            data-testid="as-of-button"
          >
            <Icon name="calendar" size={15} />
            <span id={`${labelId}-value`}>{ISO_DATE.test(draft) ? formatDate(draft) : 'Today'}</span>
          </button>
          <input
            ref={picker}
            type="date"
            className="date-picker-input"
            value={draft}
            onChange={(event) => changeDate(event.target.value)}
            disabled={clockBusy}
            tabIndex={-1}
            aria-hidden="true"
            data-testid="as-of"
          />
        </span>
      </div>
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
        <TopBarBell onOpenReply={onOpenReply} />
      </div>
    </header>
  );
}
