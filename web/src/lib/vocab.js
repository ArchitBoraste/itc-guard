// Engine vocabulary -> plain English.
//
// The CODES stay intact everywhere they matter — data-testid attributes, filter
// values, the IMS JSON — because they are the contract. Only the words a trader
// reads are translated. Nobody running a hardware shop knows what NON_IMS means.
import { rupeesExact } from './money.js';

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
  // Placeholder only — CHASE_SUPPLIER depends on the calendar, so read it through
  // actionHelp() below and never straight out of this table.
  CHASE_SUPPLIER:
    'Call the supplier. Whether their fix still lands in this period depends on ' +
    'their own cut-off.',
  NO_ACTION: 'No IMS action applies to this record.'
};

// actionHelp(action, results) -> the sentence shown above a group.
//
// Every other action means the same thing whatever day it is. CHASE_SUPPLIER does
// not: before a supplier's cut-off the fix is free and lands this period, after it
// the same call gets the credit into a LATER period instead of losing it. The
// static sentence used to promise the first case unconditionally, so on the 16th
// the group header read "the cut-off has not passed" directly above rows saying a
// correction now reaches a later period.
//
// The cut-off is per SUPPLIER, so this cannot be derived from the run's one date.
// It counts the CUTOFF_PASSED flag the engine wrote against each result, which is
// the same verdict the row's own explanation was built from.
export function actionHelp(action, results = []) {
  if (action !== 'CHASE_SUPPLIER' || !results.length) return ACTION_HELP[action];

  const past = results.filter((result) => result.flags?.includes('CUTOFF_PASSED')).length;

  let timing;
  if (past === 0) {
    timing =
      'Their cut-off has not passed, so their fix still lands in this period for free.';
  } else if (past === results.length) {
    timing =
      'Their cut-off has passed. Calling still matters — it is how the credit reaches a ' +
      'later period instead of being lost — but it can no longer land in this period.';
  } else {
    timing =
      `${past} of ${results.length} are past their supplier's cut-off: for those, a fix ` +
      'now reaches a later period, not this one. The rest are still inside the free-fix ' +
      'window, where the correction costs nothing.';
  }

  return `Call the supplier. ${timing}${portalActionClause(results)}`;
}

// What the group used to leave out, and it is the half that costs money.
//
// A CHASE_SUPPLIER record can be either of two quite different things. If it is
// in IMS with the wrong amounts, a portal action is available RIGHT NOW and doing
// nothing is itself a decision: the IMS file emits N for this group
// (RECOMMENDED_TO_IMS.CHASE_SUPPLIER), and N is exactly what deemed acceptance
// acts on — so the trader silently accepts the supplier's figure rather than
// their own. If it is absent from IMS there is no record to act on and the phone
// call is the only lever. The old text described neither case.
function portalActionClause(results) {
  const inIms = results.filter(
    (result) => result.portal && result.portal.source === 'IMS'
  );
  if (!inIms.length) {
    return (
      ' None of these are in IMS, so there is no portal record to accept or reject — ' +
      'the call is the only thing that moves them.'
    );
  }

  const differences = inIms
    .filter((result) => Number.isFinite(result.deltaTotalTax) && result.deltaTotalTax !== 0)
    .map((result) => {
      const name = result.books?.supplierName ?? result.portal?.supplierName ?? 'this supplier';
      // From integer paise, never paise / 100 (audit P37).
      const amount = rupeesExact(Math.abs(result.deltaTotalTax));
      return `${name} ${amount} ${result.deltaTotalTax < 0 ? 'below' : 'above'} your books`;
    });

  const scope =
    inIms.length === results.length
      ? 'These are in IMS'
      : `${inIms.length} of ${results.length} are in IMS`;

  const named = differences.length
    ? ` — ${differences.slice(0, 3).join(', ')}${differences.length > 3 ? `, and ${differences.length - 3} more` : ''}`
    : '';

  return (
    ` ${scope} with the wrong amounts, so Accept and Reject are available on them right ` +
    `now${named}. Left alone they go into the IMS file as no action, and no action is ` +
    "deemed acceptance at GSTR-3B — you would be accepting the portal's figure, not yours."
  );
}

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

