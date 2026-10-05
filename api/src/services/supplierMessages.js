// Every message the app writes to a supplier. Built here, sent elsewhere: the
// trader copies it or opens it in WhatsApp or their mail app, or the app sends it
// (services/supplierEmail.js, services/supplierWhatsapp.js).
//
// Two shapes:
//   supplierMessage(kind, facts)  one document, a few sentences, shown beside the
//                                 row it is about (IMS decisions, Not filed yet,
//                                 Corrections). Signed with the trader's name.
//                                 Its ask is the same request in one sentence, for
//                                 the WhatsApp template's last value.
//   buildChaseMessage(...)        every unsettled document from one supplier as a
//                                 single digest (the alerts' chaseMessage). ASCII
//                                 only, for SMS gateways and ERP note fields.
//
// The short messages quote amounts with the rupee sign, as on screen: they go out
// through WhatsApp and email, both of which carry it.
import { addMonths, dateToIso } from '../matching/normalize.js';
import { FILING_SCHEMES, cutoffDate } from '../matching/cutoff.js';
import { formatRupeesAscii } from '../matching/recommend.js';
import { whatsappLink } from './supplierContacts.js';

export const MESSAGE_KINDS = Object.freeze({
  NOT_FILED_BEFORE_CUTOFF: 'NOT_FILED_BEFORE_CUTOFF',
  NOT_FILED_AFTER_CUTOFF: 'NOT_FILED_AFTER_CUTOFF',
  SAVED_NOT_FILED_BEFORE_CUTOFF: 'SAVED_NOT_FILED_BEFORE_CUTOFF',
  SAVED_NOT_FILED_AFTER_CUTOFF: 'SAVED_NOT_FILED_AFTER_CUTOFF',
  SAVED_DIFFERENT_BEFORE_CUTOFF: 'SAVED_DIFFERENT_BEFORE_CUTOFF',
  SAVED_DIFFERENT_AFTER_CUTOFF: 'SAVED_DIFFERENT_AFTER_CUTOFF',
  PORTAL_HIGHER: 'PORTAL_HIGHER',
  PORTAL_LOWER: 'PORTAL_LOWER',
  INVOICE_NO_DIFFERS: 'INVOICE_NO_DIFFERS',
  NOT_IN_BOOKS: 'NOT_IN_BOOKS',
  CORRECTION_REMINDER: 'CORRECTION_REMINDER'
});

const K = MESSAGE_KINDS;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// --- formatting ------------------------------------------------------------------

function groupIndian(digits) {
  const text = String(digits);
  if (text.length <= 3) return text;
  let head = text.slice(0, -3);
  const groups = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  return `${groups.join(',')},${text.slice(-3)}`;
}

