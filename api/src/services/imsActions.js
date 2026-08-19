// Builds the IMS upload JSON for a run.
//
// confirmed_action wins over recommended_action. That ordering is the product:
// the engine proposes, the trader decides, and what goes to the portal is the
// trader's decision wherever they made one.
import { pool } from '../db/pool.js';
import { buildImsActionJson } from '../adapters/imsActionWriter.js';
import { ServiceError } from './ingest.js';

// Workflow states are not portal actions. CHASE_SUPPLIER / VERIFY / DEFERRED all
// mean "do nothing in IMS yet", which is action N — and N is precisely the
// deemed-acceptance default, so these records must still appear in the upload
// carrying N rather than being silently dropped.
const RECOMMENDED_TO_IMS = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  PENDING: 'PENDING',
  NO_ACTION: 'NO_ACTION',
  CHASE_SUPPLIER: 'NO_ACTION',
  VERIFY: 'NO_ACTION',
  DEFERRED: 'NO_ACTION'
};

const ACTION_CODES = { ACCEPT: 'A', REJECT: 'R', PENDING: 'P', NO_ACTION: 'N' };

export async function buildRunImsActions(orgId, runId) {
  const [runs] = await pool.query(
    'SELECT id, tax_period FROM runs WHERE org_id = ? AND id = ?',
    [orgId, runId]
  );
  if (!runs.length) throw new ServiceError('run not found', 404, 'not_found');

  const [orgs] = await pool.query('SELECT gstin FROM organizations WHERE id = ?', [orgId]);
  if (!orgs.length) throw new ServiceError('organization not found', 404, 'not_found');

  // Only IMS-sourced records can be actioned. A 2B-only record (ISD, imports, or
  // anything ITC-ineligible) has no IMS row to act on, and the writer refuses it.
  const [rows] = await pool.query(
    `SELECT mr.id, mr.bucket, mr.recommended_action, mr.confirmed_action, mr.remarks,
            pr.source, pr.section, pr.supplier_gstin, pr.supplier_name, pr.doc_type,
            pr.supply_type, pr.invoice_no, pr.invoice_no_norm, pr.invoice_date,
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
  const skipped = [];

  for (const row of rows) {
    const chosen = row.confirmed_action ?? RECOMMENDED_TO_IMS[row.recommended_action] ?? 'NO_ACTION';
    const action = ACTION_CODES[chosen];
    if (!action) {
      skipped.push({ resultId: row.id, reason: `no IMS action for ${chosen}` });
      continue;
    }

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
      remarks: row.remarks ?? undefined,
      resultId: row.id,
      source: row.confirmed_action ? 'CONFIRMED' : 'RECOMMENDED'
    });
  }

  const { json, warnings } = buildImsActionJson({ rtin: orgs[0].gstin, decisions });

  return {
    json,
    warnings,
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