// The IMS actions that are a decision. N is the portal's "nothing recorded", so it
// never is — whoever chose it. Mirrors IMS_DECISIONS in api/src/services/decisions.js.
export const IMS_DECISIONS = new Set(['ACCEPT', 'REJECT', 'PENDING']);

// The IMS action each recommendation proposes. A workflow state proposes nothing,
// which is N — and N is exactly what deemed acceptance acts on, so it is never a
// decision (IMS_DECISIONS).
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
  CUTOFF_PASSED: 'Cut-off has passed',
  CHANGED_AFTER_REVIEW: 'Supplier changed this after you reviewed it',
  CONFIRMATION_RESET: 'Your decision was reset'
};

// Flags that are true of a result but are NOT row-level exceptions, so they do
// not earn a chip next to GSTIN_MISMATCH and CHANGED_AFTER_REVIEW.
//
// CUTOFF_PASSED is true of EVERY result in a run read after the cut-off — 424 of
// 424 in the April demo period. Rendering it per row would put an identical chip
// on four hundred rows that are perfectly fine, and bury the handful of flags
// that actually mean something. It is calendar context for the group header
// (see actionHelp), not a mark against the invoice.
export const ROW_FLAGS_HIDDEN = new Set(['CUTOFF_PASSED']);

export const rowFlags = (flags = []) => flags.filter((flag) => !ROW_FLAGS_HIDDEN.has(flag));

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

// exposureSplit(entry) -> the two components behind an "at stake" figure, or
// null when nothing pulls the other way.
//
// Still fixable measures EXPOSURE — how much credit is unsettled and still
// chaseable — not what a period can claim. So the headline is the gross, and
// this says what it is made of. An unreported invoice and an unreported credit
// note are two problems, and the net of them describes neither: Patel Systems'
// April pair netted to MINUS Rs 5,577 out of Rs 51,278 unsettled.
//
// Summary's Deferred card already splits this exact pair. This is the same idea
// on the screen that was still adding them together.
export function exposureSplit(entry) {
  const other = entry?.breakdown?.otherDocuments;
  const notes = entry?.breakdown?.creditNotes;
  if (!notes?.count) return null;
  return {
    owed: { count: other?.count ?? 0, itc: Math.abs(other?.itc ?? 0) },
    claimed: { count: notes.count, itc: Math.abs(notes.itc) },
    netItc: entry.netItc ?? 0
  };
}

// --- preventive alerts ------------------------------------------------------
//
// Mirrors api/src/services/preventive.js. The band is a claim about the SUPPLIER,
// the urgency is a claim about the CALENDAR, and they are shown separately
// because they move independently: a reliable supplier on the 12th is low risk
// and out of time, which is a different sentence from either one alone.

export const RISK_BAND_LABEL = {
  HIGH: 'Chase these',
  MEDIUM: 'Worth a look',
  LOW: 'Normal for this point in the month',
  // A DISPLAY band, not a fourth risk level. The stored band stays MEDIUM — the
  // phase 7 call that absence of history is not evidence of reliability is right
  // and is unchanged. What was wrong was the sentence: "Worth a look" over three
  // clean facts and "only 1 month of history" reads as a model that has gone
  // wrong, and it collapses "we do not know yet" into "we have concerns".
  UNPROVEN: 'Too early to say'
};

// What a band says about the SUPPLIER'S RECORD. True whichever day it is read on,
// which is the point: everything calendar-dependent has been lifted out into
// bandHelp() below.
//
// These used to carry the calendar too, and it contradicted the cards underneath
// them. LOW read "Not reported yet, and that is normal — GSTR-1 is not due until
// their cut-off" while Mahavir Sales Corp inside it showed a red "Cut-off passed"
// chip and a GSTR-1A consequence: the header said nothing was wrong, the card
// said the credit had slipped a month. HIGH promised "a phone call today is free"
// on a date when it was not.
export const RISK_BAND_CLAIM = {
  HIGH:
    'These suppliers have a filing record that says the invoice may not arrive, ' +
    'or may arrive too late to count.',
  MEDIUM:
    'Some history of filing late or short. Worth a message if the amount ' +
    'matters to you.',
  UNPROVEN:
    'Not enough filing history to judge yet. Not a concern and not a clean ' +
    'bill of health — just too early to say either way.',
  LOW:
    'Nothing in their filing record suggests a problem. Listed so nothing is ' +
    'hidden, not because anything is wrong.'
};

