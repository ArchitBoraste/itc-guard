// demo-timeline.js — the live demo's story as data: one trader, twelve suppliers,
// August and September 2026, and what each supplier saved or filed on which day.
//
// PURE: no fs, no network. tools/generate-demo-fixtures.js writes the sample files
// from it and tools/verify-demo.js checks the app against it, so the files and the
// assertions cannot tell two different stories.
//
// Money is integer paise and dates are ISO yyyy-mm-dd. Rupees, dd-mm-yyyy and
// every portal field name exist only in the generator's writers.
import { gstinCheckDigit } from '../api/src/matching/normalize.js';

export const TRADER = Object.freeze({
  gstin: '27AABCS1080F1ZN',
  name: 'Sharma Electronics Pvt Ltd',
  stateCode: '27'
});

export const GST_RATE_PERCENT = 18;

// GSTR-1 cut-off day in the month after the tax period, per supplier scheme.
export const CUTOFF_DAY = Object.freeze({ MONTHLY: 11, QUARTERLY: 13 });
export const TWO_B_DAY = 14;

// key, name, state code, PAN, HSN, GSTR-1 scheme. The GSTIN is state code + PAN +
// entity number '1' + 'Z' + the real check digit, so every one passes the checksum.
const SUPPLIER_ROWS = [
  ['orbit', 'Orbit Distributors', '27', 'AAFFO2231R', '8544', 'MONTHLY'],
  ['ganesh', 'Ganesh Traders', '27', 'AKLPG6614M', '8536', 'MONTHLY'],
  ['laxmi', 'Laxmi Components', '29', 'AACCL3907B', '8541', 'MONTHLY'],
  ['mahavir', 'Mahavir Sales', '24', 'AAKFM5120D', '8504', 'MONTHLY'],
  ['national', 'National Supply Co', '27', 'AABCN7782E', '8471', 'MONTHLY'],
  ['balaji', 'Balaji Agencies', '33', 'AAGFB1455H', '8517', 'MONTHLY'],
  ['patel', 'Patel Systems', '24', 'AAECP8836L', '8473', 'MONTHLY'],
  ['anand', 'Anand Electricals', '27', 'ADQPA4410C', '8538', 'MONTHLY'],
  ['krishna', 'Krishna Enterprises', '27', 'BBRPK2295N', '8539', 'QUARTERLY'],
  ['unity', 'Unity Distributors', '07', 'AADCU6071J', '8528', 'MONTHLY'],
  ['crystal', 'Crystal Enterprises', '27', 'AAHFC3348Q', '8532', 'MONTHLY'],
  // Never in the register: everything of theirs on the portal is a phantom.
  ['reliable', 'Reliable Traders', '27', 'AAJFR9162G', '8542', 'MONTHLY']
];

export function gstinFor(stateCode, pan) {
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
}

export const SUPPLIERS = Object.freeze(
  SUPPLIER_ROWS.map(([key, name, stateCode, pan, hsn, scheme], index) =>
    Object.freeze({ key, number: index + 1, name, stateCode, pan, gstin: gstinFor(stateCode, pan), hsn, scheme })
  )
);

const SUPPLIER_BY_KEY = new Map(SUPPLIERS.map((supplier) => [supplier.key, supplier]));

export function supplierOf(key) {
  const supplier = SUPPLIER_BY_KEY.get(key);
  if (!supplier) throw new Error(`unknown supplier ${key}`);
  return supplier;
}

// The committed files carry these, never anybody's real details. The phone number
// is deliberately not a valid Indian mobile number (those start 6-9), so nothing
// can ever message it.
export function placeholderContact(supplier) {
  const nn = String(supplier.number).padStart(2, '0');
  return {
    person: `Sample contact ${nn}`,
    phone: `+91 00000 000${nn}`,
    email: `supplier${supplier.number}@example.com`
  };
}

