// Earlier periods' documents still waiting on a supplier fix, and what has become
// of each since. Pure — no db, no fs: rows in, items out.
//
// Input rows are results read by reconcile.loadEarlierRows(): every result, in any
// run, whose books document belongs to a period before the one asked about. A row
// with linked_period NULL is the document's result in its OWN period's run; one
// with linked_period set is a later period's run linking a record to it.
import { BUCKETS } from '../matching/buckets.js';

export const NEEDED = Object.freeze({
  NOT_FILED: 'NOT_FILED',
  SAVED_NOT_FILED: 'SAVED_NOT_FILED',
  VALUE_MISMATCH: 'VALUE_MISMATCH'
});

// What a document's own run left its supplier to fix, or null. Never a phantom
// (there is nothing of the trader's to arrive) and never an invoice-number-only
// difference (the money is right); a value mismatch within the materiality
// tolerance needed nothing either.
export function neededFix(row, { materialityTolerancePaise }) {
  if (row.bucket === BUCKETS.MISSING_IN_PORTAL) {
    return row.portal_record_id === null ? NEEDED.NOT_FILED : NEEDED.SAVED_NOT_FILED;
  }
  if (
    row.bucket === BUCKETS.VALUE_MISMATCH &&
    Math.abs(Number(row.delta_total_tax ?? 0)) > materialityTolerancePaise
  ) {
    return NEEDED.VALUE_MISMATCH;
  }
  return null;
}

// A linked record has arrived once it is filed. A saved one can still change, or
// never be filed at all.
export const hasArrived = (link) =>
  link.portal_filing_status !== 'SAVED' && link.bucket !== BUCKETS.MISSING_IN_PORTAL;

// earlierItems(rows, taxPeriod, { materialityTolerancePaise }) ->
//   [{ row, needed, open, closedIn, link, laterLink }]
//
//   row        the document's result in its own period's run
//   needed     neededFix(row); null for a settled document
//   closedIn   a period between the document's and taxPeriod in which a filed
//              record arrived for it: it is no longer anybody's open item
//   open       needed, and not closed
//   link       its linked result in taxPeriod's own run, if that run has one
//   laterLink  the first linked result after taxPeriod whose record was filed
export function earlierItems(rows, taxPeriod, options) {
  const linksOf = new Map();
  for (const row of rows) {
    if (row.linked_period === null) continue;
    if (!linksOf.has(row.id)) linksOf.set(row.id, []);
    linksOf.get(row.id).push(row);
  }

  return rows
    .filter((row) => row.linked_period === null && row.run_period < taxPeriod)
    .map((row) => {
      const links = [...(linksOf.get(row.id) ?? [])].sort((a, b) => a.run_period.localeCompare(b.run_period));
      const closedBy = links.find(
        (link) => link.run_period > row.run_period && link.run_period < taxPeriod && hasArrived(link)
      );
      const needed = neededFix(row, options);
      return {
        row,
        needed,
        open: Boolean(needed) && !closedBy,
        closedIn: closedBy?.run_period ?? null,
        link: links.find((link) => link.run_period === taxPeriod) ?? null,
        laterLink: links.find((link) => link.run_period > taxPeriod && hasArrived(link)) ?? null
      };
    });
}