// bandHelp(band, suppliers) -> the sentence shown above a group on Still fixable.
//
// Exactly the shape of actionHelp() above, and for exactly the same reason. The
// engine already decides per supplier whether their own cut-off has passed —
// 11th for a monthly filer, 13th for QRMP — so a group can hold both kinds at
// once and no single static sentence is true of it. This counts what is actually
// in the group and says that.
//
// preCutOff is true / false / null, and null means the date could not be
// resolved rather than "not passed". Unknowns are excluded from BOTH sides of the
// count: claiming nothing is past its cut-off because we failed to work it out is
// the same class of mistake this function exists to remove.
export function bandHelp(band, suppliers = []) {
  const claim = RISK_BAND_CLAIM[band] ?? '';

  // Suppliers the API moved up a band because their own cut-off passed. Their
  // filing record is not why they are in this group, so the band's record-based
  // claim is not about them.
  const escalated = suppliers.filter((supplier) => supplier?.escalated === true).length;

  if (suppliers.length && escalated === suppliers.length) {
    return (
      'Every supplier here is past their own cut-off with nothing reported. Their ' +
      'filing record is not what put them in this group — the deadline is. Chasing ' +
      'still matters, because it is how the credit reaches a later period instead ' +
      'of being lost, but it can no longer land in this one.'
    );
  }

  const known = suppliers.filter(
    (supplier) => supplier?.preCutOff === true || supplier?.preCutOff === false
  );
  if (!known.length) return claim;

  const past = known.filter((supplier) => supplier.preCutOff === false).length;

  let clause;
  if (past === 0) {
    clause =
      'None of them are past their own cut-off yet, so there is still time for ' +
      'the invoice to land in this period.';
  } else if (past === known.length) {
    clause =
      'All of them are past their own cut-off: chasing still matters — it is how ' +
      'the credit reaches a later period instead of being lost — but it can no ' +
      'longer land in this one.';
  } else {
    clause =
      `${past} of ${known.length} are past their supplier's cut-off — for those, a ` +
      'correction now reaches a later period, not this one. The rest are still ' +
      'inside the window where it costs nothing.';
  }

  // A group holding both kinds has to say so, or the record-based claim silently
  // gets applied to somebody whose record is clean.
  const note = escalated
    ? ` ${escalated} of them moved up from a calmer group because their cut-off ` +
      'passed, not because of their filing record.'
    : '';

  return `${claim} ${clause}${note}`;
}

export const URGENCY_LABEL = {
  EARLY: 'Time in hand',
  CHASE: 'Chase now',
  URGENT: 'Almost out of time',
  LAST_DAY: 'Cut-off is today',
  PAST_CUTOFF: 'Cut-off passed'
};

export const ALERT_STATUS_LABEL = {
  NOT_REPORTED: 'Not in IMS',
  SAVED_NOT_FILED: 'Saved, not filed',
  SAVED_VALUE_MISMATCH: 'Saved with different amounts'
};

// Why a document was kept OFF Still fixable entirely. Mirrors EXCLUDED_REASONS
// and excludedReasonFor() in api/src/services/preventive.js.
//
// None of these are concerns. Each one is a document that reaches GSTR-2B
// directly and never enters IMS, so its absence from IMS is the finished state
// rather than a supplier running late.
export const EXCLUDED_REASON_LABEL = {
  REVERSE_CHARGE: 'on reverse charge',
  ITC_INELIGIBLE: 'where the portal says you cannot claim the credit',
  NON_IMS_SECTION: 'imports, or credit passed down from a head office'
};

