// generate-demo-fixtures.js — the small, human-readable sample files the live demo
// is uploaded from.
//
//   node tools/generate-demo-fixtures.js     (or: npm run gen:demo)
//
// Writes, for August and September 2026 (the story is in tools/demo-timeline.js):
//
//   fixtures/demo/<mon>/purchase_register_<mon>26.xlsx   GSTN template v2.4, plus the
//                                                        three supplier-contact columns
//   fixtures/demo/<mon>/ims_<mon>26_as_of_<DDmon>.json   one IMS download per snapshot
//                                                        date, each cumulative
//   fixtures/demo/<mon>/gstr2b_<mon>26.json              filed records only
//   fixtures/demo/contacts.example.json                  the shape of contacts.local.json
//
// The committed registers carry placeholder contacts. When the gitignored
// fixtures/demo/contacts.local.json exists, a second copy of every file with the
// real contacts merged into the registers goes to the gitignored fixtures/demo-local/.
//
// Every file is read back through the app's own adapters and compared with the
// timeline before the script reports success: a writer that drifts from the
// documented portal format fails here, not on stage.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as purchaseRegister from '../api/src/adapters/purchaseRegister.js';
import * as ims from '../api/src/adapters/ims.js';
import * as gstr2b from '../api/src/adapters/gstr2b.js';
import { isValidGstin } from '../api/src/matching/normalize.js';
import {
  PERIODS,
  PERIOD_KEYS,
  REGISTER,
  SUPPLIERS,
  TRADER,
  filedOn,
  imsFileName,
  imsSnapshot,
  placeholderContact,
  registerFileName,
  twoBDocuments,
  twoBFileName
} from './demo-timeline.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = join(REPO_ROOT, 'fixtures', 'demo');
const LOCAL_DIR = join(REPO_ROOT, 'fixtures', 'demo-local');
const LOCAL_CONTACTS = join(DEMO_DIR, 'contacts.local.json');

// xlsx is installed in api/node_modules; load it from there without a root install.
const XLSX = createRequire(join(REPO_ROOT, 'api', 'package.json'))('xlsx');

// --- formatting at the boundary ------------------------------------------------

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Paise -> rupees as a JSON number, through a fixed two-decimal string so no
// binary float error can creep into a written amount.
const toRupees = (paise) => Number((paise / 100).toFixed(2));

function ddmmyyyy(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}-${month}-${year}`;
}

// 'd-MMM-yy', the purchase register's own date format: '3-Aug-26'.
function registerDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day}-${MONTH_SHORT[month - 1]}-${String(year).slice(-2)}`;
}

// '2026-08' -> '08' (IMS rtnprd) and '082026' (2B rtnprd / supprd).
const mm = (taxPeriod) => taxPeriod.slice(5, 7);
const mmyyyy = (taxPeriod) => `${taxPeriod.slice(5, 7)}${taxPeriod.slice(0, 4)}`;

// --- purchase register -------------------------------------------------------

// The v2.4 template's own headers, trailing space included as real GSTN exports
// carry them, then the three contact columns the app reads when they are present.
const REGISTER_HEADERS = [
  'GSTIN of Supplier/ECO* ', 'Trade/Legal name ', 'Type of inward supplies* ',
  'Document type* ', 'Document number* ', 'Document date* ', 'Taxable value (₹)* ',
  'Integrated tax (₹) ', 'Central tax (₹) ', 'State/UT tax (₹) ', 'Cess (₹) ',
  'Supplier contact person', 'Supplier phone', 'Supplier email'
];
const AMOUNT_COLUMNS = [6, 7, 8, 9, 10];
const DOC_TYPE_LABEL = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note' };

// A tax head the supplier does not charge is left blank, as a trader's own sheet
// would leave it, rather than written as 0.
const amountCell = (paise) => (paise ? toRupees(paise) : null);

function registerRow(doc, contact) {
  return [
    doc.supplier.gstin,
    doc.supplier.name,
    'B2B',
    DOC_TYPE_LABEL[doc.docType],
    doc.invoiceNo,
    registerDate(doc.invoiceDate),
    toRupees(doc.amounts.taxable),
    amountCell(doc.amounts.igst),
    amountCell(doc.amounts.cgst),
    amountCell(doc.amounts.sgst),
    amountCell(doc.amounts.cess),
    contact.person,
    contact.phone,
    contact.email
  ];
}

