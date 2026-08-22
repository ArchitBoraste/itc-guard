// Loading, empty and error states. Every screen uses these rather than inventing
// its own, so "nothing here" never looks like "something broke".

export function Loading({ label = 'Loading', rows = 3 }) {
  return (
    <div className="state state-loading" data-testid="loading" role="status" aria-live="polite">
      <div className="state-label">{label}…</div>
      <div className="skeletons">
        {Array.from({ length: rows }, (_, index) => (
          <div className="skeleton" key={index} />
        ))}
      </div>
    </div>
  );
}

export function Empty({ title, children, action = null, testId = 'empty' }) {
  return (
    <div className="state state-empty" data-testid={testId}>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry = null, title = 'Something went wrong' }) {
  if (!error) return null;
  return (
    <div className="state state-error" data-testid="error" role="alert">
      <h3>{title}</h3>
      <p className="mono">{error.message}</p>
      {error.code ? <p className="muted small">code: {error.code}{error.status ? ` · http ${error.status}` : ''}</p> : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

// Inline banner for a failure that must not blank the screen it happened on — a
// rejected PATCH, for instance, where the rest of the list is still valid.
export function InlineError({ error, onDismiss = null }) {
  if (!error) return null;
  return (
    <div className="inline-error" role="alert" data-testid="inline-error">
      <span>{error.message}</span>
      {onDismiss ? (
        <button type="button" className="link" onClick={onDismiss}>
          dismiss
        </button>
      ) : null}
    </div>
  );
}