// excludedSentence(excluded) -> the quiet line under the summary cards, or null
// when nothing was left out.
//
// Said out loud rather than dropped silently: this removes 32 of 36 documents and
// 21 of 24 suppliers on the April sample, and a screen whose headline falls from
// Rs 13.29 L to Rs 79,211 between two versions has to say where the difference
// went or it reads as lost data.
export function excludedSentence(excluded, formatMoney) {
  if (!excluded?.invoiceCount) return null;

  const parts = Object.entries(excluded.byReason ?? {})
    .filter(([, part]) => part.count > 0)
    .map(([reason, part]) => `${part.count} ${EXCLUDED_REASON_LABEL[reason] ?? reason}`);

  const docs = `${excluded.invoiceCount} document${excluded.invoiceCount === 1 ? '' : 's'}`;
  const suppliers = excluded.supplierCount
    ? ` from ${excluded.supplierCount} supplier${excluded.supplierCount === 1 ? '' : 's'}`
    : '';

  return (
    `Left out: ${docs}${suppliers}, ${formatMoney(Math.abs(excluded.itcAtStake))} — ` +
    `${parts.join(', ')}. Your supplier cannot change these and there is nothing for ` +
    'you to accept, so nothing above counts them. Summary still does.'
  );
}

// --- why the two screens count different things -----------------------------
//
// The single most confusing thing in the app, and it is not a bug in either
// screen: Still fixable reconciles the books against IMS ALONE, because IMS is
// the only source that exists before the cut-off and the only one that shows a
// record a supplier has merely SAVED. Summary reconciles against IMS and
// GSTR-2B together, because by the 14th both exist.
//
// So a document already filed into 2B is "reported" on Summary while still
// counting here — and the reverse-charge and ITC-ineligible ones never enter IMS
// at all. Neither figure contains the other. Both screens say so, in each
// other's terms, or the totals read as a contradiction.
// One line per screen saying what is on it, in a shopkeeper's words.
//
// The rule for every string in this file that a trader reads: if a sentence needs
// a second read, it is not finished. No "population", no "subset", no "records
// whose IMS position is not final" — those are our words, for our own benefit,
// and somebody who runs a shop should not have to decode them to use the app.
//
// The boundary underneath, for whoever maintains this: Summary and Actions are
// the SAME result set grouped two ways; Still fixable is the part of it a
// supplier can still correct without an amendment, and all of it is on Actions
// too.
export const POPULATION_NOTE = {
  SUMMARY:
    'Everything this month’s check compared, grouped by how your books and the ' +
    'portal lined up. The Actions tab is the same list, sorted by what to do about ' +
    'each one.',
  ACTIONS:
    'The same list as Summary, sorted by what to do about each one rather than by ' +
    'how it matched. Anything on Still fixable is in here too.'
};

// The long explanation, shown only when someone opens the disclosure on Still
// fixable. Collapsed is not an excuse for jargon: anything the portal did not
// already teach a trader is spelled out where it first appears.
//
// Worth keeping and worth being right — the two screens genuinely count different
// things and the totals look contradictory without it — but not what anybody
// needs in the first ten seconds.
export const WHY_TOTALS_DIFFER = [
  'Summary and this screen read two different lists from the portal, on purpose.',
  'This screen uses IMS. That is the portal’s live list, and an invoice appears ' +
    'there the moment your supplier saves it — days before they file it. Summary ' +
    'also uses GSTR-2B, the fixed statement that comes out on the 14th and only ' +
    'ever holds invoices that have actually been filed. So an invoice your supplier ' +
    'has filed is finished as far as Summary is concerned, while this screen can ' +
    'still be showing you one that is only a draft.',
  'Some purchases never go through IMS at all: reverse charge, imports, credit ' +
    'passed down from a head office, and anything the portal says you cannot claim. ' +
    'Nobody can fix those and there is nothing to accept on them, so they are left ' +
    'off this screen. Summary counts every one of them.',
  'That is why the two totals do not add up to each other, and why neither one is ' +
    'part of the other. They answer different questions: what is still worth a ' +
    'phone call, and what does this month come to.'
];

// The line under Summary's own totals. One sentence, naming the other tab.
export const SUMMARY_VS_FIXABLE =
  'These totals cover every purchase, including reverse charge, imports and credit ' +
  'you cannot claim. The Still fixable tab lists only what a supplier can still put ' +
  'right, so it is a shorter list and a smaller figure — not a part of these.';

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
      allowed: [],
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

// True when the trader chose something other than what the engine proposed.
export function isOverride(result) {
  if (!result.confirmedAction) return false;
  return result.confirmedAction !== RECOMMENDED_TO_IMS[result.recommendedAction];
}
