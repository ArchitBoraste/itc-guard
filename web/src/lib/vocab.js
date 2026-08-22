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
