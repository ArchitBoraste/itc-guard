import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './../api.js';
import { Empty, ErrorBox, InlineError, Loading } from '../components/States.jsx';
import { formatPeriod } from '../lib/calendar.js';

// Three sources, in the order the trader actually has them: their own books
// first, then what the portal says.
const ZONES = [
  {
    kind: 'PURCHASE_REGISTER',
    title: 'Purchase register',
    hint: 'GSTN template v2.4 .xlsx, or a GSTR-2 offline-tool CSV',
    accept: '.xlsx,.xls,.csv'
  },
  {
    kind: 'IMS',
    title: 'IMS',
    hint: 'JSON from the IMS offline utility — includes records suppliers have only saved',
    accept: '.json'
  },
  {
    kind: 'GSTR2B',
    title: 'GSTR-2B',
    hint: 'JSON from the portal — filed records only',
    accept: '.json'
  }
];

const FORMAT_LABEL = {
  PR_TEMPLATE_V24: 'GSTN purchase register template v2.4',
  GSTR2_CSV: 'GSTR-2 offline tool CSV',
  IMS_JSON: 'IMS offline utility JSON',
  GSTR2B_JSON: 'GSTR-2B JSON',
  UNKNOWN: 'not recognised'
};

const FIELD_LABEL = {
  supplierGstin: 'Supplier GSTIN',
  supplierName: 'Supplier name',
  supplyType: 'Type of inward supply',
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
  originalInvoiceDate: 'Original document date'
};

// --- one drop zone ---------------------------------------------------------

