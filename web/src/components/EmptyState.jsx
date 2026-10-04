// What a screen says when it has nothing to show, and the one thing to do next.
export function EmptyState({ title, children = null, action = null, testId = 'empty-state' }) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="empty-title">{title}</div>
      {children ? <div>{children}</div> : null}
      {action}
    </div>
  );
}
