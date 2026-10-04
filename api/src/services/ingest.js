// Upload ingestion: receive bytes -> preview -> commit rows.
//
// The adapters own every portal field name; this service only ever sees the
// canonical ExpectedInvoice / PortalRecord shapes.
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { insertInChunks, withTransaction } from '../db/tx.js';
import * as purchaseRegister from '../adapters/purchaseRegister.js';
import * as ims from '../adapters/ims.js';
import * as gstr2b from '../adapters/gstr2b.js';
import { stripBom } from '../adapters/values.js';
import { isTwoBGenerated, twoBGenerationDate } from '../matching/cutoff.js';
import { assignExpectedIdentities, assignPortalIdentities } from './identity.js';
import { saveRegisterContacts } from './supplierContacts.js';
import { applyDeclaredSchemes } from './supplierStats.js';
import { planPortalDiff, writePortalDiff } from './syncDiff.js';
import { displayDate, displayPeriod, workspaceAsOf } from './workspaceClock.js';
import { adoptFileGstin, adoptTraderPhone, assertFileGstin, fileTraderGstin } from './workspaceGstin.js';

export const UPLOAD_KINDS = Object.freeze(['PURCHASE_REGISTER', 'IMS', 'GSTR2B']);

export class ServiceError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
    // Every ServiceError message is copy written for the trader, so it is safe
    // to send back as-is. The production error responder redacts everything
    // NOT marked this way — see createApp() in app.js.
    this.expose = true;
  }
}

// An IMS upload with zero rows still has to diff against IMS and nothing else.
const sourceOf = (kind) => (kind === 'IMS' ? 'IMS' : 'GSTR2B');

function fileFormatOf(kind, filename) {
  if (kind === 'PURCHASE_REGISTER') {
    return /\.csv$/i.test(filename ?? '') ? 'CSV' : 'XLSX';
  }
  return 'JSON';
}

// --- create ----------------------------------------------------------------

export async function createUpload({ orgId, kind, filename, buffer, taxPeriod = null }) {
  if (!UPLOAD_KINDS.includes(kind)) {
    throw new ServiceError(`kind must be one of ${UPLOAD_KINDS.join(', ')}`);
  }
  if (!buffer?.length) throw new ServiceError('file is empty');

  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const detected = detectFormat(kind, buffer);
  // Another trader's file is refused before it is stored (services/workspaceGstin.js).
  await assertFileGstin(orgId, fileTraderGstin(kind, buffer));
  const asOfDate = await workspaceAsOf(orgId);
  if (kind === 'GSTR2B') assertTwoBGenerated(taxPeriod ?? gstr2b.statementPeriod(buffer), asOfDate);

  const [result] = await pool.query(
    `INSERT INTO uploads
       (org_id, kind, file_format, detected_format, original_filename, byte_size,
        file_hash, tax_period, snapshot_date, status, raw_bytes)
     VALUES (:orgId, :kind, :fileFormat, :detected, :filename, :byteSize,
             :fileHash, :taxPeriod, :snapshotDate, 'RECEIVED', :raw)`,
    {
      orgId,
      kind,
      fileFormat: fileFormatOf(kind, filename),
      detected,
      filename: filename ?? 'upload',
      byteSize: buffer.length,
      fileHash,
      taxPeriod,
      // An IMS download is the portal as it stood on one day: the workspace's.
      snapshotDate: kind === 'IMS' ? asOfDate : null,
      raw: buffer
    }
  );

  const created = await getUpload(orgId, result.insertId);
  return { ...created, warnings: snapshotWarnings(created) };
}

// GSTR-2B for a period is generated on the 14th of the following month, so on an
// earlier workspace date a file for it cannot exist yet and is refused.
function assertTwoBGenerated(taxPeriod, asOfDate) {
  if (!taxPeriod || isTwoBGenerated(asOfDate, taxPeriod) !== false) return;
  const generated = displayDate(twoBGenerationDate(taxPeriod));
  throw new ServiceError(
    `GSTR-2B for ${displayPeriod(taxPeriod)} is generated on ${generated}, and the workspace ` +
      `date is ${displayDate(asOfDate)}. Move the workspace date to ${generated} or later to upload it.`,
    409,
    'gstr2b_not_generated'
  );
}

