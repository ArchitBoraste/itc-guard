import { Popover } from './Popover.jsx';
import { rupees } from '../lib/money.js';
import { formatDate } from '../lib/calendar.js';

// The matcher's score is the reason a row is on the screen at all. Showing the
// number without the breakdown asks the trader to trust an opaque 0.80 before
// rejecting an invoice — so every component, its weight and its contribution are
// laid out, in the order the engine weights them.

const COMPONENT_LABEL = {
  invoiceNo: 'Invoice number',
  taxableValue: 'Taxable value',
  totalTax: 'Total tax',
  invoiceDate: 'Invoice date',
  gstin: 'Supplier GSTIN'
};

const MONEY_COMPONENTS = new Set(['taxableValue', 'totalTax']);

function renderValue(key, value) {
  if (value === null || value === undefined) return '—';
  if (MONEY_COMPONENTS.has(key)) return rupees(value);
  if (key === 'invoiceDate') return formatDate(value);
  return String(value);
}

export function ScoreBreakdown({ score, breakdown, matchedVia }) {
  if (score === null || score === undefined) {
    return <span className="muted small">unmatched</span>;
  }

  const entries = Object.entries(breakdown ?? {}).sort(
    (a, b) => (b[1].weight ?? 0) - (a[1].weight ?? 0)
  );

  return (
    <Popover
      testId="score-popover"
      className="score"
      label={<span className="score-chip">{score.toFixed(2)}</span>}
      title={`Match score ${score.toFixed(4)}`}
      triggerLabel={`Match score ${score.toFixed(2)} — show the breakdown`}
    >
      {entries.length === 0 ? (
        <p className="muted small">No breakdown was recorded for this pair.</p>
      ) : (
        <table className="breakdown">
          <thead>
            <tr>
              <th>Component</th>
              <th>Books</th>
              <th>Portal</th>
              <th className="num">Sim</th>
              <th className="num">Weight</th>
              <th className="num">Adds</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, part]) => (
              <tr key={key} className={part.comparable === false ? 'dim' : ''}>
                <td>
                  <span className="bd-name">{COMPONENT_LABEL[key] ?? key}</span>
                  <span className="bd-rule">{part.rule}</span>
                </td>
                <td className="mono small">{renderValue(key, part.expected)}</td>
                <td className="mono small">{renderValue(key, part.portal)}</td>
                <td className="num mono">
                  {part.similarity === null ? '—' : part.similarity.toFixed(2)}
                </td>
                <td className="num mono muted">{(part.weight ?? 0).toFixed(2)}</td>
                <td className="num mono strong">{(part.contribution ?? 0).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>Total</td>
              <td className="num mono strong">{score.toFixed(4)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      <p className="muted small">
        ≥ 0.92 auto-match · 0.70–0.92 needs your confirmation · below 0.70 no match.
        {matchedVia ? ` Paired via ${matchedVia.replace(/_/g, ' ').toLowerCase()}.` : ''}
      </p>
    </Popover>
  );
}
