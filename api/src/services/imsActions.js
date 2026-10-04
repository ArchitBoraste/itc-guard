// Builds the IMS upload JSON for a run.
//
// Each record carries the action it has RIGHT NOW (services/decisions.js): the
// trader's decision wherever they made one, an action already on the portal, and
// Accept for a clean match. Every other recommendation — a Reject included — is a
// proposal until the trader confirms it, so it goes out as N. N is the deemed-
// acceptance default and never a decision, so the records carrying it are counted
// back to the caller as open decisions, by category, and the route refuses to
// hand the file over while any remain unless the trader acknowledges them.
import { pool } from '../db/pool.js';
import { buildImsActionJson } from '../adapters/imsActionWriter.js';
import { ServiceError } from './ingest.js';
import { currentImsAction, isImsActionable, isImsDecision, summarizeOpenDecisions } from './decisions.js';
import { decisionView } from './reconcile.js';

const ACTION_CODES = { ACCEPT: 'A', REJECT: 'R', PENDING: 'P', NO_ACTION: 'N' };

export async function buildRunImsActions(orgId, runId) {
  const [runs] = await pool.query(
    'SELECT id, tax_period FROM runs WHERE org_id = ? AND id = ?',
    [orgId, runId]
  );
  if (!runs.length) throw new ServiceError('run not found', 404, 'not_found');

  // The trader GSTIN the workspace adopted from its files, else the org's own.
  const [orgs] = await pool.query(
    'SELECT COALESCE(workspace_gstin, gstin) AS gstin FROM organizations WHERE id = ?',
    [orgId]
  );
  if (!orgs.length) throw new ServiceError('organization not found', 404, 'not_found');

  // Only IMS-sourced records can be actioned. A 2B-only record (ISD, imports, or
  // anything ITC-ineligible) has no IMS row to act on, and the writer refuses it.
  const [rows] = await pool.query(
    `SELECT mr.id, mr.bucket, mr.confirmed_action, mr.remarks, mr.signed_itc, mr.flags,
            mr.portal_record_id, pr.absent_since,
            pr.source AS portal_source, pr.section, pr.supplier_gstin, pr.supplier_name,
            pr.doc_type, pr.supply_type, pr.invoice_no, pr.invoice_no_norm, pr.invoice_date,
            pr.tax_period, pr.place_of_supply, pr.taxable_value, pr.igst, pr.cgst,
            pr.sgst, pr.cess, pr.total_tax, pr.invoice_value, pr.filing_status,
            pr.ims_action, pr.pending_blocked, pr.remarks_blocked,
            pr.itc_reduction_blocked, pr.original_invoice_no, pr.original_invoice_date,
            pr.source_form
       FROM match_results mr
       JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ? AND pr.source = 'IMS'
      ORDER BY mr.id`,
    [orgId, runId]
  );

  const decisions = [];
  const exported = [];
  const skipped = [];

  for (const row of rows) {
    const view = decisionView(row);
    // A record the supplier withdrew is no longer in IMS to act on.
    if (!isImsActionable(view)) {
      skipped.push({ resultId: row.id, reason: 'withdrawn by the supplier' });
      continue;
    }
    exported.push(view);
    const action = ACTION_CODES[currentImsAction(view)];

    decisions.push({
      record: {
        source: 'IMS',
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
        filingStatus: row.filing_status,
        imsAction: row.ims_action,
        pendingBlocked: Boolean(row.pending_blocked),
        remarksBlocked: Boolean(row.remarks_blocked),
        itcReductionBlocked: Boolean(row.itc_reduction_blocked),
        originalInvoiceNo: row.original_invoice_no,
        originalInvoiceDate: row.original_invoice_date,
        sourceForm: row.source_form
      },
      action,
      // The stated reason for a rejection, and for nothing else.
      remarks: action === 'R' ? row.remarks ?? undefined : undefined,
      resultId: row.id,
      source: isImsDecision(row.confirmed_action) ? 'CONFIRMED' : 'RECOMMENDED'
    });
  }

  const { json, warnings } = buildImsActionJson({ rtin: orgs[0].gstin, decisions });

  return {
    json,
    warnings,
    // The records about to go out as N. The same rule as run.openDecisions.
    openDecisions: summarizeOpenDecisions(exported),
    stats: {
      records: decisions.length,
      confirmed: decisions.filter((d) => d.source === 'CONFIRMED').length,
      recommended: decisions.filter((d) => d.source === 'RECOMMENDED').length,
      byAction: decisions.reduce((acc, d) => {
        acc[d.action] = (acc[d.action] ?? 0) + 1;
        return acc;
      }, {}),
      skipped
    }
  };
}