const FILE_NAME_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The as-of date a file name carries, as the IMS download names are written:
// 'ims_aug26_as_of_05sep.json' -> '2026-09-05'. With no year in the name, the year
// is the one that puts the date nearest `near`. null when the name carries none.
export function asOfDateInFileName(filename, near) {
  const match = /as[\s_-]*of[\s_-]*(\d{1,2})[\s_-]*([a-z]{3})[a-z]*(?:[\s_-]*(\d{4}|\d{2})(?!\d))?/i.exec(
    String(filename ?? '')
  );
  if (!match) return null;
  const day = Number(match[1]);
  const month = FILE_NAME_MONTHS.indexOf(match[2].toLowerCase()) + 1;
  if (month < 1 || day < 1 || day > 31) return null;

  const iso = (year) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (match[3]) return iso(match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]));
  const nearYear = Number(String(near).slice(0, 4));
  const distance = (candidate) => Math.abs(Date.parse(candidate) - Date.parse(near));
  return [nearYear - 1, nearYear, nearYear + 1].map(iso).sort((a, b) => distance(a) - distance(b))[0];
}

// An IMS file named for one day and uploaded on another is recorded on the
// workspace date. Said, not refused: the name may simply be wrong.
function snapshotWarnings(upload) {
  if (upload.kind !== 'IMS' || !upload.snapshot_date) return [];
  const named = asOfDateInFileName(upload.original_filename, upload.snapshot_date);
  if (!named || named === upload.snapshot_date) return [];
  const recorded = displayDate(upload.snapshot_date);
  return [
    `The file name says this IMS download is as of ${displayDate(named)}, but the workspace ` +
      `date is ${recorded}, so it was recorded as the ${recorded} snapshot. If the name is ` +
      'right, move the workspace date and upload it again.'
  ];
}

// Format sniffing belongs to the adapters: the envelope keys it looks at are
// portal field names, which never appear outside adapters/.
function detectFormat(kind, buffer) {
  if (kind === 'PURCHASE_REGISTER') return purchaseRegister.detectFormat(buffer);
  if (kind === 'IMS') return ims.detectFormat(buffer);
  return gstr2b.detectFormat(buffer);
}

export async function getUpload(orgId, id, { withBytes = false } = {}) {
  const columns =
    'id, org_id, kind, file_format, detected_format, original_filename, byte_size, ' +
    'file_hash, tax_period, snapshot_date, row_count, status, error_message, parsed_at, ' +
    'committed_at, replaced_at, replaced_by_upload_id, created_at' +
    (withBytes ? ', raw_bytes' : '');
  const [rows] = await pool.query(
    `SELECT ${columns} FROM uploads WHERE org_id = :orgId AND id = :id`,
    { orgId, id }
  );
  if (!rows.length) throw new ServiceError('upload not found', 404, 'not_found');
  return rows[0];
}

// --- preview ---------------------------------------------------------------

// Detected format plus the first N canonical rows, so the trader can see that the
// mapping worked before committing anything.
export async function previewUpload(orgId, id, { limit = 20, columnMap = null, allInvoices = false } = {}) {
  const upload = await getUpload(orgId, id, { withBytes: true });
  const buffer = upload.raw_bytes;
  if (!buffer) throw new ServiceError('upload has no stored bytes', 409, 'conflict');

  const parsed = parseUpload(upload, buffer, columnMap, { allInvoices });
  return {
    uploadId: upload.id,
    kind: upload.kind,
    detectedFormat: parsed.format,
    taxPeriod: parsed.taxPeriod,
    metadata: parsed.metadata,
    warnings: [...snapshotWarnings(upload), ...parsed.warnings],
    totalRows: parsed.rows.length,
    rows: parsed.rows.slice(0, limit)
  };
}

