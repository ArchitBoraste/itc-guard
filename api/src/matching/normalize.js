// Canonical normalisation for the matching engine.
//
// PURE: no db, no fs, no network, no imports from services/ or routes/.
// Both the adapters and the matcher call these, so a single definition keeps
// invoiceNoNorm byte-identical on both sides of a comparison.

// uppercase -> strip non-alphanumeric -> strip leading zeros per numeric group.
//
// ⚠ OPEN DECISION — the build spec is self-inconsistent here.
// It states this order but gives 'INV/2024/0891' -> 'INV2024891' as the example.
// The two cannot both hold: stripping punctuation first merges 2024 and 0891 into
// the single run '20240891', which has no leading zero left to strip, so the
// result is 'INV20240891'.
//
// This implements the stated ORDER, matching tools/generate-fixtures.js — which
// means every invoiceNoNorm and contentHash already in fixtures/ agrees with it.
// Consequence: 'INV/2024/0891' and 'INV-2024-891' — the pair the docs name as the
// headline win over GSTN's exact matcher — do NOT collapse to one string. They
// still score ~0.98 on Jaro-Winkler, so the pair is recovered as SUGGESTED for a
// human rather than lost, but it is not an automatic match.
//
// Stripping zeros per group BEFORE removing punctuation would satisfy the example
// and the headline claim. It changes 862 of the 4,844 invoice numbers in the
// current fixtures, so adopting it means regenerating the corpus and re-baselining
// contentHash. Deliberately left to a human call.
//
// Two warnings that shape the scorer: 'A/1003' and 'A1003' normalise to the same
// string, and so do '1-10010' and '1/10010'. Never decide a match on this value
// alone — that is why value, date and GSTIN carry weight.
export function normalizeInvoiceNo(value) {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/\d+/g, (run) => String(Number(run)));
}

// GSTIN comparison form: uppercase, alphanumeric only. Deliberately does NOT
// validate the checksum — a typo'd GSTIN still has to be matchable, that is the
// whole point of the fallback blocking pass.
export function normalizeGstin(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized === '' ? null : normalized;
}

// First two characters of a GSTIN are the state code.
export function gstinStateCode(value) {
  const normalized = normalizeGstin(value);
  return normalized && /^\d{2}/.test(normalized) ? normalized.slice(0, 2) : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Internal dates are ISO yyyy-mm-dd strings. Adapters convert at their boundary,
// so this is a defensive normaliser: it accepts what is already unambiguous and
// refuses anything locale-dependent rather than guessing day-vs-month.
export function dateToIso(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const text = String(value).trim();
  const iso = ISO_DATE.exec(text) ?? /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);
  if (!iso) return null;

  const [, y, m, d] = iso;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

// Whole days from a to b. Positive when b is later.
export function daysBetween(isoA, isoB) {
  const a = dateToIso(isoA);
  const b = dateToIso(isoB);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// 'YYYY-MM' -> absolute month index, for period arithmetic without Date objects.
export function periodIndex(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

export function periodsApart(periodA, periodB) {
  const a = periodIndex(periodA);
  const b = periodIndex(periodB);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

export function addMonths(period, delta) {
  const index = periodIndex(period);
  if (index === null) return null;
  const shifted = index + delta;
  const year = Math.floor(shifted / 12);
  const month = (shifted % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function isoToPeriod(iso) {
  const normalized = dateToIso(iso);
  return normalized ? normalized.slice(0, 7) : null;
}
