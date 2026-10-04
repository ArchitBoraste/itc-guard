// The page title, at most one sentence under it (README principle 1), and the
// page's own controls on the right.
export function PageHeader({ title, subtitle = null, children = null }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}
