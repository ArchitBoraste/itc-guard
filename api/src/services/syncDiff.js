// Sync diffing: what the portal said last time vs what it says now.
//
// A trader downloads IMS on the 6th, works through the exceptions, and downloads
// again on the 10th. Between those two files a supplier can have amended a saved
// record, deleted one, or filed what they had only saved. The portal shows the
// new state and says nothing about the old one — reconciling the second file
// against the books gives a correct answer to the wrong question, because the
// trader has already made decisions about the first.
//
// ---------------------------------------------------------------------------
// The four kinds
// ---------------------------------------------------------------------------
//   AMENDED        same identity_key, different content_hash
//   DISAPPEARED    present in the last file for this source+period, absent now
//   REAPPEARED     absent (see portal_records.absent_since), present now
//   STATUS_CHANGE  filing_status moved, in practice SAVED -> FILED
//
// NEW is also emitted, but only on a RE-ingest: an identity nobody has seen
// before is not a change on the first upload of a period, it is the period. On a
// later upload it is a document the supplier added after the trader reviewed, and
// an unreviewed IMS record is deemed accepted at GSTR-3B — the one thing this
// product exists to prevent. See planPortalDiff().
//
// AMENDED and STATUS_CHANGE are independent tests and both can fire for the same
// record in one upload: a supplier who corrects a value and then files has done
// two things, and collapsing them into one row would hide whichever came second.
// Only the amendment is still fixable for free; the filing is not.
//
// ---------------------------------------------------------------------------
// Strictly within one source
// ---------------------------------------------------------------------------
// The baseline is (org_id, source, tax_period) and never wider. Uploading only
// IMS must not mark GSTR-2B records as DISAPPEARED — the 2B file simply was not
// part of this upload, and "your supplier deleted 400 records" is both alarming
// and false. Every query below carries the source.
//
// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
// AMENDED is CHANGED_AFTER_REVIEW renamed: the same hash test, under a name that
// does not claim a review happened. The old value is still read (see
// CANONICAL_TYPE) and never written. CONFIRMATION_RESET, from phase 4, is a
// different thing and is left alone — it is what an amendment does to a HUMAN
// DECISION, decided during the run rebuild by carryForward(), and it also fires
// on a bucket move with no portal change at all. See 004_sync_diff.sql.
import { insertInChunks } from '../db/tx.js';
import { pool } from '../db/pool.js';
import { ServiceError } from './ingest.js';

export const CHANGE_TYPES = Object.freeze([
  'NEW',
  'AMENDED',
  'DISAPPEARED',
  'REAPPEARED',
  'STATUS_CHANGE'
]);

// Retired names -> what they meant. Written by phase 4's ingest, still on disk.
const CANONICAL_TYPE = Object.freeze({
  CHANGED_AFTER_REVIEW: 'AMENDED',
  FILING_STATUS_CHANGED: 'STATUS_CHANGE',
  ACTION_CHANGED: 'AMENDED'
});

export const canonicalChangeType = (type) => CANONICAL_TYPE[type] ?? type;

// The fields worth diffing. The first six are exactly the content_hash inputs, so
// an AMENDED row can always name at least one of them. The tax components are not
// hashed but are stored and cheap, and "IGST 9,000 -> 4,500 + 4,500 CGST/SGST" is
// a different conversation with the supplier than a changed total.
const TRACKED_FIELDS = Object.freeze([
  { field: 'supplierGstin', column: 'supplier_gstin', money: false },
  { field: 'invoiceNoNorm', column: 'invoice_no_norm', money: false },
  { field: 'invoiceDate', column: 'invoice_date', money: false },
  { field: 'docType', column: 'doc_type', money: false },
  { field: 'taxableValue', column: 'taxable_value', money: true },
  { field: 'totalTax', column: 'total_tax', money: true },
  { field: 'igst', column: 'igst', money: true },
  { field: 'cgst', column: 'cgst', money: true },
  { field: 'sgst', column: 'sgst', money: true },
  { field: 'cess', column: 'cess', money: true }
]);

const BASELINE_COLUMNS =
  'id, identity_key, content_hash, filing_status, ims_action, absent_since, ' +
  TRACKED_FIELDS.map((f) => f.column).join(', ');

// --- planning (runs BEFORE the upsert) -------------------------------------

