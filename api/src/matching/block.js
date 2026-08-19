// Candidate generation. PURE — no db, no fs, no network.
//
// Comparing every books row against every portal record is O(n²) and, worse,
// invites accidental matches between unrelated suppliers. Two passes instead:
//
//   PRIMARY   same supplier GSTIN, tax period within ±1 month.
//   FALLBACK  same normalised invoice number and taxable value within 1%, any
//             GSTIN — this is the only way to recover a typo'd GSTIN, since the
//             primary pass keys on the very field that is wrong. Flagged
//             GSTIN_MISMATCH so nothing downstream mistakes it for a clean match.
import { amountSimilarity, AMOUNT_TOLERANCE_PAISE } from './similarity.js';
import { normalizeGstin, periodsApart } from './normalize.js';

export const PRIMARY_PASS = 'GSTIN_PERIOD';
export const FALLBACK_PASS = 'INVOICE_NO_VALUE';

export const DEFAULT_BLOCKING = Object.freeze({
  periodWindow: 1,          // ±1 month
  fallbackValuePct: 0.01,   // taxable value within 1%
  fallbackTolerancePaise: AMOUNT_TOLERANCE_PAISE
});

// Imports carry no supplier GSTIN, so they can never block against a books row —
// there is nothing to key on. They are handled as portal-only records.
function blockableGstin(record) {
  return normalizeGstin(record.supplierGstin);
}

// candidatePairs(expected[], portal[], options) ->
//   [{ expectedIndex, portalIndex, via, flags }]
// Deduplicated: a pair found by both passes keeps the primary label and any flags.
export function candidatePairs(expected, portal, options = {}) {
  const config = { ...DEFAULT_BLOCKING, ...(options.blocking ?? {}) };

  const byGstin = new Map();
  const byInvoiceNo = new Map();
  portal.forEach((record, index) => {
    const gstin = blockableGstin(record);
    if (gstin) {
      if (!byGstin.has(gstin)) byGstin.set(gstin, []);
      byGstin.get(gstin).push(index);
    }
    const norm = record.invoiceNoNorm;
    if (norm) {
      if (!byInvoiceNo.has(norm)) byInvoiceNo.set(norm, []);
      byInvoiceNo.get(norm).push(index);
    }
  });

  const pairs = new Map(); // 'e:p' -> pair

  const add = (expectedIndex, portalIndex, via, flags = []) => {
    const key = `${expectedIndex}:${portalIndex}`;
    const existing = pairs.get(key);
    if (!existing) {
      pairs.set(key, { expectedIndex, portalIndex, via, flags: [...flags] });
      return;
    }
    // Primary provenance wins; flags accumulate.
    if (existing.via === FALLBACK_PASS && via === PRIMARY_PASS) existing.via = PRIMARY_PASS;
    for (const flag of flags) {
      if (!existing.flags.includes(flag)) existing.flags.push(flag);
    }
  };

  expected.forEach((books, expectedIndex) => {
    const gstin = blockableGstin(books);

    // --- primary: same supplier, neighbouring tax period --------------------
    if (gstin) {
      for (const portalIndex of byGstin.get(gstin) ?? []) {
        const record = portal[portalIndex];
        const apart = periodsApart(books.taxPeriod, record.taxPeriod);
        if (apart === null || apart <= config.periodWindow) {
          add(expectedIndex, portalIndex, PRIMARY_PASS);
        }
      }
    }

    // --- fallback: recover a GSTIN typo ------------------------------------
    // Same normalised invoice number plus a taxable value that agrees within 1%
    // is strong enough evidence to consider the pair at all; the scorer and the
    // one-to-one assignment still have to accept it.
    for (const portalIndex of byInvoiceNo.get(books.invoiceNoNorm) ?? []) {
      const record = portal[portalIndex];
      const recordGstin = blockableGstin(record);
      if (recordGstin && gstin && recordGstin === gstin) continue; // primary covers it

      const similar = amountSimilarity(books.taxableValue, record.taxableValue, {
        tolerancePaise: config.fallbackTolerancePaise,
        tolerancePct: config.fallbackValuePct
      });
      if (similar < 1) continue;

      add(expectedIndex, portalIndex, FALLBACK_PASS, ['GSTIN_MISMATCH']);
    }
  });

  return [...pairs.values()];
}

// Blocking recall check for diagnostics: how many books rows got no candidate at
// all. A books row with no candidate can only ever be MISSING_IN_PORTAL.
export function blockingCoverage(expected, pairs) {
  const covered = new Set(pairs.map((p) => p.expectedIndex));
  return {
    expected: expected.length,
    withCandidates: covered.size,
    withoutCandidates: expected.length - covered.size
  };
}