export const PERIODS = Object.freeze({
  aug: Object.freeze({
    key: 'aug',
    taxPeriod: '2026-08',
    monthName: 'August',
    financialYear: '2026-27',
    snapshots: Object.freeze(['2026-09-05', '2026-09-07', '2026-09-10', '2026-09-11']),
    twoBOn: '2026-09-14'
  }),
  sep: Object.freeze({
    key: 'sep',
    taxPeriod: '2026-09',
    monthName: 'September',
    financialYear: '2026-27',
    snapshots: Object.freeze(['2026-10-05', '2026-10-07', '2026-10-10', '2026-10-11']),
    twoBOn: '2026-10-14'
  })
});

export const PERIOD_KEYS = Object.freeze(Object.keys(PERIODS));

// --- money -----------------------------------------------------------------

// The tax heads a supplier charges on a taxable value: CGST + SGST within
// Maharashtra, IGST from any other state. taxPaise overrides the 18% (Unity's
// Rs 0.60 rounding).
export function amountsFor(supplier, taxablePaise, { taxPaise = null } = {}) {
  const tax = taxPaise ?? (taxablePaise * GST_RATE_PERCENT) / 100;
  const intraState = supplier.stateCode === TRADER.stateCode;
  if (!Number.isInteger(tax) || (intraState && tax % 2 !== 0)) {
    throw new Error(`${supplier.name}: tax ${tax} paise does not split into whole paise`);
  }
  return Object.freeze({
    taxable: taxablePaise,
    igst: intraState ? 0 : tax,
    cgst: intraState ? tax / 2 : 0,
    sgst: intraState ? tax / 2 : 0,
    cess: 0,
    totalTax: tax
  });
}

const rupees = (value) => Math.round(value * 100);

// --- the purchase register ---------------------------------------------------

function book(supplierKey, invoiceNo, invoiceDate, taxableRupees, { docType = 'INVOICE' } = {}) {
  const supplier = supplierOf(supplierKey);
  return Object.freeze({
    supplier,
    docType,
    invoiceNo,
    invoiceDate,
    amounts: amountsFor(supplier, rupees(taxableRupees))
  });
}

export const REGISTER = Object.freeze({
  aug: Object.freeze([
    book('orbit', 'INV-0801', '2026-08-03', 50000),
    book('ganesh', 'GT/0145', '2026-08-06', 20000),
    book('laxmi', 'LC-821', '2026-08-08', 30000),
    book('mahavir', 'MS-878', '2026-08-11', 40000),
    book('national', 'NS-612', '2026-08-13', 25000),
    book('balaji', 'BA/219', '2026-08-17', 15000),
    book('patel', 'PS-3401', '2026-08-19', 18000),
    book('anand', 'AE/177', '2026-08-21', 22000),
    book('krishna', 'KE-112', '2026-08-24', 12000),
    book('unity', 'UD-1905', '2026-08-26', 10000),
    book('crystal', 'CE-CN-08', '2026-08-28', 5000, { docType: 'CREDIT_NOTE' })
  ]),
  sep: Object.freeze([
    book('orbit', 'INV-0902', '2026-09-02', 40000),
    book('ganesh', 'GT/0201', '2026-09-04', 15000),
    book('laxmi', 'LC-905', '2026-09-07', 25000),
    book('national', 'NS-701', '2026-09-09', 18000),
    book('mahavir', 'MS-951', '2026-09-12', 30000),
    book('patel', 'PS-3502', '2026-09-15', 12000),
    book('unity', 'UD-2011', '2026-09-18', 20000),
    book('balaji', 'BA/305', '2026-09-22', 10000),
    book('crystal', 'CE-1021', '2026-09-24', 22000),
    book('krishna', 'KE-130', '2026-09-26', 14000)
  ])
});

export function booksDocument(periodKey, invoiceNo) {
  const found = REGISTER[periodKey].find((doc) => doc.invoiceNo === invoiceNo);
  if (!found) throw new Error(`no ${invoiceNo} in the ${periodKey} register`);
  return found;
}

