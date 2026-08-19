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
import { assignExpectedIdentities, assignPortalIdentities } from './identity.js';

export const UPLOAD_KINDS = Object.freeze(['PURCHASE_REGISTER', 'IMS', 'GSTR2B']);

export class ServiceError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

  const [result] = await pool.query(
    `INSERT INTO uploads
       (org_id, kind, file_format, detected_format, original_filename, byte_size,
        file_hash, tax_period, status, raw_bytes)
     VALUES (:orgId, :kind, :fileFormat, :detected, :filename, :byteSize,
             :fileHash, :taxPeriod, 'RECEIVED', :raw)`,
    {
      orgId,
      kind,
      fileFormat: fileFormatOf(kind, filename),
      detected,
      filename: filename ?? 'upload',
      byteSize: buffer.length,
      fileHash,
      taxPeriod,
      raw: buffer
    }
  );

  return getUpload(orgId, result.insertId);
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
    'file_hash, tax_period, row_count, status, error_message, parsed_at, committed_at, created_at' +
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
export async function previewUpload(orgId, id, { limit = 20, columnMap = null } = {}) {
  const upload = await getUpload(orgId, id, { withBytes: true });
  const buffer = upload.raw_bytes;
  if (!buffer) throw new ServiceError('upload has no stored bytes', 409, 'conflict');

  const parsed = parseUpload(upload, buffer, columnMap);
  return {
    uploadId: upload.id,
    kind: upload.kind,
    detectedFormat: parsed.format,
    taxPeriod: parsed.taxPeriod,
    metadata: parsed.metadata,
    totalRows: parsed.rows.length,
    rows: parsed.rows.slice(0, limit)
  };
}

function parseUpload(upload, buffer, columnMap) {
  try {
    if (upload.kind === 'PURCHASE_REGISTER') {
      const out = purchaseRegister.parseWithMetadata(buffer, columnMap, {
        taxPeriod: upload.tax_period ?? undefined,
        orgId: upload.org_id
      });
      return {
        format: out.format,
        taxPeriod: out.taxPeriod,
        metadata: out.metadata,
        rows: out.invoices
      };
    }

    const json = JSON.parse(stripBom(buffer.toString('utf8')));
    const options = { orgId: upload.org_id };
    if (upload.tax_period) options.taxPeriod = upload.tax_period;
    const rows = upload.kind === 'IMS' ? ims.parse(json, options) : gstr2b.parse(json, options);
    return {
      format: upload.kind === 'IMS' ? 'IMS_JSON' : 'GSTR2B_JSON',
      taxPeriod: upload.tax_period ?? rows[0]?.taxPeriod ?? null,
      metadata: null,
      rows
    };
  } catch (err) {
    // Adapter errors carry the row or JSON path; surface them verbatim.
    throw new ServiceError(err.message, 422, err.code ?? 'parse_error');
  }
}

// --- commit ----------------------------------------------------------------

// Upserts on identity_key, so re-uploading the same source for the same period
// updates rows instead of inserting duplicates. Returns what changed.
export async function commitUpload(orgId, id, { columnMap = null } = {}) {
  const upload = await getUpload(orgId, id, { withBytes: true });
  const buffer = upload.raw_bytes;
  if (!buffer) throw new ServiceError('upload has no stored bytes', 409, 'conflict');

  const parsed = parseUpload(upload, buffer, columnMap);

  const outcome = await withTransaction(async (connection) => {
    if (upload.kind === 'PURCHASE_REGISTER') {
      return commitExpected(connection, orgId, upload, parsed);
    }
    return commitPortal(connection, orgId, upload, parsed);
  });

  await pool.query(
    `UPDATE uploads
        SET status = 'PARSED', row_count = :rowCount, parsed_at = NOW(),
            committed_at = NOW(), tax_period = COALESCE(tax_period, :taxPeriod),
            detected_format = :format
      WHERE org_id = :orgId AND id = :id`,
    {
      orgId,
      id,
      rowCount: parsed.rows.length,
      taxPeriod: parsed.taxPeriod,
      format: parsed.format
    }
  );

  return { uploadId: upload.id, kind: upload.kind, taxPeriod: parsed.taxPeriod, ...outcome };
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

  const after = await countRows(connection, 'expected_invoices', orgId);
  return { parsed: invoices.length, inserted: after - before, updated: invoices.length - (after - before) };
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

  // Detect amendments before writing: a changed content_hash on the same identity
  // means the supplier edited a record we have already shown the trader.
  const changes = await detectChanges(connection, orgId, records, upload.id);

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
  await recordChanges(connection, orgId, changes, upload.id);

  const after = await countRows(connection, 'portal_records', orgId);
  return {
    parsed: records.length,
    inserted: after - before,
    updated: records.length - (after - before),
    changes: changes.length
  };
}

async function detectChanges(connection, orgId, records, uploadId) {
  if (!records.length) return [];
  const keys = records.map((record) => record.identityKey);
  const changes = [];

  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const [existing] = await connection.query(
      `SELECT id, identity_key, content_hash, filing_status, ims_action,
              taxable_value, total_tax
         FROM portal_records
        WHERE org_id = ? AND identity_key IN (?)`,
      [orgId, chunk]
    );
    const byKey = new Map(existing.map((row) => [row.identity_key, row]));

    for (const record of records) {
      const previous = byKey.get(record.identityKey);
      if (!previous) continue;
      if (previous.content_hash === record.contentHash) continue;

      // Same identity, different content: the supplier amended a saved record.
      const changeType =
        previous.taxable_value !== record.taxableValue || previous.total_tax !== record.totalTax
          ? 'CHANGED_AFTER_REVIEW'
          : previous.filing_status !== record.filingStatus
            ? 'FILING_STATUS_CHANGED'
            : 'ACTION_CHANGED';

      changes.push({
        portalRecordId: previous.id,
        changeType,
        oldContentHash: previous.content_hash,
        newContentHash: record.contentHash,
        oldValues: {
          taxableValue: previous.taxable_value,
          totalTax: previous.total_tax,
          filingStatus: previous.filing_status,
          imsAction: previous.ims_action
        },
        newValues: {
          taxableValue: record.taxableValue,
          totalTax: record.totalTax,
          filingStatus: record.filingStatus,
          imsAction: record.imsAction
        },
        uploadId
      });
    }
  }
  return changes;
}

async function recordChanges(connection, orgId, changes) {
  if (!changes.length) return;
  const rows = changes.map((change) => [
    orgId,
    change.portalRecordId,
    change.changeType,
    change.oldContentHash,
    change.newContentHash,
    JSON.stringify(change.oldValues),
    JSON.stringify(change.newValues),
    change.uploadId
  ]);
  await insertInChunks(
    connection,
    `INSERT INTO record_changes
       (org_id, portal_record_id, change_type, old_content_hash, new_content_hash,
        old_values, new_values, detected_from_upload_id)
     VALUES ?`,
    rows
  );
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

export async function listUploads(orgId, { limit = 50 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, kind, file_format, detected_format, original_filename, byte_size,
            tax_period, row_count, status, created_at, committed_at
       FROM uploads WHERE org_id = :orgId
      ORDER BY id DESC LIMIT :limit`,
    { orgId, limit }
  );
  return rows;
}
