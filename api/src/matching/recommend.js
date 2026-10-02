// Recommended IMS action per result. PURE — no db, no fs, no network.
//
// The product is an action list, not a mismatch list. Two rules govern every
// branch below:
//
//   * A wrong REJECT costs the trader a month of credit and raises the supplier's
//     liability. Nothing here is ever auto-applied — REJECT always comes back
//     with requiresConfirmation.
//   * Timing decides the remedy, not severity. Before the cut-off a supplier can
//     edit a saved record for free; after it, the same fix needs GSTR-1A and the
//     credit slips a month. So the identical discrepancy yields CHASE_SUPPLIER on
//     the 10th and ACCEPT/REJECT/DEFERRED on the 16th.
import { BUCKETS } from './buckets.js';
import { FILING_SCHEMES, filingWindow, isBeforeCutoff } from './cutoff.js';
import { AMOUNT_TOLERANCE_PAISE, amountsDiffer } from './similarity.js';

export const ACTIONS = Object.freeze({
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  PENDING: 'PENDING',
  CHASE_SUPPLIER: 'CHASE_SUPPLIER',
  VERIFY: 'VERIFY',
  DEFERRED: 'DEFERRED',
  NO_ACTION: 'NO_ACTION'
});

// IMS actions the portal understands. CHASE_SUPPLIER / VERIFY / DEFERRED are
// workflow states for the trader, not portal actions — they map to no IMS action.
const IMS_ACTION_CODES = Object.freeze({
  ACCEPT: 'A',
  REJECT: 'R',
  PENDING: 'P',
  NO_ACTION: 'N'
});

export const REMARKS_MAX_LENGTH = 250;

// A value mismatch whose TAX differs by no more than this is accepted as
// immaterial. Configurable (MATERIALITY_TOLERANCE_PAISE); the default is the
// largest round figure that agrees with the audit brief's verdict on every
// fixture mismatch — its smallest portal-higher difference, Rs. 1.35, is a reject.
export const DEFAULT_MATERIALITY_TOLERANCE_PAISE = 100;

// recommendAction(result, context) ->
//   { action, imsActionCode, reason, remarks, requiresConfirmation, itcAtRisk }
//
// context: { asOfDate, taxPeriod, filingScheme, tolerancePaise, materialityTolerancePaise }
export function recommendAction(result, context = {}) {
  const { expected, portal, bucket } = result;
  const taxPeriod = context.taxPeriod ?? expected?.taxPeriod ?? portal?.taxPeriod ?? null;
  const filingScheme = context.filingScheme ?? FILING_SCHEMES.MONTHLY;
  const asOfDate = context.asOfDate ?? null;

  // Null when we have no as-of date: callers running a pure reconciliation with
  // no calendar context get the timing-independent recommendation.
  const preCutOff = asOfDate && taxPeriod
    ? isBeforeCutoff(asOfDate, taxPeriod, filingScheme)
    : null;
  const window = asOfDate && taxPeriod
    ? filingWindow(asOfDate, taxPeriod, filingScheme)
    : null;

  // The SAME tolerance classify() used to put this result in its bucket. If the
  // two ever drifted, a difference could decide the bucket and then be too small
  // for the sentence explaining it to mention — which is how the zero-rupee text
  // got written in the first place.
  const tolerancePaise = context.tolerancePaise ?? AMOUNT_TOLERANCE_PAISE;
  const materialityTolerancePaise =
    context.materialityTolerancePaise ?? DEFAULT_MATERIALITY_TOLERANCE_PAISE;

  const decision = decide({
    bucket, expected, portal, preCutOff, tolerancePaise, materialityTolerancePaise
  });

  return finalize(decision, { result, portal, window, preCutOff });
}

