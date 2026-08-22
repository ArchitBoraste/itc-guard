// Reconciliation run: load a period's books and portal rows, hand them to the
// PURE matching engine, persist the run and its results.
//
// src/matching/** never learns that a database exists — this service is the only
// place the two meet.
//
// IDEMPOTENCY — chosen strategy: REPLACE, not version.
//   One current run per (org_id, tax_period), enforced by uq_runs_org_period.
//   Re-running the period updates that row in place and deletes/reinserts its
//   match_results inside a single transaction, so row counts stay constant no
//   matter how many times it runs. Versioning would be the better audit trail,
//   but it makes "how many exceptions are open right now" a query over the latest
//   run rather than a plain count, and for a prototype whose whole point is a
//   clear action list, replace is the honest trade.
//
//   Human decisions survive the rebuild — but only while they still apply. A
//   confirmed_action is carried across by result identity AND revalidated against
//   the portal content_hash and bucket it was made about; see carryForward().
import { pool } from '../db/pool.js';
import { insertInChunks, withTransaction } from '../db/tx.js';
import { ENGINE_VERSION, reconcile as matchReconcile } from '../matching/index.js';
import { cutoffDate, FILING_SCHEMES } from '../matching/cutoff.js';
import { ServiceError } from './ingest.js';
import { assertTotalsBalance, computeRunTotals, itcSign, totalBucketFor } from './totals.js';
import { supplierSchemeMap } from './supplierStats.js';

export const RUN_MODES = Object.freeze(['PREVENTIVE', 'REACTIVE']);

// --- loading ---------------------------------------------------------------

// Candidates come from the tax period and its immediate neighbours, matching the
// engine's ±1 month blocking window: a supplier reporting a late invoice files it
// in the next period.
function periodWindow(taxPeriod) {
  const [year, month] = taxPeriod.split('-').map(Number);
  const shift = (delta) => {
    const index = year * 12 + (month - 1) + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  };
  return [shift(-1), taxPeriod, shift(1)];
}

export async function loadExpected(orgId, taxPeriod) {
  const [rows] = await pool.query(
    `SELECT id, supplier_gstin, supplier_name, doc_type, supply_type, invoice_no,
            invoice_no_norm, invoice_date, tax_period, place_of_supply,
            taxable_value, igst, cgst, sgst, cess, total_tax, invoice_value,
            reverse_charge, itc_eligibility, original_invoice_no,
            original_invoice_date, identity_key
       FROM expected_invoices
      WHERE org_id = ? AND tax_period = ?
      ORDER BY id`,
    [orgId, taxPeriod]
  );
  return rows.map(toExpectedShape);
}

export async function loadPortal(orgId, taxPeriod) {
  const [rows] = await pool.query(
    `SELECT id, source, section, supplier_gstin, supplier_name, doc_type, supply_type,
            invoice_no, invoice_no_norm, invoice_date, tax_period, place_of_supply,
            taxable_value, igst, cgst, sgst, cess, total_tax, invoice_value,
            reverse_charge, itc_available, itc_ineligible_reason, supplier_filed_on,
            counterparty_filing_status, supplier_return_period, differential_percent,
            filing_status, ims_action, pending_blocked, remarks_blocked,
            itc_reduction_blocked, original_invoice_no, original_invoice_date,
            port_code, source_form, content_hash, identity_key
       FROM portal_records
      WHERE org_id = ? AND tax_period IN (?)
      ORDER BY id`,
    [orgId, periodWindow(taxPeriod)]
  );
  return rows.map(toPortalShape);
}