// Reads the previous state of this source+period and returns the changes the
// incoming records imply. Nothing is written here: a NEW record has no id until
// the upsert has run, so the plan is resolved to rows afterwards by
// writePortalDiff().
//
// `taxPeriod` is the upload's declared period; the periods actually present in
// the file are added to it, so a file whose rows carry a neighbouring period
// still diffs against the right baseline.
export async function planPortalDiff(connection, { orgId, source, taxPeriod, records }) {
  const periods = new Set(records.map((record) => record.taxPeriod).filter(Boolean));
  if (taxPeriod) periods.add(taxPeriod);
  if (!periods.size) return { changes: [], reappeared: [], disappeared: [] };

  const [existing] = await connection.query(
    `SELECT ${BASELINE_COLUMNS}
       FROM portal_records
      WHERE org_id = ? AND source = ? AND tax_period IN (?)`,
    [orgId, source, [...periods]]
  );

  const baseline = new Map(existing.map((row) => [row.identity_key, row]));
  const incoming = new Map(records.map((record) => [record.identityKey, record]));

  // A first upload has nothing to diff against. Every row would be NEW, which is
  // 400 rows of "this file contains this file" — noise, and it would bury the two
  // real changes in the next upload. The record list itself is the report for a
  // first sighting.
  const isReingest = baseline.size > 0;

  const changes = [];
  const reappeared = [];
  const disappeared = [];

  for (const record of records) {
    const previous = baseline.get(record.identityKey);

    if (!previous) {
      if (isReingest) changes.push({ identityKey: record.identityKey, changeType: 'NEW', record });
      continue;
    }

    if (previous.absent_since) {
      reappeared.push(previous.id);
      changes.push(describeChange('REAPPEARED', previous, record));
    }

    if (previous.content_hash !== record.contentHash) {
      changes.push(describeChange('AMENDED', previous, record));
    }

    // Independent of the hash: filing_status is not one of its inputs, so a
    // supplier who files an unchanged saved record changes nothing else.
    const wasStatus = previous.filing_status ?? null;
    const nowStatus = record.filingStatus ?? null;
    if (wasStatus !== nowStatus && !(wasStatus === null && nowStatus === null)) {
      changes.push(describeChange('STATUS_CHANGE', previous, record));
    }
  }

  const gone = [];
  for (const [identityKey, previous] of baseline) {
    if (incoming.has(identityKey)) continue;
    // Already known to be gone. Reporting it again on every upload would make the
    // feed grow without anything new having happened.
    if (previous.absent_since) continue;
    disappeared.push(previous.id);
    gone.push(previous);
  }

  // A withdrawn record leaves reconciliation, and its result with it, on the next
  // rebuild. The decision the trader had made about it is written into the change
  // now, while it can still be read, so the feed can keep saying whose decision
  // the withdrawal cost.
  const decisions = await decisionsOn(connection, orgId, disappeared);
  for (const previous of gone) {
    const change = describeChange('DISAPPEARED', previous, null);
    change.oldValues.decision = decisions.get(previous.id) ?? null;
    changes.push(change);
  }

  return { changes, reappeared, disappeared };
}

// portal record id -> the IMS decision (A/R/P) recorded on its current result.
async function decisionsOn(connection, orgId, portalRecordIds) {
  if (!portalRecordIds.length) return new Map();
  const [rows] = await connection.query(
    `SELECT portal_record_id, confirmed_action FROM match_results
      WHERE org_id = ? AND portal_record_id IN (?)
        AND confirmed_action IN ('ACCEPT', 'REJECT', 'PENDING')`,
    [orgId, portalRecordIds]
  );
  return new Map(rows.map((row) => [row.portal_record_id, row.confirmed_action]));
}

// old/new snapshots plus the per-field diff. `record` is null for DISAPPEARED:
// there is no new side, and the old side IS the report.
function describeChange(changeType, previous, record) {
  const oldValues = snapshotOf(previous);
  const newValues = record ? incomingSnapshot(record) : null;

  const fields = [];
  if (newValues) {
    for (const { field, money } of TRACKED_FIELDS) {
      const before = oldValues[field] ?? null;
      const after = newValues[field] ?? null;
      if (before === after) continue;
      fields.push({
        field,
        oldValue: before,
        newValue: after,
        delta: money ? Number(after ?? 0) - Number(before ?? 0) : null
      });
    }
    if (oldValues.filingStatus !== newValues.filingStatus) {
      fields.push({
        field: 'filingStatus',
        oldValue: oldValues.filingStatus,
        newValue: newValues.filingStatus,
        delta: null
      });
    }
  }

  const deltaOf = (name) =>
    newValues ? Number(newValues[name] ?? 0) - Number(oldValues[name] ?? 0) : null;

  return {
    portalRecordId: previous.id,
    identityKey: previous.identity_key,
    changeType,
    oldContentHash: previous.content_hash,
    newContentHash: record?.contentHash ?? null,
    oldValues,
    newValues,
    // A STATUS_CHANGE row carries only the status field even when the same upload
    // also amended the record — the AMENDED row is where the money moved.
    changedFields: changeType === 'STATUS_CHANGE'
      ? fields.filter((entry) => entry.field === 'filingStatus')
      : fields.filter((entry) => entry.field !== 'filingStatus'),
    deltaTaxableValue: changeType === 'STATUS_CHANGE' ? null : deltaOf('taxableValue'),
    deltaTotalTax: changeType === 'STATUS_CHANGE' ? null : deltaOf('totalTax')
  };
}

