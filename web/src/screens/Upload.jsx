import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.js';
import { Chip } from '../components/Chip.jsx';
import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { InlineError, Loading } from '../components/States.jsx';
import { uploadView } from '../lib/uploads.js';
import {
  deadlineOf,
  formatDate,
  formatPeriod,
  formatPeriodShort,
  formatUploadTime,
  monthOf,
  twoBGenerationDate
} from '../lib/calendar.js';

const KINDS = {
  PURCHASE_REGISTER: {
    title: 'Purchase register',
    source: 'From your accounts · Excel or Tally CSV',
    accept: '.xlsx,.xls,.csv',
    replace: 'Replace file'
  },
  IMS: {
    title: 'IMS',
    source: 'From the GST portal · JSON',
    accept: '.json',
    replace: 'Upload newer download'
  },
  GSTR2B: {
    title: 'GSTR-2B',
    source: 'From the GST portal · JSON',
    accept: '.json',
    replace: 'Replace file'
  }
};

const FIELD_LABEL = {
  supplierGstin: 'Supplier GSTIN',
  supplierName: 'Supplier name',
  supplyType: 'Type of supply',
  docType: 'Document type',
  invoiceNo: 'Document number',
  invoiceDate: 'Document date',
  invoiceValue: 'Document value',
  placeOfSupply: 'Place of supply',
  reverseCharge: 'Reverse charge',
  rate: 'Tax rate',
  taxableValue: 'Taxable value',
  igst: 'Integrated tax',
  cgst: 'Central tax',
  sgst: 'State/UT tax',
  cess: 'Cess',
  itcEligibility: 'ITC eligibility',
  originalInvoiceNo: 'Original document number',
  originalInvoiceDate: 'Original document date',
  contactPerson: 'Contact person',
  contactPhone: 'Phone',
  contactEmail: 'Email',
  filingFrequency: 'Supplier filing frequency'
};

const SUPPLIER_FIELDS = ['contactPerson', 'contactPhone', 'contactEmail', 'filingFrequency'];

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const isUnset = (value) => value === '' || value === undefined || value === null;

// --- one file card -------------------------------------------------------------