// DB row -> the canonical shapes the engine expects. camelCase, integer paise,
// real booleans, ISO date strings (the pool is configured with dateStrings).
function toExpectedShape(row) {
  return {
    id: row.id,
    supplierGstin: row.supplier_gstin,
    supplierName: row.supplier_name,
    docType: row.doc_type,
    supplyType: row.supply_type,
    invoiceNo: row.invoice_no,
    invoiceNoNorm: row.invoice_no_norm,
    invoiceDate: row.invoice_date,
    taxPeriod: row.tax_period,
    placeOfSupply: row.place_of_supply,
    taxableValue: Number(row.taxable_value),
    igst: Number(row.igst),
    cgst: Number(row.cgst),
    sgst: Number(row.sgst),
    cess: Number(row.cess),
    totalTax: Number(row.total_tax),
    invoiceValue: row.invoice_value === null ? null : Number(row.invoice_value),
    reverseCharge: Boolean(row.reverse_charge),
    itcEligibility: row.itc_eligibility,
    originalInvoiceNo: row.original_invoice_no,
    originalInvoiceDate: row.original_invoice_date,
    identityKey: row.identity_key,
    rateLines: []
  };
}

function toPortalShape(row) {
  return {
    id: row.id,
    source: row.source,
    section: row.section,
    supplierGstin: row.supplier_gstin,
    supplierName: row.supplier_name,
    docType: row.doc_type,
    supplyType: row.supply_type,
    invoiceNo: row.invoice_no,
    invoiceNoNorm: row.invoice_no_norm,
    invoiceDate: row.invoice_date,
    taxPeriod: row.tax_period,
    placeOfSupply: row.place_of_supply,
    taxableValue: Number(row.taxable_value),
    igst: Number(row.igst),
    cgst: Number(row.cgst),
    sgst: Number(row.sgst),
    cess: Number(row.cess),
    totalTax: Number(row.total_tax),
    invoiceValue: row.invoice_value === null ? null : Number(row.invoice_value),
    reverseCharge: Boolean(row.reverse_charge),
    itcAvailable: row.itc_available === null ? null : Boolean(row.itc_available),
    itcIneligibleReason: row.itc_ineligible_reason,
    supplierFiledOn: row.supplier_filed_on,
    counterpartyFilingStatus: row.counterparty_filing_status,
    supplierReturnPeriod: row.supplier_return_period,
    differentialPercent:
      row.differential_percent === null ? null : Number(row.differential_percent),
    filingStatus: row.filing_status,
    imsAction: row.ims_action,
    pendingBlocked: Boolean(row.pending_blocked),
    remarksBlocked: Boolean(row.remarks_blocked),
    itcReductionBlocked: Boolean(row.itc_reduction_blocked),
    originalInvoiceNo: row.original_invoice_no,
    originalInvoiceDate: row.original_invoice_date,
    portCode: row.port_code,
    sourceForm: row.source_form,
    contentHash: row.content_hash,
    identityKey: row.identity_key,
    rateLines: []
  };
}

// --- run -------------------------------------------------------------------

