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
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { insertInChunks, withTransaction } from '../db/tx.js';
import { ENGINE_VERSION, reconcile as matchReconcile } from '../matching/index.js';
import { FLAGS } from '../matching/buckets.js';
import { cutoffDate, filingCalendar, FILING_SCHEMES } from '../matching/cutoff.js';
import { ServiceError } from './ingest.js';
import {
  decisionCategory,
  isImsActionable,
  isImsDecision,
  needsDecision,
  summarizeOpenDecisions
} from './decisions.js';
import {
  allocate,
  assertTotalsBalance,
  computeRunTotals,
  itcSign,
  sumAllocations
} from './totals.js';
import { supplierSchemeMap } from './supplierStats.js';
import { earlierItems } from './carryOver.js';
import { rebuildSupplierStats } from './supplierRisk.js';
import { workspaceAsOf } from './workspaceClock.js';
import { CONTACT_COLUMNS, contactView } from './supplierContacts.js';

export const RUN_MODES = Object.freeze(['PREVENTIVE', 'REACTIVE']);

// Matches recommendation_reason's column width (006_reason_length.sql). Clamped
// rather than trusted: an explanation growing by a sentence must never be able to
// fail an entire run's INSERT.
const REASON_MAX_LENGTH = 512;

// --- loading ---------------------------------------------------------------

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