// allInvoices: the trader confirms a register with no document-type column
// holds invoices only (purchaseRegister.requireDocumentType).
function parseUpload(upload, buffer, columnMap, { allInvoices = false } = {}) {
  try {
    if (upload.kind === 'PURCHASE_REGISTER') {
      const out = purchaseRegister.parseWithMetadata(buffer, columnMap, {
        taxPeriod: upload.tax_period ?? undefined,
        orgId: upload.org_id,
        allInvoices
      });
      return {
        format: out.format,
        // A CSV carries no file-level period, so it is the one most of its rows
        // fall in. Recorded on the upload at commit, which is what puts a CSV in
        // the period-filtered upload history (audit P33).
        taxPeriod: out.taxPeriod ?? dominantPeriod(out.invoices),
        metadata: out.metadata,
        // Rows read as one document without the file saying so (P31).
        warnings: out.warnings ?? [],
        rows: out.invoices
      };
    }

    const json = JSON.parse(stripBom(buffer.toString('utf8')));
    const options = { orgId: upload.org_id };
    if (upload.tax_period) options.taxPeriod = upload.tax_period;
    const rows = upload.kind === 'IMS'
      ? inUploadPeriod(ims.parse(json, options), upload.tax_period)
      : gstr2b.parse(json, options);
    return {
      format: upload.kind === 'IMS' ? 'IMS_JSON' : 'GSTR2B_JSON',
      taxPeriod: upload.tax_period ?? rows[0]?.taxPeriod ?? null,
      metadata: null,
      warnings: [],
      rows
    };
  } catch (err) {
    // Adapter errors carry the row or JSON path; surface them verbatim.
    throw new ServiceError(err.message, 422, err.code ?? 'parse_error');
  }
}

// --- commit ----------------------------------------------------------------

// A commit REPLACES what the org held for its period and source, in one
// transaction (audit P30):
//   * purchase register: rows of the file's period that the new file does not
//     carry are deleted. Upserting on identity_key keeps the ids of unchanged rows,
//     so the decisions made on them survive the rebuild.
//   * IMS / 2B: a record missing from the new download is marked absent
//     (syncDiff), and an absent record no longer takes part in reconciliation
//     (loadPortal). It is kept for the change feed.
// Every period the file touched has its run marked out of date until rebuilt.
// Returns what changed, and those periods.
export async function commitUpload(orgId, id, { columnMap = null, allInvoices = false } = {}) {
  const upload = await getUpload(orgId, id, { withBytes: true });
  const buffer = upload.raw_bytes;
  if (!buffer) throw new ServiceError('upload has no stored bytes', 409, 'conflict');

  const parsed = parseUpload(upload, buffer, columnMap, { allInvoices });
  // Again at commit: the workspace date may have moved back since the upload.
  if (upload.kind === 'GSTR2B') assertTwoBGenerated(parsed.taxPeriod, await workspaceAsOf(orgId));

  const outcome = await withTransaction(async (connection) => {
    // Again at commit, where an empty workspace adopts the file's GSTIN.
    const traderGstin = await adoptFileGstin(connection, orgId, fileTraderGstin(upload.kind, buffer));
    const committed = upload.kind === 'PURCHASE_REGISTER'
      ? await commitExpected(connection, orgId, upload, parsed)
      : await commitPortal(connection, orgId, upload, parsed);
    await markRunsStale(connection, orgId, committed.periods);
    return { ...committed, traderGstin };
  });

  // Committed now, so current again even if it was once replaced.
  await pool.query(
    `UPDATE uploads
        SET status = 'PARSED', row_count = :rowCount, parsed_at = NOW(),
            committed_at = NOW(), tax_period = COALESCE(tax_period, :taxPeriod),
            detected_format = :format, replaced_at = NULL, replaced_by_upload_id = NULL
      WHERE org_id = :orgId AND id = :id`,
    {
      orgId,
      id,
      rowCount: parsed.rows.length,
      taxPeriod: parsed.taxPeriod,
      format: parsed.format
    }
  );
  const replacedUploadIds = await markReplacedUploads(orgId, upload, upload.tax_period ?? parsed.taxPeriod);
  // The register's "Supplier filing frequency" column, set as the trader's own.
  const filingSchemes = upload.kind === 'PURCHASE_REGISTER'
    ? await applyDeclaredSchemes(orgId, parsed.rows)
    : { declared: 0, changed: 0 };

  return {
    uploadId: upload.id,
    kind: upload.kind,
    taxPeriod: parsed.taxPeriod,
    snapshotDate: upload.snapshot_date,
    warnings: [...snapshotWarnings(upload), ...parsed.warnings],
    replacedUploadIds,
    filingSchemes,
    ...outcome
  };
}

