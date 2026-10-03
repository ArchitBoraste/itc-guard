// ClearAllData: one click back to an empty workspace, affecting this visitor's
// and nobody else's. Confirmation is a second click rather than a
// window.confirm(), which is easy to dismiss by reflex and impossible to style.
import { useEffect, useState } from 'react';

export function ClearAllData({ onClear, busy = false }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <div className="reset-confirm">
        <span className="muted small">Delete every upload and decision in this workspace?</span>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="clear-confirm"
          disabled={busy}
          onClick={() => {
            setArmed(false);
            onClear();
          }}
        >
          Yes, clear
        </button>
        <button type="button" className="link" onClick={() => setArmed(false)}>
          cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-danger-ghost"
      data-testid="clear-all-data"
      disabled={busy}
      title="Empties only your own workspace"
      onClick={() => setArmed(true)}
    >
      {busy ? 'Clearing…' : 'Clear all data'}
    </button>
  );
}
