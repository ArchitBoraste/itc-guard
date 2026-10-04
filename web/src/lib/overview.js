// The four headline figures and the bar under them. Pure.
//
// Each is measured on the period's OWN documents (an earlier period's late
// arrival is reported apart, as run.carriedIn) and in the books' terms, so the
// four parts add up to the books total:
//
//   Ready to claim          the run's claimable credit
//   Not filed by suppliers  books documents with nothing filed: absent, or saved only
//   Needs your decision     the books credit on records waiting for a decision
//   the rest                credit already decided but still waiting on a supplier's
//                           correction (a reject, or the part of a lower figure
//                           not claimed)
//
// A phantom has no books credit, so it adds a record to "Needs your decision"
// and nothing to its amount.
import { isNotFiled, isOutsideIms, needsMention } from './issues.js';

const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
const own = (results) => results.filter((result) => !result.linkedFrom);

export function notFiledRows(results = []) {
  return own(results).filter(isNotFiled);
}

export function overviewFigures(run, results = []) {
  const mine = own(results);
  const books = mine.filter((result) => result.books);
  const outside = books.filter(isOutsideIms);
  const inIms = books.filter((result) => !isOutsideIms(result));
  const notFiled = inIms.filter(isNotFiled);
  const deciding = inIms.filter((result) => result.needsDecision && !isNotFiled(result));

  const booksItc = sum(books, (result) => result.signedItc);
  const readyItc = run?.totals?.claimableItc ?? sum(mine, (result) => result.claimableItc);
  const notFiledItc = sum(notFiled, (result) => result.signedItc);
  const decisionItc = sum(deciding, (result) => result.signedItc - result.claimableItc);
  const outsideItc = sum(outside, (result) => result.signedItc);
  const restItc = booksItc - readyItc - notFiledItc - decisionItc - outsideItc;
  const claimable = mine.filter((result) => result.claimableItc !== 0);

  return {
    books: { itc: booksItc, count: books.length },
    ready: {
      itc: readyItc,
      count: claimable.length,
      allExact: claimable.every((result) => result.bucket === 'MATCHED')
    },
    decision: { itc: decisionItc, count: run?.openDecisions?.count ?? 0 },
    notFiled: {
      itc: notFiledItc,
      count: notFiled.length,
      suppliers: new Set(notFiled.map((result) => result.books.supplierGstin)).size
    },
    rest: { itc: Math.max(0, restItc) },
    outside: { itc: outsideItc, count: own(results).filter(isOutsideIms).length }
  };
}

// The bar's segments, in order, sized by credit. Nothing negative, nothing empty.
export function barSegments(figures) {
  return [
    { key: 'ready', tone: 'ok', label: 'Ready to claim', itc: figures.ready.itc },
    { key: 'decision', tone: 'warn', label: 'Needs your decision', itc: figures.decision.itc },
    { key: 'notFiled', tone: 'neutral', label: 'Not filed by suppliers', itc: figures.notFiled.itc },
    { key: 'rest', tone: 'rest', label: "Waiting on a supplier's correction", itc: figures.rest.itc }
  ].filter((segment) => segment.itc > 0);
}

// "What we found": every row that is not a clean filed match, this period's and
// the earlier ones arriving in it, most serious first.
const ORDER = ['LOWER', 'HIGHER', 'INVOICE_NO_DIFFERS', 'NOT_IN_BOOKS', 'SAVED_DIFFERENT', 'NOT_ON_PORTAL', 'SAVED_NOT_FILED', 'ROUNDING'];

export function foundRows(results = [], issueKey) {
  return results
    .filter((result) => needsMention(result) || result.linkedFrom)
    .map((result) => ({ result, issue: issueKey(result) }))
    .sort((a, b) =>
      Number(Boolean(a.result.linkedFrom)) - Number(Boolean(b.result.linkedFrom)) ||
      rank(a.issue) - rank(b.issue) ||
      Math.abs(b.result.signedItc) - Math.abs(a.result.signedItc)
    );
}

const rank = (issue) => {
  const index = ORDER.indexOf(issue.key);
  return index === -1 ? ORDER.length : index;
};

export function exactMatchCount(results = []) {
  return own(results).filter((result) => !needsMention(result) && !isOutsideIms(result)).length;
}

// Documents the portal shows for the period: one per record, however many of
// IMS and GSTR-2B carry it.
export function portalDocumentCount(results = []) {
  return own(results).filter((result) => result.portal).length;
}

export function outsideImsRows(results = []) {
  return own(results).filter(isOutsideIms);
}