function decide({ bucket, expected, portal, preCutOff, tolerancePaise, materialityTolerancePaise }) {
  switch (bucket) {
    case BUCKETS.MATCHED:
      return {
        action: ACTIONS.ACCEPT,
        reason: 'Books and portal agree on supplier, number, date and amount.'
      };

    case BUCKETS.VALUE_MISMATCH:
      return valueMismatch({ expected, portal, preCutOff, tolerancePaise, materialityTolerancePaise });

    case BUCKETS.SUGGESTED:
      return {
        action: ACTIONS.VERIFY,
        reason:
          'Likely the same invoice, but the number still differs after normalisation. ' +
          'Confirm before accepting.'
      };

    case BUCKETS.MISSING_IN_PORTAL:
      // Pre cut-off the supplier can still file it into this period. After the
      // cut-off there is no IMS record to act on at all, so nothing can be done
      // this month — the credit moves to a later period.
      if (preCutOff === false) {
        return {
          action: ACTIONS.DEFERRED,
          reason:
            'Not on the portal and the cut-off has passed — no IMS record exists to act on. ' +
            'Credit deferred to a later period.'
        };
      }
      return {
        action: ACTIONS.CHASE_SUPPLIER,
        reason: preCutOff === true
          ? 'Not yet on the portal, but the cut-off has not passed — chasing now still lands it this period.'
          : 'Not on the portal. Chase the supplier to file it.'
      };

    case BUCKETS.MISSING_IN_BOOKS:
      // Never auto-reject: this is exactly where a wrong reject does its damage.
      return {
        action: ACTIONS.VERIFY,
        reason:
          'On the portal but not in the purchase register. Verify no goods or invoice ' +
          'were received before rejecting — an unreviewed record is deemed accepted.'
      };

    case BUCKETS.INELIGIBLE:
      return {
        action: ACTIONS.NO_ACTION,
        reason: portal?.itcIneligibleReason
          ? `ITC not available (${portal.itcIneligibleReason}). Appears in 2B only, not in IMS.`
          : 'ITC not available on this record. Appears in 2B only, not in IMS.'
      };

    case BUCKETS.NON_IMS:
      return { action: ACTIONS.NO_ACTION, reason: nonImsReason(portal) };

    default:
      return { action: ACTIONS.VERIFY, reason: `Unclassified result (${bucket}).` };
  }
}

// The fields a VALUE_MISMATCH is actually decided on — the same two classify()
// tests, in the order a trader reads them. Anything named here must be something
// that CAN have put the result in this bucket.
const MISMATCH_FIELDS = Object.freeze([
  { key: 'taxableValue', label: 'taxable value' },
  { key: 'totalTax', label: 'tax' }
]);

// Which amounts actually differ, and by how much.
//
// The bug this replaces: every sentence was built from the TAX delta alone, so a
// mismatch that was purely in the taxable value — same tax on both sides, which
// happens whenever a supplier mistypes the base and the rate arithmetic still
// lands on the same figure — produced "Portal tax is Rs. 0.00 lower than books".
// The row was correctly bucketed and then explained by a sentence about nothing.
export function valueDifferences(expected, portal, tolerancePaise = AMOUNT_TOLERANCE_PAISE) {
  const differences = [];
  for (const field of MISMATCH_FIELDS) {
    const books = Number(expected?.[field.key] ?? 0);
    const shown = Number(portal?.[field.key] ?? 0);
    if (!amountsDiffer(books, shown, tolerancePaise)) continue;
    const delta = shown - books;
    differences.push({
      field: field.key,
      label: field.label,
      books,
      portal: shown,
      delta,
      direction: delta > 0 ? 'higher' : 'lower',
      magnitude: Math.abs(delta)
    });
  }
  return differences;
}