// The latest commit of a kind and period owns that kind's data for the period, so
// every earlier one is marked replaced: kept in the history, never deleted.
async function markReplacedUploads(orgId, upload, taxPeriod) {
  if (!taxPeriod) return [];
  const [earlier] = await pool.query(
    `SELECT id FROM uploads
      WHERE org_id = ? AND kind = ? AND tax_period = ? AND id <> ?
        AND committed_at IS NOT NULL AND replaced_at IS NULL`,
    [orgId, upload.kind, taxPeriod, upload.id]
  );
  const ids = earlier.map((row) => row.id);
  if (ids.length) {
    await pool.query(
      'UPDATE uploads SET replaced_at = NOW(), replaced_by_upload_id = ? WHERE org_id = ? AND id IN (?)',
      [upload.id, orgId, ids]
    );
  }
  return ids;
}

async function commitExpected(connection, orgId, upload, parsed) {
  const invoices = assignExpectedIdentities(parsed.rows);

  const rows = invoices.map((invoice) => [
    orgId,
    upload.id,
    invoice.supplierGstin,
    invoice.supplierName,
    invoice.docType,
    invoice.supplyType,
    invoice.invoiceNo,
    invoice.invoiceNoNorm,
    invoice.invoiceDate,
    invoice.taxPeriod,
    invoice.placeOfSupply,
    invoice.taxableValue,
    invoice.igst,
    invoice.cgst,
    invoice.sgst,
    invoice.cess,
    invoice.totalTax,
    invoice.invoiceValue,
    invoice.reverseCharge ? 1 : 0,
    invoice.itcEligibility,
    invoice.originalInvoiceNo,
    invoice.originalInvoiceDate,
    invoice.sourceRowNo,
    invoice.identitySeq,
    invoice.identityKey
  ]);

  const before = await countRows(connection, 'expected_invoices', orgId);

  await insertInChunks(
    connection,
    `INSERT INTO expected_invoices
       (org_id, upload_id, supplier_gstin, supplier_name, doc_type, supply_type,
        invoice_no, invoice_no_norm, invoice_date, tax_period, place_of_supply,
        taxable_value, igst, cgst, sgst, cess, total_tax, invoice_value,
        reverse_charge, itc_eligibility, original_invoice_no, original_invoice_date,
        source_row_no, identity_seq, identity_key)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       upload_id = VALUES(upload_id),
       supplier_name = VALUES(supplier_name),
       supply_type = VALUES(supply_type),
       invoice_no = VALUES(invoice_no),
       place_of_supply = VALUES(place_of_supply),
       taxable_value = VALUES(taxable_value),
       igst = VALUES(igst), cgst = VALUES(cgst), sgst = VALUES(sgst),
       cess = VALUES(cess), total_tax = VALUES(total_tax),
       invoice_value = VALUES(invoice_value),
       reverse_charge = VALUES(reverse_charge),
       itc_eligibility = VALUES(itc_eligibility),
       original_invoice_no = VALUES(original_invoice_no),
       original_invoice_date = VALUES(original_invoice_date),
       source_row_no = VALUES(source_row_no)`,
    rows
  );

  // Rate lines are children of the invoice, so replace them wholesale for the
  // invoices this upload touched rather than trying to diff them.
  await replaceExpectedRateLines(connection, orgId, invoices);
  const contacts = await saveRegisterContacts(connection, orgId, upload.id, invoices);
  await adoptTraderPhone(connection, orgId, parsed.metadata?.recipientPhone);

  const afterUpsert = await countRows(connection, 'expected_invoices', orgId);
  const filePeriod = upload.tax_period ?? parsed.taxPeriod;
  const replaced = await replacePeriodRegister(connection, orgId, filePeriod, invoices);

  return {
    parsed: invoices.length,
    inserted: afterUpsert - before,
    updated: invoices.length - (afterUpsert - before),
    replaced,
    contacts,
    periods: periodsOf(invoices, filePeriod)
  };
}

// The register for one period is whatever the latest file says it is. Rows the
// new file does not carry are deleted, with their rate lines and results
// (ON DELETE CASCADE). Bounded to the file's own period: a CSV that also carries
// a stray row from another month adds that row there and deletes nothing.
async function replacePeriodRegister(connection, orgId, taxPeriod, invoices) {
  if (!taxPeriod) return 0;
  const keep = invoices.filter((invoice) => invoice.taxPeriod === taxPeriod).map((i) => i.identityKey);
  const [result] = keep.length
    ? await connection.query(
        `DELETE FROM expected_invoices
          WHERE org_id = ? AND tax_period = ? AND identity_key NOT IN (?)`,
        [orgId, taxPeriod, keep]
      )
    : await connection.query(
        'DELETE FROM expected_invoices WHERE org_id = ? AND tax_period = ?',
        [orgId, taxPeriod]
      );
  return result.affectedRows;
}

