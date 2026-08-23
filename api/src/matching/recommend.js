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
//     the 10th and REJECT/DEFERRED on the 16th.
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

// recommendAction(result, context) ->
//   { action, imsActionCode, reason, remarks, requiresConfirmation, itcAtRisk }
//
// context: { asOfDate, taxPeriod, filingScheme, tolerancePaise }
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

  const decision = decide({ bucket, expected, portal, preCutOff, tolerancePaise });

  return finalize(decision, { result, portal, window, preCutOff });
}

function decide({ bucket, expected, portal, preCutOff, tolerancePaise }) {
  switch (bucket) {
    case BUCKETS.MATCHED:
      return {
        action: ACTIONS.ACCEPT,
        reason: 'Books and portal agree on supplier, number, date and amount.'
      };

    case BUCKETS.VALUE_MISMATCH:
      return valueMismatch({ expected, portal, preCutOff, tolerancePaise });

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

// The remark GSTN receives as the stated reason for a rejection. It names both
// sides of every field that differs, because the supplier reading it has to know
// which figure to correct.
//
// ASCII only. The IMS schema documents remarks as a 250-char string and says
// nothing about its character set (docs/ims-json-schema.md), and a rupee sign
// rejected by the offline utility's validation would fail the WHOLE upload, not
// just this record. "Rs." costs two characters and cannot fail.
function mismatchRemarks(differences) {
  if (!differences.length) return 'Value mismatch between books and portal.';
  const parts = differences.map(
    (entry) =>
      `${entry.label} ${formatRupeesAscii(entry.portal)} on portal vs ` +
      `${formatRupeesAscii(entry.books)} in books`
  );
  return `Value mismatch: ${parts.join('; ')}.`;
}

function valueMismatch({ expected, portal, preCutOff, tolerancePaise }) {
  const differences = valueDifferences(expected, portal, tolerancePaise);

  // A bucket of VALUE_MISMATCH with no measurable difference means the caller
  // classified on a different tolerance than the one handed to us. Say that the
  // amounts disagree without quoting a figure, rather than inventing a zero.
  const summary = differences.length
    ? `Portal ${describeDifferences(differences, formatRupees)} than books`
    : 'Books and portal disagree on the amount';

  // A saved record is still editable by the supplier. Before the cut-off this is
  // the golden window: one phone call, the supplier corrects the draft, and
  // nothing is lost. Same error caught a week later costs a month of cash flow.
  if (portal?.filingStatus === 'SAVED') {
    if (preCutOff !== false) {
      return {
        action: ACTIONS.CHASE_SUPPLIER,
        reason:
          `${summary}. The record is only saved, not filed, so the supplier can ` +
          'still correct it for free before the cut-off.'
      };
    }
    return {
      action: ACTIONS.CHASE_SUPPLIER,
      reason:
        `${summary}. The record was never filed, so a correction now reaches a ` +
        'later period, not this one.'
    };
  }

  // Filed: the supplier can no longer edit. Rejecting purges it from 2B and puts
  // the onus on them to re-report through GSTR-1A, which lands next period.
  return {
    action: ACTIONS.REJECT,
    // Kept as two sentences: with more than one field differing, "...lower and tax
    // is ... lower and the record is filed" stacks conjunctions until nothing is
    // readable.
    reason:
      `${summary}. The record is filed, so reject and ask the supplier to ` +
      're-report via GSTR-1A — that credit arrives next period.',
    remarks: mismatchRemarks(differences)
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
    // A REJECT is never applied without a human saying so.
    requiresConfirmation: action === ACTIONS.REJECT || result.bucket === BUCKETS.SUGGESTED,
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

// Two formatters on purpose. `reason` is read by a trader on screen, where the
// rupee sign matches the rest of the app; `remarks` is uploaded to GSTN, where an
// unvalidated character is a risk taken for no benefit. See mismatchRemarks().
function formatAmount(paise) {
  return (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatRupees(paise) {
  return `₹${formatAmount(paise)}`;
}

export function formatRupeesAscii(paise) {
  return `Rs. ${formatAmount(paise)}`;
}