// createRun({ orgId, taxPeriod, mode, asOfDate }) -> run summary
export async function createRun({
  orgId,
  taxPeriod,
  mode = 'REACTIVE',
  asOfDate = null,
  filingScheme = FILING_SCHEMES.MONTHLY,
  engineOptions = {}
}) {
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod ?? ''))) {
    throw new ServiceError('taxPeriod must be YYYY-MM');
  }
  if (!RUN_MODES.includes(mode)) {
    throw new ServiceError(`mode must be one of ${RUN_MODES.join(', ')}`);
  }

  const [expected, portal, schemeMap] = await Promise.all([
    loadExpected(orgId, taxPeriod),
    loadPortal(orgId, taxPeriod),
    supplierSchemeMap(orgId)
  ]);

  if (!expected.length && !portal.length) {
    throw new ServiceError(
      `nothing to reconcile for ${taxPeriod} — commit a purchase register and an IMS or 2B file first`,
      409,
      'conflict'
    );
  }

  const allResults = matchReconcile(expected, portal, {
    ...engineOptions,
    taxPeriod,
    asOfDate,
    filingScheme
  });

  // The ±1 month window exists so a books row can match a portal record the
  // supplier reported late, in the neighbouring period. It is a CANDIDATE window,
  // not a reporting window: an unmatched portal record from another period belongs
  // to that period's run, not this one. Without this filter, every neighbouring
  // period's portal rows would surface here as MISSING_IN_BOOKS — hundreds of
  // phantom exceptions that grow as more periods are loaded.
  const results = allResults.filter(
    (result) => result.expected || result.portal?.taxPeriod === taxPeriod
  );

  const schemeFor = (gstin) => schemeMap.get(gstin) ?? null;
  const totals = computeRunTotals(results, { asOfDate, taxPeriod, filingScheme, schemeFor });
  // If this throws, a bucket has no home in the total mapping. Fix the
  // classification, never the arithmetic.
  assertTotalsBalance(totals);

  return withTransaction(async (connection) => {
    const runId = await upsertRunRow(connection, {
      orgId, taxPeriod, mode, asOfDate, filingScheme, totals, engineOptions
    });

    // Carry human decisions across the rebuild, keyed on the pair identity rather
    // than on row ids, which are about to change.
    const confirmed = await loadConfirmedActions(connection, orgId, runId);

    await connection.query('DELETE FROM match_results WHERE org_id = ? AND run_id = ?', [
      orgId,
      runId
    ]);
    await insertResults(connection, orgId, runId, totals, confirmed);

    await connection.query(
      `UPDATE runs SET status = 'COMPLETED', finished_at = NOW() WHERE id = ?`,
      [runId]
    );

    return runId;
  }).then((runId) => getRun(orgId, runId));
}

async function upsertRunRow(connection, {
  orgId, taxPeriod, mode, asOfDate, filingScheme, totals, engineOptions
}) {
  const summary = JSON.stringify({
    bucketCounts: totals.bucketCounts,
    totalCounts: totals.totalCounts
  });
  const thresholds = JSON.stringify({
    weights: engineOptions.weights ?? null,
    thresholds: engineOptions.thresholds ?? null
  });

  const [result] = await connection.query(
    `INSERT INTO runs
       (org_id, tax_period, mode, as_of_date, filing_scheme, cut_off_date, status,
        engine_version, thresholds, summary, expected_total_itc, claimable_itc,
        at_risk_itc, deferred_itc, ineligible_itc, non_ims_itc, grand_total_itc,
        started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       mode = VALUES(mode), as_of_date = VALUES(as_of_date),
       filing_scheme = VALUES(filing_scheme), cut_off_date = VALUES(cut_off_date),
       status = 'RUNNING', engine_version = VALUES(engine_version),
       thresholds = VALUES(thresholds), summary = VALUES(summary),
       expected_total_itc = VALUES(expected_total_itc),
       claimable_itc = VALUES(claimable_itc), at_risk_itc = VALUES(at_risk_itc),
       deferred_itc = VALUES(deferred_itc), ineligible_itc = VALUES(ineligible_itc),
       non_ims_itc = VALUES(non_ims_itc), grand_total_itc = VALUES(grand_total_itc),
       started_at = NOW(), finished_at = NULL, error_message = NULL,
       id = LAST_INSERT_ID(id)`,
    [
      orgId, taxPeriod, mode, asOfDate, filingScheme, cutoffDate(taxPeriod, filingScheme),
      ENGINE_VERSION,
      thresholds, summary,
      totals.expectedTotalItc, totals.claimableItc, totals.atRiskItc,
      totals.deferredItc, totals.ineligibleItc, totals.nonImsItc, totals.grandTotalItc
    ]
  );
  return result.insertId;
}

