import { Fragment } from 'react';

// A table inside its card. Wide tables scroll inside the card, never the page
// (audit P29), so a phone at 390px never scrolls sideways.
//
// columns: [{ key, header, align: 'right' | undefined, hideHeader, nowrap, render(row) }]
// renderDetail(row) draws a full-width row under any row isExpanded(row) says is open.
export function DataTable({
  columns,
  rows,
  rowKey,
  label,
  minWidth = null,
  rowClassName = null,
  rowProps = null,
  renderDetail = null,
  isExpanded = null,
  testId = null
}) {
  return (
    <div className="table-scroll">
      <table className="table" aria-label={label} style={minWidth ? { minWidth } : undefined} data-testid={testId}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === 'right' ? 'align-right' : undefined}>
                {column.hideHeader ? <span className="visually-hidden">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const open = Boolean(renderDetail && isExpanded?.(row));
            const extra = rowProps?.(row) ?? {};
            const className = [rowClassName?.(row), open ? 'has-detail' : null].filter(Boolean).join(' ');
            return (
              <Fragment key={key}>
                <tr className={className || undefined} {...extra}>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={[
                        column.align === 'right' ? 'align-right' : null,
                        column.nowrap ? 'nowrap' : null,
                        column.className ?? null
                      ].filter(Boolean).join(' ') || undefined}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {open ? (
                  <tr className="is-detail">
                    <td colSpan={columns.length}>{renderDetail(row)}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
