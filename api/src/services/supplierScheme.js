// The trader settles a supplier's filing scheme, and everything measured against
// that supplier's cut-off follows.
//
// Inference cannot tell a QRMP supplier who files by the 11th from a monthly one
// (audit P9), so the trader can say which it is. The scheme decides the
// engine's recommendation (a saved mismatch on the 12th is a free fix for a QRMP
// supplier, a GSTR-1A for a monthly one), deferred vs at risk in the run totals,
// days late per period, and the risk band built on them. Every reconciled period
// is re-run, oldest first, so each period's risk reads an already-rebuilt history.
// Decisions carry across the re-run as on any other (reconcile.carryForward).
import { pool } from '../db/pool.js';
import { FILING_SCHEMES } from '../matching/cutoff.js';
import { ServiceError } from './ingest.js';
import { rerunPeriods } from './reconcile.js';
import {
  clearSupplierScheme,
  getSupplierHistory,
  refreshSupplierMaster,
  setSupplierScheme
} from './supplierStats.js';

// changeSupplierScheme(orgId, gstin, scheme) -> { supplier, reruns }
//
// scheme: 'MONTHLY' | 'QRMP' sets it; null hands it back to inference.
export async function changeSupplierScheme(orgId, gstin, scheme) {
  if (scheme !== null && !Object.values(FILING_SCHEMES).includes(scheme)) {
    throw new ServiceError(
      `scheme must be one of ${Object.values(FILING_SCHEMES).join(', ')}, or null to infer it`
    );
  }
  // The master as the data stands now, so a supplier known only from a register
  // uploaded a moment ago can be set before anything is reconciled. 404 for a
  // supplier this org has never seen; a GSTIN variant is its supplier.
  await refreshSupplierMaster(orgId);
  const { gstin: supplierGstin } = await getSupplierHistory(orgId, gstin);

  if (scheme === null) await clearSupplierScheme(orgId, supplierGstin);
  else await setSupplierScheme(orgId, supplierGstin, scheme);

  const reruns = await rerunEveryPeriod(orgId);
  const failed = reruns.filter((rerun) => !rerun.ran);
  if (failed.length) {
    throw new ServiceError(
      `the scheme was saved, but ${failed.map((rerun) => rerun.taxPeriod).join(', ')} could not ` +
        're-run; re-run those periods before relying on their figures',
      500,
      'rerun_failed'
    );
  }
  return { supplier: await getSupplierHistory(orgId, supplierGstin), reruns };
}

async function rerunEveryPeriod(orgId) {
  const [runs] = await pool.query('SELECT tax_period FROM runs WHERE org_id = ?', [orgId]);
  return rerunPeriods(orgId, runs.map((run) => run.tax_period));
}
