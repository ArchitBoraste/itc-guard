// Canonical invoice-number normalisation — the matching-engine contract.
// Lives in matching/ (PURE: no db, no fs, no network) because both the adapters
// and the matcher must produce byte-identical invoiceNoNorm values. Two copies
// would silently diverge and wreck the phase-3 accuracy numbers.

// uppercase -> strip non-alphanumeric -> strip leading zeros per numeric group.
//   'INV/2024/0891' -> 'INV2024891'
export function normalizeInvoiceNo(value) {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/\d+/g, (run) => String(Number(run)));
}
