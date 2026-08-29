// The two pieces of UI that per-visitor demo data needs.
//
// PreparingScreen — shown while this visitor's own copy of the demo is being
// built. Most people never see it: the API hands out orgs that were seeded in
// advance, so a first visit is instant. It appears when arrivals outrun the pool,
// and after a reset, which is the same wait for the same reason.
//
// ResetMyData — one click back to the state the demo starts in, affecting this
// visitor's org and nobody else's. Confirmation is a second click rather than a
// window.confirm(), which is easy to dismiss by reflex and impossible to style.
import { useEffect, useState } from 'react';

export function PreparingScreen({ error = null, onRetry = null }) {
  // Purely cosmetic: something that visibly moves, so a slow seed on a small box
  // does not read as a frozen page.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="state state-loading" data-testid="preparing" role="status" aria-live="polite">
      <h3>Preparing your demo data</h3>
      <p>
        Every visitor gets their own private copy, so nothing you do here changes what anyone
        else sees. Loading March and April 2026 and reconciling both — a few seconds.
      </p>
      <p className="muted small" data-testid="preparing-elapsed">
        {seconds}s elapsed
      </p>
      <div className="skeletons">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="skeleton" key={index} />
        ))}
      </div>
      {error ? (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          {onRetry ? (
            <button type="button" className="link" onClick={onRetry}>
              try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ResetMyData({ onReset, busy = false }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <div className="reset-confirm">
        <span className="muted small">Reload the sample data?</span>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="reset-confirm"
          disabled={busy}
          onClick={() => {
            setArmed(false);
            onReset();
          }}
        >
          Yes, reset
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
      data-testid="reset-my-data"
      disabled={busy}
      title="Wipes and reloads only your own copy of the demo data"
      onClick={() => setArmed(true)}
    >
      {busy ? 'Resetting…' : 'Reset my data'}
    </button>
  );
}