function snapshotOf(row) {
  const out = { filingStatus: row.filing_status ?? null, imsAction: row.ims_action ?? null };
  for (const { field, column, money } of TRACKED_FIELDS) {
    out[field] = money ? Number(row[column] ?? 0) : row[column] ?? null;
  }
  return out;
}

function incomingSnapshot(record) {
  const out = { filingStatus: record.filingStatus ?? null, imsAction: record.imsAction ?? null };
  for (const { field, money } of TRACKED_FIELDS) {
    out[field] = money ? Number(record[field] ?? 0) : record[field] ?? null;
  }
  return out;
}

// --- writing (runs AFTER the upsert) ---------------------------------------

// Persists the plan and moves the absent flags. NEW changes have no
// portal_record_id until now, so they are resolved by identity_key here.
export async function writePortalDiff(connection, { orgId, uploadId, plan }) {
  const { changes, reappeared, disappeared } = plan;
  if (!changes.length && !reappeared.length && !disappeared.length) return 0;

  if (disappeared.length) {
    await connection.query(
      `UPDATE portal_records SET absent_since = NOW()
        WHERE org_id = ? AND id IN (?) AND absent_since IS NULL`,
      [orgId, disappeared]
    );
  }
  if (reappeared.length) {
    await connection.query(
      'UPDATE portal_records SET absent_since = NULL WHERE org_id = ? AND id IN (?)',
      [orgId, reappeared]
    );
  }

  const pending = changes.filter((change) => !change.portalRecordId);
  if (pending.length) {
    const keys = pending.map((change) => change.identityKey);
    const idByKey = new Map();
    for (let i = 0; i < keys.length; i += 500) {
      const [rows] = await connection.query(
        'SELECT id, identity_key FROM portal_records WHERE org_id = ? AND identity_key IN (?)',
        [orgId, keys.slice(i, i + 500)]
      );
      for (const row of rows) idByKey.set(row.identity_key, row.id);
    }
    for (const change of pending) {
      change.portalRecordId = idByKey.get(change.identityKey) ?? null;
      if (change.newValues === undefined) change.newValues = incomingSnapshot(change.record);
    }
  }

  const rows = changes
    .filter((change) => change.portalRecordId)
    .map((change) => [
      orgId,
      change.portalRecordId,
      change.changeType,
      change.oldContentHash ?? null,
      change.newContentHash ?? (change.record?.contentHash ?? null),
      change.oldValues ? JSON.stringify(change.oldValues) : null,
      change.newValues ? JSON.stringify(change.newValues) : null,
      change.changedFields ? JSON.stringify(change.changedFields) : null,
      change.deltaTaxableValue ?? null,
      change.deltaTotalTax ?? null,
      uploadId
    ]);

  if (!rows.length) return 0;

  await insertInChunks(
    connection,
    `INSERT INTO record_changes
       (org_id, portal_record_id, change_type, old_content_hash, new_content_hash,
        old_values, new_values, changed_fields, delta_taxable_value, delta_total_tax,
        detected_from_upload_id)
     VALUES ?`,
    rows
  );
  return rows.length;
}

// --- reading ---------------------------------------------------------------

