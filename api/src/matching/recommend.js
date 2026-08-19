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
// context: { asOfDate, taxPeriod, filingScheme }
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

  const decision = decide({ bucket, expected, portal, preCutOff });

  return finalize(decision, { result, portal, window, preCutOff });
}

function decide({ bucket, expected, portal, preCutOff }) {
  switch (bucket) {
    case BUCKETS.MATCHED:
      return {
        action: ACTIONS.ACCEPT,
        reason: 'Books and portal agree on supplier, number, date and amount.'
      };

    case BUCKETS.VALUE_MISMATCH:
      return valueMismatch({ expected, portal, preCutOff });

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

function valueMismatch({ expected, portal, preCutOff }) {
  const delta = (portal?.totalTax ?? 0) - (expected?.totalTax ?? 0);
  const direction = delta > 0 ? 'higher' : 'lower';
  const magnitude = formatRupees(Math.abs(delta));

  // A saved record is still editable by the supplier. Before the cut-off this is
  // the golden window: one phone call, the supplier corrects the draft, and
  // nothing is lost. Same error caught a week later costs a month of cash flow.
  if (portal?.filingStatus === 'SAVED') {
    if (preCutOff !== false) {
      return {
        action: ACTIONS.CHASE_SUPPLIER,
        reason:
          `Portal tax is ${magnitude} ${direction} than books, and the record is only saved, ` +
          'not filed. The supplier can still correct it for free before the cut-off.'
      };
    }
    return {
      action: ACTIONS.CHASE_SUPPLIER,
      reason:
        `Portal tax is ${magnitude} ${direction} than books and the record was never filed. ` +
        'A correction now reaches a later period, not this one.'
    };
  }

  // Filed: the supplier can no longer edit. Rejecting purges it from 2B and puts
  // the onus on them to re-report through GSTR-1A, which lands next period.
  return {
    action: ACTIONS.REJECT,
    reason:
      `Portal tax is ${magnitude} ${direction} than books and the record is filed. ` +
      'Reject and ask the supplier to re-report via GSTR-1A — that credit arrives next period.',
    remarks: `Value mismatch: books tax differs from portal by ${magnitude}.`
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

function formatRupees(paise) {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
