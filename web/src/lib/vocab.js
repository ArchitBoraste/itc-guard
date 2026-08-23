// Engine vocabulary -> plain English.
//
// The CODES stay intact everywhere they matter — data-testid attributes, filter
// values, the IMS JSON — because they are the contract. Only the words a trader
// reads are translated. Nobody running a hardware shop knows what NON_IMS means.

export const BUCKETS = [
  'VALUE_MISMATCH',
  'MISSING_IN_BOOKS',
  'SUGGESTED',
  'MISSING_IN_PORTAL',
  'MATCHED',
  'INELIGIBLE',
  'NON_IMS'
];

export const BUCKET_LABEL = {
  MATCHED: 'Agrees with the portal',
  VALUE_MISMATCH: 'Amounts disagree',
  SUGGESTED: 'Probably the same invoice',
  MISSING_IN_PORTAL: 'In your books, never reported',
  MISSING_IN_BOOKS: 'On the portal, not in your books',
  INELIGIBLE: 'Credit not available',
  NON_IMS: 'Shows in 2B only'
};

export const BUCKET_HELP = {
  MATCHED:
    'Supplier, invoice number, date and amounts all line up. Nothing to chase.',
  VALUE_MISMATCH:
    'Matched to a portal record, but the rupee amounts differ. Either your books ' +
    'or the supplier got a figure wrong.',
  SUGGESTED:
    'The money agrees but the invoice number still differs after normalisation. ' +
    'Cheap for you to confirm, dangerous to accept blind.',
  MISSING_IN_PORTAL:
    'You booked this purchase and the supplier has not reported it. There is no ' +
    'portal record to accept.',
  MISSING_IN_BOOKS:
    'The supplier reported this and it is not in your purchase register. Left ' +
    'alone it is deemed accepted at GSTR-3B.',
  INELIGIBLE:
    'The portal marks ITC as unavailable on this record. It was never claimable.',
  NON_IMS:
    'Reverse charge, ISD or imports. These reach GSTR-2B directly and never pass ' +
    'through IMS, so there is no record to act on.'
};

// The engine's recommendation vocabulary. CHASE_SUPPLIER / VERIFY / DEFERRED are
// workflow states for the trader, not portal actions.
export const ACTION_LABEL = {
  ACCEPT: 'Accept',
  REJECT: 'Reject',
  PENDING: 'Pending',
  VERIFY: 'Verify',
  DEFERRED: 'Deferred',
  CHASE_SUPPLIER: 'Chase supplier',
  NO_ACTION: 'No action'
};

export const ACTION_HELP = {
  ACCEPT: 'Accept the record in IMS. The credit is claimed this period.',
  REJECT:
    'Reject in IMS and ask the supplier to re-report via GSTR-1A. That credit ' +
    'arrives next period, never this one.',
  PENDING: 'Hold the record in IMS without deciding. It carries to the next period.',
  VERIFY: 'Needs a human decision before anything is sent to the portal.',
  DEFERRED:
    'Nothing can be done this period — no IMS record exists to act on and the ' +
    'cut-off has passed.',
  CHASE_SUPPLIER:
    'Call the supplier. The cut-off has not passed, so their fix still lands in ' +
    'this period for free.',
  NO_ACTION: 'No IMS action applies to this record.'
};

// The order the action list presents its groups in.
export const ACTION_ORDER = [
  'ACCEPT',
  'REJECT',
  'PENDING',
  'VERIFY',
  'CHASE_SUPPLIER',
  'DEFERRED',
  'NO_ACTION'
];

// Groups that represent an open decision rather than a settled one.
export const NEEDS_ATTENTION = new Set(['REJECT', 'PENDING', 'VERIFY', 'CHASE_SUPPLIER']);

// Mirrors services/imsActions.js. A workflow state means "do nothing in IMS yet",
// which is action N — and N is exactly what deemed acceptance acts on.
export const RECOMMENDED_TO_IMS = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  PENDING: 'PENDING',
  NO_ACTION: 'NO_ACTION',
  CHASE_SUPPLIER: 'NO_ACTION',
  VERIFY: 'NO_ACTION',
  DEFERRED: 'NO_ACTION'
};

// The four the portal understands, in the order the row controls show them.
export const IMS_ACTIONS = ['ACCEPT', 'REJECT', 'PENDING', 'NO_ACTION'];
export const IMS_ACTION_CODE = { ACCEPT: 'A', REJECT: 'R', PENDING: 'P', NO_ACTION: 'N' };

export const TOTAL_BUCKET_LABEL = {
  CLAIMABLE: 'Claimable',
  AT_RISK: 'At risk',
  DEFERRED: 'Deferred',
  INELIGIBLE: 'Ineligible',
  NON_IMS: 'Outside IMS'
};

export const FLAG_LABEL = {
  GSTIN_MISMATCH: 'GSTIN differs',
  FUZZY_INV_NO: 'Invoice number differs',
  DATE_DRIFT: 'Dates differ',
  DUPLICATE_INV_NO: 'Duplicate invoice number',
  RCM: 'Reverse charge',
  ITC_INELIGIBLE: 'ITC not available',
  NON_IMS_SECTION: 'Not an IMS section',
  SUPPLIER_UNFILED: 'Supplier has saved but not filed',
  LATE_FILING: 'Filed late',
  CHANGED_AFTER_REVIEW: 'Supplier changed this after you reviewed it',
  CONFIRMATION_RESET: 'Your decision was reset'
};