function DropZone({ zone, state, onFile, onRetry }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const take = (fileList) => {
    const file = fileList?.[0];
    if (file) onFile(zone.kind, file);
  };

  return (
    <div
      className={`dropzone ${dragging ? 'is-dragging' : ''} ${state?.status ? `is-${state.status}` : ''}`}
      data-testid={`dropzone-${zone.kind}`}
      onDragOver={(event) => {
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
      <div className="dz-head">
        <h3>{zone.title}</h3>
        {state?.status === 'committed' ? <span className="pill pill-ok">loaded</span> : null}
        {state?.status === 'mapping' ? <span className="pill pill-warn">needs mapping</span> : null}
        {state?.status === 'error' ? <span className="pill pill-bad">failed</span> : null}
      </div>

      {!state || state.status === 'error' ? (
        <>
          <p className="dz-hint">{zone.hint}</p>
          <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
            Choose a file
          </button>
          <p className="dz-drop">or drop it here</p>
        </>
      ) : null}

      {state?.status === 'uploading' ? <Loading label="Reading the file" rows={2} /> : null}

      {state?.status === 'previewed' || state?.status === 'committed' ? (
        <dl className="dz-facts">
          <div>
            <dt>File</dt>
            <dd className="mono ellipsis" title={state.filename}>{state.filename}</dd>
          </div>
          <div>
            <dt>Detected format</dt>
            <dd data-testid={`format-${zone.kind}`}>
              {FORMAT_LABEL[state.detectedFormat] ?? state.detectedFormat}
            </dd>
          </div>
          <div>
            <dt>Rows</dt>
            <dd className="mono strong" data-testid={`rowcount-${zone.kind}`}>
              {state.rowCount === null ? '—' : state.rowCount.toLocaleString('en-IN')}
            </dd>
          </div>
          <div>
            <dt>Tax period</dt>
            <dd>{state.taxPeriod ? formatPeriod(state.taxPeriod) : 'from the file'}</dd>
          </div>
        </dl>
      ) : null}

      {state?.status === 'error' ? <InlineError error={state.error} onDismiss={onRetry} /> : null}

      <input
        ref={inputRef}
        type="file"
        accept={zone.accept}
        className="visually-hidden"
        data-testid={`file-${zone.kind}`}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

// --- column mapping (only when detection failed) ---------------------------

function ColumnMapper({ columns, draft, onChange, onApply, onCancel, busy, error }) {
  const options = columns.headers;

  return (
    <section className="panel mapper" data-testid="column-mapper">
      <header className="panel-head">
        <div>
          <h2>Which column is which?</h2>
          <p className="muted">
            This file is not one of the two templates we recognise, so the columns have to
            be named. Header row {columns.headerRow} of the {columns.layout} was read; the
            four marked required are the ones nothing can be matched without.
          </p>
        </div>
        <button type="button" className="link" onClick={onCancel}>
          cancel
        </button>
      </header>

      <div className="mapper-grid">
        {columns.mappableFields.map((field) => {
          const required = columns.requiredFields.includes(field);
          const value = draft[field];
          return (
            <label
              key={field}
              className={`mapper-row ${required && (value === '' || value === undefined) ? 'is-missing' : ''}`}
            >
              <span className="mapper-field">
                {FIELD_LABEL[field] ?? field}
                {required ? <span className="req" title="required">*</span> : null}
              </span>
              <select
                data-testid={`map-${field}`}
                value={value === undefined || value === null ? '' : String(value)}
                onChange={(event) =>
                  onChange(field, event.target.value === '' ? '' : Number(event.target.value))
                }
              >
                <option value="">— not in this file —</option>
                {options.map((header) => (
                  <option key={header.index} value={header.index}>
                    {header.text || `(column ${header.index + 1})`}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      <InlineError error={error} />

      <div className="mapper-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="apply-mapping"
          disabled={busy || columns.requiredFields.some((field) => draft[field] === '' || draft[field] === undefined)}
          onClick={onApply}
        >
          {busy ? 'Checking…' : 'Apply mapping'}
        </button>
        <span className="muted small">
          Required: {columns.requiredFields.map((field) => FIELD_LABEL[field] ?? field).join(', ')}
        </span>
      </div>
    </section>
  );
}

// A GSTR-2 CSV carries no file-level tax period — only the v2.4 template has
// header rows naming one. The parsed rows still each derive theirs from the
// document date, so read it back from the preview rather than leaving the upload
// unlabelled and the Reconcile button permanently disabled.
function periodOf(committed, preview) {
  return committed?.taxPeriod ?? preview?.taxPeriod ?? preview?.rows?.[0]?.taxPeriod ?? null;
}

// --- screen ----------------------------------------------------------------

export function UploadScreen({ org, runs, onIngested }) {
  const [zones, setZones] = useState({});
  const [mapper, setMapper] = useState(null); // { kind, uploadId, columns, draft }
  const [mapperBusy, setMapperBusy] = useState(false);
  const [mapperError, setMapperError] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [existing, setExisting] = useState(null);
  const [samplePeriod, setSamplePeriod] = useState('');

  useEffect(() => {
    api.listUploads().then(setExisting).catch(() => setExisting([]));
  }, []);

  // Defaults once, when the org's fixture list arrives, and then leaves the
  // trader's own choice alone.
  useEffect(() => {
    setSamplePeriod(
      (current) => current || org?.defaultDemoPeriod || org?.demoPeriods?.[0] || ''
    );
  }, [org]);

  const setZone = useCallback((kind, patch) => {
    setZones((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  }, []);

  // Upload -> preview -> commit. The mapping step slots in between preview and
  // commit, and ONLY when detection came back UNKNOWN: a recognised template must
  // never make the trader answer questions the file already answers.
  const handleFile = useCallback(
    async (kind, file) => {
      setZone(kind, { status: 'uploading', filename: file.name, error: null });
      try {
        const upload = await api.uploadFile(kind, file);

        if (kind === 'PURCHASE_REGISTER' && upload.detected_format === 'UNKNOWN') {
          const columns = await api.uploadColumns(upload.id);
          // A spreadsheet that is not the GSTN template has no locatable header
          // row, so naming the columns cannot rescue it. Say that instead of
          // offering a mapping step that will fail on commit.
          if (!columns.mappable) {
            throw new ApiError(
              'This .xlsx is not the GSTN v2.4 template and its header row cannot be located. ' +
                'Export it as CSV and the columns can be mapped by hand.',
              { code: 'unmappable_xlsx' }
            );
          }
          const draft = {};
          for (const field of columns.mappableFields) {
            draft[field] = columns.mapped[field] ?? '';
          }
          setMapper({ kind, uploadId: upload.id, filename: file.name, columns, draft });
          setMapperError(null);
          setZone(kind, { status: 'mapping', uploadId: upload.id, filename: file.name });
          return;
        }

        const preview = await api.previewUpload(upload.id);
        setZone(kind, {
          status: 'previewed',
          uploadId: upload.id,
          filename: file.name,
          detectedFormat: preview.detectedFormat,
          rowCount: preview.totalRows,
          taxPeriod: preview.taxPeriod
        });

        const committed = await api.commitUpload(upload.id);
        setZone(kind, {
          status: 'committed',
          rowCount: committed.parsed,
          taxPeriod: periodOf(committed, preview)
        });
      } catch (err) {
        setZone(kind, { status: 'error', error: err });
      }
    },
    [setZone]
  );

  const applyMapping = useCallback(async () => {
    if (!mapper) return;
    setMapperBusy(true);
    setMapperError(null);
    try {
      const columnMap = {};
      for (const [field, index] of Object.entries(mapper.draft)) {
        if (index !== '' && index !== null && index !== undefined) columnMap[field] = index;
      }
      const preview = await api.previewUpload(mapper.uploadId, { columnMap });
      const committed = await api.commitUpload(mapper.uploadId, columnMap);
      setZone(mapper.kind, {
        status: 'committed',
        detectedFormat: preview.detectedFormat,
        rowCount: committed.parsed,
        taxPeriod: periodOf(committed, preview),
        filename: mapper.filename
      });
      setMapper(null);
    } catch (err) {
      setMapperError(err);
    } finally {
      setMapperBusy(false);
    }
  }, [mapper, setZone]);

  const committed = Object.entries(zones).filter(([, state]) => state.status === 'committed');
  const committedPeriod = committed.map(([, state]) => state.taxPeriod).find(Boolean) ?? null;
  const hasBooks = zones.PURCHASE_REGISTER?.status === 'committed';
  const hasPortal =
    zones.IMS?.status === 'committed' || zones.GSTR2B?.status === 'committed';

  const reconcile = useCallback(async () => {
    if (!committedPeriod) return;
    setRunning(true);
    setRunError(null);
    try {
      // Mid-window by default: after 2B generates on the 14th, before GSTR-3B on
      // the 20th. That is the window the recommendations are written for.
      const [year, month] = committedPeriod.split('-').map(Number);
      const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
      await api.createRun({ taxPeriod: committedPeriod, mode: 'REACTIVE', asOfDate: `${next}-16` });
      await onIngested(committedPeriod);
    } catch (err) {
      setRunError(err);
    } finally {
      setRunning(false);
    }
  }, [committedPeriod, onIngested]);

  const seed = useCallback(
    async (taxPeriod) => {
      setSeeding(true);
      setSeedError(null);
      try {
        const seeded = await api.seedDemo(taxPeriod);
        await onIngested(seeded.taxPeriod);
      } catch (err) {
        setSeedError(err);
      } finally {
        setSeeding(false);
      }
    },
    [onIngested]
  );

  const nothingLoaded = !runs?.length && !existing?.length && !committed.length;
  const demoPeriods = org?.demoPeriods ?? [];

  return (
    <div className="screen screen-upload">
      {nothingLoaded ? (
        <section className="panel first-run" data-testid="first-run">
          <h2>Nothing loaded yet</h2>
          <p>
            Drop a purchase register and at least one portal file below, or start from a
            worked sample period so you can see what the reconciliation produces before
            trusting it with your own books.
          </p>
          {demoPeriods.length ? (
            <div className="first-run-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="load-sample"
                disabled={seeding}
                onClick={() => seed(org?.defaultDemoPeriod ?? demoPeriods[0])}
              >
                {seeding ? 'Loading sample…' : 'Load sample data'}
              </button>
              <span className="muted small">
                Seeds {formatPeriod(org?.defaultDemoPeriod ?? demoPeriods[0])} through the same
                upload path your own files take.
              </span>
            </div>
          ) : (
            <p className="muted small">
              No sample data is available — the fixtures directory is not mounted into the
              API container.
            </p>
          )}
          <ErrorBox error={seedError} title="Could not load the sample" />
        </section>
      ) : null}

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Load a period</h2>
            <p className="muted">
              {org?.org
                ? `Filing as ${org.org.legalName} (${org.org.gstin}).`
                : 'Files are parsed and previewed before anything is written.'}
            </p>
          </div>
          {demoPeriods.length && !nothingLoaded ? (
            <div className="seed-inline">
              <label htmlFor="sample-period" className="visually-hidden">
                Sample tax period
              </label>
              <select
                id="sample-period"
                data-testid="sample-period"
                value={samplePeriod}
                onChange={(event) => setSamplePeriod(event.target.value)}
              >
                {demoPeriods.map((entry) => (
                  <option key={entry} value={entry}>
                    {formatPeriod(entry)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                data-testid="load-sample-inline"
                disabled={seeding}
                onClick={() => seed(samplePeriod)}
              >
                {seeding ? 'Loading…' : 'Load sample period'}
              </button>
            </div>
          ) : null}
        </header>

        <div className="zones">
          {ZONES.map((zone) => (
            <DropZone
              key={zone.kind}
              zone={zone}
              state={zones[zone.kind]}
              onFile={handleFile}
              onRetry={() => setZones((current) => ({ ...current, [zone.kind]: undefined }))}
            />
          ))}
        </div>

        {!nothingLoaded ? <ErrorBox error={seedError} title="Could not load the sample" /> : null}
      </section>

      {mapper ? (
        <ColumnMapper
          columns={mapper.columns}
          draft={mapper.draft}
          busy={mapperBusy}
          error={mapperError}
          onChange={(field, value) =>
            setMapper((current) => ({ ...current, draft: { ...current.draft, [field]: value } }))
          }
          onApply={applyMapping}
          onCancel={() => {
            setZones((current) => ({ ...current, [mapper.kind]: undefined }));
            setMapper(null);
          }}
        />
      ) : null}

      {committed.length ? (
        <section className="panel" data-testid="reconcile-panel">
          <header className="panel-head">
            <div>
              <h2>Reconcile</h2>
              <p className="muted">
                {committed.length} source{committed.length === 1 ? '' : 's'} committed
                {committedPeriod ? ` for ${formatPeriod(committedPeriod)}` : ''}.
                {hasBooks && hasPortal
                  ? ''
                  : ' A purchase register and at least one portal file are both needed.'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="run-reconcile"
              disabled={running || !committedPeriod || !hasBooks || !hasPortal}
              onClick={reconcile}
            >
              {running ? 'Reconciling…' : 'Run reconciliation'}
            </button>
          </header>
          <ErrorBox error={runError} title="The run failed" />
        </section>
      ) : null}

      <section className="panel">
        <h2>Previously uploaded</h2>
        {existing === null ? (
          <Loading label="Reading upload history" rows={2} />
        ) : existing.length === 0 ? (
          <Empty title="No uploads yet" testId="empty-uploads">
            Files you load show up here with their detected format and row count.
          </Empty>
        ) : (
          <div className="table-wrap">
          <table className="table dense" data-testid="upload-history">
            <thead>
              <tr>
                <th>Source</th>
                <th>File</th>
                <th>Detected format</th>
                <th className="num">Rows</th>
                <th>Period</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {existing.slice(0, 12).map((upload) => (
                <tr key={upload.id}>
                  <td>{upload.kind.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="mono ellipsis">{upload.original_filename}</td>
                  <td>{FORMAT_LABEL[upload.detected_format] ?? upload.detected_format}</td>
                  <td className="num mono">
                    {upload.row_count === null ? '—' : upload.row_count.toLocaleString('en-IN')}
                  </td>
                  <td>{upload.tax_period ? formatPeriod(upload.tax_period) : '—'}</td>
                  <td>
                    <span className={`pill ${upload.status === 'PARSED' ? 'pill-ok' : 'pill-idle'}`}>
                      {upload.status.toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