// A rebuilt run must not silently discard a decision the trader already made.
// Keyed on (expected_invoice_id, portal_record_id) — stable across the delete.
async function loadConfirmedActions(connection, orgId, runId) {
  const [rows] = await connection.query(
    `SELECT expected_invoice_id, portal_record_id, confirmed_action, confirmed_by,
            confirmed_at, confirmed_content_hash, confirmed_bucket, remarks
       FROM match_results
      WHERE org_id = ? AND run_id = ? AND confirmed_action IS NOT NULL`,
    [orgId, runId]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.expected_invoice_id ?? ''}:${row.portal_record_id ?? ''}`, row);
  }
  return map;
}

// Flag added when a decision is dropped because the record it was about changed.
export const CONFIRMATION_RESET = 'CONFIRMATION_RESET';

// A confirmation survives the rebuild only if it is still a decision about the
// SAME thing: same portal content, same bucket. A supplier who corrects a value
// has produced a different record, and IMS resets the recipient's action in
// exactly that situation — carrying a stale REJECT onto a now-clean match would
// reject an invoice the trader already agreed with.
function carryForward(previous, result) {
  if (!previous) return { confirmation: null, stale: false };

  const currentHash = result.portal?.contentHash ?? null;
  const contentUnchanged = (previous.confirmed_content_hash ?? null) === currentHash;
  const bucketUnchanged = (previous.confirmed_bucket ?? null) === result.bucket;

  if (contentUnchanged && bucketUnchanged) return { confirmation: previous, stale: false };
  return { confirmation: null, stale: true };
}

async function insertResults(connection, orgId, runId, totals, confirmed) {
  const rows = totals.perResult.map(({ result, signedItc, totalBucket }) => {
    const key = `${result.expected?.id ?? ''}:${result.portal?.id ?? ''}`;
    const { confirmation, stale } = carryForward(confirmed.get(key), result);

    const flags = [...(result.flags ?? [])];
    if (stale && !flags.includes(CONFIRMATION_RESET)) flags.push(CONFIRMATION_RESET);

    return [
      orgId,
      runId,
      result.expected?.id ?? null,
      result.portal?.id ?? null,
      result.bucket,
      result.score,
      result.matchedVia,
      result.scoreBreakdown ? JSON.stringify(result.scoreBreakdown) : null,
      JSON.stringify(flags),
      result.recommendedAction,
      result.recommendationReason,
      // Remarks follow the decision: a dropped confirmation reverts to the
      // engine's own remark rather than keeping the one written for the old value.
      confirmation?.remarks ?? result.remarks,
      result.deltaTaxableValue,
      result.deltaTotalTax,
      // itc_impact is the rupee consequence of this one result, signed so a credit
      // note reads as the reduction it is.
      itcSign(result.expected?.docType ?? result.portal?.docType) * (result.itcAtRisk ?? 0),
      signedItc,
      totalBucket,
      confirmation?.confirmed_action ?? null,
      confirmation?.confirmed_by ?? null,
      confirmation?.confirmed_at ?? null,
      confirmation?.confirmed_content_hash ?? null,
      confirmation?.confirmed_bucket ?? null
    ];
  });

  if (!rows.length) return;
  await insertInChunks(
    connection,
    `INSERT INTO match_results
       (org_id, run_id, expected_invoice_id, portal_record_id, bucket, score,
        matched_via, score_breakdown, flags, recommended_action,
        recommendation_reason, remarks, delta_taxable_value, delta_total_tax,
        itc_impact, signed_itc, total_bucket, confirmed_action, confirmed_by,
        confirmed_at, confirmed_content_hash, confirmed_bucket)
     VALUES ?`,
    rows
  );
}

// --- reading ---------------------------------------------------------------

export async function getRun(orgId, runId) {
  const [rows] = await pool.query(
    `SELECT id, org_id, tax_period, mode, as_of_date, filing_scheme, cut_off_date,
            status, engine_version, thresholds, summary, expected_total_itc,
            claimable_itc, at_risk_itc, deferred_itc, ineligible_itc, non_ims_itc,
            grand_total_itc, started_at, finished_at, created_at
       FROM runs WHERE org_id = ? AND id = ?`,
    [orgId, runId]
  );
  if (!rows.length) throw new ServiceError('run not found', 404, 'not_found');
  const run = rows[0];

  const [counts] = await pool.query(
    `SELECT bucket, COUNT(*) AS n, SUM(signed_itc) AS itc
       FROM match_results WHERE org_id = ? AND run_id = ?
      GROUP BY bucket`,
    [orgId, runId]
  );

  const bucketCounts = {};
  const bucketItc = {};
  for (const row of counts) {
    bucketCounts[row.bucket] = Number(row.n);
    bucketItc[row.bucket] = Number(row.itc ?? 0);
  }

  const totalsBreakdown = await runTotalsBreakdown(orgId, runId);

  return {
    id: run.id,
    taxPeriod: run.tax_period,
    mode: run.mode,
    asOfDate: run.as_of_date,
    filingScheme: run.filing_scheme,
    cutOffDate: run.cut_off_date,
    status: run.status,
    engineVersion: run.engine_version,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    createdAt: run.created_at,
    bucketCounts,
    bucketItc,
    // All paise. Formatting is the UI's job.
    totals: {
      expectedTotalItc: Number(run.expected_total_itc),
      claimableItc: Number(run.claimable_itc),
      atRiskItc: Number(run.at_risk_itc),
      deferredItc: Number(run.deferred_itc),
      ineligibleItc: Number(run.ineligible_itc),
      nonImsItc: Number(run.non_ims_itc),
      grandTotalItc: Number(run.grand_total_itc)
    },
    totalsBreakdown,
    summary: parseJsonColumn(run.summary)
  };
}

// Splits each run total by document type, so a NEGATIVE total is explicable
// rather than alarming.
//
// 2026-04's deferred total is -Rs 5,577.37. That is not a broken number: it is a
// credit note the supplier never reported, so a reduction the trader is already
// carrying in their books has not yet reached the portal. Without this split the
// UI can only render "Deferred: -Rs 5,577.37", which reads like a bug. With it,
// the UI can say "1 unreported credit note" and show the reduction as pending.
export async function runTotalsBreakdown(orgId, runId) {
  const [rows] = await pool.query(
    `SELECT mr.total_bucket AS total_bucket,
            COALESCE(ei.doc_type, pr.doc_type) AS doc_type,
            COUNT(*) AS n,
            SUM(mr.signed_itc) AS itc
       FROM match_results mr
       LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ?
      GROUP BY mr.total_bucket, COALESCE(ei.doc_type, pr.doc_type)`,
    [orgId, runId]
  );

  const breakdown = {};
  for (const row of rows) {
    const key = row.total_bucket ?? 'UNASSIGNED';
    const entry = (breakdown[key] ??= {
      itc: 0,
      count: 0,
      creditNotes: { itc: 0, count: 0 },
      otherDocuments: { itc: 0, count: 0 },
      byDocType: {}
    });

    const itc = Number(row.itc ?? 0);
    const count = Number(row.n);
    const docType = row.doc_type ?? 'UNKNOWN';

    entry.itc += itc;
    entry.count += count;
    entry.byDocType[docType] = { itc, count };

    // Credit notes carry negative ITC by construction — see services/totals.js.
    const side = docType === 'CREDIT_NOTE' || docType === 'ISD_CREDIT'
      ? entry.creditNotes
      : entry.otherDocuments;
    side.itc += itc;
    side.count += count;
  }
  return breakdown;
}

// Every period that has been reconciled, newest first. The period switcher needs
// this: without it the UI can only guess which periods have runs by probing.
export async function listRuns(orgId, { limit = 36 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, tax_period, mode, as_of_date, filing_scheme, cut_off_date, status,
            expected_total_itc, claimable_itc, at_risk_itc, deferred_itc,
            ineligible_itc, non_ims_itc, grand_total_itc, finished_at
       FROM runs WHERE org_id = ?
      ORDER BY tax_period DESC
      LIMIT ?`,
    [orgId, Math.min(Math.max(Number(limit) || 36, 1), 200)]
  );
  return rows.map((run) => ({
    id: run.id,
    taxPeriod: run.tax_period,
    mode: run.mode,
    asOfDate: run.as_of_date,
    filingScheme: run.filing_scheme,
    cutOffDate: run.cut_off_date,
    status: run.status,
    finishedAt: run.finished_at,
    totals: {
      expectedTotalItc: Number(run.expected_total_itc),
      claimableItc: Number(run.claimable_itc),
      atRiskItc: Number(run.at_risk_itc),
      deferredItc: Number(run.deferred_itc),
      ineligibleItc: Number(run.ineligible_itc),
      nonImsItc: Number(run.non_ims_itc),
      grandTotalItc: Number(run.grand_total_itc)
    }
  }));
}