// Why a stored verdict no longer describes the record it is shown against.
//
// STALE and WITHDRAWN are both un-actionable and are deliberately NOT the same
// message: re-running fixes the first and cannot fix the second, so offering
// "re-run the reconciliation" on a withdrawn record would be advice that never
// works.
export const STALE_HELP = {
  PORTAL_CHANGED:
    'The supplier changed this record after this run was computed. The verdict, ' +
    'the score and the recommendation above all describe the old figures. Re-run ' +
    'the reconciliation before deciding — the figures shown are current, the ' +
    'verdict is not.',
  // Not the same claim. Nothing is known to have changed; the run simply cannot
  // prove it has not, and saying "the supplier changed this" would be inventing a
  // fact.
  UNVERIFIABLE:
    'This run was computed before the app started recording which version of each ' +
    'portal record a verdict was about, so there is no way to tell whether these ' +
    'still agree. Re-run the reconciliation once and it will say for certain.'
};

export const WITHDRAWN_HELP =
  'The supplier has withdrawn this record from the portal. There is no IMS record ' +
  'left to accept or reject, and re-running will not bring it back — it returns ' +
  'only if the supplier reports it again.';

// --- what changed on the portal between two downloads ----------------------
//
// Mirrors CHANGE_TYPES in api/src/services/syncDiff.js. The words are the
// trader's, not the schema's: nobody thinks "STATUS_CHANGE", they think "they
// finally filed it".
export const CHANGE_TYPE_LABEL = {
  NEW: 'Newly reported',
  AMENDED: 'Amounts changed',
  DISAPPEARED: 'Withdrawn by the supplier',
  REAPPEARED: 'Back on the portal',
  STATUS_CHANGE: 'Now filed'
};

export const CHANGE_TYPE_HELP = {
  NEW: 'The supplier added this after your last download. Left unactioned it is ' +
    'deemed accepted at GSTR-3B.',
  AMENDED: 'The supplier edited what they had reported. Anything you decided was ' +
    'about the old figures.',
  DISAPPEARED:
    'The supplier deleted this saved record before filing. There is nothing left ' +
    'in IMS to accept, and no credit unless they report it again.',
  REAPPEARED: 'The supplier had deleted this and has reported it again.',
  STATUS_CHANGE:
    'Saved became filed. Until now their fix was free; from here a correction ' +
    'needs GSTR-1A and the credit lands next period.'
};

export const CHANGE_FIELD_LABEL = {
  supplierGstin: 'Supplier GSTIN',
  invoiceNoNorm: 'Invoice number',
  invoiceDate: 'Invoice date',
  docType: 'Document type',
  taxableValue: 'Taxable value',
  totalTax: 'Total tax',
  igst: 'IGST',
  cgst: 'CGST',
  sgst: 'SGST',
  cess: 'Cess',
  filingStatus: 'Filing status'
};

// Which changed fields are integer paise and must be rendered as rupees.
export const CHANGE_MONEY_FIELDS = new Set([
  'taxableValue', 'totalTax', 'igst', 'cgst', 'sgst', 'cess'
]);

export const SECTION_LABEL = {
  b2b: 'B2B',
  b2ba: 'B2B amendment',
  cdnr: 'Credit/debit note',
  cdnra: 'Note amendment',
  isd: 'ISD',
  isda: 'ISD amendment',
  impg: 'Import of goods',
  impgsez: 'Import from SEZ',
  ecom: 'E-commerce',
  ecoma: 'E-commerce amendment'
};

export const DOC_TYPE_LABEL = {
  INVOICE: 'Invoice',
  DEBIT_NOTE: 'Debit note',
  CREDIT_NOTE: 'Credit note',
  ISD_INVOICE: 'ISD invoice',
  ISD_CREDIT: 'ISD credit note',
  BOE: 'Bill of entry',
  UNKNOWN: 'Unknown'
};

// A record with no IMS row cannot be actioned at all — the writer only emits
// source = 'IMS' records, and confirmResult returns 409 for ISD and imports. The
// UI must never offer a control that the API is guaranteed to refuse.
export function actionability(result) {
  if (!result.portal) {
    return {
      kind: 'BOOKS_ONLY',
      allowed: ['NO_ACTION'],
      why: 'Nothing was reported on the portal, so there is no IMS record to accept or reject.'
    };
  }
  if (result.bucket === 'NON_IMS' || result.portal.source !== 'IMS') {
    return {
      kind: 'NOT_IN_IMS',
      allowed: [],
      why: BUCKET_HELP[result.bucket] ?? 'This record reaches GSTR-2B directly and never enters IMS.'
    };
  }
  const allowed = IMS_ACTIONS.filter(
    (action) => !(action === 'PENDING' && result.portal.pendingBlocked)
  );
  return {
    kind: 'IMS',
    allowed,
    why: result.portal.pendingBlocked
      ? 'The portal blocks Pending on this record (ispendactblocked = Y). Sending it ' +
        'would make the portal reject the whole upload.'
      : null
  };
}

// What is actually going into the IMS file for this row right now.
export function effectiveAction(result) {
  return result.confirmedAction ?? RECOMMENDED_TO_IMS[result.recommendedAction] ?? 'NO_ACTION';
}

// True when the trader chose something other than what the engine proposed.
export function isOverride(result) {
  if (!result.confirmedAction) return false;
  return result.confirmedAction !== RECOMMENDED_TO_IMS[result.recommendedAction];
}