// ₹28,000 for a whole amount, ₹1,800.60 when there are paise. From the integer
// paise's digits; the sign is the caller's business.
export function messageRupees(paise) {
  const abs = Math.abs(Math.trunc(Number(paise) || 0));
  const rupees = (abs - (abs % 100)) / 100;
  const cents = abs % 100;
  return `₹${groupIndian(rupees)}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
}

function monthName(taxPeriod) {
  const [year, month] = String(taxPeriod ?? '').split('-').map(Number);
  if (!year || !month) return String(taxPeriod ?? '');
  return `${MONTHS[month - 1]} ${year}`;
}

// '2026-08-11' -> '11 Aug 2026'
export function formatDate(iso) {
  const normalized = dateToIso(iso);
  if (!normalized) return String(iso ?? '');
  const [year, month, day] = normalized.split('-').map(Number);
  return `${day} ${MONTHS[month - 1].slice(0, 3)} ${year}`;
}

const DOC_WORD = Object.freeze({ INVOICE: 'invoice', DEBIT_NOTE: 'debit note', CREDIT_NOTE: 'credit note' });
const docWord = (docType) => DOC_WORD[docType] ?? 'invoice';

// The name a message addresses: "Rakesh" from "Rakesh Jain", or null with no
// usable name. A name with digits in it is a placeholder, not a person, and an
// initial ("K. Balaji") is not a first name, so that one is used whole.
export function addressName(person) {
  const name = String(person ?? '').trim();
  if (!name || /\d/.test(name)) return null;
  const first = name.split(/\s+/)[0];
  return /^[A-Za-z]{2,}$/.test(first) ? first : name;
}

// "Hello Rakesh ji," from "Rakesh Jain"; "Hello," with no usable name.
export function greeting(person) {
  const name = addressName(person);
  return name ? `Hello ${name} ji,` : 'Hello,';
}

const signOff = (traderName) => (traderName ? `Thank you, ${traderName}` : 'Thank you');

// "our invoice PS-3401 dated 14 Aug 2026 (₹18,000 + ₹3,240 GST)"
function ourDocument(facts) {
  const amounts = facts.books
    ? ` (${messageRupees(facts.books.taxableValue)} + ${messageRupees(facts.books.totalTax)} GST)`
    : '';
  return `our ${docWord(facts.docType)} ${facts.invoiceNo} dated ${formatDate(facts.invoiceDate)}${amounts}`;
}

// Why the supplier should bother: an invoice brings the trader credit, a credit
// note takes it away, so "so we can claim the credit" is only an invoice's reason.
function becauseClause(facts, { period = null } = {}) {
  if (facts.docType === 'CREDIT_NOTE') return 'so that our returns agree';
  return period ? `so we can claim the credit in ${monthName(period)}` : 'so we can claim the credit';
}

// "GSTR-1" for a monthly filer; a quarterly one reports a month's documents in
// the IFF (or their quarterly GSTR-1).
const returnName = (scheme) => (scheme === FILING_SCHEMES.QRMP ? 'GSTR-1 or IFF' : 'GSTR-1');

// "₹28,000 taxable and ₹5,040 tax"
const amountsOf = (side) => `${messageRupees(side.taxableValue)} taxable and ${messageRupees(side.totalTax)} tax`;

function sentenceFor(kind, facts) {
  const cutOff = formatDate(facts.cutOffDate);
  const doc = `${docWord(facts.docType)} ${facts.invoiceNo}`;
  const docDated = `${doc} (${formatDate(facts.invoiceDate)})`;

  switch (kind) {
    case K.NOT_FILED_BEFORE_CUTOFF:
      return (
        `${ourDocument(facts)} is not on the GST portal yet. Please include it in your ` +
        `${returnName(facts.scheme)} by ${cutOff} ${becauseClause(facts, { period: facts.taxPeriod })}.`
      );

    case K.NOT_FILED_AFTER_CUTOFF:
      return (
        `${ourDocument(facts)} is not on the GST portal yet. ` +
        (facts.scheme === FILING_SCHEMES.QRMP
          ? `Please include it in your quarterly GSTR-1 ${becauseClause(facts)}.`
          : `Please add it through GSTR-1A ${becauseClause(facts)}.`)
      );

    case K.SAVED_NOT_FILED_BEFORE_CUTOFF:
      return (
        `${ourDocument(facts)} is saved on the GST portal but not filed yet. Please file ` +
        `it with your ${returnName(facts.scheme)} by ${cutOff} ${becauseClause(facts, { period: facts.taxPeriod })}.`
      );

    case K.SAVED_NOT_FILED_AFTER_CUTOFF:
      return (
        `${ourDocument(facts)} was saved on the GST portal but not filed by ${cutOff}. ` +
        `Please file it with your next GSTR-1 ${becauseClause(facts)}.`
      );

    case K.SAVED_DIFFERENT_BEFORE_CUTOFF:
      return (
        `${doc} dated ${formatDate(facts.invoiceDate)} is saved on the GST portal at ` +
        `${amountsOf(facts.portal)}, but our books show ${messageRupees(facts.books.taxableValue)} and ` +
        `${messageRupees(facts.books.totalTax)}. Please correct it before you file your ` +
        `${returnName(facts.scheme)} by ${cutOff}.`
      );

    case K.SAVED_DIFFERENT_AFTER_CUTOFF:
      return (
        `${doc} dated ${formatDate(facts.invoiceDate)} is saved on the GST portal at ` +
        `${amountsOf(facts.portal)}, but our books show ${messageRupees(facts.books.taxableValue)} and ` +
        `${messageRupees(facts.books.totalTax)}, and it was not filed by ${cutOff}. Please correct it ` +
        'and file it with your next GSTR-1.'
      );

    case K.PORTAL_HIGHER:
      return (
        `${docDated} shows ${amountsOf(facts.portal)} on the GST portal, but our books show ` +
        `${messageRupees(facts.books.taxableValue)} and ${messageRupees(facts.books.totalTax)}.` +
        (facts.decided === 'REJECT' ? ' We have rejected it in IMS.' : '') +
        ' Please correct it through GSTR-1A so we can accept it.'
      );

    case K.PORTAL_LOWER: {
      const taxable = Math.abs(facts.books.taxableValue - facts.portal.taxableValue);
      const tax = Math.abs(facts.books.totalTax - facts.portal.totalTax);
      return (
        `${docDated} shows ${amountsOf(facts.portal)} on the GST portal, but our books show ` +
        `${messageRupees(facts.books.taxableValue)} and ${messageRupees(facts.books.totalTax)}.` +
        (facts.decided === 'ACCEPT' ? ` We have accepted ${messageRupees(facts.portal.totalTax)} for now.` : '') +
        ` Please report the remaining ${taxable ? `${messageRupees(taxable)} taxable (${messageRupees(tax)} tax)` : `${messageRupees(tax)} tax`}` +
        ' through GSTR-1A.'
      );
    }

    case K.INVOICE_NO_DIFFERS:
      return (
        `${docDated} appears on the GST portal as ${facts.portal.invoiceNo}. Please confirm ` +
        'it is the same bill and correct the number through GSTR-1A.'
      );

    case K.NOT_IN_BOOKS:
      return (
        `${docWord(facts.docType)} ${facts.invoiceNo} (${formatDate(facts.invoiceDate)}, ` +
        `${messageRupees(facts.portal.totalTax)} tax) is on the GST portal under our GSTIN, but we have ` +
        'no purchase against it.' +
        (facts.decided === 'REJECT' ? ' We have rejected it in IMS.' : '') +
        ' Please check and remove it.'
      );

    case K.CORRECTION_REMINDER:
      return reminderSentence(facts);

    default:
      throw new Error(`unknown message kind ${kind}`);
  }
}

function reminderSentence(facts) {
  const opening = `a reminder about ${ourDocument(facts)}.`;
  const by = facts.nextChance?.date
    ? ` by ${formatDate(facts.nextChance.date)} so it reaches our ${monthName(facts.nextChance.reachesPeriod)} GSTR-2B`
    : '';
  if (facts.needed === 'VALUE_MISMATCH') {
    return (
      `${opening} The GST portal still shows ${amountsOf(facts.portal)}. Please correct it through ` +
      `GSTR-1A${by}.`
    );
  }
  if (facts.needed === 'SAVED_NOT_FILED') {
    return `${opening} It is saved on the GST portal but still not filed. Please file it${by}.`;
  }
  return `${opening} It is still not on the GST portal. Please file it${by}.`;
}

// --- the ask: the request in one sentence ---------------------------------------------

// One value for a WhatsApp template: no newline or tab, no run of spaces (Meta
// refuses more than four), at most max characters.
export function whatsappParam(text, max = 200) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

const taxAgainst = (facts) =>
  `${messageRupees(facts.portal.totalTax)} tax against ${messageRupees(facts.books.totalTax)} in our books`;

// The template already names the document and its date, so the ask is only what
// is wrong and what to do: "X, so please Y."
function askFor(kind, facts) {
  const cutOff = formatDate(facts.cutOffDate);
  const rejected = facts.decided === 'REJECT' ? ' and we have rejected it in IMS' : '';
  switch (kind) {
    case K.NOT_FILED_BEFORE_CUTOFF:
      return `It is not on the GST portal yet, so please include it in your ${returnName(facts.scheme)} by ${cutOff}.`;
    case K.NOT_FILED_AFTER_CUTOFF:
      return facts.scheme === FILING_SCHEMES.QRMP
        ? 'It is not on the GST portal yet, so please include it in your quarterly GSTR-1.'
        : 'It is not on the GST portal yet, so please add it through GSTR-1A.';
    case K.SAVED_NOT_FILED_BEFORE_CUTOFF:
      return `It is saved on the GST portal but not filed yet, so please file it with your ${returnName(facts.scheme)} by ${cutOff}.`;
    case K.SAVED_NOT_FILED_AFTER_CUTOFF:
      return `It was saved on the GST portal but not filed by ${cutOff}, so please file it with your next GSTR-1.`;
    case K.SAVED_DIFFERENT_BEFORE_CUTOFF:
      return `It is saved on the GST portal with ${taxAgainst(facts)}, so please correct it before you file by ${cutOff}.`;
    case K.SAVED_DIFFERENT_AFTER_CUTOFF:
      return `It is saved on the GST portal with ${taxAgainst(facts)} and was not filed by ${cutOff}, so please correct it and file it with your next GSTR-1.`;
    case K.PORTAL_HIGHER:
      return `The GST portal shows ${taxAgainst(facts)}${rejected}, so please correct it through GSTR-1A.`;
    case K.PORTAL_LOWER: {
      const tax = Math.abs(facts.books.totalTax - facts.portal.totalTax);
      return `The GST portal shows ${taxAgainst(facts)}, so please report the remaining ${messageRupees(tax)} tax through GSTR-1A.`;
    }
    case K.INVOICE_NO_DIFFERS:
      return `It appears on the GST portal as ${facts.portal.invoiceNo}, so please confirm it is the same bill and correct the number through GSTR-1A.`;
    case K.NOT_IN_BOOKS:
      return `It is on the GST portal under our GSTIN but we have no purchase against it${rejected}, so please check and remove it.`;
    case K.CORRECTION_REMINDER: {
      const by = facts.nextChance?.date
        ? ` by ${formatDate(facts.nextChance.date)} so it reaches our ${monthName(facts.nextChance.reachesPeriod)} GSTR-2B`
        : '';
      if (facts.needed === 'VALUE_MISMATCH') {
        return `The GST portal still shows ${messageRupees(facts.portal.totalTax)} tax, so please correct it through GSTR-1A${by}.`;
      }
      if (facts.needed === 'SAVED_NOT_FILED') return `It is saved on the GST portal but still not filed, so please file it${by}.`;
      return `It is still not on the GST portal, so please file it${by}.`;
    }
    default:
      throw new Error(`unknown message kind ${kind}`);
  }
}

// The ask, ready to be the WhatsApp template's last value.
export const supplierAsk = (kind, facts) => whatsappParam(askFor(kind, facts), 200);

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// supplierMessage(kind, facts) -> { kind, subject, text, whatsappUrl, ask, invoiceDate }
//
// The greeting ends in a comma, so the sentence after it starts in lower case.
//
// facts: { traderName, contact: { person, phone, email } | null, docType,
//          invoiceNo, invoiceDate, taxPeriod, scheme, cutOffDate,
//          books: { taxableValue, totalTax } | null,
//          portal: { invoiceNo, taxableValue, totalTax } | null,
//          decided: the trader's confirmed IMS action, or null,
//          needed, nextChance (a correction reminder only) }
export function supplierMessage(kind, facts) {
  const text = `${greeting(facts.contact?.person)} ${sentenceFor(kind, facts)} ${signOff(facts.traderName)}`;
  return {
    kind,
    subject: `${capitalise(docWord(facts.docType))} ${facts.invoiceNo} dated ${formatDate(facts.invoiceDate)}`,
    text,
    whatsappUrl: whatsappLink(facts.contact?.phone, text),
    ask: supplierAsk(kind, facts),
    invoiceDate: dateToIso(facts.invoiceDate)
  };
}

// --- which message a row needs -----------------------------------------------------

const SAVED = 'SAVED';

// The message for one reconciliation result, or null when there is nothing to ask
// the supplier: a clean match, an immaterial difference, or a record outside IMS.
//
// ctx: { traderName, taxPeriod (the run's), scheme (the supplier's),
//        cutOffPassed, materialityTolerancePaise }
export function resultMessageKind(result, { materialityTolerancePaise = 100 } = {}) {
  const passed = (result.flags ?? []).includes('CUTOFF_PASSED');
  const saved = result.portal?.filingStatus === SAVED;
  switch (result.bucket) {
    case 'MISSING_IN_PORTAL':
      if (saved) return passed ? K.SAVED_NOT_FILED_AFTER_CUTOFF : K.SAVED_NOT_FILED_BEFORE_CUTOFF;
      return passed ? K.NOT_FILED_AFTER_CUTOFF : K.NOT_FILED_BEFORE_CUTOFF;
    case 'MATCHED':
      if (!saved || !result.books) return null;
      return passed ? K.SAVED_NOT_FILED_AFTER_CUTOFF : K.SAVED_NOT_FILED_BEFORE_CUTOFF;
    case 'VALUE_MISMATCH': {
      if (!result.books || !result.portal) return null;
      const gap = result.portal.totalTax - result.books.totalTax;
      if (Math.abs(gap) <= materialityTolerancePaise) return null;
      if (saved) return passed ? K.SAVED_DIFFERENT_AFTER_CUTOFF : K.SAVED_DIFFERENT_BEFORE_CUTOFF;
      return gap > 0 ? K.PORTAL_HIGHER : K.PORTAL_LOWER;
    }
    case 'SUGGESTED':
      return result.books && result.portal ? K.INVOICE_NO_DIFFERS : null;
    case 'MISSING_IN_BOOKS':
      return result.portal ? K.NOT_IN_BOOKS : null;
    default:
      return null;
  }
}

export function messageForResult(result, ctx) {
  const kind = resultMessageKind(result, ctx);
  if (!kind) return null;
  const identity = kind === K.NOT_IN_BOOKS ? result.portal : (result.books ?? result.portal);
  return supplierMessage(kind, {
    traderName: ctx.traderName,
    contact: result.supplierContact,
    docType: identity.docType,
    invoiceNo: identity.invoiceNo,
    invoiceDate: identity.invoiceDate,
    taxPeriod: ctx.taxPeriod,
    scheme: ctx.scheme,
    cutOffDate: cutoffDate(ctx.taxPeriod, ctx.scheme),
    books: result.books,
    portal: result.portal,
    decided: result.confirmedAction
  });
}

const ALERT_KIND = Object.freeze({
  NOT_REPORTED: [K.NOT_FILED_BEFORE_CUTOFF, K.NOT_FILED_AFTER_CUTOFF],
  SAVED_NOT_FILED: [K.SAVED_NOT_FILED_BEFORE_CUTOFF, K.SAVED_NOT_FILED_AFTER_CUTOFF],
  SAVED_VALUE_MISMATCH: [K.SAVED_DIFFERENT_BEFORE_CUTOFF, K.SAVED_DIFFERENT_AFTER_CUTOFF]
});

// One document on Not filed yet. supplier is the alert entry (cut-off, scheme,
// contact); invoice one of its invoices.
export function messageForAlertInvoice({ traderName, taxPeriod, supplier, invoice }) {
  const [before, after] = ALERT_KIND[invoice.status] ?? ALERT_KIND.NOT_REPORTED;
  return supplierMessage(supplier.preCutOff === false ? after : before, {
    traderName,
    contact: supplier.contact,
    docType: invoice.docType,
    invoiceNo: invoice.invoiceNo,
    invoiceDate: invoice.invoiceDate,
    taxPeriod,
    scheme: supplier.filingScheme,
    cutOffDate: supplier.cutOffDate,
    books: { taxableValue: invoice.taxableValue, totalTax: invoice.totalTax },
    portal: invoice.portalTotalTax === null || invoice.portalTotalTax === undefined
      ? null
      : { taxableValue: invoice.portalTaxableValue, totalTax: invoice.portalTotalTax },
    decided: null
  });
}

// A reminder for a correction still waiting; null once it has arrived.
export function messageForCorrection({ traderName, item }) {
  if (item.status !== 'WAITING') return null;
  return supplierMessage(K.CORRECTION_REMINDER, {
    traderName,
    contact: item.supplier.contact,
    docType: item.document.docType,
    invoiceNo: item.document.invoiceNo,
    invoiceDate: item.document.invoiceDate,
    taxPeriod: item.taxPeriod,
    scheme: item.supplier.filingScheme,
    books: { taxableValue: item.document.taxableValue, totalTax: item.document.totalTax },
    portal: item.needed.portal,
    needed: item.needed.kind,
    nextChance: item.waiting?.nextChance ?? null,
    decided: null
  });
}

// The trader's name as a message is signed: the trade name, else the legal one.
export const traderNameOf = (org) => org?.trade_name ?? org?.legal_name ?? org?.tradeName ?? org?.legalName ?? '';

// ---------------------------------------------------------------------------
// The digest: every unsettled document from one supplier (alerts' chaseMessage)
// ---------------------------------------------------------------------------

// ASCII ONLY, "Rs." rather than the rupee sign, consistent with the IMS remarks
// writer. This text gets pasted into WhatsApp, SMS gateways and ERP note fields,
// any of which may mangle a non-Latin-1 byte, and a garbled invoice number in a
// chase message is worse than no message at all.
//
// org.gstin is the workspace's own GSTIN, the one its files carry.
export function buildChaseMessage({ org, supplier, taxPeriod, asOf }) {
  const traderName = ascii(org.trade_name ?? org.legal_name ?? '');
  const lines = [];

  lines.push(`To: ${ascii(supplier.tradeName)} (${supplier.gstin})`);
  lines.push(`From: ${traderName} (${org.gstin})`);
  lines.push(
    `Subject: GSTR-1 for ${monthName(taxPeriod)} - ${supplier.invoiceCount} document(s) pending`
  );
  lines.push('');
  lines.push('Hello,');
  lines.push('');
  lines.push(
    `As of ${formatDate(asOf)}, the following ${monthName(taxPeriod)} document(s) from you ` +
      `${openingClause(supplier.invoices)}:`
  );
  lines.push('');

  supplier.invoices.forEach((invoice, index) => {
    // A credit note and an invoice ask the supplier for opposite things.
    const kind = DOC_WORD[invoice.docType] ?? 'document';
    lines.push(
      `  ${index + 1}. ${kind} ${ascii(invoice.invoiceNo)}  ` +
        `dated ${formatDate(invoice.invoiceDate)}  ` +
        `taxable ${formatRupeesAscii(invoice.taxableValue)}  ` +
        `tax ${formatRupeesAscii(invoice.totalTax)}`
    );
    lines.push(`     ${statusLine(invoice)}`);
  });

  lines.push('');
  // Split, never netted: an unreported invoice is credit the trader is owed, an
  // unreported credit note is credit they are claiming and should not be.
  for (const line of stakeLines(supplier)) lines.push(line);
  lines.push('');

  if (supplier.preCutOff === false) {
    const creditNotesOnly =
      supplier.breakdown.creditNotes.count > 0 && supplier.breakdown.otherDocuments.count === 0;
    lines.push(
      `Your cut-off for this period was ${formatDate(supplier.cutOffDate)} and it has passed. ` +
        'A correction now needs GSTR-1A, and it would only reach our GSTR-2B in ' +
        `${monthName(addMonths(taxPeriod, 1))} - the next tax period, not ` +
        `${monthName(taxPeriod)}. ` +
        (creditNotesOnly
          ? 'Please still report it - until you do, our return overstates the credit we ' +
            'have taken on it.'
          : 'Please still report it so the credit is not lost altogether.')
    );
  } else {
    const days = supplier.daysToCutOff;
    lines.push(
      `Your GSTR-1 cut-off for this period is ${formatDate(supplier.cutOffDate)}` +
        (days === 0 ? ' - that is today.' : ` - ${days} day(s) from now.`)
    );
    lines.push(
      'If these are saved and filed by then, the credit reaches our GSTR-2B for ' +
        `${monthName(taxPeriod)} at no cost to either of us. After that date the fix needs ` +
        `GSTR-1A and the credit slips to ${monthName(addMonths(taxPeriod, 1))}.`
    );
  }

  lines.push('');
  lines.push('Please confirm once done. Thank you,');
  lines.push(traderName);
  lines.push(`GSTIN ${org.gstin}`);

  return ascii(lines.join('\n'));
}

function statusLine(invoice) {
  switch (invoice.status) {
    case 'SAVED_VALUE_MISMATCH':
      return (
        `saved on the portal as taxable ${formatRupeesAscii(invoice.portalTaxableValue)} / ` +
        `tax ${formatRupeesAscii(invoice.portalTotalTax)} - please check before filing`
      );
    case 'SAVED_NOT_FILED':
      return 'saved but not filed yet - please file it';
    default:
      return 'not in the IMS data we have downloaded - please report it';
  }
}

// True of whatever is actually in the list, rather than of the commonest case.
function openingClause(invoices) {
  const unreported = invoices.filter((invoice) => invoice.status === 'NOT_REPORTED').length;
  if (unreported === invoices.length) return 'have not yet reached our GST portal data (IMS)';
  if (unreported === 0) {
    return 'are saved in our GST portal data (IMS) but have not been filed';
  }
  return 'are not yet settled in our GST portal data (IMS) - each line says which';
}

function stakeLines(supplier) {
  const { otherDocuments, creditNotes } = supplier.breakdown;
  const lines = [];

  if (otherDocuments.count) {
    lines.push(
      `Input tax credit we are waiting for: ${formatRupeesAscii(Math.abs(otherDocuments.itc))} ` +
        `across ${otherDocuments.count} document(s).`
    );
  }
  if (creditNotes.count) {
    lines.push(
      'Credit we are still claiming and should not be: ' +
        `${formatRupeesAscii(Math.abs(creditNotes.itc))} across ${creditNotes.count} ` +
        'credit note(s). Until these are settled our return overstates the input tax ' +
        'credit we have taken, so please file them even though they reduce what we can claim.'
    );
  }
  if (otherDocuments.count && creditNotes.count) {
    lines.push(`Total unsettled: ${formatRupeesAscii(supplier.itcAtStake)}.`);
  }
  return lines;
}

// Anything outside printable ASCII is replaced rather than dropped, so a name
// that was entirely non-Latin does not silently become an empty string.
function ascii(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/₹/g, 'Rs.')
    .replace(/[^\x20-\x7e\n]/g, '?');
}
