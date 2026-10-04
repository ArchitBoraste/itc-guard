// What each supplier did this period, read from the run's own results. Pure.
import { formatDay } from './calendar.js';
import { issueOf } from './issues.js';
import { rupeesExact } from './money.js';

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The order a row names its issues in: what costs the trader most first.
const ISSUE_ORDER = [
  ['NOT_IN_BOOKS', (n) => `${plural(n, 'invoice')} not in your books`],
  ['HIGHER', () => 'Amount higher than your bill'],
  ['LOWER', () => 'Amount lower than your bill'],
  ['SAVED_DIFFERENT', () => 'Saved with a different amount'],
  ['INVOICE_NO_DIFFERS', () => 'Invoice number differs'],
  ['NOT_ON_PORTAL', (n) => `${plural(n, 'invoice')} missing`],
  ['SAVED_NOT_FILED', (n) => `${plural(n, 'invoice')} not filed`]
];

const RISK_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// gstin (and each typo variant of it) -> the supplier's GSTIN
function gstinIndex(suppliers) {
  const index = new Map();
  for (const supplier of suppliers) {
    index.set(supplier.gstin, supplier.gstin);
    for (const variant of supplier.gstinVariants ?? []) index.set(variant.gstin, supplier.gstin);
  }
  return index;
}

function summarise(rows) {
  const counts = new Map();
  let rounding = null;
  for (const result of rows) {
    const issue = issueOf(result);
    if (issue.key === 'ROUNDING') rounding = result.portal.totalTax - result.books.totalTax;
    counts.set(issue.key, (counts.get(issue.key) ?? 0) + 1);
  }
  const named = ISSUE_ORDER.filter(([key]) => counts.has(key)).map(([key, words]) => words(counts.get(key)));
  if (named.length) {
    return { text: named.length > 1 ? `${named[0]} and ${named.length - 1} more` : named[0], hasIssue: true };
  }
  if (rounding !== null) return { text: `${rupeesExact(Math.abs(rounding))} rounding, accepted`, hasIssue: false };
  return { text: rows.length ? 'No issues' : 'Nothing this period', hasIssue: false };
}

function lastFiling(rows, filedOn) {
  const filed = rows.filter((result) => result.portal?.filingStatus === 'FILED');
  if (filed.length) {
    const date = [filedOn, ...filed.map((result) => result.portal.supplierFiledOn)].filter(Boolean).sort().at(-1);
    return { text: date ? `Filed ${formatDay(date)}` : 'Filed', tone: null };
  }
  if (rows.some((result) => result.portal?.filingStatus === 'SAVED')) return { text: 'Saved, not filed', tone: 'warn' };
  if (rows.some((result) => result.books)) return { text: 'Not filed', tone: 'bad' };
  return null;
}

// supplierRows(suppliers, results) -> one row per supplier this period, riskiest
// first. With no results (nothing reconciled) every supplier is listed.
export function supplierRows(suppliers = [], results = null) {
  const index = gstinIndex(suppliers);
  const byGstin = new Map();
  for (const result of results ?? []) {
    if (result.linkedFrom) continue;
    const gstin = index.get(result.books?.supplierGstin ?? result.portal?.supplierGstin);
    if (!gstin) continue;
    if (!byGstin.has(gstin)) byGstin.set(gstin, []);
    byGstin.get(gstin).push(result);
  }

  return suppliers
    .filter((supplier) => !results || byGstin.has(supplier.gstin))
    .map((supplier) => {
      const rows = byGstin.get(supplier.gstin) ?? [];
      const issue = summarise(rows);
      return {
        supplier,
        issue: issue.text,
        hasIssue: issue.hasIssue,
        itc: rows.reduce((total, result) => total + result.signedItc, 0),
        filing: lastFiling(rows, supplier.lastFiledOn),
        inRegister: rows.some((result) => result.books) || (supplier.stats?.expectedTotalTax ?? 0) > 0
      };
    })
    .sort(
      (a, b) =>
        (RISK_ORDER[a.supplier.risk?.band] ?? 3) - (RISK_ORDER[b.supplier.risk?.band] ?? 3) ||
        Number(b.hasIssue) - Number(a.hasIssue) ||
        Math.abs(b.itc) - Math.abs(a.itc) ||
        a.supplier.tradeName.localeCompare(b.supplier.tradeName)
    );
}

export function matchesSearch(row, text) {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return (
    row.supplier.tradeName?.toLowerCase().includes(needle) ||
    row.supplier.legalName?.toLowerCase().includes(needle) ||
    row.supplier.gstin.toLowerCase().includes(needle)
  );
}
