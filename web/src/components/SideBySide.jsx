import { rupees } from '../lib/money.js';
import { formatDate } from '../lib/calendar.js';
import { DOC_TYPE_LABEL, SECTION_LABEL } from '../lib/vocab.js';

// Books against portal, field by field, with every disagreement marked.
//
// This is the whole argument the row is making. A trader about to reject an
// invoice needs to see WHICH field differs, not a verdict — the same
// VALUE_MISMATCH bucket covers "the supplier typed 9 instead of 4" and "we booked
// the wrong invoice entirely", and only the field-level view tells them apart.

const ROWS = [
  { key: 'invoiceNo', label: 'Invoice no.', kind: 'text' },
  { key: 'invoiceDate', label: 'Date', kind: 'date' },
  { key: 'docType', label: 'Type', kind: 'docType' },
  { key: 'supplierGstin', label: 'GSTIN', kind: 'mono' },
  { key: 'taxableValue', label: 'Taxable', kind: 'money' },
  { key: 'totalTax', label: 'Total tax', kind: 'money' }
];

function render(kind, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'money') return rupees(value);
  if (kind === 'date') return formatDate(value);
  if (kind === 'docType') return DOC_TYPE_LABEL[value] ?? value;
  return String(value);
}

export function SideBySide({ books, portal, deltaTaxableValue, deltaTotalTax }) {
  const missingSide = !books ? 'books' : !portal ? 'portal' : null;

  return (
    <div className="sbs" data-testid="side-by-side">
      <div className="sbs-head">
        <span />
        <span className={missingSide === 'books' ? 'sbs-absent' : ''}>Your books</span>
        <span className={missingSide === 'portal' ? 'sbs-absent' : ''}>
          Portal
          {portal?.source ? <em className="sbs-src">{portal.source === 'IMS' ? 'IMS' : '2B'}</em> : null}
        </span>
        <span className="num">Difference</span>
      </div>

      {ROWS.map((row) => {
        const left = books?.[row.key] ?? null;
        const right = portal?.[row.key] ?? null;
        const differs = books && portal && left !== right;

        let delta = null;
        if (row.key === 'taxableValue' && deltaTaxableValue) delta = deltaTaxableValue;
        if (row.key === 'totalTax' && deltaTotalTax) delta = deltaTotalTax;

        return (
          <div className={`sbs-row ${differs ? 'is-differs' : ''}`} key={row.key}>
            <span className="sbs-label">{row.label}</span>
            <span className={`sbs-cell ${row.kind === 'money' ? 'mono num' : 'mono'} ${!books ? 'is-void' : ''}`}>
              {books ? render(row.kind, left) : <em>not in books</em>}
            </span>
            <span className={`sbs-cell ${row.kind === 'money' ? 'mono num' : 'mono'} ${!portal ? 'is-void' : ''}`}>
              {portal ? render(row.kind, right) : <em>not reported</em>}
            </span>
            <span className="sbs-delta num mono">
              {delta ? (
                <strong className={delta > 0 ? 'bad' : 'warn-text'}>
                  {rupees(delta, { signed: true })}
                </strong>
              ) : differs ? (
                <span className="dot-differs" title="these differ">≠</span>
              ) : (
                ''
              )}
            </span>
          </div>
        );
      })}

      {portal ? (
        <div className="sbs-foot">
          <span>{SECTION_LABEL[portal.section] ?? portal.section}</span>
          {portal.filingStatus ? (
            <span className={portal.filingStatus === 'SAVED' ? 'warn-text' : ''}>
              supplier has {portal.filingStatus === 'SAVED' ? 'saved, not filed' : 'filed'}
            </span>
          ) : null}
          {portal.supplierFiledOn ? <span>filed {formatDate(portal.supplierFiledOn)}</span> : null}
          <span>
            IMS action recorded: <strong>{portal.imsAction ?? 'N'}</strong>
          </span>
          {portal.itcIneligibleReason ? (
            <span className="bad">reason {portal.itcIneligibleReason}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