function FileCard({ kind, period, loaded, upload, state, locked, onFile, onDismiss, onAllInvoices }) {
  const meta = KINDS[kind];
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const busy = state?.status === 'uploading';

  const take = (files) => {
    const file = files?.[0];
    if (file && !locked && !busy) onFile(kind, file);
  };

  return (
    <section
      className={`card file-card${locked ? ' is-locked' : ''}${dragging ? ' is-dragging' : ''}`}
      aria-labelledby={`card-${kind}`}
      data-testid={`card-${kind}`}
      onDragOver={(event) => {
        if (locked) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        take(event.dataTransfer.files);
      }}
    >
      <div className="file-card-head">
        <div>
          <h2 className="file-card-title" id={`card-${kind}`}>
            {meta.title}
          </h2>
          <div className="small muted">{meta.source}</div>
        </div>
        {locked ? (
          <Chip tone="muted" pill icon="lock" testId={`lock-${kind}`}>
            Opens {formatDate(locked.opensOn)}
          </Chip>
        ) : loaded ? (
          <Chip tone="ok" pill icon="check">
            Read
          </Chip>
        ) : null}
      </div>

      {locked ? (
        <div className="file-card-body">
          <div className="figure-value secondary">{plural(locked.daysLeft, 'day')}</div>
          <div className="small muted">
            The portal generates {monthOf(period)}&apos;s GSTR-2B on {formatDate(locked.opensOn)}. Until then we
            check your books against IMS.
          </div>
        </div>
      ) : loaded ? (
        <>
          {upload ? (
            <div className="file-chip">
              <Icon name="file" size={16} />
              <span className="mono" title={upload.original_filename}>
                {upload.original_filename}
              </span>
            </div>
          ) : null}
          <div className="file-figures">
            {loaded.figures.map(([value, label]) => (
              <div key={label}>
                <div className="figure-value">{value}</div>
                <div className="figure-label">{label}</div>
              </div>
            ))}
          </div>
          {loaded.line ? <div className="small secondary">{loaded.line}</div> : null}
        </>
      ) : (
        <div className="file-card-body">
          <div className="small muted">Drop the file here, or choose it.</div>
        </div>
      )}

      {busy ? (
        <div className="small secondary" role="status">
          Reading {state.filename}…
        </div>
      ) : null}
      {state?.status === 'error' ? (
        <div className="card-error" role="alert" data-testid={`error-${kind}`}>
          <span>{state.error.message}</span>
          <div className="button-row">
            {state.error.code === 'document_type_unmapped' && state.uploadId ? (
              <button type="button" className="btn" onClick={() => onAllInvoices(kind, state)}>
                Every row is an invoice
              </button>
            ) : null}
            <button type="button" className="btn-link" onClick={() => onDismiss(kind)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {state?.status === 'done' && state.warnings?.length ? (
        <div className="card-note" role="status">
          {state.warnings[0]}
        </div>
      ) : null}

      <button
        type="button"
        className="btn"
        disabled={Boolean(locked) || busy}
        onClick={() => inputRef.current?.click()}
        data-testid={`choose-${kind}`}
      >
        {loaded ? meta.replace : 'Choose file'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={meta.accept}
        className="visually-hidden"
        tabIndex={-1}
        aria-label={`${meta.title} file`}
        data-testid={`file-${kind}`}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
    </section>
  );
}

// --- naming the columns of a register we do not recognise ---------------------------

function ColumnMapper({ mapper, onChange, onApply, onCancel, busy, error }) {
  const { columns, draft, guessed, allInvoices } = mapper;
  const required = columns.requiredFields;
  const optional = columns.mappableFields.filter(
    (name) => !required.includes(name) && !SUPPLIER_FIELDS.includes(name)
  );
  const supplier = columns.mappableFields.filter((name) => SUPPLIER_FIELDS.includes(name));
  const missing = required.some((name) => isUnset(draft[name]));

  const field = (name) => {
    const unset = isUnset(draft[name]);
    const isRequired = required.includes(name);
    return (
      <label key={name} className={`mapper-row${isRequired && unset ? ' is-missing' : ''}`}>
        <span>
          {FIELD_LABEL[name] ?? name}
          {isRequired ? (
            <span className="required-mark" aria-label="required">
              *
            </span>
          ) : null}
          {guessed[name] ? <span className="caption"> · guessed from “{guessed[name].header}”</span> : null}
        </span>
        <select
          className="select"
          value={unset ? '' : String(draft[name])}
          onChange={(event) => onChange(name, event.target.value === '' ? '' : Number(event.target.value))}
          data-testid={`map-${name}`}
        >
          <option value="">Not in this file</option>
          {columns.headers.map((header) => (
            <option key={header.index} value={header.index}>
              {header.text || `Column ${header.index + 1}`}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <section className="card card-pad" aria-labelledby="mapper-title" data-testid="column-mapper">
      <div className="page-header">
        <div>
          <h2 className="card-title" id="mapper-title">
            Which column is which?
          </h2>
          <p className="page-subtitle small">
            {mapper.filename} is not a template we recognise. Pick its columns once.
          </p>
        </div>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="mapper-body">
        <div className="mapper-grid">{required.map(field)}</div>
        <h3 className="mapper-group-title">More about each document</h3>
        <div className="mapper-grid">{optional.map(field)}</div>
        <h3 className="mapper-group-title">Supplier contact and filing frequency (optional)</h3>
        <div className="mapper-grid">{supplier.map(field)}</div>
        {isUnset(draft.docType) ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={allInvoices}
              onChange={(event) => onChange('__allInvoices', event.target.checked)}
            />
            Every row in this file is an invoice (no credit or debit notes)
          </label>
        ) : null}
        <InlineError error={error} />
        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || missing}
            onClick={onApply}
            data-testid="apply-mapping"
          >
            {busy ? 'Reading…' : 'Read the file'}
          </button>
          <span className="caption">Required: {required.map((name) => FIELD_LABEL[name] ?? name).join(', ')}</span>
        </div>
      </div>
    </section>
  );
}

// --- the screen --------------------------------------------------------------------

export function UploadScreen({ period, inventory, calendar, run, perVisitor, dataVersion, refresh, navigate }) {
  const [uploads, setUploads] = useState(null);
  const [cards, setCards] = useState({});
  const [mapper, setMapper] = useState(null);
  const [mapperBusy, setMapperBusy] = useState(false);
  const [mapperError, setMapperError] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState(null);
  const [demoFiles, setDemoFiles] = useState(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [allPeriods, setAllPeriods] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listUploads()
      .then((list) => !cancelled && setUploads(list))
      .catch(() => !cancelled && setUploads([]));
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const setCard = useCallback((kind, value) => setCards((current) => ({ ...current, [kind]: value })), []);
  const dismiss = useCallback(
    (kind) =>
      setCards((current) => {
        const next = { ...current };
        delete next[kind];
        return next;
      }),
    []
  );

  // A commit has already rebuilt every period it touched; the app follows the
  // file to its period.
  const committed = useCallback(
    async (kind, result) => {
      setCard(kind, { status: 'done', warnings: result.warnings ?? [] });
      await refresh({ prefer: result.taxPeriod ?? null });
    },
    [refresh, setCard]
  );

  const handleFile = useCallback(
    async (kind, file) => {
      setCard(kind, { status: 'uploading', filename: file.name });
      let uploadId = null;
      try {
        const upload = await api.uploadFile(kind, file);
        uploadId = upload.id;
        if (kind === 'PURCHASE_REGISTER' && upload.detected_format === 'UNKNOWN') {
          const columns = await api.uploadColumns(upload.id);
          if (!columns.mappable) {
            throw new ApiError(
              'This spreadsheet is not the GSTN purchase register template. Save it as CSV and choose it again to pick its columns.',
              { code: 'unmappable_xlsx' }
            );
          }
          // Exact matches first, then the adapter's guesses, shown as guesses.
          const draft = {};
          const guessed = {};
          for (const name of columns.mappableFields) {
            if (name in columns.mapped) draft[name] = columns.mapped[name];
            else if (columns.suggested?.[name]) {
              draft[name] = columns.suggested[name].index;
              guessed[name] = columns.suggested[name];
            } else draft[name] = '';
          }
          setMapper({ uploadId: upload.id, filename: file.name, columns, draft, guessed, allInvoices: false });
          setMapperError(null);
          dismiss(kind);
          return;
        }
        const result = await api.commitUpload(upload.id);
        await committed(kind, { ...result, warnings: upload.warnings });
      } catch (err) {
        setCard(kind, { status: 'error', error: err, uploadId });
      }
    },
    [committed, dismiss, setCard]
  );

  const commitAllInvoices = useCallback(
    async (kind, state) => {
      setCard(kind, { status: 'uploading', filename: 'the file' });
      try {
        await committed(kind, await api.commitUpload(state.uploadId, { allInvoices: true }));
      } catch (err) {
        setCard(kind, { status: 'error', error: err, uploadId: state.uploadId });
      }
    },
    [committed, setCard]
  );

  const applyMapping = useCallback(async () => {
    setMapperBusy(true);
    setMapperError(null);
    try {
      const columnMap = Object.fromEntries(Object.entries(mapper.draft).filter(([, index]) => !isUnset(index)));
      const options = { columnMap, allInvoices: mapper.allInvoices };
      await api.previewUpload(mapper.uploadId, options);
      const result = await api.commitUpload(mapper.uploadId, options);
      setMapper(null);
      await committed('PURCHASE_REGISTER', result);
    } catch (err) {
      setMapperError(err);
    } finally {
      setMapperBusy(false);
    }
  }, [mapper, committed]);

  const reconcile = async () => {
    setReconciling(true);
    setReconcileError(null);
    try {
      await api.createRun(period);
      await refresh();
      navigate('overview');
    } catch (err) {
      setReconcileError(err);
    } finally {
      setReconciling(false);
    }
  };

  const remove = async () => {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.deleteUpload(removing.id);
      setRemoving(null);
      await refresh();
    } catch (err) {
      setRemoveError(err);
    } finally {
      setRemoveBusy(false);
    }
  };

  const clearAll = async () => {
    setClearBusy(true);
    setClearError(null);
    try {
      await api.clearWorkspace();
      setClearing(false);
      setCards({});
      setMapper(null);
      await refresh();
    } catch (err) {
      setClearError(err);
    } finally {
      setClearBusy(false);
    }
  };

  const toggleDemoFiles = async () => {
    setDemoOpen((open) => !open);
    if (demoFiles === null) setDemoFiles(await api.listDemoFiles().catch(() => []));
  };

  // --- what each card shows for the period in view --------------------------------

  const view = uploadView({ uploads, inventory, period, run });
  const generated = deadlineOf(calendar, 'GSTR2B_GENERATED');
  const locked =
    period && generated && generated.daysLeft > 0
      ? { opensOn: generated.date ?? twoBGenerationDate(period), daysLeft: generated.daysLeft }
      : null;
  const { step, against, stillNeeded } = view;
  // Results are ready only beside cards that show the files they came from.
  const results = Boolean(run) && view.ready;

  // --- upload history ---------------------------------------------------------------

  // The period in view, unless the trader asks for every period.
  const allUploads = (uploads ?? []).filter((upload) => upload.committed_at).sort((a, b) => b.id - a.id);
  const inPeriod = allUploads.filter((upload) => upload.tax_period === period);
  const otherPeriods = allUploads.length - inPeriod.length;
  const everyPeriod = allPeriods || !period;
  const history = everyPeriod ? allUploads : inPeriod;
  const byId = new Map(allUploads.map((upload) => [upload.id, upload]));
  const typeOf = (upload) => {
    if (upload.kind === 'IMS') return `IMS${upload.snapshot_date ? ` · as of ${formatDate(upload.snapshot_date)}` : ''}`;
    return upload.kind === 'GSTR2B' ? 'GSTR-2B' : 'Purchase register';
  };
  const replacedText = (upload) => {
    const by = byId.get(upload.replaced_by_upload_id);
    return by?.kind === 'IMS' && by.snapshot_date ? `Replaced by ${formatDate(by.snapshot_date)}` : 'Replaced by a newer file';
  };

  return (
    <>
      <PageHeader
        title="Upload files"
        subtitle={
          period
            ? `Add your purchase register and the latest IMS download for ${formatPeriod(period)}.`
            : 'Add your purchase register and the latest IMS download.'
        }
      >
        <ol className="steps" aria-label="Steps">
          {['Upload', 'Reconcile', 'Review'].map((label, index) => {
            const number = index + 1;
            const state = number === step ? ' is-current' : number < step ? ' is-done' : '';
            return (
              <li key={label} className={`step${state}`} aria-current={number === step ? 'step' : undefined}>
                <span className="step-number">
                  {number < step ? <Icon name="check" size={12} strokeWidth={2.4} /> : number}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
      </PageHeader>

      <div className="file-cards">
        {Object.keys(KINDS).map((kind) => (
          <FileCard
            key={kind}
            kind={kind}
            period={period}
            loaded={view.cards[kind]}
            upload={view.cards[kind]?.upload ?? null}
            state={cards[kind]}
            locked={kind === 'GSTR2B' ? locked : null}
            onFile={handleFile}
            onDismiss={dismiss}
            onAllInvoices={commitAllInvoices}
          />
        ))}
      </div>

      {mapper ? (
        <ColumnMapper
          mapper={mapper}
          busy={mapperBusy}
          error={mapperError}
          onChange={(name, value) =>
            setMapper((current) => {
              if (name === '__allInvoices') return { ...current, allInvoices: value };
              // Once the trader has picked a column it is theirs, not a guess.
              const guessed = { ...current.guessed };
              delete guessed[name];
              return { ...current, draft: { ...current.draft, [name]: value }, guessed };
            })
          }
          onApply={applyMapping}
          onCancel={() => setMapper(null)}
        />
      ) : null}

      <section className="card reconcile-bar" aria-label="Reconcile" data-testid="reconcile-bar">
        <div>
          <div className="strong-line">
            {results ? 'Results are ready' : view.ready ? 'Ready to reconcile' : 'Nothing to reconcile yet'}
          </div>
          <div className="small muted">
            {results
              ? `Purchase register against ${against}. A newer upload updates them straight away.`
              : view.ready
                ? `Purchase register against ${against}. Upload a newer IMS any time to see what changed.`
                : `Add ${stillNeeded} to reconcile.`}
          </div>
          <InlineError error={reconcileError} />
        </div>
        {results ? (
          <a
            className="btn btn-primary btn-large"
            href="#/overview"
            onClick={(event) => {
              event.preventDefault();
              navigate('overview');
            }}
            data-testid="see-results"
          >
            See results
            <Icon name="arrowRight" size={16} />
          </a>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-large"
            disabled={!view.ready || reconciling}
            onClick={reconcile}
            data-testid="reconcile"
          >
            {reconciling ? 'Reconciling…' : `Reconcile ${period ? formatPeriod(period) : ''}`.trim()}
            <Icon name="arrowRight" size={16} />
          </button>
        )}
      </section>

      <div className="split">
        <section className="card card-table history" aria-labelledby="history-title">
          <div className="card-head">
            <div>
              <h2 className="card-title is-small" id="history-title">
                Upload history
              </h2>
              {period ? (
                <div className="caption" data-testid="history-scope">
                  {everyPeriod ? 'All periods' : formatPeriod(period)}
                </div>
              ) : null}
            </div>
            {period && otherPeriods > 0 ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allPeriods}
                  onChange={(event) => setAllPeriods(event.target.checked)}
                  data-testid="history-all-periods"
                />
                Show all periods
              </label>
            ) : null}
          </div>
          {uploads === null ? (
            <Loading label="Reading upload history" rows={2} />
          ) : history.length ? (
            <DataTable
              label="Upload history"
              testId="upload-history"
              minWidth={620}
              rows={history}
              rowKey={(upload) => upload.id}
              rowClassName={(upload) => (upload.replaced_by_upload_id ? 'is-muted' : null)}
              columns={[
                { key: 'file', header: 'File', className: 'cell-mono', render: (upload) => upload.original_filename },
                { key: 'type', header: 'Type', nowrap: true, render: typeOf },
                // One period's list needs no Period column.
                ...(everyPeriod
                  ? [{ key: 'period', header: 'Period', nowrap: true, render: (upload) => formatPeriodShort(upload.tax_period) }]
                  : []),
                {
                  key: 'rows',
                  header: 'Rows',
                  align: 'right',
                  render: (upload) => <span className="num">{upload.row_count ?? '—'}</span>
                },
                {
                  key: 'when',
                  header: 'Uploaded',
                  nowrap: true,
                  render: (upload) =>
                    upload.replaced_by_upload_id ? (
                      replacedText(upload)
                    ) : (
                      <span className="muted">{formatUploadTime(upload.created_at)}</span>
                    )
                },
                {
                  key: 'remove',
                  header: 'Actions',
                  hideHeader: true,
                  align: 'right',
                  render: (upload) => (
                    <button
                      type="button"
                      className="btn-link is-danger"
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(upload);
                      }}
                      aria-label={`Remove ${upload.original_filename}`}
                    >
                      Remove
                    </button>
                  )
                }
              ]}
            />
          ) : allUploads.length ? (
            <EmptyState title={`No files for ${formatPeriod(period)}`} testId="empty-history">
              Files for other periods show under Show all periods.
            </EmptyState>
          ) : (
            <EmptyState title="No files yet" testId="empty-history">
              Files you upload appear here.
            </EmptyState>
          )}
        </section>

        <aside className="card side-card" aria-labelledby="formats-title">
          <h2 className="card-title is-small" id="formats-title">
            Accepted formats
          </h2>
          <ul className="formats">
            <li>GSTN purchase register template (.xlsx)</li>
            <li>Tally purchase register (.csv)</li>
            <li>IMS download from the portal (.json)</li>
            <li>GSTR-2B download from the portal (.json)</li>
          </ul>
          <div>
            <button type="button" className="btn-link link-start" aria-expanded={demoOpen} onClick={toggleDemoFiles}>
              Download demo files (August and September)
            </button>
            {demoOpen ? (
              demoFiles === null ? (
                <Loading rows={2} label="Listing demo files" />
              ) : demoFiles.length ? (
                <ul className="formats" data-testid="demo-files">
                  {demoFiles.map((file) => (
                    <li key={file.url}>
                      <a href={file.url} download={file.name} className="mono small">
                        {file.name}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">No demo files on this server.</p>
              )
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-danger align-start"
            onClick={() => {
              setClearError(null);
              setClearing(true);
            }}
            data-testid="clear-all"
          >
            Clear all data
          </button>
        </aside>
      </div>

      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${removing?.original_filename ?? 'this file'}?`}
        confirmLabel="Remove"
        danger
        busy={removeBusy}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      >
        <p>
          {removing?.replaced_by_upload_id
            ? 'A newer file already replaced it, so nothing on screen changes.'
            : `Its records leave ${formatPeriod(removing?.tax_period)}, and the period is reconciled again without them.`}
        </p>
        <InlineError error={removeError} />
      </ConfirmDialog>

      <ConfirmDialog
        open={clearing}
        title="Clear all data?"
        confirmLabel="Clear all data"
        danger
        busy={clearBusy}
        onConfirm={clearAll}
        onCancel={() => setClearing(false)}
      >
        <p>
          Every upload, run, decision and contact {perVisitor ? 'in this workspace' : 'for this trader'} is deleted, and
          the date follows today again.
        </p>
        <InlineError error={clearError} />
      </ConfirmDialog>
    </>
  );
}