// --- the portal ----------------------------------------------------------------

// What a supplier did, and when. An event that names no amounts keeps the previous
// ones: filing a saved record unchanged.
const saved = (on, change = null) => ({ on, status: 'SAVED', change });
const filed = (on, change = null) => ({ on, status: 'FILED', change });

// onPortal(period, supplier, invoiceNo, events, options) -> one document as the
// portal shows it for the trader's return `period`.
//
//   books        the register document it is, when the number on the portal differs
//   booksPeriod  the register it comes from, when not this period's (a carry-over)
//   notInBooks   { invoiceDate, taxable }: a phantom, with no register document
//   amends       a GSTR-1A amendment of the books document: the amendment section,
//                carrying the original number and date
//   sourceForm   'R1' GSTR-1/IFF, 'R1A' GSTR-1A
//   returnPeriod the supplier's own return period (a quarterly filer reports the
//                quarter, a GSTR-1A the period it amends)
function onPortal(periodKey, supplierKey, invoiceNo, events, options = {}) {
  const supplier = supplierOf(supplierKey);
  const books = options.notInBooks
    ? null
    : booksDocument(options.booksPeriod ?? periodKey, options.books ?? invoiceNo);
  const base = books?.amounts ?? amountsFor(supplier, rupees(options.notInBooks.taxable));

  let current = base;
  const resolved = events.map((event) => {
    if (event.change) {
      const taxable = event.change.taxable === undefined ? current.taxable : rupees(event.change.taxable);
      current = amountsFor(supplier, taxable, { taxPaise: event.change.taxPaise ?? null });
    }
    return Object.freeze({ on: event.on, status: event.status, amounts: current });
  });

  return Object.freeze({
    id: `${periodKey}:${supplierKey}:${invoiceNo}`,
    period: periodKey,
    supplier,
    invoiceNo,
    invoiceDate: books?.invoiceDate ?? options.notInBooks.invoiceDate,
    docType: books?.docType ?? 'INVOICE',
    books: books ? Object.freeze({ period: options.booksPeriod ?? periodKey, invoiceNo: books.invoiceNo }) : null,
    amendment: options.amends
      ? Object.freeze({ originalInvoiceNo: books.invoiceNo, originalInvoiceDate: books.invoiceDate })
      : null,
    sourceForm: options.sourceForm ?? 'R1',
    returnPeriod: options.returnPeriod ?? PERIODS[periodKey].taxPeriod,
    events: Object.freeze(resolved)
  });
}