// An IMS download is one return period's worklist. A GSTR-1A filed for an earlier
// month, or a document filed late, is acted on now and reaches THIS period's 2B,
// whatever source period (rtnprd) it names, so every record belongs to the
// upload's period: the one declared, else the one most of its records name. Left
// on its source period, one GSTR-1A record would also make the upload replace
// that earlier period's IMS.
function inUploadPeriod(records, declared) {
  const period = declared ?? dominantPeriod(records);
  return records.map((record) => ({ ...record, taxPeriod: period }));
}

// The period most of a file's rows fall in, for a file that declares none.
export function dominantPeriod(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.taxPeriod) counts.set(row.taxPeriod, (counts.get(row.taxPeriod) ?? 0) + 1);
  }
  // Most rows first; a tie goes to the later period.
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
}

const periodsOf = (rows, ...extra) =>
  [...new Set([...rows.map((row) => row.taxPeriod), ...extra].filter(Boolean))].sort();

// A run computed before this commit no longer describes its period's data.
// Recorded on the run itself, so it holds whatever the commit changed — a
// replaced register can leave every count exactly as it was. createRun()
// rewrites the summary, which clears it. See reconcile.runStaleness().
export async function markRunsStale(connection, orgId, periods) {
  if (!periods.length) return;
  await connection.query(
    `UPDATE runs
        SET summary = JSON_SET(COALESCE(summary, JSON_OBJECT()), '$.inputsChangedAt', ?)
      WHERE org_id = ? AND tax_period IN (?)`,
    [new Date().toISOString(), orgId, periods]
  );
}

async function replaceExpectedRateLines(connection, orgId, invoices) {
  const withLines = invoices.filter((invoice) => invoice.rateLines?.length);
  if (!withLines.length) return;

  const keys = withLines.map((invoice) => invoice.identityKey);
  const [existing] = await connection.query(
    'SELECT id, identity_key FROM expected_invoices WHERE org_id = ? AND identity_key IN (?)',
    [orgId, keys]
  );
  const idByKey = new Map(existing.map((row) => [row.identity_key, row.id]));

  const ids = [...idByKey.values()];
  if (ids.length) {
    await connection.query(
      'DELETE FROM expected_rate_lines WHERE org_id = ? AND expected_invoice_id IN (?)',
      [orgId, ids]
    );
  }

  const rows = [];
  for (const invoice of withLines) {
    const invoiceId = idByKey.get(invoice.identityKey);
    if (!invoiceId) continue;
    for (const line of invoice.rateLines) {
      rows.push([
        orgId, invoiceId, line.hsn, line.rate,
        line.taxableValue, line.igst, line.cgst, line.sgst, line.cess
      ]);
    }
  }
  if (rows.length) {
    await insertInChunks(
      connection,
      `INSERT INTO expected_rate_lines
         (org_id, expected_invoice_id, hsn, rate, taxable_value, igst, cgst, sgst, cess)
       VALUES ?`,
      rows
    );
  }
}