function joinClauses(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// "taxable value is Rs. 5,000.00 lower" / "...lower and tax is Rs. 900.00 higher"
function describeDifferences(differences, format) {
  return joinClauses(
    differences.map(
      (entry) => `${entry.label} is ${format(entry.magnitude)} ${entry.direction}`
    )
  );
}

const DOCUMENT_LABEL = Object.freeze({
  INVOICE: 'invoice',
  DEBIT_NOTE: 'debit note',
  CREDIT_NOTE: 'credit note'
});

const direction = (delta) => (delta > 0 ? 'higher' : 'lower');

// How the supplier fixes their side: a saved record is still theirs to edit, a
// filed one needs GSTR-1A.
const correctionRoute = (filingStatus) =>
  filingStatus === 'SAVED' ? 'correct the saved record before filing' : 'correct it via GSTR-1A';

// The value-mismatch rule table, from the audit brief (rule 8). First match wins.
// Checked against the brief's verdict on all 63 fixture mismatches.
//
//   tax difference within tolerance   ACCEPT
//   saved, on or before the cut-off   CHASE_SUPPLIER  the supplier's fix is still free
//   portal tax lower                  ACCEPT          invoice / debit note: chase the difference
//                                                     credit note: the books reversal stands
//   portal tax higher                 REJECT          invoice / debit note: more credit than it carries
//                                                     credit note: reverses more than the books owe
//
// A credit note gets the same action but its own sentence: it REVERSES credit, so
// what accepting does to the trader runs the other way.
export const MISMATCH_RULES = Object.freeze([
  {
    rule: 'WITHIN_TOLERANCE',
    applies: ({ taxGap, tolerance }) => Math.abs(taxGap) <= tolerance,
    action: ACTIONS.ACCEPT,
    explain: ({ taxGap, tolerance }) =>
      taxGap === 0
        ? "The tax is the same on both sides, so accept the portal's figure."
        : `The tax is ${formatRupees(Math.abs(taxGap))} ${direction(taxGap)}, within the ` +
          `${formatRupees(tolerance)} tolerance, so accept the portal's figure.`
  },
  {
    rule: 'SAVED_BEFORE_CUTOFF',
    applies: ({ filingStatus, preCutOff }) => filingStatus === 'SAVED' && preCutOff !== false,
    action: ACTIONS.CHASE_SUPPLIER,
    explain: () =>
      'The record is only saved, not filed, so the supplier can still correct it for free ' +
      'before the cut-off.'
  },
  {
    rule: 'PORTAL_LOWER',
    applies: ({ taxGap }) => taxGap < 0,
    action: ACTIONS.ACCEPT,
    explain: ({ credit, taxGap, books, portal }) =>
      credit
        ? `Accept it: your books still reverse the full ${formatRupees(books)}, so the ` +
          'smaller note costs you nothing.'
        : `Accept the portal's ${formatRupees(portal)} now and chase the supplier for the ` +
          `${formatRupees(-taxGap)} difference.`
  },
  {
    rule: 'PORTAL_HIGHER',
    applies: ({ taxGap }) => taxGap > 0,
    action: ACTIONS.REJECT,
    explain: ({ credit, document, taxGap, filingStatus }) =>
      credit
        ? `Reject: accepting would reverse ${formatRupees(taxGap)} more credit than your ` +
          `books owe. Ask the supplier to ${correctionRoute(filingStatus)}.`
        : `Reject: accepting would claim ${formatRupees(taxGap)} more credit than the ` +
          `${document} carries. Ask the supplier to ${correctionRoute(filingStatus)}; the ` +
          'corrected credit arrives next period.'
  }
]);

// The remark GSTN receives as the stated reason for a rejection. It names both
// sides of every field that differs and which way it differs, because the
// supplier reading it has to know which figure to correct.
//
// ASCII only. The IMS schema documents remarks as a 250-char string and says
// nothing about its character set (docs/ims-json-schema.md), and a rupee sign
// rejected by the offline utility's validation would fail the WHOLE upload, not
// just this record. "Rs." costs two characters and cannot fail.
function mismatchRemarks(differences, { document, filingStatus }) {
  const heading = `${document[0].toUpperCase()}${document.slice(1)} mismatch, portal vs our books`;
  const fix = filingStatus === 'SAVED' ? 'Please correct before filing.' : 'Please correct via GSTR-1A.';
  if (!differences.length) return `${heading}. ${fix}`;
  const parts = differences.map(
    (entry) =>
      `${entry.label} ${formatRupeesAscii(entry.portal)} vs ${formatRupeesAscii(entry.books)} ` +
      `(${formatRupeesAscii(entry.magnitude)} ${entry.direction})`
  );
  return `${heading}: ${parts.join('; ')}. ${fix}`;
}

function valueMismatch({ expected, portal, preCutOff, tolerancePaise, materialityTolerancePaise }) {
  const differences = valueDifferences(expected, portal, tolerancePaise);
  const docType = expected?.docType ?? portal?.docType;
  const books = Number(expected?.totalTax ?? 0);
  const portalTax = Number(portal?.totalTax ?? 0);
  const facts = {
    taxGap: portalTax - books,
    tolerance: materialityTolerancePaise,
    books,
    portal: portalTax,
    credit: docType === 'CREDIT_NOTE',
    document: DOCUMENT_LABEL[docType] ?? 'document',
    filingStatus: portal?.filingStatus ?? null,
    preCutOff
  };
  const { action, explain } = MISMATCH_RULES.find((entry) => entry.applies(facts));

  // A bucket of VALUE_MISMATCH with no measurable difference means the caller
  // classified on a different tolerance than the one handed to us. Say that the
  // amounts disagree without quoting a figure, rather than inventing a zero.
  const summary = differences.length
    ? `On this ${facts.document} the portal's ${describeDifferences(differences, formatRupees)} than your books.`
    : `Your books and the portal disagree on the amount of this ${facts.document}.`;

  return {
    action,
    reason: `${summary} ${explain(facts)}`,
    remarks: action === ACTIONS.REJECT ? mismatchRemarks(differences, facts) : null
  };
}

function nonImsReason(portal) {
  if (portal?.reverseCharge) {
    return 'Reverse-charge record. Never enters IMS; tax is paid by the recipient directly.';
  }
  switch (portal?.section) {
    case 'isd':
    case 'isda':
      return 'ISD credit distribution. Appears in 2B only — there is no IMS record to act on.';
    case 'impg':
    case 'impgsez':
      return 'Import of goods (Bill of Entry). Appears in 2B only, not actionable in IMS.';
    default:
      return 'Appears in 2B only. No IMS record exists to act on.';
  }
}

function finalize(decision, { result, portal, window, preCutOff }) {
  let { action, reason, remarks = null } = decision;

  // Honour the IMS blocked flags. Emitting either of these gets the entire upload
  // rejected by the portal, not just the offending record.
  if (action === ACTIONS.PENDING && portal?.pendingBlocked) {
    action = ACTIONS.VERIFY;
    reason = `${reason} Pending is blocked on this record, so it needs manual review instead.`;
    remarks = null;
  }
  if (remarks && portal?.remarksBlocked) remarks = null;
  if (remarks && ![ACTIONS.REJECT, ACTIONS.PENDING].includes(action)) remarks = null;
  if (remarks && remarks.length > REMARKS_MAX_LENGTH) {
    remarks = remarks.slice(0, REMARKS_MAX_LENGTH);
  }

  // The deemed-acceptance guard: an untouched record is accepted for the trader
  // whether they looked at it or not.
  if (window === 'REACTIVE' && portal && portal.imsAction === 'N') {
    reason = `${reason} No action recorded in IMS yet — it will be deemed accepted at GSTR-3B.`;
  }

  return {
    action,
    imsActionCode: IMS_ACTION_CODES[action] ?? null,
    reason,
    remarks,
    // A REJECT, a VERIFY and any verdict on a mismatch wait for a human; only a
    // clean match's ACCEPT stands on its own (services/decisions.js).
    requiresConfirmation:
      action === ACTIONS.REJECT ||
      action === ACTIONS.VERIFY ||
      result.bucket === BUCKETS.VALUE_MISMATCH,
    itcAtRisk: itcAtRisk(result),
    window,
    preCutOff
  };
}

// Rupee impact in paise of getting this one result wrong.
export function itcAtRisk({ bucket, expected, portal }) {
  switch (bucket) {
    // The credit the trader expected and has not received.
    case BUCKETS.MISSING_IN_PORTAL:
      return expected?.totalTax ?? 0;
    // Credit that would be claimed by doing nothing, for a purchase never made.
    case BUCKETS.MISSING_IN_BOOKS:
      return portal?.totalTax ?? 0;
    case BUCKETS.VALUE_MISMATCH:
      return Math.abs((portal?.totalTax ?? 0) - (expected?.totalTax ?? 0));
    case BUCKETS.SUGGESTED:
      return expected?.totalTax ?? 0;
    // Matched credit is safe; ineligible and non-IMS credit was never claimable.
    default:
      return 0;
  }
}

// "12019049" -> "1,20,190.49". Built from the digits of the integer paise, so no
// amount ever passes through a float on its way into a sentence.
export function formatPaise(paise) {
  const digits = String(Math.abs(paise)).padStart(3, '0');
  let head = digits.slice(0, -5);
  const groups = [digits.slice(-5, -2)];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  return `${paise < 0 ? '-' : ''}${groups.join(',')}.${digits.slice(-2)}`;
}

// Two formatters on purpose. `reason` is read by a trader on screen, where the
// rupee sign matches the rest of the app; `remarks` is uploaded to GSTN, where an
// unvalidated character is a risk taken for no benefit. See mismatchRemarks().
function formatRupees(paise) {
  return `₹${formatPaise(paise)}`;
}

export function formatRupeesAscii(paise) {
  return `Rs. ${formatPaise(paise)}`;
}
