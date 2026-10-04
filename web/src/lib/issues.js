// One name per idea (docs/design/README.md, "Principles"). Every screen that
// names an issue, a recommendation or a portal status reads it from here, so the
// same record is never "Amounts disagree" on one screen and "Higher on portal" on
// the next. Engine codes stay in data attributes; only these words are shown.
import { rupees, rupeesExact } from './money.js';

const MATERIALITY_PAISE = 100;

export const DOC_TYPE_LABEL = {
  INVOICE: 'Invoice',
  DEBIT_NOTE: 'Debit note',
  CREDIT_NOTE: 'Credit note'
};

const isSaved = (result) => result.portal?.filingStatus === 'SAVED';
const isCreditNote = (result) => (result.books ?? result.portal)?.docType === 'CREDIT_NOTE';
const taxGap = (result) =>
  result.books && result.portal ? result.portal.totalTax - result.books.totalTax : 0;

// A record outside IMS: reverse charge, ineligible, ISD or imports.
export const isOutsideIms = (result) => result.bucket === 'NON_IMS' || result.bucket === 'INELIGIBLE';

// Not filed by suppliers: a document in the books whose supplier has filed
// nothing for it, or has only saved it. The same rule as the Not filed yet screen
// (GET /api/alerts), applied to the run's own rows.
export function isNotFiled(result) {
  if (!result.books || isOutsideIms(result)) return false;
  return !result.portal || isSaved(result);
}

// issueOf(result) -> { key, label, tone }
//
// key is stable for tests and data attributes; label is what the trader reads.
export function issueOf(result) {
  const gap = taxGap(result);
  switch (result.bucket) {
    case 'MATCHED':
      if (isSaved(result)) return { key: 'SAVED_NOT_FILED', label: 'Saved, not filed', tone: 'warn' };
      if (gap !== 0) return { key: 'ROUNDING', label: `${rupeesExact(Math.abs(gap))} rounding`, tone: 'ok' };
      return { key: 'MATCHES', label: 'Matches', tone: 'ok' };
    case 'VALUE_MISMATCH':
      if (isSaved(result)) {
        return { key: 'SAVED_DIFFERENT', label: 'Saved with a different amount', tone: 'warn' };
      }
      if (Math.abs(gap) <= MATERIALITY_PAISE) {
        return gap === 0
          ? { key: 'MATCHES', label: 'Matches', tone: 'ok' }
          : { key: 'ROUNDING', label: `${rupeesExact(Math.abs(gap))} rounding`, tone: 'ok' };
      }
      return gap > 0
        ? { key: 'HIGHER', label: 'Higher on portal', tone: 'warn' }
        : { key: 'LOWER', label: 'Lower on portal', tone: 'warn' };
    case 'SUGGESTED':
      return { key: 'INVOICE_NO_DIFFERS', label: 'Invoice no. differs', tone: 'warn' };
    case 'MISSING_IN_BOOKS':
      return { key: 'NOT_IN_BOOKS', label: 'Not in your books', tone: 'bad' };
    case 'MISSING_IN_PORTAL':
      return isSaved(result)
        ? { key: 'SAVED_NOT_FILED', label: 'Saved, not filed', tone: 'warn' }
        : { key: 'NOT_ON_PORTAL', label: 'Not on portal', tone: 'neutral' };
    case 'INELIGIBLE':
      return { key: 'INELIGIBLE', label: 'Credit not available', tone: 'neutral' };
    case 'NON_IMS':
      return { key: 'OUTSIDE_IMS', label: outsideImsLabel(result), tone: 'neutral' };
    default:
      return { key: 'OTHER', label: 'Check', tone: 'muted' };
  }
}

function outsideImsLabel(result) {
  const section = result.portal?.section;
  if ((result.flags ?? []).includes('RCM')) return 'Reverse charge';
  if (section === 'isd' || section === 'isda') return 'ISD credit';
  if (section === 'impg' || section === 'impgsez') return 'Import';
  return 'Outside IMS';
}

// A difference within the ₹1 tolerance that was accepted as it stands.
export const isRounding = (result) => issueOf(result).key === 'ROUNDING';

// Everything Overview lists under "What we found": any row that is not a clean,
// filed match. Records outside IMS have their own line.
export function needsMention(result) {
  if (isOutsideIms(result)) return false;
  return issueOf(result).key !== 'MATCHES';
}

