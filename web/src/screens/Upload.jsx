import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './../api.js';
import { Empty, ErrorBox, InlineError, Loading } from '../components/States.jsx';
import { formatDate, formatPeriod, nextPeriod } from '../lib/calendar.js';

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

function ColumnMapper({ columns, draft, guessed, onChange, onApply, onCancel, busy, error }) {
  const options = columns.headers;
  const guessCount = Object.keys(guessed ?? {}).length;

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

      {guessCount ? (
        <p className="mapper-guess-note" data-testid="guess-note">
          <strong>{guessCount}</strong> {guessCount === 1 ? 'column was' : 'columns were'}{' '}
          filled in from your own column titles. Guesses are marked{' '}
          <span className="guess-chip">guessed</span> — check them before applying, and
          change any that are wrong. The mark clears when you pick something else.
        </p>
      ) : null}

      <div className="mapper-grid">
        {columns.mappableFields.map((field) => {
          const required = columns.requiredFields.includes(field);
          const value = draft[field];
          const guess = guessed?.[field];
          const unset = value === '' || value === undefined;
          return (
            <label
              key={field}
              className={`mapper-row ${required && unset ? 'is-missing' : ''} ${guess ? 'is-guessed' : ''}`}
              data-testid={`maprow-${field}`}
            >
              <span className="mapper-field">
                {FIELD_LABEL[field] ?? field}
                {required ? <span className="req" title="required">*</span> : null}
                {guess ? (
                  <span
                    className="guess-chip"
                    data-testid={`guessed-${field}`}
                    title={`Matched "${guess.header}" by name (${guess.confidence.toLowerCase()} confidence). Change it if that is wrong.`}
                  >
                    guessed
                  </span>
                ) : null}
              </span>
              <select
                data-testid={`map-${field}`}
                value={unset ? '' : String(value)}
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
// "414 register rows, 384 IMS and 420 GSTR-2B records" — the trader has to be
// able to see WHY the button is enabled when they only dropped one file.
function describeStored(entry) {
  const parts = [];
  if (entry.books) parts.push(`${entry.books.toLocaleString('en-IN')} register rows`);
  if (entry.ims) parts.push(`${entry.ims.toLocaleString('en-IN')} IMS records`);
  if (entry.gstr2b) parts.push(`${entry.gstr2b.toLocaleString('en-IN')} GSTR-2B records`);
  if (!parts.length) return 'nothing';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// The reconciliation window: the 16th of the month AFTER the tax period. Mirrors
// seedDemoPeriod() in api/src/services/demo.js and the default in reconcile()
// below, so what this screen promises is what the run is actually built at.
function asOfFor(taxPeriod) {
  const next = nextPeriod(taxPeriod);
  return next ? `${next}-16` : null;
}

function periodOf(committed, preview) {
  return committed?.taxPeriod ?? preview?.taxPeriod ?? preview?.rows?.[0]?.taxPeriod ?? null;
}

// --- screen ----------------------------------------------------------------

export function UploadScreen({ org, runs, activePeriod = null, onIngested, onDataChanged }) {
  const [zones, setZones] = useState({});
  const [mapper, setMapper] = useState(null); // { kind, uploadId, columns, draft }
  const [mapperBusy, setMapperBusy] = useState(false);
  const [mapperError, setMapperError] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [existing, setExisting] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [samplePeriod, setSamplePeriod] = useState('');

  // What the SERVER holds, per period. Re-read after every commit: the normal
  // case is a trader re-downloading IMS weekly into a period whose purchase
  // register was committed weeks ago, and asking this page what it happens to
  // have uploaded gets that case wrong every time.
  const refreshHistory = useCallback(async () => {
    const [uploads, known] = await Promise.all([
      api.listUploads().catch(() => []),
      api.listPeriods().catch(() => [])
    ]);
    setExisting(uploads);
    setPeriods(known);
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // Follows the period the app is actually showing, so the dropdown and the
  // header can never contradict each other — it read "April 2026" while the
  // header read "July 2026", which makes both look wrong.
  //
  // Only ever snaps to a period that has sample files, and only when the loaded
  // period changes. A choice the trader made inside this screen is left alone
  // until they load something else.
  const demoPeriodList = org?.demoPeriods;
  useEffect(() => {
    const available = demoPeriodList ?? [];
    if (!available.length) return;
    if (activePeriod && available.includes(activePeriod)) {
      setSamplePeriod(activePeriod);
      return;
    }
    setSamplePeriod((current) => current || org?.defaultDemoPeriod || available[0] || '');
  }, [activePeriod, demoPeriodList, org?.defaultDemoPeriod]);

  const setZone = useCallback((kind, patch) => {
    setZones((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  }, []);

  // Deletes the key rather than setting it to undefined. `{...zones, IMS: undefined}`
  // keeps IMS as an OWN key, so Object.entries still yields it and every consumer
  // that reads `state.status` throws — which is what blanked the whole app when an
  // upload error was dismissed.
  const clearZone = useCallback((kind) => {
    setZones((current) => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
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
          // Exact aliases first, then the adapter's name-based guesses. Anything
          // still unresolved stays blank rather than being filled with a bad
          // guess — a wrong column silently mis-parses every row in the file.
          const draft = {};
          const guessed = {};
          for (const field of columns.mappableFields) {
            if (field in columns.mapped) {
              draft[field] = columns.mapped[field];
              continue;
            }
            const guess = columns.suggested?.[field];
            draft[field] = guess ? guess.index : '';
            if (guess) guessed[field] = guess;
          }
          setMapper({ kind, uploadId: upload.id, filename: file.name, columns, draft, guessed });
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
        const taxPeriod = periodOf(committed, preview);
        setZone(kind, {
          status: 'committed',
          rowCount: committed.parsed,
          taxPeriod,
          rerun: committed.rerun ?? null
        });
        await refreshHistory();
        // The server re-ran the period the moment this landed, so whatever the
        // rest of the app is holding for it is now a version behind.
        if (committed.rerun?.ran) await onDataChanged?.(taxPeriod);
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
      const taxPeriod = periodOf(committed, preview);
      setZone(mapper.kind, {
        status: 'committed',
        detectedFormat: preview.detectedFormat,
        rowCount: committed.parsed,
        taxPeriod,
        filename: mapper.filename,
        rerun: committed.rerun ?? null
      });
      setMapper(null);
      await refreshHistory();
      if (committed.rerun?.ran) await onDataChanged?.(taxPeriod);
    } catch (err) {
      setMapperError(err);
    } finally {
      setMapperBusy(false);
    }
  }, [mapper, setZone, refreshHistory, onDataChanged]);

  const committed = Object.entries(zones).filter(([, state]) => state?.status === 'committed');
  const committedPeriod = committed.map(([, state]) => state.taxPeriod).find(Boolean) ?? null;

  // A source counts if it was committed in THIS session or is already in the
  // database for this period. Uploading one file must never invalidate the other
  // two that are sitting there.
  const stored = periods.find((entry) => entry.taxPeriod === committedPeriod) ?? null;
  const hasBooks = zones.PURCHASE_REGISTER?.status === 'committed' || Boolean(stored?.hasBooks);
  const hasPortal =
    zones.IMS?.status === 'committed' ||
    zones.GSTR2B?.status === 'committed' ||
    Boolean(stored?.hasPortal);
  // What the trader is told is missing has to be the truth about the period, not
  // about this page.
  const missing = [!hasBooks ? 'a purchase register' : null, !hasPortal ? 'an IMS or GSTR-2B file' : null]
    .filter(Boolean)
    .join(' and ');

  const reconcile = useCallback(async () => {
    if (!committedPeriod) return;
    setRunning(true);
    setRunError(null);
    try {
      // Mid-window by default: after 2B generates on the 14th, before GSTR-3B on
      // the 20th. That is the window the recommendations are written for.
      await api.createRun({
        taxPeriod: committedPeriod,
        mode: 'REACTIVE',
        asOfDate: asOfFor(committedPeriod)
      });
      await refreshHistory();
      await onIngested(committedPeriod);
    } catch (err) {
      setRunError(err);
    } finally {
      setRunning(false);
    }
  }, [committedPeriod, onIngested, refreshHistory]);

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

  // Twelve rows across three periods is a wall of near-identical filenames that
  // says nothing. Scope it to the period in view — what was uploaded for THIS
  // month is the only question this table answers — and say how many rows that
  // hid rather than dropping them silently.
  const historyPeriod = committedPeriod ?? activePeriod ?? null;
  const scopedUploads = historyPeriod
    ? (existing ?? []).filter((upload) => upload.tax_period === historyPeriod)
    : (existing ?? []);
  const visibleUploads = scopedUploads.slice(0, 6);
  const hiddenUploads = (existing?.length ?? 0) - visibleUploads.length;

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
                disabled={seeding || !samplePeriod}
                onClick={() => seed(samplePeriod)}
              >
                {seeding ? 'Loading…' : 'Load sample period'}
              </button>
              <p className="muted small seed-inline-help" data-testid="seed-inline-help">
                Loads all three files for {formatPeriod(samplePeriod)} through the same path
                your own would take, reconciles, and shows you the result as of{' '}
                {formatDate(asOfFor(samplePeriod))} — after GSTR-2B generates on the 14th,
                before GSTR-3B is due on the 20th.
              </p>
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
              onRetry={() => clearZone(zone.kind)}
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
          guessed={mapper.guessed}
          onChange={(field, value) =>
            setMapper((current) => {
              // Once the user has ruled on a field it is their choice, not a guess.
              const guessed = { ...current.guessed };
              delete guessed[field];
              return { ...current, draft: { ...current.draft, [field]: value }, guessed };
            })
          }
          onApply={applyMapping}
          onCancel={() => {
            clearZone(mapper.kind);
            setMapper(null);
          }}
        />
      ) : null}

      {committed.length ? (
        <section className="panel" data-testid="reconcile-panel">
          <header className="panel-head">
            <div>
              <h2>Reconcile</h2>
              <p className="muted" data-testid="reconcile-status">
                {committed.length} source{committed.length === 1 ? '' : 's'} committed
                {committedPeriod ? ` for ${formatPeriod(committedPeriod)}` : ''}
                {stored && committedPeriod
                  ? `, alongside ${describeStored(stored)} already loaded for that period`
                  : ''}
                .
                {hasBooks && hasPortal
                  ? stored?.runId
                    ? ' That period has already been reconciled and was re-run automatically ' +
                      'when this file landed; run it again to change the mode or as-of date.'
                    : ''
                  : ` Still needed: ${missing}.`}
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
        <h2>
          Previously uploaded
          {historyPeriod ? (
            <span className="group-count" data-testid="history-scope">
              {formatPeriod(historyPeriod)}
              {hiddenUploads ? ` · ${hiddenUploads} more hidden` : ''}
            </span>
          ) : null}
        </h2>
        {existing === null ? (
          <Loading label="Reading upload history" rows={2} />
        ) : visibleUploads.length === 0 ? (
          <Empty title="No uploads yet" testId="empty-uploads">
            {existing.length
              ? `Nothing has been uploaded for ${formatPeriod(historyPeriod)}. ` +
                `${existing.length} file${existing.length === 1 ? '' : 's'} loaded for other periods.`
              : 'Files you load show up here with their detected format and row count.'}
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
              {visibleUploads.map((upload) => (
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