async function commitPortal(connection, orgId, upload, parsed) {
  const records = assignPortalIdentities(parsed.rows);

  // The diff is PLANNED before writing — once the upsert lands, the previous
  // content_hash is gone and there is nothing left to compare against. It is
  // written after, because a NEW record has no id until it exists.
  const plan = await planPortalDiff(connection, {
    orgId,
    source: records[0]?.source ?? sourceOf(upload.kind),
    taxPeriod: parsed.taxPeriod ?? upload.tax_period ?? null,
    records
  });

  const rows = records.map((record) => [
    orgId,
    upload.id,
    record.source,
    record.section,
    record.supplierGstin,
    record.supplierName,
    record.docType,
    record.supplyType,
    record.invoiceNo,
    record.invoiceNoNorm,
    record.invoiceDate,
    record.taxPeriod,
    record.placeOfSupply,
    record.taxableValue,
    record.igst,
    record.cgst,
    record.sgst,
    record.cess,
    record.totalTax,
    record.invoiceValue,
    record.reverseCharge ? 1 : 0,
    record.itcAvailable === null || record.itcAvailable === undefined
      ? null
      : record.itcAvailable ? 1 : 0,
    record.itcIneligibleReason,
    record.supplierFiledOn,
    record.counterpartyFilingStatus,
    record.supplierReturnPeriod,
    record.differentialPercent,
    record.filingStatus,
    record.imsAction,
    record.pendingBlocked ? 1 : 0,
    record.remarksBlocked ? 1 : 0,
    record.itcReductionBlocked ? 1 : 0,
    record.originalInvoiceNo,
    record.originalInvoiceDate,
    record.portCode,
    record.sourceForm,
    record.contentHash,
    record.identitySeq,
    record.identityKey
  ]);

  const before = await countRows(connection, 'portal_records', orgId);

  await insertInChunks(
    connection,
    `INSERT INTO portal_records
       (org_id, upload_id, source, section, supplier_gstin, supplier_name, doc_type,
        supply_type, invoice_no, invoice_no_norm, invoice_date, tax_period,
        place_of_supply, taxable_value, igst, cgst, sgst, cess, total_tax,
        invoice_value, reverse_charge, itc_available, itc_ineligible_reason,
        supplier_filed_on, counterparty_filing_status, supplier_return_period,
        differential_percent, filing_status, ims_action, pending_blocked,
        remarks_blocked, itc_reduction_blocked, original_invoice_no,
        original_invoice_date, port_code, source_form, content_hash,
        identity_seq, identity_key)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       upload_id = VALUES(upload_id),
       supplier_name = VALUES(supplier_name),
       supply_type = VALUES(supply_type),
       invoice_no = VALUES(invoice_no),
       place_of_supply = VALUES(place_of_supply),
       taxable_value = VALUES(taxable_value),
       igst = VALUES(igst), cgst = VALUES(cgst), sgst = VALUES(sgst),
       cess = VALUES(cess), total_tax = VALUES(total_tax),
       invoice_value = VALUES(invoice_value),
       reverse_charge = VALUES(reverse_charge),
       itc_available = VALUES(itc_available),
       itc_ineligible_reason = VALUES(itc_ineligible_reason),
       supplier_filed_on = VALUES(supplier_filed_on),
       counterparty_filing_status = VALUES(counterparty_filing_status),
       supplier_return_period = VALUES(supplier_return_period),
       differential_percent = VALUES(differential_percent),
       filing_status = VALUES(filing_status),
       ims_action = VALUES(ims_action),
       pending_blocked = VALUES(pending_blocked),
       remarks_blocked = VALUES(remarks_blocked),
       itc_reduction_blocked = VALUES(itc_reduction_blocked),
       original_invoice_no = VALUES(original_invoice_no),
       original_invoice_date = VALUES(original_invoice_date),
       port_code = VALUES(port_code),
       source_form = VALUES(source_form),
       content_hash = VALUES(content_hash),
       last_seen_at = NOW()`,
    rows
  );

  await replacePortalRateLines(connection, orgId, records);
  const changeCount = await writePortalDiff(connection, {
    orgId,
    uploadId: upload.id,
    plan
  });

  const after = await countRows(connection, 'portal_records', orgId);
  return {
    parsed: records.length,
    inserted: after - before,
    updated: records.length - (after - before),
    changes: changeCount,
    // Records the new download no longer carries: absent from here on.
    replaced: plan.disappeared.length,
    periods: periodsOf(records, parsed.taxPeriod ?? upload.tax_period)
  };
}

async function replacePortalRateLines(connection, orgId, records) {
  const withLines = records.filter((record) => record.rateLines?.length);
  if (!withLines.length) return;

  const keys = withLines.map((record) => record.identityKey);
  const [existing] = await connection.query(
    'SELECT id, identity_key FROM portal_records WHERE org_id = ? AND identity_key IN (?)',
    [orgId, keys]
  );
  const idByKey = new Map(existing.map((row) => [row.identity_key, row.id]));

  const ids = [...idByKey.values()];
  if (ids.length) {
    await connection.query(
      'DELETE FROM portal_rate_lines WHERE org_id = ? AND portal_record_id IN (?)',
      [orgId, ids]
    );
  }

  const rows = [];
  for (const record of withLines) {
    const recordId = idByKey.get(record.identityKey);
    if (!recordId) continue;
    for (const line of record.rateLines) {
      rows.push([
        orgId, recordId, line.hsn, line.rate,
        line.taxableValue, line.igst, line.cgst, line.sgst, line.cess
      ]);
    }
  }
  if (rows.length) {
    await insertInChunks(
      connection,
      `INSERT INTO portal_rate_lines
         (org_id, portal_record_id, hsn, rate, taxable_value, igst, cgst, sgst, cess)
       VALUES ?`,
      rows
    );
  }
}