// The period's own portal records: a record belongs to the period of the upload it
// came from, and no other period's run reads it. An earlier period's document
// arriving late is linked to its own books row instead (loadEarlierRows), so a
// later upload can never change what an earlier period was reconciled against.
//
// A record missing from the latest download of its source is no longer on the
// portal (absent_since, set by syncDiff): it stays in the table for the change
// feed and leaves reconciliation, so a re-upload replaces rather than adds.
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
      WHERE org_id = ? AND tax_period = ? AND absent_since IS NULL
      ORDER BY id`,
    [orgId, taxPeriod]
  );
  return rows.map(toPortalShape);
}

// Every result, in any run, about a books document from a period before
// taxPeriod: each document's result in its own period's run, and any later run's
// link to it. services/carryOver.js reads these: which documents are still open,
// and which a later period has already received. Books columns as loadExpected
// names them, so toExpectedShape() reads a row as the document.
export async function loadEarlierRows(orgId, taxPeriod) {
  const [rows] = await pool.query(
    `SELECT r.tax_period AS run_period, mr.run_id, mr.id AS result_id, mr.bucket,
            mr.recommended_action, mr.recommendation_reason, mr.claimable_itc, mr.signed_itc,
            mr.delta_total_tax, mr.total_bucket, mr.confirmed_action, mr.flags AS result_flags,
            mr.linked_period, mr.linked_via, mr.portal_record_id,
            ei.id, ei.supplier_gstin, ei.supplier_name, ei.doc_type, ei.supply_type,
            ei.invoice_no, ei.invoice_no_norm, ei.invoice_date, ei.tax_period,
            ei.place_of_supply, ei.taxable_value, ei.igst, ei.cgst, ei.sgst, ei.cess,
            ei.total_tax, ei.invoice_value, ei.reverse_charge, ei.itc_eligibility,
            ei.original_invoice_no, ei.original_invoice_date, ei.identity_key,
            pr.source AS portal_source, pr.section AS portal_section,
            pr.filing_status AS portal_filing_status, pr.supplier_gstin AS portal_supplier_gstin,
            pr.invoice_no AS portal_invoice_no, pr.invoice_no_norm AS portal_invoice_no_norm,
            pr.invoice_date AS portal_invoice_date, pr.doc_type AS portal_doc_type,
            pr.taxable_value AS portal_taxable_value, pr.total_tax AS portal_total_tax,
            pr.supplier_filed_on AS portal_filed_on, pr.source_form AS portal_source_form,
            pr.upload_id AS portal_upload_id
       FROM match_results mr
       JOIN runs r ON r.id = mr.run_id AND r.org_id = mr.org_id
       JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND ei.tax_period < ?
      ORDER BY ei.id, r.tax_period`,
    [orgId, taxPeriod]
  );
  return rows;
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
//
// asOfDate defaults to the workspace's date (services/workspaceClock.js), which is
// what every request path uses. Only tools replaying a fixed calendar, like the
// answer-key verifier, pass their own.
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

  const [expected, portal, schemeMap, asOf, earlierRows] = await Promise.all([
    loadExpected(orgId, taxPeriod),
    loadPortal(orgId, taxPeriod),
    supplierSchemeMap(orgId),
    asOfDate ?? workspaceAsOf(orgId),
    loadEarlierRows(orgId, taxPeriod)
  ]);

  if (!expected.length && !portal.length) {
    throw new ServiceError(
      `nothing to reconcile for ${taxPeriod} — commit a purchase register and an IMS or 2B file first`,
      409,
      'conflict'
    );
  }

  // The deployment's materiality tolerance, unless the caller is tuning the engine.
  const tuning = {
    materialityTolerancePaise: config.matching.materialityTolerancePaise,
    ...engineOptions
  };

  // Each supplier's own scheme decides their cut-off; the run's is the default.
  const schemeFor = (gstin) => schemeMap.get(gstin) ?? null;

  // Earlier periods' documents a late record of this period may belong to: open
  // ones (not filed, saved past the cut-off, a value mismatch), and settled ones
  // for an amendment to name by number. One a period in between already received
  // is nobody's any more.
  const earlier = earlierItems(earlierRows, taxPeriod, tuning)
    .filter((item) => !item.closedIn)
    .map((item) => ({
      expected: toExpectedShape(item.row),
      open: item.open,
      claimedItc: Number(item.row.claimable_itc ?? 0)
    }));

  const results = matchReconcile(expected, portal, {
    ...tuning,
    taxPeriod,
    asOfDate: asOf,
    filingScheme,
    schemeFor,
    earlier
  });

  const inputCounts = runInputCounts(expected, portal, taxPeriod);

  return withTransaction(async (connection) => {
    // Carry human decisions across the rebuild, keyed on the pair identity rather
    // than on row ids, which are about to change — and BEFORE the totals, which a
    // decision the trader already made has to keep counting in.
    const carried = await loadCarriedState(connection, orgId, taxPeriod);
    const decided = results.map((result) => carryForward(carried, result));

    const totals = computeRunTotals(decided, { asOfDate: asOf, taxPeriod, filingScheme, schemeFor });
    // If this throws, a bucket has no home in the total mapping. Fix the
    // classification, never the arithmetic.
    assertTotalsBalance(totals);

    const runId = await upsertRunRow(connection, {
      orgId, taxPeriod, mode, asOfDate: asOf, filingScheme, totals, tuning, inputCounts
    });

    await connection.query('DELETE FROM match_results WHERE org_id = ? AND run_id = ?', [
      orgId,
      runId
    ]);
    await insertResults(connection, orgId, runId, totals);

    await connection.query(
      `UPDATE runs SET status = 'COMPLETED', finished_at = NOW() WHERE id = ?`,
      [runId]
    );

    return runId;
  }).then((runId) => getRun(orgId, runId));
}

// What this run was computed FROM, not what it produced. runStaleness() compares
// these against the live counts to notice records that arrived afterwards and so
// appear in no result at all — a record nobody has seen is deemed accepted.
//
// Portal records are counted for the run's OWN period, the only one it reads:
// counting a neighbour's made loading April put March "out of date" with 804
// April records it never had to show (audit P2). `portal` and `periodPortal` are
// now the same count; both are kept because runs written earlier carry both.
export function runInputCounts(expected, portal, taxPeriod) {
  return {
    expected: expected.length,
    portal: portal.length,
    periodPortal: portal.filter((record) => record.taxPeriod === taxPeriod).length
  };
}

async function upsertRunRow(connection, {
  orgId, taxPeriod, mode, asOfDate, filingScheme, totals, tuning, inputCounts
}) {
  const summary = JSON.stringify({
    bucketCounts: totals.bucketCounts,
    totalCounts: totals.totalCounts,
    inputCounts
  });
  const thresholds = JSON.stringify({
    weights: tuning.weights ?? null,
    thresholds: tuning.thresholds ?? null,
    materialityTolerancePaise: tuning.materialityTolerancePaise
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

// Flag added when a decision is dropped because the record it was about changed.
export const CONFIRMATION_RESET = 'CONFIRMATION_RESET';

const pairKey = (expectedId, portalId) => `${expectedId ?? ''}:${portalId ?? ''}`;

const hasFlag = (flags, flag) => (parseJsonColumn(flags) ?? []).includes(flag);

// A flags column with one flag taken out, ready to write back.
const withoutFlag = (flags, flag) =>
  (parseJsonColumn(flags) ?? []).filter((entry) => entry !== flag);

// What a rebuilt run must not silently lose: every decision the trader made, and
// every warning that one was dropped and has not been made again. Keyed on
// (expected_invoice_id, portal_record_id) — stable across the delete. One run per
// (org, period), so the period finds the run being replaced.
async function loadCarriedState(connection, orgId, taxPeriod) {
  const [rows] = await connection.query(
    `SELECT mr.expected_invoice_id, mr.portal_record_id, mr.confirmed_action,
            mr.confirmed_by, mr.confirmed_at, mr.confirmed_content_hash,
            mr.confirmed_bucket, mr.remarks, mr.flags
       FROM match_results mr
       JOIN runs r ON r.id = mr.run_id AND r.org_id = mr.org_id
      WHERE mr.org_id = ? AND r.tax_period = ?
        AND (mr.confirmed_action IS NOT NULL OR JSON_CONTAINS(mr.flags, JSON_QUOTE(?)))`,
    [orgId, taxPeriod, CONFIRMATION_RESET]
  );
  return new Map(rows.map((row) => [pairKey(row.expected_invoice_id, row.portal_record_id), row]));
}

// A dropped decision stays flagged until the trader decides that row again or
// dismisses the warning. A rebuild is neither: re-running used to erase "1
// decision you made was dropped" with nothing decided again (audit P14). N does
// not count as deciding again — it is never a decision.
const awaitingRedecision = (row) =>
  hasFlag(row.flags, CONFIRMATION_RESET) && !isImsDecision(row.confirmed_action);

// carryForward(carried, result) -> the result with what survives the rebuild on it:
// the decision (confirmedAction, and the row it came from as `confirmation`),
// and/or confirmationReset.
export function carryForward(carried, result) {
  const previous = carried.get(pairKey(result.expected?.id, result.portal?.id));
  if (!previous) return result;

  const next = previous.confirmed_action ? applyConfirmation(previous, result) : result;
  return awaitingRedecision(previous) ? { ...next, confirmationReset: true } : next;
}

// A confirmation survives the rebuild only if it is still a decision about the
// SAME thing: same portal content, same bucket. A supplier who corrects a value
// has produced a different record, and IMS resets the recipient's action in
// exactly that situation — carrying a stale REJECT onto a now-clean match would
// reject an invoice the trader already agreed with.
function applyConfirmation(previous, result) {
  const currentHash = result.portal?.contentHash ?? null;
  const contentUnchanged = (previous.confirmed_content_hash ?? null) === currentHash;
  const bucketUnchanged = (previous.confirmed_bucket ?? null) === result.bucket;

  if (contentUnchanged && bucketUnchanged) {
    return { ...result, confirmedAction: previous.confirmed_action, confirmation: previous };
  }
  return { ...result, confirmationReset: true };
}

async function insertResults(connection, orgId, runId, totals) {
  const rows = totals.perResult.map(({ result, signedItc, totalBucket, claimableItc }) => {
    const confirmation = result.confirmation ?? null;

    const flags = [...(result.flags ?? [])];
    if (result.confirmationReset && !flags.includes(CONFIRMATION_RESET)) {
      flags.push(CONFIRMATION_RESET);
    }

    return [
      orgId,
      runId,
      result.expected?.id ?? null,
      result.portal?.id ?? null,
      // What this verdict was computed against. If the record's hash moves later,
      // the verdict is about a document that no longer exists in that form.
      result.portal?.contentHash ?? null,
      result.bucket,
      result.score,
      result.matchedVia,
      result.scoreBreakdown ? JSON.stringify(result.scoreBreakdown) : null,
      JSON.stringify(flags),
      result.recommendedAction,
      result.recommendationReason?.slice(0, REASON_MAX_LENGTH) ?? null,
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
      claimableItc,
      result.linkedFrom?.taxPeriod ?? null,
      result.linkedFrom?.via ?? null,
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
       (org_id, run_id, expected_invoice_id, portal_record_id, portal_content_hash,
        bucket, score, matched_via, score_breakdown, flags, recommended_action,
        recommendation_reason, remarks, delta_taxable_value, delta_total_tax,
        itc_impact, signed_itc, total_bucket, claimable_itc, linked_period, linked_via,
        confirmed_action, confirmed_by, confirmed_at, confirmed_content_hash, confirmed_bucket)
     VALUES ?`,
    rows
  );
}