export async function getRunByPeriod(orgId, taxPeriod) {
  const [rows] = await pool.query(
    'SELECT id FROM runs WHERE org_id = ? AND tax_period = ?',
    [orgId, taxPeriod]
  );
  return rows.length ? getRun(orgId, rows[0].id) : null;
}

export async function listResults(orgId, runId, { bucket = null, page = 1, pageSize = 50 } = {}) {
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const where = ['mr.org_id = ?', 'mr.run_id = ?'];
  const params = [orgId, runId];
  if (bucket) {
    where.push('mr.bucket = ?');
    params.push(bucket);
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS n FROM match_results mr WHERE ${where.join(' AND ')}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT mr.id, mr.bucket, mr.score, mr.matched_via, mr.score_breakdown, mr.flags,
            mr.recommended_action, mr.recommendation_reason, mr.remarks,
            mr.delta_taxable_value, mr.delta_total_tax, mr.itc_impact, mr.signed_itc,
            mr.total_bucket, mr.confirmed_action, mr.confirmed_at,
            ei.invoice_no  AS books_invoice_no,
            ei.invoice_date AS books_invoice_date,
            ei.supplier_gstin AS books_supplier_gstin,
            ei.supplier_name AS books_supplier_name,
            ei.doc_type AS books_doc_type,
            ei.taxable_value AS books_taxable_value,
            ei.total_tax AS books_total_tax,
            pr.invoice_no AS portal_invoice_no,
            pr.invoice_date AS portal_invoice_date,
            pr.supplier_gstin AS portal_supplier_gstin,
            pr.supplier_name AS portal_supplier_name,
            pr.doc_type AS portal_doc_type,
            pr.section AS portal_section,
            pr.source AS portal_source,
            pr.taxable_value AS portal_taxable_value,
            pr.total_tax AS portal_total_tax,
            pr.filing_status, pr.ims_action, pr.pending_blocked, pr.remarks_blocked,
            pr.itc_available, pr.itc_ineligible_reason, pr.supplier_filed_on
       FROM match_results mr
       LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE ${where.join(' AND ')}
      ORDER BY FIELD(mr.bucket,'VALUE_MISMATCH','MISSING_IN_BOOKS','SUGGESTED',
                     'MISSING_IN_PORTAL','INELIGIBLE','NON_IMS','MATCHED'),
               ABS(mr.signed_itc) DESC, mr.id
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    total: Number(countRows[0].n),
    page: Math.max(Number(page) || 1, 1),
    pageSize: limit,
    results: rows.map(toResultView)
  };
}

