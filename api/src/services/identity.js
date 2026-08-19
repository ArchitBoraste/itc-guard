// Idempotent ingest identity.
//
// identity_key answers "is this the same document I already stored?" — so it must
// contain everything that distinguishes two documents and NOTHING that a supplier
// might legitimately change. Amounts are therefore excluded: an amended record has
// to be recognised as the SAME row with a new content_hash (CHANGED_AFTER_REVIEW),
// not as a new document.
//
// Because amounts are excluded, two genuinely different invoices that agree on
// supplier, number, date and doc type collide. That happens twice in the fixtures
// (the DUPLICATE_INV_NO defect at its hardest). identity_seq separates them by
// ordering the group deterministically, so re-ingesting the same file assigns the
// same ordinals and updates in place.
import { createHash } from 'node:crypto';

function hash(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

// Everything except the ordinal. Records sharing this are an "identity group".
function portalGroupKey(record) {
  return [
    record.source ?? '',
    record.section ?? '',
    record.supplierGstin ?? '',
    record.portCode ?? '',
    record.docType ?? '',
    record.invoiceNoNorm ?? '',
    record.invoiceDate ?? '',
    record.taxPeriod ?? ''
  ].join('|');
}

function expectedGroupKey(invoice) {
  return [
    'BOOKS',
    invoice.supplierGstin ?? '',
    invoice.docType ?? '',
    invoice.invoiceNoNorm ?? '',
    invoice.invoiceDate ?? '',
    invoice.taxPeriod ?? ''
  ].join('|');
}

// Assigns identity_seq within each group, then the identity_key hash.
// Ordering inside a group is by taxable value then total tax then the raw invoice
// number, so it does not depend on the order rows happened to arrive in.
function assignIdentities(rows, groupKeyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const [groupKey, members] of groups) {
    if (members.length > 1) {
      members.sort(
        (a, b) =>
          (a.taxableValue ?? 0) - (b.taxableValue ?? 0) ||
          (a.totalTax ?? 0) - (b.totalTax ?? 0) ||
          String(a.invoiceNo ?? '').localeCompare(String(b.invoiceNo ?? ''))
      );
    }
    members.forEach((row, index) => {
      row.identitySeq = index;
      row.identityKey = hash([groupKey, index]);
    });
  }

  return rows;
}

export function assignPortalIdentities(records) {
  return assignIdentities(records, portalGroupKey);
}

export function assignExpectedIdentities(invoices) {
  return assignIdentities(invoices, expectedGroupKey);
}