// --- keeping a run in step with its data -----------------------------------

// Re-runs a period's run if it HAS one, and reports what happened.
//
// Called after every commit. New portal data makes the stored verdicts wrong the
// instant it lands — the results are frozen, but every read joins the portal rows
// live, so the screen ends up showing new figures under an old answer.
//
// A period with NO run is left alone. Creating one on upload would put a period
// in the run list that the trader never asked to reconcile; that decision belongs
// to the Reconcile button.
//
// The run keeps its mode and filing scheme and reads the workspace's date, like
// every other run: one date for the whole workspace, never one per run.
//
// supplierStats: false skips the supplier figures, for a caller that only moved
// the date. Buckets, and so the mismatch counts, do not depend on it.
export async function rerunPeriodIfRun(orgId, taxPeriod, { supplierStats = true } = {}) {
  if (!taxPeriod) return { ran: false, reason: 'unknown_period' };

  const [rows] = await pool.query(
    'SELECT id, mode, filing_scheme FROM runs WHERE org_id = ? AND tax_period = ?',
    [orgId, taxPeriod]
  );
  if (!rows.length) return { ran: false, reason: 'no_run_yet' };

  try {
    const run = await createRun({
      orgId,
      taxPeriod,
      mode: rows[0].mode,
      filingScheme: rows[0].filing_scheme
    });
    if (supplierStats) await rebuildSupplierStats(orgId, taxPeriod, { runId: run.id });
    return { ran: true, runId: run.id, taxPeriod, asOfDate: run.asOfDate };
  } catch (err) {
    // A failed rebuild must not fail the upload: the rows are committed, and the
    // staleness guard marks every affected result so nothing can be acted on in
    // the meantime. Report it rather than swallowing it.
    return { ran: false, reason: err.code ?? 'rerun_failed', message: err.message };
  }
}

// rerunPeriodIfRun for several periods, oldest first: a period's supplier risk
// reads the periods before it. Every later period with a run is rebuilt too,
// after them: its run links late records to these periods' open documents, and
// what is open may just have changed. Never the other way round: a later
// period's data never changes an earlier one. -> [{ taxPeriod, ran, ... }]
export async function rerunPeriods(orgId, periods = [], options = {}) {
  const requested = [...new Set(periods)].filter(Boolean).sort();
  if (!requested.length) return [];
  const [later] = await pool.query(
    'SELECT tax_period FROM runs WHERE org_id = ? AND tax_period > ?',
    [orgId, requested[0]]
  );
  const reruns = [];
  for (const taxPeriod of [...new Set([...requested, ...later.map((row) => row.tax_period)])].sort()) {
    reruns.push({ taxPeriod, ...(await rerunPeriodIfRun(orgId, taxPeriod, options)) });
  }
  return reruns;
}