// recommendationOf(result) -> { label, tone, ims }
//
// ims is the IMS action the recommendation proposes, or null when it proposes
// none (a phone call, or nothing to do). "Accept if same bill" proposes ACCEPT:
// accepting a suggested match follows the recommendation (audit P24).
export function recommendationOf(result) {
  switch (result.recommendedAction) {
    case 'ACCEPT':
      if (result.bucket === 'VALUE_MISMATCH' && taxGap(result) < -MATERIALITY_PAISE && !isCreditNote(result)) {
        return { label: `Accept ${rupees(result.portal.totalTax)}`, tone: 'ok', ims: 'ACCEPT' };
      }
      return { label: 'Accept', tone: 'ok', ims: 'ACCEPT' };
    case 'REJECT':
      return { label: 'Reject', tone: 'bad', ims: 'REJECT' };
    case 'PENDING':
      return { label: 'Pending', tone: 'warn', ims: 'PENDING' };
    case 'VERIFY':
      return { label: 'Accept if same bill', tone: 'info', ims: 'ACCEPT' };
    case 'CHASE_SUPPLIER':
      return { label: 'Call supplier', tone: 'info', ims: null };
    case 'DEFERRED':
      return { label: 'Wait for supplier', tone: 'neutral', ims: null };
    default:
      return { label: 'Nothing to do', tone: 'muted', ims: null };
  }
}

// whyLine(result) -> the one sentence under books-vs-portal in an expanded row.
//
// Credit notes read differently from invoices: rejecting one stops a reversal
// that is too large, and nothing "arrives" later.
export function whyLine(result) {
  const creditNote = isCreditNote(result);
  const gap = taxGap(result);
  const issue = issueOf(result).key;
  switch (issue) {
    case 'MATCHES':
      return creditNote
        ? 'Credit note matches. Accepting it reduces your credit exactly as your books expect.'
        : 'Supplier, number, date and amounts all match.';
    case 'ROUNDING':
      return `Tax differs by ${rupeesExact(Math.abs(gap))}, inside the ₹1 tolerance. Claim the lower figure.`;
    case 'HIGHER':
      return creditNote
        ? 'The portal reverses more credit than your books. Reject it and ask the supplier to correct the note.'
        : 'The portal shows more than your bill. Accepting would claim credit you are not owed, so reject and ask for a correction.';
    case 'LOWER':
      return creditNote
        ? 'The portal reverses less than your books. Accept it; your books reversal still stands, so ask for the difference.'
        : `The portal shows less than your bill. Accept what is there now and ask the supplier for the ${rupees(Math.abs(gap))} difference.`;
    case 'SAVED_DIFFERENT':
      return (result.flags ?? []).includes('CUTOFF_PASSED')
        ? 'Saved with a different amount and not filed by the cut-off. Decide on the amount shown, then ask for a correction.'
        : 'Saved with a different amount. The supplier can still correct it for free before filing.';
    case 'SAVED_NOT_FILED':
      return 'Saved by the supplier but not filed, so it cannot reach your GSTR-2B yet.';
    case 'INVOICE_NO_DIFFERS':
      return `Same supplier and amount, but the number is ${result.portal?.invoiceNo ?? 'different'} on the portal. Check your bill; if it is the same one, accept.`;
    case 'NOT_IN_BOOKS':
      return 'On the portal but not in your purchase register. If no goods came in, reject it, or it is accepted automatically when GSTR-3B is filed.';
    case 'NOT_ON_PORTAL':
      return 'In your books, but the supplier has not filed it. There is nothing in IMS to accept yet.';
    case 'INELIGIBLE':
      return 'The portal marks the credit on this record as not available.';
    case 'OUTSIDE_IMS':
      return 'This reaches GSTR-2B directly and never passes through IMS.';
    default:
      return '';
  }
}

// Filing scheme as a supplier row shows it: "Monthly (assumed)", "Quarterly ·
// set by you". An inferred scheme without evidence is an assumption.
export function schemeLabel({ filingScheme, filingSchemeSource, filingSchemeConfidence } = {}) {
  const name = filingScheme === 'QRMP' ? 'Quarterly' : 'Monthly';
  if (filingSchemeSource === 'USER') return `${name} · set by you`;
  if (!filingSchemeConfidence || filingSchemeConfidence === 'LOW') return `${name} (assumed)`;
  return name;
}

// Not filed yet: the three ways a document can still be waiting on its supplier.
export const NOT_FILED_STATUS = {
  NOT_REPORTED: { label: 'Not on portal', tone: 'neutral' },
  SAVED_NOT_FILED: { label: 'Saved, not filed', tone: 'warn' },
  SAVED_VALUE_MISMATCH: { label: 'Saved with a different amount', tone: 'warn' }
};

export const RISK_CHIP = {
  HIGH: { label: 'High', tone: 'bad-solid' },
  MEDIUM: { label: 'Medium', tone: 'warn' },
  LOW: { label: 'Low', tone: 'ok' }
};