function writeRegister(path, periodKey, contactOf) {
  const period = PERIODS[periodKey];
  // v2.4 layout: recipient + financial year on row 1, trade name + tax period on
  // row 2, two blank rows, the header on row 5 and documents from row 6.
  const aoa = [
    ['GSTIN of recipient* :', TRADER.gstin, null, 'Financial year* :', period.financialYear],
    ['Trade/Legal name:', TRADER.name, null, 'Tax period* :', period.monthName],
    [],
    [],
    REGISTER_HEADERS,
    ...REGISTER[periodKey].map((doc) => registerRow(doc, contactOf(doc.supplier)))
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  // Amounts display as 1,800.00, which is how Unity's Rs 0.60 rounding gets read.
  for (let row = 5; row < aoa.length; row += 1) {
    for (const col of AMOUNT_COLUMNS) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
    }
  }
  sheet['!cols'] = [22, 22, 10, 12, 12, 11, 13, 12, 11, 11, 7, 20, 17, 26].map((wch) => ({ wch }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Purchase Register');
  XLSX.writeFile(book, path);
}

// --- IMS -------------------------------------------------------------------------

const IMS_SECTIONS = ['b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna', 'ecom', 'ecoma'];

function imsSection(doc) {
  if (doc.docType === 'CREDIT_NOTE') return doc.amendment ? 'b2bcna' : 'b2bcn';
  if (doc.docType === 'DEBIT_NOTE') return doc.amendment ? 'b2bdna' : 'b2bdn';
  return doc.amendment ? 'b2ba' : 'b2b';
}

// One record as the IMS download carries it (docs/ims-json-schema.md section 3).
// The trader has not acted on anything yet, so every action is N.
function imsRecord(doc, state) {
  const { amounts } = state;
  const note = doc.docType !== 'INVOICE';
  const record = {
    stin: doc.supplier.gstin,
    tradenm: doc.supplier.name,
    ...(note
      ? { nt_num: doc.invoiceNo, nt_dt: ddmmyyyy(doc.invoiceDate) }
      : { inum: doc.invoiceNo, idt: ddmmyyyy(doc.invoiceDate) }),
    inv_typ: 'R',
    val: toRupees(amounts.taxable + amounts.totalTax),
    action: 'N',
    pos: TRADER.stateCode,
    txval: toRupees(amounts.taxable),
    iamt: toRupees(amounts.igst),
    camt: toRupees(amounts.cgst),
    samt: toRupees(amounts.sgst),
    cess: toRupees(amounts.cess),
    srcform: doc.sourceForm,
    rtnprd: mm(doc.returnPeriod),
    srcfilstatus: state.status,
    rtnTyp: doc.sourceForm,
    sRtnPrd: mm(doc.returnPeriod),
    ispendactblocked: 'N',
    isRemarksBlocked: 'N',
    itcRedReqBlocked: 'N'
  };
  if (doc.amendment) {
    const original = note
      ? { ont_num: doc.amendment.originalInvoiceNo, ont_dt: ddmmyyyy(doc.amendment.originalInvoiceDate) }
      : { oinum: doc.amendment.originalInvoiceNo, oidt: ddmmyyyy(doc.amendment.originalInvoiceDate) };
    Object.assign(record, original);
  }
  return record;
}

function imsDownload(periodKey, date) {
  const imsDetails = Object.fromEntries(IMS_SECTIONS.map((section) => [section, []]));
  for (const { doc, state } of imsSnapshot(periodKey, date)) {
    imsDetails[imsSection(doc)].push(imsRecord(doc, state));
  }
  return { imsDetails };
}

// --- GSTR-2B -----------------------------------------------------------------------

const TWO_B_SECTIONS = ['b2b', 'b2ba', 'cdnr', 'cdnra', 'isd', 'isda', 'impg', 'impgsez', 'ecom', 'ecoma'];

function twoBSection(doc) {
  if (doc.docType !== 'INVOICE') return doc.amendment ? 'cdnra' : 'cdnr';
  return doc.amendment ? 'b2ba' : 'b2b';
}

function twoBItems(doc, amounts) {
  return [{
    hsn: doc.supplier.hsn,
    rt: 18,
    txval: toRupees(amounts.taxable),
    igst: toRupees(amounts.igst),
    cgst: toRupees(amounts.cgst),
    sgst: toRupees(amounts.sgst),
    cess: toRupees(amounts.cess)
  }];
}

// One document under its supplier block (docs/gstr2b-schema.md sections 2-3).
function twoBDocument(doc, { amounts }) {
  const common = {
    val: toRupees(amounts.taxable + amounts.totalTax),
    pos: TRADER.stateCode,
    rev: 'N',
    itcavl: 'Y',
    rsn: '',
    diffprcnt: 100,
    items: twoBItems(doc, amounts)
  };
  const original = doc.amendment
    ? doc.docType === 'INVOICE'
      ? { oinum: doc.amendment.originalInvoiceNo, oidt: ddmmyyyy(doc.amendment.originalInvoiceDate) }
      : { ont_num: doc.amendment.originalInvoiceNo, ont_dt: ddmmyyyy(doc.amendment.originalInvoiceDate) }
    : {};
  if (doc.docType === 'INVOICE') {
    return { inum: doc.invoiceNo, dt: ddmmyyyy(doc.invoiceDate), typ: 'R', ...common, ...original };
  }
  return {
    ntnum: doc.invoiceNo,
    ntdt: ddmmyyyy(doc.invoiceDate),
    typ: doc.docType === 'CREDIT_NOTE' ? 'C' : 'D',
    ...common,
    ...original
  };
}

// 2B groups documents under one block per supplier return: a supplier who filed a
// GSTR-1 and a GSTR-1A appears twice, each with its own filing date and period.
function twoBStatement(periodKey) {
  const docdata = Object.fromEntries(TWO_B_SECTIONS.map((section) => [section, []]));
  const blocks = new Map();
  for (const { doc, state } of twoBDocuments(periodKey)) {
    const section = twoBSection(doc);
    const key = [section, doc.supplier.gstin, filedOn(doc), doc.returnPeriod].join('|');
    if (!blocks.has(key)) {
      const block = {
        ctin: doc.supplier.gstin,
        trdnm: doc.supplier.name,
        supfildt: ddmmyyyy(filedOn(doc)),
        supprd: mmyyyy(doc.returnPeriod),
        cfs: 'Y',
        [section.startsWith('cdnr') ? 'nt' : 'inv']: []
      };
      blocks.set(key, block);
      docdata[section].push(block);
    }
    const block = blocks.get(key);
    block[section.startsWith('cdnr') ? 'nt' : 'inv'].push(twoBDocument(doc, state));
  }
  const rtnprd = mmyyyy(PERIODS[periodKey].taxPeriod);
  const chksum = createHash('sha256').update(JSON.stringify({ rtnprd, docdata })).digest('hex').slice(0, 32);
  return { chksum, rtnprd, docdata };
}

// --- contacts ----------------------------------------------------------------------

const REGISTER_SUPPLIERS = SUPPLIERS.filter((supplier) =>
  PERIOD_KEYS.some((key) => REGISTER[key].some((doc) => doc.supplier.key === supplier.key))
);

function contactsExample() {
  return {
    note:
      'Copy to contacts.local.json (gitignored) and fill in real details. ' +
      'npm run gen:demo then writes registers carrying them to fixtures/demo-local/. ' +
      'Reliable Traders is not in the register; set its contact in the app.',
    suppliers: Object.fromEntries(
      REGISTER_SUPPLIERS.map((supplier) => [supplier.name, { contactPerson: '', phone: '', email: '' }])
    )
  };
}

// contacts.local.json -> supplier key -> { person, phone, email }. Names are
// matched exactly, so a typo is an error rather than a supplier silently left on
// the placeholder.
function readLocalContacts(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const byName = new Map(REGISTER_SUPPLIERS.map((supplier) => [supplier.name, supplier]));
  const contacts = new Map();
  for (const [name, entry] of Object.entries(parsed.suppliers ?? {})) {
    const supplier = byName.get(name);
    if (!supplier) {
      throw new Error(
        `contacts.local.json names "${name}", which is not a supplier in the register. ` +
          `Expected one of: ${[...byName.keys()].join(', ')}`
      );
    }
    contacts.set(supplier.key, {
      person: entry.contactPerson?.trim() || null,
      phone: entry.phone?.trim() || null,
      email: entry.email?.trim() || null
    });
  }
  return contacts;
}

// --- self-check through the app's adapters -------------------------------------------

function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n  expected ${e}\n  read     ${a}`);
}

const keyed = (rows) => [...rows].sort((x, y) => x.key.localeCompare(y.key));

function checkRegister(path, periodKey) {
  const parsed = purchaseRegister.parseWithMetadata(readFileSync(path));
  assertEqual(parsed.format, purchaseRegister.FORMAT_TEMPLATE_V24, `${path}: format`);
  assertEqual(parsed.taxPeriod, PERIODS[periodKey].taxPeriod, `${path}: tax period`);
  assertEqual(parsed.metadata.recipientGstin, TRADER.gstin, `${path}: recipient`);
  const read = parsed.invoices.map((invoice) => ({
    key: `${invoice.supplierGstin}|${invoice.invoiceNo}`,
    docType: invoice.docType,
    date: invoice.invoiceDate,
    amounts: [invoice.taxableValue, invoice.igst, invoice.cgst, invoice.sgst, invoice.totalTax]
  }));
  const expected = REGISTER[periodKey].map((doc) => ({
    key: `${doc.supplier.gstin}|${doc.invoiceNo}`,
    docType: doc.docType,
    date: doc.invoiceDate,
    amounts: [doc.amounts.taxable, doc.amounts.igst, doc.amounts.cgst, doc.amounts.sgst, doc.amounts.totalTax]
  }));
  assertEqual(keyed(read), keyed(expected), `${path}: documents`);
}

function portalView(record) {
  return {
    key: `${record.supplierGstin}|${record.invoiceNo}`,
    section: record.section,
    docType: record.docType,
    date: record.invoiceDate,
    status: record.filingStatus,
    amounts: [record.taxableValue, record.igst, record.cgst, record.sgst, record.totalTax],
    original: record.originalInvoiceNo
  };
}

const SECTION_OF_IMS = { b2b: 'b2b', b2ba: 'b2ba', b2bcn: 'cdnr', b2bdn: 'cdnr', b2bcna: 'cdnra', b2bdna: 'cdnra' };

function expectedPortalView(doc, state, section) {
  return {
    key: `${doc.supplier.gstin}|${doc.invoiceNo}`,
    section,
    docType: doc.docType,
    date: doc.invoiceDate,
    status: state.status,
    amounts: [state.amounts.taxable, state.amounts.igst, state.amounts.cgst, state.amounts.sgst, state.amounts.totalTax],
    original: doc.amendment?.originalInvoiceNo ?? null
  };
}

function checkIms(path, periodKey, date) {
  const read = ims.parse(readFileSync(path)).map(portalView);
  const expected = imsSnapshot(periodKey, date).map(({ doc, state }) =>
    expectedPortalView(doc, state, SECTION_OF_IMS[imsSection(doc)])
  );
  assertEqual(keyed(read), keyed(expected), `${path}: records`);
}

function checkTwoB(path, periodKey) {
  const records = gstr2b.parse(readFileSync(path));
  assertEqual([...new Set(records.map((r) => r.taxPeriod))], [PERIODS[periodKey].taxPeriod], `${path}: period`);
  const read = records.map(portalView);
  const expected = twoBDocuments(periodKey).map(({ doc, state }) =>
    expectedPortalView(doc, state, twoBSection(doc))
  );
  assertEqual(keyed(read), keyed(expected), `${path}: records`);
}

// --- writing one set ---------------------------------------------------------------

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// Reads every file of a written set back through the adapters and compares it with
// the timeline. Throws on the first difference. The test suite runs this over the
// committed set, so an edit to the timeline cannot ship without regenerating.
export function checkSet(root = DEMO_DIR) {
  for (const periodKey of PERIOD_KEYS) {
    const dir = join(root, periodKey);
    checkRegister(join(dir, registerFileName(periodKey)), periodKey);
    for (const date of PERIODS[periodKey].snapshots) {
      checkIms(join(dir, imsFileName(periodKey, date)), periodKey, date);
    }
    checkTwoB(join(dir, twoBFileName(periodKey)), periodKey);
  }
}

function writeSet(root, contactOf) {
  const written = [];
  for (const periodKey of PERIOD_KEYS) {
    const dir = join(root, periodKey);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const registerPath = join(dir, registerFileName(periodKey));
    writeRegister(registerPath, periodKey, contactOf);
    written.push(registerPath);

    for (const date of PERIODS[periodKey].snapshots) {
      const path = join(dir, imsFileName(periodKey, date));
      writeJson(path, imsDownload(periodKey, date));
      written.push(path);
    }

    const twoBPath = join(dir, twoBFileName(periodKey));
    writeJson(twoBPath, twoBStatement(periodKey));
    written.push(twoBPath);
  }
  checkSet(root);
  return written;
}

// --- main ----------------------------------------------------------------------------

function main() {
  for (const gstin of [TRADER.gstin, ...SUPPLIERS.map((supplier) => supplier.gstin)]) {
    if (!isValidGstin(gstin)) throw new Error(`${gstin} fails the GSTIN check digit`);
  }

  mkdirSync(DEMO_DIR, { recursive: true });
  const committed = writeSet(DEMO_DIR, placeholderContact);
  writeJson(join(DEMO_DIR, 'contacts.example.json'), contactsExample());
  console.log(`wrote ${committed.length} files to fixtures/demo/ (placeholder contacts), all read back through the adapters`);

  if (!existsSync(LOCAL_CONTACTS)) {
    console.log('no fixtures/demo/contacts.local.json: skipped fixtures/demo-local/');
    return;
  }
  const real = readLocalContacts(LOCAL_CONTACTS);
  const blank = { person: null, phone: null, email: null };
  // The portal files are the same as the committed ones; writing the whole set
  // again keeps one folder to upload from on the day.
  const local = writeSet(LOCAL_DIR, (supplier) => real.get(supplier.key) ?? blank);
  console.log(`wrote ${local.length} files to fixtures/demo-local/ with ${real.size} real contact(s) (gitignored)`);
}

// Only when run directly, so the test suite can import checkSet().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