// The later periods whose runs link these books documents, rebuilt: what an
// earlier period claims for a document decides what its late arrival is worth.
async function rerunLinkingPeriods(orgId, expectedInvoiceIds) {
  const ids = expectedInvoiceIds.filter(Boolean);
  if (!ids.length) return [];
  const [rows] = await pool.query(
    `SELECT DISTINCT r.tax_period
       FROM match_results mr
       JOIN runs r ON r.id = mr.run_id AND r.org_id = mr.org_id
      WHERE mr.org_id = ? AND mr.linked_period IS NOT NULL AND mr.expected_invoice_id IN (?)`,
    [orgId, ids]
  );
  return rerunPeriods(orgId, rows.map((row) => row.tax_period));
}

// Every reconciled period again, against the workspace's date as it is now. This
// is what moving the date does: each recommendation, cut-off state and total is a
// statement about a day, so none may keep describing the old one. Supplier
// figures are left alone, as nothing in them depends on the date.
export async function reevaluateRuns(orgId) {
  const [runs] = await pool.query('SELECT tax_period FROM runs WHERE org_id = ?', [orgId]);
  return rerunPeriods(orgId, runs.map((run) => run.tax_period), { supplierStats: false });
}

// Every period this org holds data for, and whether that data is enough to run.
//
// The Reconcile button asks this instead of counting what the page just uploaded.
// The normal case is a trader re-downloading IMS weekly into a period whose
// purchase register was committed weeks ago; treating one dropped file as the
// whole picture disables the button on exactly that case.
export async function listPeriodInventory(orgId) {
  const [books] = await pool.query(
    'SELECT tax_period, COUNT(*) AS n FROM expected_invoices WHERE org_id = ? GROUP BY tax_period',
    [orgId]
  );
  const [portal] = await pool.query(
    `SELECT tax_period, source, COUNT(*) AS n
       FROM portal_records WHERE org_id = ? AND absent_since IS NULL
      GROUP BY tax_period, source`,
    [orgId]
  );
  const [runs] = await pool.query('SELECT id, tax_period FROM runs WHERE org_id = ?', [orgId]);

  const periods = new Map();
  const entry = (taxPeriod) => {
    if (!periods.has(taxPeriod)) {
      periods.set(taxPeriod, {
        taxPeriod, books: 0, ims: 0, gstr2b: 0, hasBooks: false, hasPortal: false, runId: null
      });
    }
    return periods.get(taxPeriod);
  };

  for (const row of books) {
    const period = entry(row.tax_period);
    period.books = Number(row.n);
    period.hasBooks = period.books > 0;
  }
  for (const row of portal) {
    const period = entry(row.tax_period);
    if (row.source === 'IMS') period.ims = Number(row.n);
    else period.gstr2b = Number(row.n);
    period.hasPortal = period.ims > 0 || period.gstr2b > 0;
  }
  for (const row of runs) entry(row.tax_period).runId = row.id;

  return [...periods.values()].sort((a, b) => b.taxPeriod.localeCompare(a.taxPeriod));
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

  // The period's own documents. Earlier periods' late arrivals are carriedIn.
  const [counts] = await pool.query(
    `SELECT bucket, COUNT(*) AS n, SUM(signed_itc) AS itc
       FROM match_results WHERE org_id = ? AND run_id = ? AND linked_period IS NULL
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
  const staleness = await runStaleness(orgId, run);
  const openDecisions = await runOpenDecisions(orgId, runId);
  const carriedIn = await runCarriedIn(orgId, runId);

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
    // Earlier periods' documents arriving in this one (amendments, late filings):
    // their credit belongs to this period, their books to their own, so they sit
    // beside the totals rather than in them. See runCarriedIn().
    carriedIn,
    // The period's deadlines against the date this run was computed for.
    calendar: filingCalendar(run.as_of_date, run.tax_period, run.filing_scheme),
    // Whether this run still describes the data underneath it. See runStaleness().
    staleness,
    // The one count of records still waiting on the trader. Every screen reads
    // this; see services/decisions.js for the rule.
    openDecisions,
    summary: parseJsonColumn(run.summary)
  };
}

// -> { count, itc, claimableItc, atRiskItc, deferredItc, byPeriod: { 'YYYY-MM': { count, itc, claimableItc } } }
//
// itc is what the late arrivals are worth to this period: each document's books
// amount less what its own period already claimed. claimableItc is the part this
// period can claim now; the rest is at risk (an open decision, a saved record)
// or deferred.
async function runCarriedIn(orgId, runId) {
  const [rows] = await pool.query(
    `SELECT linked_period, total_bucket, COUNT(*) AS n, SUM(signed_itc) AS itc,
            SUM(claimable_itc) AS claimable
       FROM match_results
      WHERE org_id = ? AND run_id = ? AND linked_period IS NOT NULL
      GROUP BY linked_period, total_bucket`,
    [orgId, runId]
  );
  const summary = { count: 0, itc: 0, claimableItc: 0, atRiskItc: 0, deferredItc: 0, byPeriod: {} };
  for (const row of rows) {
    const itc = Number(row.itc ?? 0);
    const claimable = Number(row.claimable ?? 0);
    const period = (summary.byPeriod[row.linked_period] ??= { count: 0, itc: 0, claimableItc: 0 });
    for (const entry of [summary, period]) {
      entry.count += Number(row.n);
      entry.itc += itc;
      entry.claimableItc += claimable;
    }
    if (row.total_bucket === 'DEFERRED') summary.deferredItc += itc;
    else if (row.total_bucket === 'AT_RISK' || row.total_bucket === 'CLAIMABLE') summary.atRiskItc += itc - claimable;
  }
  return summary;
}

async function runOpenDecisions(orgId, runId) {
  const [rows] = await pool.query(
    `SELECT mr.bucket, mr.confirmed_action, mr.signed_itc, mr.flags,
            mr.portal_record_id, pr.source AS portal_source, pr.ims_action, pr.filing_status,
            pr.absent_since
       FROM match_results mr
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ?`,
    [orgId, runId]
  );
  return summarizeOpenDecisions(rows.map(decisionView));
}

// Is this run still current?
//
// Questions that fail differently:
//   * staleResults — a row whose portal record changed under the stored verdict.
//     Exact, per row, and it is what disables the action buttons.
//   * unseenRecords — records that arrived after the run and appear in no result
//     at all. A record nobody has seen is deemed accepted at GSTR-3B, so "nothing
//     on screen is stale" is not the same as "the run is current".
//   * withdrawnResults / inputsChangedAt — the run's inputs were replaced since.
async function runStaleness(orgId, run) {
  const [staleRows] = await pool.query(
    `SELECT
       SUM(mr.portal_content_hash IS NOT NULL
           AND mr.portal_content_hash <> pr.content_hash) AS stale,
       SUM(mr.portal_content_hash IS NULL) AS unverifiable,
       SUM(pr.absent_since IS NOT NULL) AS withdrawn
       FROM match_results mr
       JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ?`,
    [orgId, run.id]
  );

  // Deliberately NOT a timestamp comparison. DATETIME resolves to the second, and
  // an ingest that finishes in the same second as the rebuild it triggers is
  // ordinary — the first attempt at this reported a freshly rebuilt run as
  // current while a change sat unaccounted for. Counts are exact and they clear
  // themselves on the next run.
  //
  // Counting raw portal rows rather than results, because the engine MERGES the
  // same document seen in IMS and 2B into one result: a new 2B row that merges
  // under an existing IMS record would look like a missing result forever.
  //
  // Both sides are counted for the run's own period only; see runInputCounts().
  const [liveExpected] = await pool.query(
    'SELECT COUNT(*) AS n FROM expected_invoices WHERE org_id = ? AND tax_period = ?',
    [orgId, run.tax_period]
  );
  const [livePortal] = await pool.query(
    `SELECT COUNT(*) AS n FROM portal_records
      WHERE org_id = ? AND tax_period = ? AND absent_since IS NULL`,
    [orgId, run.tax_period]
  );

  // A run written before periodPortal existed only knows its window count, which a
  // neighbour's upload inflates. It reports on stale results alone until re-run,
  // rather than calling itself out of date for records that are not its own.
  const inputCounts = parseJsonColumn(run.summary)?.inputCounts ?? null;
  const atRun = inputCounts?.periodPortal === undefined ? null : inputCounts;
  const unseenRecords = atRun
    ? Math.max(0, Number(livePortal[0].n) - Number(atRun.periodPortal)) +
      Math.max(0, Number(liveExpected[0].n) - Number(atRun.expected ?? 0))
    : 0;

  const staleResults = Number(staleRows[0].stale ?? 0);
  // Rows this run cannot vouch for, because it predates the baseline column. Kept
  // apart from staleResults so the UI can say "re-run to verify" rather than
  // claiming records changed when it does not know that.
  const unverifiedResults = Number(staleRows[0].unverifiable ?? 0);
  // Rows about a record the latest download no longer carries. Rebuilding takes
  // the record out of the run (loadPortal), so these are a reason to re-run.
  const withdrawnResults = Number(staleRows[0].withdrawn ?? 0);
  // Set by every commit to this period (ingest.markRunsStale) and cleared by the
  // next run. Counts cannot see a replaced register whose row count did not move.
  const inputsChangedAt = parseJsonColumn(run.summary)?.inputsChangedAt ?? null;
  return {
    staleResults,
    unverifiedResults,
    withdrawnResults,
    unseenRecords,
    inputsChangedAt,
    // Runs written before the per-period counts existed report on stale results
    // alone rather than claiming a certainty they do not have.
    inputCountsKnown: Boolean(atRun),
    isStale:
      staleResults > 0 || unverifiedResults > 0 || unseenRecords > 0 ||
      withdrawnResults > 0 || Boolean(inputsChangedAt)
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
//
// An accepted mismatch is split the way the run totals split it: its claimable
// part under CLAIMABLE, where the document is counted, and the difference still
// being chased under AT_RISK as money without a second count.
export async function runTotalsBreakdown(orgId, runId) {
  const [rows] = await pool.query(
    `SELECT mr.total_bucket AS total_bucket,
            COALESCE(ei.doc_type, pr.doc_type) AS doc_type,
            COUNT(*) AS n,
            SUM(mr.signed_itc) AS itc,
            SUM(mr.claimable_itc) AS claimable
       FROM match_results mr
       LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ? AND mr.linked_period IS NULL
      GROUP BY mr.total_bucket, COALESCE(ei.doc_type, pr.doc_type)`,
    [orgId, runId]
  );

  const breakdown = {};
  const add = (totalBucket, docType, itc, count) => {
    const entry = (breakdown[totalBucket] ??= {
      itc: 0,
      count: 0,
      creditNotes: { itc: 0, count: 0 },
      otherDocuments: { itc: 0, count: 0 },
      byDocType: {}
    });
    const ofType = (entry.byDocType[docType] ??= { itc: 0, count: 0 });
    // Credit notes carry negative ITC by construction — see services/totals.js.
    const side = docType === 'CREDIT_NOTE' || docType === 'ISD_CREDIT'
      ? entry.creditNotes
      : entry.otherDocuments;
    for (const part of [entry, ofType, side]) {
      part.itc += itc;
      part.count += count;
    }
  };

  for (const row of rows) {
    const totalBucket = row.total_bucket ?? 'UNASSIGNED';
    const docType = row.doc_type ?? 'UNKNOWN';
    const itc = Number(row.itc ?? 0);
    const count = Number(row.n);
    if (totalBucket !== 'CLAIMABLE') {
      add(totalBucket, docType, itc, count);
      continue;
    }
    const claimable = Number(row.claimable ?? 0);
    add('CLAIMABLE', docType, claimable, count);
    if (itc !== claimable) add('AT_RISK', docType, itc - claimable, 0);
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
  // Another org's run is not found, as GET /runs/:id says — not an empty page
  // (audit P26).
  const [runs] = await pool.query('SELECT id FROM runs WHERE org_id = ? AND id = ?', [orgId, runId]);
  if (!runs.length) throw new ServiceError('run not found', 404, 'not_found');

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
            mr.total_bucket, mr.claimable_itc, mr.confirmed_action, mr.confirmed_at,
            mr.linked_period, mr.linked_via, mr.expected_invoice_id,
            ei.tax_period AS books_tax_period,
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
            pr.itc_available, pr.itc_ineligible_reason, pr.supplier_filed_on,
            mr.portal_record_id, mr.portal_content_hash,
            pr.content_hash AS portal_current_hash, pr.absent_since,
            ${CONTACT_COLUMNS}
       FROM match_results mr
       LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
       LEFT JOIN supplier_gstin_aliases sa
              ON sa.org_id = mr.org_id AND sa.alias_gstin = pr.supplier_gstin
       LEFT JOIN supplier_contacts sc
              ON sc.org_id = mr.org_id
             AND sc.gstin = COALESCE(ei.supplier_gstin, sa.gstin, pr.supplier_gstin)
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

// Whether this stored verdict still describes the portal record it is rendered
// beside. The comparison is against the hash the result was COMPUTED from, not a
// timestamp: exact, and true whichever path wrote the portal row.
export function stalenessOf(row) {
  if (row.portal_content_hash) {
    return row.portal_content_hash === row.portal_current_hash ? null : 'PORTAL_CHANGED';
  }
  // A result with a portal side but no recorded baseline was written before this
  // check existed. We cannot tell whether it is current — and "cannot tell"
  // reported as "current" is the original bug with extra steps. Unverifiable rows
  // are treated as stale and clear on the first rebuild.
  return row.portal_record_id ? 'UNVERIFIABLE' : null;
}

// A record the supplier withdrew. Deliberately NOT folded into staleness, because
// the two are fixed by different things: a stale verdict is cured by re-running,
// a withdrawn record is not — the row stays absent until the supplier reports it
// again, and the matcher still pairs it as though it were there. Calling it stale
// would put a "re-run the reconciliation" prompt on screen that could never clear.
//
// Both are un-actionable. Only one is a reason to rebuild.
export const isWithdrawn = (row) => Boolean(row.absent_since);

// The fields the decision rules read, from a match_results row (with its flags)
// joined to its portal record (portal source aliased as portal_source).
export function decisionView(row) {
  return {
    bucket: row.bucket,
    confirmedAction: row.confirmed_action,
    signedItc: Number(row.signed_itc ?? 0),
    withdrawn: isWithdrawn(row),
    cutOffPassed: hasFlag(row.flags, FLAGS.CUTOFF_PASSED),
    portal: row.portal_record_id === null
      ? null
      : { source: row.portal_source, imsAction: row.ims_action, filingStatus: row.filing_status }
  };
}

function toResultView(row) {
  const staleReason = stalenessOf(row);
  const decision = decisionView(row);
  return {
    id: row.id,
    bucket: row.bucket,
    // The verdict, the score and the recommendation on this row were all computed
    // against portal figures that have since moved. Acting on it is the single
    // most expensive mistake available here, so it is reported on every read.
    stale: Boolean(staleReason),
    staleReason,
    withdrawn: isWithdrawn(row),
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
    claimableItc: Number(row.claimable_itc ?? 0),
    confirmedAction: row.confirmed_action,
    confirmedAt: row.confirmed_at,
    needsDecision: needsDecision(decision),
    decisionCategory: decisionCategory(decision),
    // "From August": an earlier period's document arriving in this one. signedItc
    // is then what it brings to this period, net of what its own period claimed.
    linkedFrom: row.linked_period === null
      ? null
      : { taxPeriod: row.linked_period, via: row.linked_via, expectedInvoiceId: row.expected_invoice_id },
    // The supplier's contact (a typo GSTIN reads its supplier's), or null.
    supplierContact: contactView(row),
    books: row.books_invoice_no === null ? null : {
      taxPeriod: row.books_tax_period,
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

// What every confirmation path reads about a row before deciding on it.
const CONFIRM_SELECT = `
  SELECT mr.id, mr.run_id, mr.bucket, mr.recommended_action, mr.confirmed_action,
         mr.flags, mr.expected_invoice_id, mr.linked_period, mr.portal_record_id, mr.portal_content_hash, pr.pending_blocked,
         pr.content_hash, pr.content_hash AS portal_current_hash, pr.absent_since,
         pr.section, pr.source AS portal_source, pr.ims_action, pr.filing_status
    FROM match_results mr
    LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id`;

// The trader's decision. Rejected outright when the record's IMS blocked flags
// forbid it: the portal refuses the entire upload over one bad record, so this has
// to fail here rather than at submission time.
export async function confirmResult(orgId, resultId, { confirmedAction, userId = null }) {
  const action = String(confirmedAction ?? '').trim().toUpperCase();
  if (!CONFIRMABLE.has(action)) {
    throw new ServiceError(`confirmedAction must be one of ${[...CONFIRMABLE].join(', ')}`);
  }

  const [rows] = await pool.query(`${CONFIRM_SELECT} WHERE mr.org_id = ? AND mr.id = ?`, [
    orgId,
    resultId
  ]);
  if (!rows.length) throw new ServiceError('result not found', 404, 'not_found');
  const row = rows[0];

  assertConfirmable(row, action);
  await recordDecisions(orgId, [{ row, action }], userId);
  // A confirmation can move a result between claimable and at-risk, so the run
  // totals have to be recomputed rather than left stale.
  await recomputeRunTotals(orgId, row.run_id);
  await rerunLinkingPeriods(orgId, ownDocuments([row]));

  const [updated] = await pool.query(
    'SELECT id, bucket, recommended_action, confirmed_action, confirmed_at FROM match_results WHERE org_id = ? AND id = ?',
    [orgId, resultId]
  );
  return updated[0];
}

// "Confirm all" on an Actions group: the engine's own recommendation, recorded on
// many rows at once.
//
// Only a recommendation that IS an IMS decision can be confirmed this way. A
// Verify row ("probably the same invoice") stays open until a human picks Accept
// or Reject on that row, and confirming a workflow state in bulk would only record
// N — which is never a decision. A request naming any such row is refused whole
// (422) and nothing is written.
//
// Rows that already carry a decision are skipped, never overwritten: re-confirming
// would silently undo an override the trader made.
export async function confirmRecommendations(orgId, runId, { resultIds, userId = null }) {
  const ids = [...new Set(Array.isArray(resultIds) ? resultIds.map(Number) : [])];
  if (!ids.length || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new ServiceError('resultIds must be a non-empty list of result ids');
  }

  const [rows] = await pool.query(
    `${CONFIRM_SELECT} WHERE mr.org_id = ? AND mr.run_id = ? AND mr.id IN (?)`,
    [orgId, runId, ids]
  );
  if (rows.length !== ids.length) {
    throw new ServiceError('one or more results are not in this run', 404, 'not_found');
  }

  const undecidable = rows.filter((row) => !isImsDecision(row.recommended_action));
  if (undecidable.length) {
    const recommended = [...new Set(undecidable.map((row) => row.recommended_action))].join(', ');
    throw new ServiceError(
      `${undecidable.length} of these ${rows.length} rows ${undecidable.length === 1 ? 'is' : 'are'} ` +
        `recommended ${recommended}, which is not an IMS decision. Pick Accept or Reject on ` +
        'each of them; they cannot be confirmed in bulk.',
      422,
      'not_bulk_confirmable'
    );
  }

  const open = rows.filter((row) => !isImsDecision(row.confirmed_action));
  for (const row of open) assertConfirmable(row, row.recommended_action);
  await recordDecisions(orgId, open.map((row) => ({ row, action: row.recommended_action })), userId);
  if (open.length) {
    await recomputeRunTotals(orgId, runId);
    await rerunLinkingPeriods(orgId, ownDocuments(open));
  }

  return {
    confirmed: open.map((row) => row.id),
    skipped: rows
      .filter((row) => isImsDecision(row.confirmed_action))
      .map((row) => ({ resultId: row.id, reason: 'already decided' }))
  };
}

// The books documents these rows decide in their own period. A decision there
// changes what that period claims, and so what a later period's link is worth.
const ownDocuments = (rows) =>
  rows.filter((row) => row.linked_period === null).map((row) => row.expected_invoice_id);

// Records WHAT each decision was about, so a later rebuild can tell whether it
// still applies. A real decision also answers a "your decision was dropped"
// warning on the row, so it clears CONFIRMATION_RESET; N leaves it standing.
async function recordDecisions(orgId, decisions, userId) {
  if (!decisions.length) return;
  await withTransaction(async (connection) => {
    for (const { row, action } of decisions) {
      const flags = isImsDecision(action)
        ? withoutFlag(row.flags, CONFIRMATION_RESET)
        : parseJsonColumn(row.flags) ?? [];
      await connection.query(
        `UPDATE match_results
            SET confirmed_action = ?, confirmed_by = ?, confirmed_at = NOW(),
                confirmed_content_hash = ?, confirmed_bucket = ?, flags = ?
          WHERE org_id = ? AND id = ?`,
        [action, userId, row.content_hash ?? null, row.bucket, JSON.stringify(flags), orgId, row.id]
      );
    }
  });
}

// "Your decision was dropped" — seen, and not to be repeated. Takes the warning
// off the row and nothing else: a row with no decision stays open. The rebuild
// carries only what the row still says, so the dismissal survives re-runs.
// Idempotent; `dismissed` says whether there was a warning to take off.
export async function dismissConfirmationReset(orgId, resultId) {
  const [rows] = await pool.query(
    'SELECT id, flags FROM match_results WHERE org_id = ? AND id = ?',
    [orgId, resultId]
  );
  if (!rows.length) throw new ServiceError('result not found', 404, 'not_found');

  const dismissed = hasFlag(rows[0].flags, CONFIRMATION_RESET);
  const flags = withoutFlag(rows[0].flags, CONFIRMATION_RESET);
  if (dismissed) {
    await pool.query('UPDATE match_results SET flags = ? WHERE org_id = ? AND id = ?', [
      JSON.stringify(flags),
      orgId,
      resultId
    ]);
  }
  return { id: rows[0].id, flags, dismissed };
}

// Every reason a decision cannot be recorded on this row. Shared by the single and
// the bulk path, so the two cannot disagree about what is allowed.
function assertConfirmable(row, action) {
  // The stale-verdict guard, enforced here and not only in the UI.
  //
  // The bucket, the score and the recommendation on this row were computed
  // against a version of the portal record that no longer exists. Accepting on
  // that basis waives a discrepancy the trader was never shown and loses the
  // disputed credit permanently, so this refuses rather than warns.
  const staleReason = stalenessOf(row);
  if (staleReason) {
    throw new ServiceError(
      staleReason === 'UNVERIFIABLE'
        ? 'this run predates the staleness check, so there is no way to tell ' +
          'whether its verdicts still match the portal; re-run the reconciliation ' +
          'before deciding'
        : 'the portal record changed after this run was computed, so this verdict ' +
          'is out of date; re-run the reconciliation before deciding',
      409,
      'stale_run'
    );
  }
  if (isWithdrawn(row)) {
    throw new ServiceError(
      'the supplier withdrew this record from the portal, so there is no IMS ' +
        'record left to act on',
      409,
      'record_withdrawn'
    );
  }

  // Books-only, reverse-charge, ineligible, ISD, import and 2B-only records have
  // no IMS row to act on — not even N, which would record a "decision" that is not
  // one.
  if (!row.portal_record_id) {
    throw new ServiceError(
      'no portal record exists for this books row, so there is no IMS action to take',
      409,
      'action_blocked'
    );
  }
  if (!isImsActionable(decisionView(row))) {
    throw new ServiceError(
      `this record never enters IMS (${row.section}), so it cannot be actioned`,
      409,
      'action_blocked'
    );
  }

  if (action === 'PENDING' && row.pending_blocked) {
    throw new ServiceError(
      'PENDING is blocked on this record by the portal (ispendactblocked = Y); ' +
        'choose ACCEPT, REJECT or NO_ACTION',
      409,
      'action_blocked'
    );
  }
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
    `SELECT mr.id, mr.bucket, mr.signed_itc, mr.delta_total_tax, mr.confirmed_action,
            mr.linked_period, pr.ims_action, pr.filing_status,
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

  const context = {
    asOfDate: run.as_of_date,
    taxPeriod: run.tax_period,
    filingScheme: run.filing_scheme,
    schemeFor: (gstin) => schemeMap.get(gstin) ?? null
  };

  // signed_itc and delta_total_tax are persisted per result, so this re-buckets
  // rather than recomputing money — no re-derivation, no drift.
  const allocations = rows.map((row) => ({
    id: row.id,
    linked: row.linked_period !== null,
    ...allocate(
      {
        bucket: row.bucket,
        docType: row.doc_type,
        signedItc: Number(row.signed_itc ?? 0),
        deltaTotalTax: row.delta_total_tax === null ? null : Number(row.delta_total_tax),
        confirmedAction: row.confirmed_action,
        expected: { supplierGstin: row.supplier_gstin, taxPeriod: run.tax_period },
        portal: {
          supplierGstin: row.supplier_gstin,
          taxPeriod: run.tax_period,
          imsAction: row.ims_action,
          filingStatus: row.filing_status
        }
      },
      context
    )
  }));

  // The period's own documents; earlier periods' late arrivals are carriedIn.
  const totals = sumAllocations(allocations.filter((allocation) => !allocation.linked));
  assertTotalsBalance(totals);

  await withTransaction(async (connection) => {
    for (const { id, totalBucket, claimableItc } of allocations) {
      await connection.query(
        'UPDATE match_results SET total_bucket = ?, claimable_itc = ? WHERE id = ?',
        [totalBucket, claimableItc, id]
      );
    }
    await connection.query(
      `UPDATE runs
          SET expected_total_itc = ?, claimable_itc = ?, at_risk_itc = ?,
              deferred_itc = ?, ineligible_itc = ?, non_ims_itc = ?, grand_total_itc = ?
        WHERE org_id = ? AND id = ?`,
      [
        totals.expectedTotalItc, totals.claimableItc, totals.atRiskItc, totals.deferredItc,
        totals.ineligibleItc, totals.nonImsItc, totals.grandTotalItc, orgId, runId
      ]
    );
  });

  return totals;
}
