// Earlier periods' documents arriving late. PURE — no db, no fs, no network.
//
// A portal record belongs to the period of the upload it came from. Some of a
// period's records are about documents from an EARLIER period: a GSTR-1A
// amendment (b2ba/cdnra, carrying the original document's number), or a document
// dated before the period that the supplier reported late. Each of those is first
// tried against earlier periods' documents for the same supplier; only one that
// links to nothing goes on to ordinary matching against this period's books.
//
//   earlier   [{ expected: ExpectedInvoice, open, claimedItc }]
//             open        the document still waits on a supplier fix in its own
//                         period (not filed, saved past cut-off, value mismatch)
//             claimedItc  signed paise its own period already claims for it
//
// An amendment links to its original by the original number, open or settled:
// the number makes the identity certain. Any other late record links only to an
// open document, and only on the matcher's own score and thresholds.
import { assignOneToOne } from './assign.js';
import { candidatePairs } from './block.js';
import { classify, FLAGS, pairFlags } from './buckets.js';
import { normalizeInvoiceNo } from './normalize.js';
import { scorePair } from './score.js';

export const LINK_VIA = Object.freeze({ AMENDMENT: 'AMENDMENT', LATE_FILING: 'LATE_FILING' });

export const isAmendment = (record) => Boolean(record?.originalInvoiceNo);

// A record of `taxPeriod` that may be an earlier period's document. Imports are
// keyed on a Bill of Entry, not on a supplier's return, so they never are.
export function isLateArrival(record, taxPeriod) {
  if (!taxPeriod || record.portCode) return false;
  if (isAmendment(record)) return true;
  return Boolean(record.invoiceDate) && record.invoiceDate < `${taxPeriod}-01`;
}

// An amendment is matched as the document it amends: its original number and
// date. Money stays the amendment's own.
export function asOriginal(record) {
  if (!isAmendment(record)) return record;
  return {
    ...record,
    invoiceNo: record.originalInvoiceNo,
    invoiceNoNorm: normalizeInvoiceNo(record.originalInvoiceNo),
    invoiceDate: record.originalInvoiceDate ?? record.invoiceDate
  };
}

// linkEarlier(earlier, portal, options) -> { links, rest }
//   links  [{ expected, portal, bucket, flags, score, scoreDetail, via, linkedFrom }]
//   rest   the portal records left for ordinary matching, in their input order
//
// options: { taxPeriod, weights, thresholds, blocking, tolerancePaise }
export function linkEarlier(earlier = [], portal = [], options = {}) {
  const arrivals = portal.filter((record) => isLateArrival(record, options.taxPeriod));
  if (!earlier.length || !arrivals.length) return { links: [], rest: portal };

  const books = earlier.map((item) => item.expected);
  const originals = arrivals.map(asOriginal);

  // Same supplier in any earlier period: the ±1 month window is for this
  // period's own books, and a document can wait several months for its fix.
  const pairs = candidatePairs(books, originals, {
    blocking: { ...(options.blocking ?? {}), periodWindow: Infinity }
  }).filter(({ expectedIndex, portalIndex }) =>
    earlier[expectedIndex].open ||
    (isAmendment(arrivals[portalIndex]) &&
      books[expectedIndex].invoiceNoNorm === originals[portalIndex].invoiceNoNorm)
  );

  const scored = pairs.map((pair) => {
    const detail = scorePair(books[pair.expectedIndex], originals[pair.portalIndex], {
      weights: options.weights
    });
    return { ...pair, score: detail.score, scoreDetail: detail };
  });

  const { assigned } = assignOneToOne(scored, {
    thresholds: options.thresholds,
    expectedCount: books.length,
    portalCount: originals.length
  });

  const linked = new Set();
  const links = assigned.map((pair) => {
    const item = earlier[pair.expectedIndex];
    const record = arrivals[pair.portalIndex];
    const original = originals[pair.portalIndex];
    linked.add(record);

    // Judged against the original number and date, so an amendment that renumbers
    // its document is not mistaken for a different invoice.
    const flags = [
      ...new Set([...pair.flags, ...pairFlags({ expected: item.expected, portal: original }), FLAGS.FROM_EARLIER_PERIOD])
    ];
    const { bucket, flags: bucketFlags } = classify(
      { expected: item.expected, portal: original, score: pair.score, flags },
      { thresholds: options.thresholds, tolerancePaise: options.tolerancePaise }
    );
    return {
      expected: item.expected,
      portal: record,
      bucket,
      flags: bucketFlags,
      score: pair.score,
      scoreDetail: pair.scoreDetail,
      via: pair.via,
      linkedFrom: {
        taxPeriod: item.expected.taxPeriod,
        via: isAmendment(record) ? LINK_VIA.AMENDMENT : LINK_VIA.LATE_FILING,
        claimedItc: item.claimedItc ?? 0,
        open: Boolean(item.open)
      }
    };
  });

  return { links, rest: portal.filter((record) => !linked.has(record)) };
}