async function countRows(connection, table, orgId) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`,
    [orgId]
  );
  return Number(rows[0].n);
}

// --- delete ----------------------------------------------------------------

// Removes an upload and every row it still owns, in one transaction. Because a
// commit replaces its period's rows, the latest file of a kind owns that kind's
// data for its period, so deleting it removes that data; a superseded file owns
// only what nothing replaced since. Rows go with their rate lines, results and
// change-feed entries (ON DELETE CASCADE), and so do the changes this upload
// detected. A period left with nothing to reconcile loses its run and supplier
// figures; any other period it touched is marked out of date for the caller to
// rebuild. An upload it replaced stays marked replaced: its rows had become this
// one's, so they go too, and the period is left without that kind of file.
export async function deleteUpload(orgId, id) {
  const upload = await getUpload(orgId, id);
  return withTransaction(async (connection) => {
    const periods = await periodsOwnedBy(connection, orgId, id, upload.tax_period);

    await connection.query(
      'DELETE FROM record_changes WHERE org_id = ? AND detected_from_upload_id = ?',
      [orgId, id]
    );
    const [books] = await connection.query(
      'DELETE FROM expected_invoices WHERE org_id = ? AND upload_id = ?',
      [orgId, id]
    );
    const [portal] = await connection.query(
      'DELETE FROM portal_records WHERE org_id = ? AND upload_id = ?',
      [orgId, id]
    );
    await connection.query(
      `UPDATE runs SET pr_upload_id = NULLIF(pr_upload_id, ?),
                       ims_upload_id = NULLIF(ims_upload_id, ?),
                       gstr2b_upload_id = NULLIF(gstr2b_upload_id, ?)
        WHERE org_id = ?`,
      [id, id, id, orgId]
    );
    await connection.query('DELETE FROM uploads WHERE org_id = ? AND id = ?', [orgId, id]);

    const emptied = await dropEmptyPeriods(connection, orgId, periods);
    await markRunsStale(connection, orgId, periods);
    return {
      uploadId: id,
      kind: upload.kind,
      removed: { registerRows: books.affectedRows, portalRecords: portal.affectedRows },
      periods,
      emptiedPeriods: emptied
    };
  });
}

async function periodsOwnedBy(connection, orgId, uploadId, declared) {
  const [rows] = await connection.query(
    `SELECT tax_period FROM expected_invoices WHERE org_id = ? AND upload_id = ?
     UNION
     SELECT tax_period FROM portal_records WHERE org_id = ? AND upload_id = ?`,
    [orgId, uploadId, orgId, uploadId]
  );
  return [...new Set([...rows.map((row) => row.tax_period), declared].filter(Boolean))].sort();
}

// A period with no books and no portal record left has nothing a run could say.
async function dropEmptyPeriods(connection, orgId, periods) {
  const emptied = [];
  for (const taxPeriod of periods) {
    const [[left]] = await connection.query(
      `SELECT (SELECT COUNT(*) FROM expected_invoices WHERE org_id = ? AND tax_period = ?) +
              (SELECT COUNT(*) FROM portal_records
                WHERE org_id = ? AND tax_period = ? AND absent_since IS NULL) AS n`,
      [orgId, taxPeriod, orgId, taxPeriod]
    );
    if (Number(left.n) > 0) continue;
    for (const sql of [
      'DELETE FROM runs WHERE org_id = ? AND tax_period = ?',
      'DELETE FROM supplier_periods WHERE org_id = ? AND tax_period = ?',
      'DELETE FROM supplier_risk WHERE org_id = ? AND as_of_period = ?'
    ]) {
      await connection.query(sql, [orgId, taxPeriod]);
    }
    emptied.push(taxPeriod);
  }
  return emptied;
}

export async function listUploads(orgId, { limit = 50 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, kind, file_format, detected_format, original_filename, byte_size,
            tax_period, snapshot_date, row_count, status, created_at, committed_at,
            replaced_at, replaced_by_upload_id
       FROM uploads WHERE org_id = :orgId
      ORDER BY id DESC LIMIT :limit`,
    { orgId, limit }
  );
  return rows;
}