// The change feed for one run: everything that moved on the portal records this
// run could have shown, most recent first.
//
// A run is scoped to a tax period, and the matcher's blocking window reaches one
// month either side (see reconcile.periodWindow), so the feed covers the same
// three periods. Anything narrower would drop a change on a record the run
// actually matched against.
export async function listChangesForRun(orgId, runId, { limit = 200 } = {}) {
  const [runRows] = await pool.query(
    'SELECT id, tax_period FROM runs WHERE org_id = ? AND id = ?',
    [orgId, runId]
  );
  if (!runRows.length) throw new ServiceError('run not found', 404, 'not_found');
  const taxPeriod = runRows[0].tax_period;

  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);

  const [rows] = await pool.query(
    `SELECT rc.id, rc.change_type, rc.old_content_hash, rc.new_content_hash,
            rc.old_values, rc.new_values, rc.changed_fields,
            rc.delta_taxable_value, rc.delta_total_tax,
            rc.detected_from_upload_id, rc.created_at,
            pr.id AS portal_record_id, pr.source, pr.section, pr.supplier_gstin,
            pr.supplier_name, pr.invoice_no, pr.invoice_date, pr.doc_type,
            pr.tax_period, pr.filing_status, pr.ims_action, pr.absent_since,
            pr.taxable_value, pr.total_tax,
            u.original_filename, u.kind AS upload_kind,
            mr.id AS result_id, mr.bucket, mr.recommended_action, mr.confirmed_action,
            mr.confirmed_at, mr.flags, mr.signed_itc
       FROM record_changes rc
       JOIN portal_records pr ON pr.id = rc.portal_record_id
       LEFT JOIN uploads u ON u.id = rc.detected_from_upload_id
       LEFT JOIN match_results mr
              ON mr.org_id = rc.org_id AND mr.run_id = ? AND mr.portal_record_id = pr.id
      WHERE rc.org_id = ? AND pr.tax_period IN (?)
      ORDER BY rc.id DESC
      LIMIT ?`,
    [runId, orgId, periodWindow(taxPeriod), capped]
  );

  const changes = rows.map(toChangeView);
  const counts = {};
  let invalidatedCount = 0;
  let invalidatedItc = 0;
  for (const change of changes) {
    counts[change.changeType] = (counts[change.changeType] ?? 0) + 1;
    if (change.review.invalidatedDecision) {
      invalidatedCount += 1;
      invalidatedItc += change.review.signedItc ?? 0;
    }
  }

  return {
    runId: Number(runId),
    taxPeriod,
    total: changes.length,
    counts,
    invalidatedCount,
    invalidatedItc,
    changes
  };
}

// Same ±1 month window the matcher blocks on.
function periodWindow(taxPeriod) {
  const [year, month] = String(taxPeriod).split('-').map(Number);
  const shift = (delta) => {
    const index = year * 12 + (month - 1) + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  };
  return [shift(-1), taxPeriod, shift(1)];
}

function toChangeView(row) {
  const flags = parseJson(row.flags) ?? [];
  const confirmationReset = flags.includes('CONFIRMATION_RESET');
  const changeType = canonicalChangeType(row.change_type);

  // Two ways a decision stops applying, and the UI has to shout about both:
  //   * the run rebuild already dropped it — carryForward() saw the content_hash
  //     move and flagged CONFIRMATION_RESET.
  //   * the record was DELETED from the portal while still carrying a decision.
  //     The rebuild takes the record out of the run (loadPortal), result and all,
  //     so the decision is read from the change itself, written when the
  //     withdrawal was detected (planPortalDiff) — or from the result, on a run
  //     not rebuilt since.
  const oldValues = parseJson(row.old_values);
  const decisionWithdrawn = changeType === 'DISAPPEARED' ? oldValues?.decision ?? null : null;
  const confirmedAction = row.confirmed_action ?? decisionWithdrawn;
  const invalidatedDecision =
    confirmationReset || (changeType === 'DISAPPEARED' && Boolean(confirmedAction));

  return {
    id: row.id,
    changeType,
    // The stored name when it differs, so a row written by phase 4 is not silently
    // relabelled in a feed someone is reading as an audit trail.
    storedChangeType: row.change_type === changeType ? null : row.change_type,
    detectedAt: row.created_at,
    detectedFrom: row.detected_from_upload_id
      ? {
          uploadId: row.detected_from_upload_id,
          kind: row.upload_kind,
          filename: row.original_filename
        }
      : null,
    record: {
      id: row.portal_record_id,
      source: row.source,
      section: row.section,
      supplierGstin: row.supplier_gstin,
      supplierName: row.supplier_name,
      invoiceNo: row.invoice_no,
      invoiceDate: row.invoice_date,
      docType: row.doc_type,
      taxPeriod: row.tax_period,
      filingStatus: row.filing_status,
      imsAction: row.ims_action,
      taxableValue: Number(row.taxable_value ?? 0),
      totalTax: Number(row.total_tax ?? 0),
      absentSince: row.absent_since
    },
    fields: (parseJson(row.changed_fields) ?? []).map((entry) => ({
      field: entry.field,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      delta: entry.delta ?? null
    })),
    // Paise, signed new - old. Null when the change did not touch money.
    deltaTaxableValue: row.delta_taxable_value === null ? null : Number(row.delta_taxable_value),
    deltaTotalTax: row.delta_total_tax === null ? null : Number(row.delta_total_tax),
    oldValues,
    newValues: parseJson(row.new_values),
    review: {
      resultId: row.result_id ?? null,
      bucket: row.bucket ?? null,
      recommendedAction: row.recommended_action ?? null,
      confirmedAction,
      confirmedAt: row.confirmed_at ?? null,
      signedItc: row.signed_itc === null || row.signed_itc === undefined
        ? null
        : Number(row.signed_itc),
      // Did a human ever decide anything here? Drives loud vs quiet in the UI.
      reviewed: Boolean(confirmedAction) || confirmationReset,
      confirmationReset,
      invalidatedDecision
    }
  };
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