export const PORTAL = Object.freeze([
  // August's return: IMS from 5 Sep, GSTR-2B on 14 Sep.
  onPortal('aug', 'orbit', 'INV-0801', [filed('2026-09-04')]),
  onPortal('aug', 'mahavir', 'MS-878', [filed('2026-09-05', { taxable: 35000 })]),
  onPortal('aug', 'ganesh', 'GT/0145', [saved('2026-09-06'), filed('2026-09-09')]),
  onPortal('aug', 'unity', 'UD-1905', [filed('2026-09-06', { taxPaise: 180060 })]),
  onPortal('aug', 'national', 'NS-612', [saved('2026-09-07', { taxable: 28000 }), filed('2026-09-11')]),
  onPortal('aug', 'anand', 'AE/177', [saved('2026-09-08')]),
  onPortal('aug', 'balaji', 'BA/291', [filed('2026-09-09')], { books: 'BA/219' }),
  onPortal('aug', 'laxmi', 'LC-821', [filed('2026-09-10')]),
  onPortal('aug', 'crystal', 'CE-CN-08', [filed('2026-09-10')]),
  onPortal('aug', 'reliable', 'RT-760', [filed('2026-09-11')], {
    notInBooks: { invoiceDate: '2026-08-27', taxable: 30000 }
  }),

  // September's return: IMS from 5 Oct, GSTR-2B on 14 Oct.
  onPortal('sep', 'orbit', 'INV-0902', [filed('2026-10-03')]),
  onPortal('sep', 'laxmi', 'LC-905', [saved('2026-10-04'), filed('2026-10-09')]),
  onPortal('sep', 'national', 'NS-701', [
    saved('2026-10-04', { taxable: 20000 }),
    filed('2026-10-08', { taxable: 18000 })
  ]),
  onPortal('sep', 'crystal', 'CE-1021', [filed('2026-10-05')]),
  onPortal('sep', 'ganesh', 'GT/0201', [filed('2026-10-06')]),
  onPortal('sep', 'mahavir', 'MS-951', [filed('2026-10-07')]),
  onPortal('sep', 'patel', 'PS-3502', [filed('2026-10-10')]),
  onPortal('sep', 'unity', 'UD-2011', [filed('2026-10-11', { taxable: 16000 })]),
  onPortal('sep', 'krishna', 'KE-130', [filed('2026-10-12')]),

  // August documents that reach September's return.
  onPortal('sep', 'mahavir', 'MS-878', [filed('2026-09-18')], {
    booksPeriod: 'aug', amends: true, sourceForm: 'R1A', returnPeriod: '2026-08'
  }),
  onPortal('sep', 'patel', 'PS-3401', [filed('2026-09-19')], {
    booksPeriod: 'aug', sourceForm: 'R1A', returnPeriod: '2026-08'
  }),
  onPortal('sep', 'anand', 'AE/177', [saved('2026-09-08'), filed('2026-10-09')], { booksPeriod: 'aug' }),
  // Krishna files quarterly with no IFF: the Jul-Sep GSTR-1 carries both.
  onPortal('sep', 'krishna', 'KE-112', [filed('2026-10-12')], { booksPeriod: 'aug' })
]);

// --- what the portal says on a given day -------------------------------------

// The document's state on `date`: the last thing its supplier did by then, or null
// when they had done nothing yet.
export function stateOn(doc, date) {
  let state = null;
  for (const event of doc.events) if (event.on <= date) state = event;
  return state;
}

// The supplier's cut-off for one of the trader's return periods.
export function cutoffFor(supplier, periodKey) {
  const [year, month] = PERIODS[periodKey].taxPeriod.split('-').map(Number);
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return `${next}-${String(CUTOFF_DAY[supplier.scheme]).padStart(2, '0')}`;
}

// An IMS download on `date` is cumulative: every record saved or filed by then,
// in the state it was in that day.
export function imsSnapshot(periodKey, date) {
  return PORTAL.filter((doc) => doc.period === periodKey)
    .map((doc) => ({ doc, state: stateOn(doc, date) }))
    .filter(({ state }) => state !== null);
}

// GSTR-2B carries filed records only: those filed by the supplier's own cut-off.
export function twoBDocuments(periodKey) {
  return PORTAL.filter((doc) => doc.period === periodKey)
    .map((doc) => ({ doc, state: stateOn(doc, cutoffFor(doc.supplier, periodKey)) }))
    .filter(({ state }) => state?.status === 'FILED');
}

// The date a document was filed, from its events.
export function filedOn(doc) {
  return doc.events.find((event) => event.status === 'FILED')?.on ?? null;
}

// 'ims_aug26_as_of_05sep.json'
const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function fileTag(periodKey) {
  return `${periodKey}${PERIODS[periodKey].taxPeriod.slice(2, 4)}`;
}

export function imsFileName(periodKey, date) {
  const [, month, day] = date.split('-');
  return `ims_${fileTag(periodKey)}_as_of_${day}${MONTH_SHORT[Number(month) - 1]}.json`;
}

export const registerFileName = (periodKey) => `purchase_register_${fileTag(periodKey)}.xlsx`;
export const twoBFileName = (periodKey) => `gstr2b_${fileTag(periodKey)}.json`;
