// A number with its label above and one line of context below, left-aligned,
// tabular figures (README principle 2). tone colours the value only.
export function StatTile({ label, value, sub = null, tone = null, compact = false, testId, card = false }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div
        className={`stat-value${compact ? ' is-compact' : ''}${tone ? ` tone-${tone}` : ''}`}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </>
  );
  return (
    <div className={`stat${card ? ' card stat-card' : ''}`} data-testid={testId}>
      {body}
    </div>
  );
}
