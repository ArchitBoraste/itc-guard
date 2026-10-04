import { useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { Chip } from '../components/Chip.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { ErrorBox, InlineError, Loading } from '../components/States.jsx';
import { RISK_CHIP, schemeLabel } from '../lib/issues.js';
import { rupees } from '../lib/money.js';
import { matchesSearch, supplierRows } from '../lib/suppliers.js';

function ContactForm({ supplier, onSaved, onCancel }) {
  const id = useId();
  const [draft, setDraft] = useState({
    contactPerson: supplier.contact?.person ?? '',
    phone: supplier.contact?.phone ?? '',
    email: supplier.contact?.email ?? ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setContact(supplier.gstin, draft);
      await onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const field = (name, label, type = 'text', autoComplete = 'off') => (
    <label htmlFor={`${id}-${name}`}>
      {label}
      <input
        id={`${id}-${name}`}
        className="input"
        type={type}
        autoComplete={autoComplete}
        value={draft[name]}
        onChange={(event) => setDraft((value) => ({ ...value, [name]: event.target.value }))}
      />
    </label>
  );

  return (
    <form className="detail-panel" onSubmit={save} aria-label={`Contact for ${supplier.tradeName}`} data-testid="contact-form">
      <div className="strong-line">Contact for {supplier.tradeName}</div>
      <div className="inline-form">
        {field('contactPerson', 'Name')}
        {field('phone', 'Phone', 'tel')}
        {field('email', 'Email', 'email')}
      </div>
      <InlineError error={error} />
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save contact'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const SCHEMES = [
  { value: 'MONTHLY', label: 'Monthly (GSTR-1 by the 11th)' },
  { value: 'QRMP', label: 'Quarterly (IFF by the 13th)' },
  { value: '', label: 'Work it out from their filings' }
];

function SchemeForm({ supplier, onSaved, onCancel }) {
  const id = useId();
  const [value, setValue] = useState(supplier.filingSchemeSource === 'USER' ? supplier.filingScheme : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setFilingScheme(supplier.gstin, value || null);
      await onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="detail-panel" onSubmit={save} aria-label={`Filing for ${supplier.tradeName}`} data-testid="scheme-form">
      <label htmlFor={`${id}-scheme`} className="strong-line">
        How {supplier.tradeName} files GSTR-1
      </label>
      <select id={`${id}-scheme`} className="select" value={value} onChange={(event) => setValue(event.target.value)}>
        {SCHEMES.map((scheme) => (
          <option key={scheme.value} value={scheme.value}>
            {scheme.label}
          </option>
        ))}
      </select>
      <div className="caption">Their cut-off moves with it, in every month.</div>
      <InlineError error={error} />
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RiskReasons({ supplier }) {
  const reasons = supplier.risk?.reasons ?? [];
  return (
    <div className="detail-panel" data-testid="risk-reasons">
      <div className="strong-line">Why {RISK_CHIP[supplier.risk?.band]?.label.toLowerCase() ?? 'no'} risk</div>
      {reasons.length ? (
        <ul className="reasons">
          {reasons.map((reason) => (
            <li key={reason}>{reason.charAt(0).toUpperCase() + reason.slice(1)}</li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No filing history yet.</p>
      )}
    </div>
  );
}

export function SuppliersScreen({ period, results, dataVersion, reloadPeriod, refresh }) {
  const [body, setBody] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [open, setOpen] = useState(null); // { gstin, panel: 'risk' | 'contact' | 'scheme' }
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listSuppliers(period)
      .then((next) => !cancelled && setBody(next))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [period, dataVersion, reload]);

  const header = (count) => (
    <PageHeader
      title="Suppliers"
      subtitle={count === null ? null : `${count} supplier${count === 1 ? '' : 's'} this period, riskiest first.`}
    >
      <label className="search-field">
        <span className="visually-hidden">Search suppliers</span>
        <input
          type="search"
          className="search"
          placeholder="Search name or GSTIN"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={onlyIssues} onChange={(event) => setOnlyIssues(event.target.checked)} />
        Only with issues
      </label>
    </PageHeader>
  );

  if (error) {
    return (
      <>
        {header(null)}
        <ErrorBox error={error} title="Cannot load suppliers" />
      </>
    );
  }
  if (!body) {
    return (
      <>
        {header(null)}
        <Loading rows={6} />
      </>
    );
  }

  const all = supplierRows(body.suppliers, results);
  const rows = all.filter((row) => matchesSearch(row, search) && (!onlyIssues || row.hasIssue));
  const isOpen = (row, panel) => open?.gstin === row.supplier.gstin && (!panel || open.panel === panel);
  const toggle = (row, panel) => setOpen(isOpen(row, panel) ? null : { gstin: row.supplier.gstin, panel });

  // A new contact changes the messages on every screen; a new scheme moves the
  // cut-off in every month, which the API has already re-run.
  const contactSaved = async () => {
    setOpen(null);
    setReload((value) => value + 1);
    await reloadPeriod();
  };
  const schemeSaved = async () => {
    setOpen(null);
    await refresh();
  };

  return (
    <>
      {header(all.length)}
      <section className="card card-table" aria-label="Suppliers">
        {rows.length ? (
          <DataTable
            label="Suppliers"
            testId="suppliers-table"
            minWidth={1040}
            rows={rows}
            rowKey={(row) => row.supplier.gstin}
            isExpanded={(row) => isOpen(row)}
            renderDetail={(row) =>
              open.panel === 'contact' ? (
                <ContactForm supplier={row.supplier} onSaved={contactSaved} onCancel={() => setOpen(null)} />
              ) : open.panel === 'scheme' ? (
                <SchemeForm supplier={row.supplier} onSaved={schemeSaved} onCancel={() => setOpen(null)} />
              ) : (
                <RiskReasons supplier={row.supplier} />
              )
            }
            columns={[
              {
                key: 'supplier',
                header: 'Supplier',
                render: ({ supplier }) => (
                  <>
                    <div className="cell-main">{supplier.tradeName}</div>
                    <div className="cell-gstin">{supplier.gstin}</div>
                  </>
                )
              },
              {
                key: 'contact',
                header: 'Contact',
                render: (row) => {
                  const { contact } = row.supplier;
                  if (!contact) {
                    return (
                      <>
                        <div className="small muted">{row.inRegister ? 'No contact on file' : 'Not in your purchase register'}</div>
                        <button type="button" className="btn-link link-start" onClick={() => toggle(row, 'contact')} aria-expanded={isOpen(row, 'contact')}>
                          Add contact
                        </button>
                      </>
                    );
                  }
                  return (
                    <div className="contact-cell">
                      <div>
                        <div>{[contact.person, contact.phone].filter(Boolean).join(' · ')}</div>
                        {contact.email ? <div className="cell-sub">{contact.email}</div> : null}
                      </div>
                      <button
                        type="button"
                        className="icon-button is-quiet"
                        aria-label={`Edit contact for ${row.supplier.tradeName}`}
                        aria-expanded={isOpen(row, 'contact')}
                        onClick={() => toggle(row, 'contact')}
                      >
                        <Icon name="pencil" size={14} />
                      </button>
                    </div>
                  );
                }
              },
              {
                key: 'filing',
                header: 'Filing',
                render: (row) => (
                  <div className="contact-cell">
                    <div>
                      <div className="nowrap">{schemeLabel(row.supplier)}</div>
                      {row.filing ? (
                        <div className={`cell-sub${row.filing.tone ? ` ${row.filing.tone}-text` : ''}`}>{row.filing.text}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="icon-button is-quiet"
                      aria-label={`Change filing frequency for ${row.supplier.tradeName}`}
                      aria-expanded={isOpen(row, 'scheme')}
                      onClick={() => toggle(row, 'scheme')}
                    >
                      <Icon name="pencil" size={14} />
                    </button>
                  </div>
                )
              },
              {
                key: 'issue',
                header: 'This period',
                render: (row) => <span className={row.hasIssue ? undefined : 'muted'}>{row.issue}</span>
              },
              { key: 'tax', header: 'Tax', align: 'right', render: (row) => <span className="num">{rupees(row.itc)}</span> },
              {
                key: 'risk',
                header: 'Risk',
                nowrap: true,
                render: (row) => {
                  const chip = RISK_CHIP[row.supplier.risk?.band];
                  return chip ? <Chip tone={chip.tone}>{chip.label}</Chip> : <span className="muted">—</span>;
                }
              },
              {
                key: 'toggle',
                header: 'Details',
                hideHeader: true,
                render: (row) => (
                  <button
                    type="button"
                    className="icon-button"
                    aria-expanded={isOpen(row, 'risk')}
                    aria-label={`${isOpen(row, 'risk') ? 'Hide' : 'Show'} why ${row.supplier.tradeName} is this risk`}
                    onClick={() => toggle(row, 'risk')}
                  >
                    <Icon name={isOpen(row, 'risk') ? 'chevronUp' : 'chevronDown'} size={14} strokeWidth={2} />
                  </button>
                )
              }
            ]}
          />
        ) : (
          <EmptyState title={all.length ? 'No supplier matches' : 'No suppliers yet'} testId="no-suppliers">
            {all.length ? 'Try another name, or show every supplier.' : 'Suppliers appear once you upload your purchase register.'}
          </EmptyState>
        )}
      </section>
    </>
  );
}
