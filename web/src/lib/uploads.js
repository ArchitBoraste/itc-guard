// What the Upload screen says about the period in view, from one reading: each
// card's current file and figures, whether the books and the portal side are in,
// the step, and what the reconcile bar names. The cards, the bar and the stepper
// all read this, so they cannot disagree (Upload marked done beside empty cards,
// or "Purchase register against ."). Pure.
import { formatDate } from './calendar.js';

export const UPLOAD_KINDS = ['PURCHASE_REGISTER', 'IMS', 'GSTR2B'];

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const word = (count, one, many = `${one}s`) => (count === 1 ? one : many);

// The latest file of a kind for the period: the one whose data is in use.
export function currentUpload(uploads, kind, period) {
  return (
    (uploads ?? [])
      .filter(
        (upload) =>
          upload.kind === kind && upload.tax_period === period && upload.committed_at && !upload.replaced_by_upload_id
      )
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

// Figures for a file whose records the period's counts do not show (an IMS
// download with nothing in it yet): its own row count.
const rowsOf = (upload, noun) => [[upload.row_count ?? 0, word(upload.row_count ?? 0, noun)]];

function registerCard(upload, register) {
  if (!register?.documents) return upload ? { upload, figures: rowsOf(upload, 'row'), line: null } : null;
  return {
    upload,
    figures: [
      [register.documents, word(register.documents, 'document')],
      [register.suppliers, word(register.suppliers, 'supplier')]
    ],
    line: [
      register.invoices ? plural(register.invoices, 'invoice') : null,
      register.creditNotes ? plural(register.creditNotes, 'credit note') : null,
      register.debitNotes ? plural(register.debitNotes, 'debit note') : null,
      register.contacts ? `contacts for ${plural(register.contacts, 'supplier')}` : 'no supplier contacts'
    ]
      .filter(Boolean)
      .join(' · ')
  };
}

function imsCard(upload, ims) {
  if (!upload && !ims?.records) return null;
  const downloaded = upload?.snapshot_date ? `Downloaded ${formatDate(upload.snapshot_date)}` : null;
  if (!ims?.records) {
    return { upload, figures: rowsOf(upload, 'record'), line: downloaded };
  }
  return {
    upload,
    figures: [
      [ims.records, word(ims.records, 'record')],
      [ims.suppliers, word(ims.suppliers, 'supplier')]
    ],
    line: [downloaded, `${ims.filed} filed`, ims.saved ? `${ims.saved} saved, not filed` : null]
      .filter(Boolean)
      .join(' · ')
  };
}

function twoBCard(upload, twoB) {
  if (!upload && !twoB?.records) return null;
  return {
    upload,
    figures: twoB?.records
      ? [
          [twoB.records, word(twoB.records, 'record')],
          [twoB.suppliers, word(twoB.suppliers, 'supplier')]
        ]
      : rowsOf(upload, 'record'),
    line: 'Filed records only'
  };
}

// uploadView({ uploads, inventory, period, run }) ->
//   { cards: { kind: { upload, figures, line } | null }, books, portal, ready,
//     step, against, stillNeeded }
//
// A card shows the period's current file, with the period's counts when it has
// them; a file the counts do not show is still a file. books / portal / ready
// and the step follow the cards.
export function uploadView({ uploads, inventory, period, run }) {
  const file = (kind) => (period ? currentUpload(uploads, kind, period) : null);
  const cards = {
    PURCHASE_REGISTER: registerCard(file('PURCHASE_REGISTER'), inventory?.register),
    IMS: imsCard(file('IMS'), inventory?.imsRecords),
    GSTR2B: twoBCard(file('GSTR2B'), inventory?.twoB)
  };

  const books = Boolean(cards.PURCHASE_REGISTER);
  const portal = Boolean(cards.IMS || cards.GSTR2B);
  const ready = books && portal;

  const snapshot = cards.IMS?.upload?.snapshot_date;
  const against = [
    cards.IMS ? (snapshot ? `IMS as of ${formatDate(snapshot)}` : 'IMS') : null,
    cards.GSTR2B ? 'GSTR-2B' : null
  ]
    .filter(Boolean)
    .join(' and ');
  const stillNeeded = [!books ? 'your purchase register' : null, !portal ? 'an IMS download' : null]
    .filter(Boolean)
    .join(' and ');

  return {
    cards,
    books,
    portal,
    ready,
    step: ready ? (run ? 3 : 2) : 1,
    against,
    stillNeeded
  };
}
