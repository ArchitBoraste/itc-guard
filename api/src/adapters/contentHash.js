import { createHash } from 'node:crypto';

// sha256 over the document identity + the money that can change under it.
// A changed hash on the same identity key means the supplier amended a saved
// record -> CHANGED_AFTER_REVIEW. Field order is part of the contract: the
// fixture generator hashes the same six values in this order, so a drift here
// shows up immediately as a fixture mismatch.
export function computeContentHash({
  supplierGstin,
  invoiceNoNorm,
  invoiceDate,
  taxableValue,
  totalTax,
  docType
}) {
  return createHash('sha256')
    .update([supplierGstin, invoiceNoNorm, invoiceDate, taxableValue, totalTax, docType].join('|'))
    .digest('hex');
}
