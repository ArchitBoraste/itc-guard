// Loading and error states, shared by every screen.

export function Loading({ label = 'Loading', rows = 3 }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${90 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, title = 'Something went wrong', onRetry = null }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert" data-testid="error-box">
      <strong>{title}</strong>
      <span>{error.message ?? String(error)}</span>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function InlineError({ error }) {
  if (!error) return null;
  return (
    <p className="inline-error" role="alert">
      {error.message ?? String(error)}
    </p>
  );
}