function toResultView(row) {
  return {
    id: row.id,
    bucket: row.bucket,
    score: row.score === null ? null : Number(row.score),
    matchedVia: row.matched_via,
    scoreBreakdown: parseJsonColumn(row.score_breakdown),
    flags: parseJsonColumn(row.flags) ?? [],
    recommendedAction: row.recommended_action,
    recommendationReason: row.recommendation_reason,
    remarks: row.remarks,
    deltaTaxableValue: row.delta_taxable_value === null ? null : Number(row.delta_taxable_value),
    deltaTotalTax: row.delta_total_tax === null ? null : Number(row.delta_total_tax),
    itcImpact: row.itc_impact === null ? null : Number(row.itc_impact),
    signedItc: Number(row.signed_itc ?? 0),
    totalBucket: row.total_bucket,
    confirmedAction: row.confirmed_action,
    confirmedAt: row.confirmed_at,
    books: row.books_invoice_no === null ? null : {
      invoiceNo: row.books_invoice_no,
      invoiceDate: row.books_invoice_date,
      supplierGstin: row.books_supplier_gstin,
      supplierName: row.books_supplier_name,
      docType: row.books_doc_type,
      taxableValue: Number(row.books_taxable_value),
      totalTax: Number(row.books_total_tax)
    },
    portal: row.portal_invoice_no === null ? null : {
      invoiceNo: row.portal_invoice_no,
      invoiceDate: row.portal_invoice_date,
      supplierGstin: row.portal_supplier_gstin,
      supplierName: row.portal_supplier_name,
      docType: row.portal_doc_type,
      section: row.portal_section,
      source: row.portal_source,
      taxableValue: Number(row.portal_taxable_value),
      totalTax: Number(row.portal_total_tax),
      filingStatus: row.filing_status,
      imsAction: row.ims_action,
      pendingBlocked: Boolean(row.pending_blocked),
      remarksBlocked: Boolean(row.remarks_blocked),
      itcAvailable: row.itc_available === null ? null : Boolean(row.itc_available),
      itcIneligibleReason: row.itc_ineligible_reason,
      supplierFiledOn: row.supplier_filed_on
    }
  };
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// --- confirming a decision -------------------------------------------------

const CONFIRMABLE = new Set(['ACCEPT', 'REJECT', 'PENDING', 'NO_ACTION']);

// The trader's decision. Rejected outright when the record's IMS blocked flags
// forbid it: the portal refuses the entire upload over one bad record, so this has
// to fail here rather than at submission time.
export async function confirmResult(orgId, resultId, { confirmedAction, userId = null }) {
  const action = String(confirmedAction ?? '').trim().toUpperCase();
  if (!CONFIRMABLE.has(action)) {
    throw new ServiceError(`confirmedAction must be one of ${[...CONFIRMABLE].join(', ')}`);
  }

  const [rows] = await pool.query(
    `SELECT mr.id, mr.run_id, mr.bucket, mr.portal_record_id,
            pr.pending_blocked, pr.remarks_blocked, pr.content_hash,
            pr.section, pr.source, pr.invoice_no
       FROM match_results mr
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.id = ?`,
    [orgId, resultId]
  );
  if (!rows.length) throw new ServiceError('result not found', 404, 'not_found');
  const result = rows[0];

  if (action === 'PENDING' && result.pending_blocked) {
    throw new ServiceError(
      'PENDING is blocked on this record by the portal (ispendactblocked = Y); ' +
        'choose ACCEPT, REJECT or NO_ACTION',
      409,
      'action_blocked'
    );
  }

  // ISD and import records have no IMS row to act on at all.
  if (!result.portal_record_id && result.bucket === 'MISSING_IN_PORTAL' && action !== 'NO_ACTION') {
    throw new ServiceError(
      'no portal record exists for this books row, so there is no IMS action to take',
      409,
      'action_blocked'
    );
  }
  if (['isd', 'isda', 'impg', 'impgsez'].includes(result.section) && action !== 'NO_ACTION') {
    throw new ServiceError(
      `section ${result.section} never enters IMS, so it cannot be actioned`,
      409,
      'action_blocked'
    );
  }

  // Record WHAT the decision was about, so a later rebuild can tell whether it
  // still applies.
  await pool.query(
    `UPDATE match_results
        SET confirmed_action = ?, confirmed_by = ?, confirmed_at = NOW(),
            confirmed_content_hash = ?, confirmed_bucket = ?
      WHERE org_id = ? AND id = ?`,
    [action, userId, result.content_hash ?? null, result.bucket, orgId, resultId]
  );

  // A confirmation can move a result between claimable and at-risk, so the run
  // totals have to be recomputed rather than left stale.
  await recomputeRunTotals(orgId, result.run_id);

  const [updated] = await pool.query(
    'SELECT id, bucket, recommended_action, confirmed_action, confirmed_at FROM match_results WHERE org_id = ? AND id = ?',
    [orgId, resultId]
  );
  return updated[0];
}

// Recomputes the stored totals from persisted results, applying the same
// bucket->total mapping. Reads confirmed_action, so it reflects human decisions.
export async function recomputeRunTotals(orgId, runId) {
  const [runRows] = await pool.query(
    'SELECT tax_period, as_of_date, filing_scheme FROM runs WHERE org_id = ? AND id = ?',
    [orgId, runId]
  );
  if (!runRows.length) throw new ServiceError('run not found', 404, 'not_found');

  const [rows] = await pool.query(
    `SELECT mr.id, mr.bucket, mr.signed_itc, mr.confirmed_action,
            COALESCE(ei.supplier_gstin, pr.supplier_gstin) AS supplier_gstin,
            COALESCE(ei.doc_type, pr.doc_type) AS doc_type
       FROM match_results mr
       LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ?`,
    [orgId, runId]
  );

  const run = runRows[0];
  const schemeMap = await supplierSchemeMap(orgId);

  // signed_itc is already persisted per result, so this re-buckets rather than
  // recomputing money — no re-derivation, no drift.
  const pseudoResults = rows.map((row) => ({
    id: row.id,
    bucket: row.bucket,
    confirmedAction: row.confirmed_action,
    signedItc: Number(row.signed_itc ?? 0),
    expected: { supplierGstin: row.supplier_gstin, taxPeriod: run.tax_period },
    portal: { supplierGstin: row.supplier_gstin, taxPeriod: run.tax_period }
  }));

  const context = {
    asOfDate: run.as_of_date,
    taxPeriod: run.tax_period,
    filingScheme: run.filing_scheme,
    schemeFor: (gstin) => schemeMap.get(gstin) ?? null
  };

  const totals = {
    claimableItc: 0, atRiskItc: 0, deferredItc: 0, ineligibleItc: 0, nonImsItc: 0
  };
  const updates = [];
  for (const result of pseudoResults) {
    const totalBucket = totalBucketFor(result, context);
    updates.push([totalBucket, result.id]);
    switch (totalBucket) {
      case 'CLAIMABLE': totals.claimableItc += result.signedItc; break;
      case 'AT_RISK': totals.atRiskItc += result.signedItc; break;
      case 'DEFERRED': totals.deferredItc += result.signedItc; break;
      case 'INELIGIBLE': totals.ineligibleItc += result.signedItc; break;
      default: totals.nonImsItc += result.signedItc; break;
    }
  }

  const expectedTotalItc =
    totals.claimableItc + totals.atRiskItc + totals.deferredItc + totals.ineligibleItc;
  const grandTotalItc = expectedTotalItc + totals.nonImsItc;
  assertTotalsBalance({ ...totals, expectedTotalItc, grandTotalItc });

  await withTransaction(async (connection) => {
    for (const [totalBucket, id] of updates) {
      await connection.query('UPDATE match_results SET total_bucket = ? WHERE id = ?', [
        totalBucket,
        id
      ]);
    }
    await connection.query(
      `UPDATE runs
          SET expected_total_itc = ?, claimable_itc = ?, at_risk_itc = ?,
              deferred_itc = ?, ineligible_itc = ?, non_ims_itc = ?, grand_total_itc = ?
        WHERE org_id = ? AND id = ?`,
      [
        expectedTotalItc, totals.claimableItc, totals.atRiskItc, totals.deferredItc,
        totals.ineligibleItc, totals.nonImsItc, grandTotalItc, orgId, runId
      ]
    );
  });

  return { ...totals, expectedTotalItc, grandTotalItc };
}
