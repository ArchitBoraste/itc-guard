// generate-fixtures.js — synthetic but realistic GST data for ITC Guard.
//
// Produces six months of a trader's purchase register plus the matching IMS and
// GSTR-2B downloads, with defects injected at controlled rates, and a
// ground_truth.json that names the true expected<->portal pairing (and the defect)
// for every document. Output is fully reproducible: one seeded RNG drives everything.
//
// Run:  node tools/generate-fixtures.js   (or: npm run gen:fixtures)
//
// Output: fixtures/<YYYY-MM>/{purchase_register.xlsx, ims.json, gstr2b.json,
//         ground_truth.json}  plus  fixtures/suppliers.json  and an aggregated
//         fixtures/ground_truth.json across all periods.
//
// Money is handled internally as integer paise and converted to rupees only at the
// writer boundary — the same rule the app enforces. Dates are ISO yyyy-mm-dd
// internally and converted per output format at the boundary too.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

// xlsx is installed in api/node_modules; load it from there without a root install.
const requireFromApi = createRequire(join(REPO_ROOT, 'api', 'package.json'));
const XLSX = requireFromApi('xlsx');

// ---------------------------------------------------------------------------
// Configuration — the knobs. Everything reproducible flows from SEED.
// ---------------------------------------------------------------------------

const SEED = 0x17c9a1d;                       // change to reshuffle the whole world
const SUPPLIER_COUNT = 40;
const PERIODS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

const TRADER = {
  gstin: '27AABCS1429F1Z8',                   // Sharma Electronics, Maharashtra (27)
  legalName: 'Sharma Electronics Private Limited',
  tradeName: 'Sharma Electronics',
  stateCode: '27'
};

// Behaviour-profile mix (must sum to SUPPLIER_COUNT after rounding).
const PROFILE_MIX = [
  ['RELIABLE', 0.60],    // files by the 8th, no errors
  ['SLOPPY', 0.15],      // files on time; 15% of invoices carry a value error
  ['LATE', 0.15],        // 30% of periods filed after the cut-off
  ['DELINQUENT', 0.05],  // files GSTR-1 on time, never files GSTR-3B
  ['GHOST', 0.05]        // 20% of invoices never filed at all
];

const QUARTERLY_SHARE = 0.15;                 // rest are MONTHLY GSTR-1 filers

const PER_SUPPLIER_INVOICES = [7, 13];        // per period; ~40*10 = ~400/month
const RATE_LINES = [1, 3];                    // per invoice
const GST_RATES = [5, 12, 18, 28];

// Controlled defect rates (per eligible invoice unless noted).
const RATES = {
  sloppyValueError: 0.15,   // of a SLOPPY supplier's invoices
  invNoDrift: 0.06,         // A/1003 in books vs A-1003 on the portal
  dateOffByOne: 0.04,       // portal date ±1 day
  gstinTypo: 0.03,          // single-character GSTIN typo on the portal
  moderateInvNo: 0.03,      // one digit changed -> borderline SUGGESTED match
  duplicateInvNo: 0.01,     // deliberate DUPLICATE_INV_NO defect: reuse a prior number
  commaFormattedRow: 0.04,  // of PR rows: amounts written as comma-formatted strings
  savedNotFiled: 0.40,      // of value-mismatch docs: SAVED (IMS only, pre cut-off)
  rcm: 0.05,                // reverse charge -> 2B only, never IMS
  ineligible: 0.02,         // ITC ineligible (POS / 16(4)) -> 2B only, itcavl=N
  ghostUnfiled: 0.20,       // of a GHOST supplier's invoices: never filed
  noteInsteadOfInvoice: 0.05 // credit/debit note rather than a plain invoice
};

const PHANTOMS_PER_PERIOD = [3, 6];   // in 2B, absent from books (not yours)
const ISD_PER_PERIOD = [1, 3];        // 2B only, never IMS
const IMPG_PER_PERIOD = [1, 2];       // imports, 2B only
const IMPGSEZ_PER_PERIOD = [0, 1];

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + primitives
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
const rand = () => rng();
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1)); // inclusive
const chance = (p) => rand() < p;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Money + date helpers. Internal money is integer paise; internal dates ISO.
// ---------------------------------------------------------------------------

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const paiseToRupees = (p) => Number((Math.round(p) / 100).toFixed(2));

function isoOf(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function partsOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}
function addDaysISO(iso, days) {
  const { y, m, d } = partsOf(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function isoToDDMMYYYY(iso) {
  const { y, m, d } = partsOf(iso);
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;
}
function isoToDMMMYY(iso) {           // d-MMM-yy — the purchase-register date format
  const { y, m, d } = partsOf(iso);
  return `${d}-${MONTHS_SHORT[m - 1]}-${String(y).slice(-2)}`;
}
function periodToMMYYYY(period) {     // 2026-02 -> 022026
  const [y, m] = period.split('-');
  return `${m}${y}`;
}
function periodToMM(period) {         // 2026-02 -> 02
  return period.split('-')[1];
}
function financialYear(period) {      // Indian FY: Apr-Mar. 2026-02 -> 2025-26
  const { y, m } = { y: Number(period.split('-')[0]), m: Number(period.split('-')[1]) };
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
function nextMonth(period) {
  let [y, m] = period.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  return { y, m };
}

// ---------------------------------------------------------------------------
// Identity helpers: GSTIN, invoice numbers, hashing, normalisation
// ---------------------------------------------------------------------------

const STATE_CODES = ['27', '29', '07', '24', '33', '06', '19', '36', '08', '23', '09', '32'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '0123456789';
const randLetters = (n) => Array.from({ length: n }, () => pick([...LETTERS])).join('');
const randDigits = (n) => Array.from({ length: n }, () => pick([...DIGITS])).join('');

// state(2) + PAN(10: 5 letters, 4 digits, 1 letter) + entity(1) + 'Z' + check(1) = 15
function makeGstin(stateCode) {
  const pan = randLetters(5) + randDigits(4) + randLetters(1);
  const entity = randDigits(1);
  const check = pick([...(LETTERS + DIGITS)]);
  return `${stateCode}${pan}${entity}Z${check}`;
}

// Flip one PAN-area character to a different one of the same class (letter/digit).
function typoGstin(gstin) {
  const chars = gstin.split('');
  const pos = randInt(2, 11); // stay inside the PAN block
  const c = chars[pos];
  if (/[A-Z]/.test(c)) {
    let r = c; while (r === c) r = pick([...LETTERS]);
    chars[pos] = r;
  } else {
    let r = c; while (r === c) r = pick([...DIGITS]);
    chars[pos] = r;
  }
  return chars.join('');
}

// Canonical normalisation — matches the engine contract in CLAUDE.md.
// uppercase -> strip non-alphanumeric -> strip leading zeros per numeric group.
function normalizeInvoiceNo(s) {
  return String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/\d+/g, (run) => String(Number(run)));
}

const BRANCH_CODES = ['KNP', 'LKO', 'DEL', 'MUM', 'BLR', 'PNQ', 'HYD', 'AMD'];

// Assign each supplier a consistent invoice-number style + parameters.
function makeInvoiceSeries() {
  const style = randInt(0, 8);
  const letter = pick([...LETTERS]);
  const digit = randInt(1, 9);
  const branch = pick(BRANCH_CODES);
  const fy = '06-17';                 // as seen in the real GSTN sample data
  const start = randInt(1000, 4000);
  const width = pick([0, 4, 5]);      // zero-padding width for hyphenated styles
  const pad = (seq) => (width ? String(seq).padStart(width, '0') : String(seq));
  const builders = [
    (seq) => `${seq}`,                              // 1000
    (seq) => `${letter}${seq}`,                     // A1001
    (seq) => `${seq}${letter}`,                     // 1000A
    (seq) => `${letter}/${seq}`,                    // A/1001
    (seq) => `${digit}/${seq}`,                     // 1/1005
    (seq) => `${letter}-${pad(seq)}`,               // A-10010
    (seq) => `${digit}-${pad(seq)}`,                // 1-10010
    (seq) => `${letter}-${branch}/${seq}/${fy}`,    // A-KNP/1000/06-17
    (seq) => `${fy}/${branch}/${seq}`               // 06-17/LKO/1052
  ];
  return { build: builders[style], start, next: start };
}

// Reformat an invoice number so it normalises identically (separator drift).
function driftInvoiceNo(orig) {
  let variant;
  if (orig.includes('/')) variant = orig.replace(/\//g, '-');
  else if (orig.includes('-')) variant = orig.replace(/-/g, '/');
  else {
    // Insert a hyphen at the first letter<->digit boundary; strips out on normalise.
    variant = orig.replace(/([A-Za-z])(\d)|(\d)([A-Za-z])/, (m, a, b, c, d) =>
      a ? `${a}-${b}` : `${c}-${d}`);
  }
  return normalizeInvoiceNo(variant) === normalizeInvoiceNo(orig) && variant !== orig
    ? variant : orig;
}

// Change one digit in the last numeric run — a borderline (not exact) difference.
function moderateInvNoChange(orig) {
  const runs = [...orig.matchAll(/\d+/g)];
  if (!runs.length) return orig;
  const last = runs[runs.length - 1];
  const s = last[0].split('');
  const i = randInt(0, s.length - 1);
  let r = s[i]; while (r === s[i]) r = pick([...DIGITS]);
  s[i] = r;
  const at = last.index;
  const changed = orig.slice(0, at) + s.join('') + orig.slice(at + last[0].length);
  return changed === orig ? orig : changed;
}

// Swap two differing adjacent digits: 47200 -> 42700.
function transposeDigits(n) {
  const s = String(n).split('');
  const spots = [];
  for (let i = 0; i < s.length - 1; i++) if (s[i] !== s[i + 1]) spots.push(i);
  if (!spots.length) return n + 100;      // fallback: still a clear delta
  const i = pick(spots);
  [s[i], s[i + 1]] = [s[i + 1], s[i]];
  const out = Number(s.join(''));
  return out === n ? n + 100 : out;
}

function sha256Hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

// ---------------------------------------------------------------------------
// Supplier master
// ---------------------------------------------------------------------------

const NAME_PREFIX = ['Dell', 'Verma', 'Krishna', 'Patel', 'Sunrise', 'Deepak', 'Ganesh',
  'Anand', 'Bharat', 'Shreeji', 'National', 'Metro', 'Prime', 'Royal', 'Global', 'Unity',
  'Sagar', 'Om', 'Sri', 'Vishal', 'Balaji', 'Ashok', 'Reliable', 'Nova', 'Apex', 'Zenith',
  'Kiran', 'Laxmi', 'Mahavir', 'Navkar', 'Star', 'Pearl', 'Crystal', 'Trident', 'Vega',
  'Orbit', 'Sundar', 'Excel', 'Fortune', 'Aggarwal'];
const NAME_SUFFIX = ['Electronics', 'Traders', 'Cables', 'Hardware', 'Enterprises',
  'Industries', 'Distributors', 'Agencies', 'Trading Co', 'Supply Co', 'Components',
  'Systems', 'Marketing', 'Sales Corp', 'Impex'];
const ENTITY_TYPE = ['Private Limited', '', '& Sons', '& Co', 'LLP'];

function buildProfileList() {
  const list = [];
  for (const [name, share] of PROFILE_MIX) {
    const n = Math.round(share * SUPPLIER_COUNT);
    for (let i = 0; i < n; i++) list.push(name);
  }
  while (list.length < SUPPLIER_COUNT) list.push('RELIABLE');
  return shuffle(list).slice(0, SUPPLIER_COUNT);
}

function buildSuppliers() {
  const profiles = buildProfileList();
  const usedNames = new Set();
  const usedGstins = new Set();
  const suppliers = [];
  for (let i = 0; i < SUPPLIER_COUNT; i++) {
    let legalName;
    do {
      const suffix = pick(NAME_SUFFIX);
      const entity = pick(ENTITY_TYPE);
      legalName = `${NAME_PREFIX[i % NAME_PREFIX.length]} ${suffix}${entity ? ' ' + entity : ''}`;
    } while (usedNames.has(legalName));
    usedNames.add(legalName);

    const stateCode = pick(STATE_CODES);
    let gstin;
    do { gstin = makeGstin(stateCode); } while (usedGstins.has(gstin));
    usedGstins.add(gstin);
    const scheme = chance(QUARTERLY_SHARE) ? 'QUARTERLY' : 'MONTHLY';
    suppliers.push({
      idx: i,
      gstin,
      legalName,
      tradeName: legalName.replace(/ (Private Limited|LLP|& Sons| & Co|Trading Co)$/, ''),
      stateCode,
      profile: profiles[i],
      scheme,
      cutoffDay: scheme === 'QUARTERLY' ? 13 : 11,  // QRMP/IFF vs monthly GSTR-1
      series: makeInvoiceSeries(),
      recentNumbers: [],            // for duplicate injection
      threeBUnfiled: profiles[i] === 'DELINQUENT',
      history: []                   // filled per period for the risk model
    });
  }
  return suppliers;
}

// Decide when a supplier files a given period's GSTR-1 (filing lands next month).
function computeFiling(supplier, period) {
  const { y, m } = nextMonth(period);
  const cut = supplier.cutoffDay;
  let day;
  const periodLate = supplier.profile === 'LATE' && chance(0.30);
  switch (supplier.profile) {
    case 'RELIABLE': day = randInt(5, 8); break;
    case 'DELINQUENT': day = randInt(5, 9); break;
    case 'SLOPPY': day = randInt(6, 10); break;
    case 'GHOST': day = randInt(6, 10); break;
    case 'LATE': day = periodLate ? randInt(cut + 1, cut + 4) : randInt(8, cut); break;
    default: day = randInt(5, 9);
  }
  const filedLate = day > cut;
  return {
    dateISO: isoOf(y, m, day),
    cutoffISO: isoOf(y, m, cut),
    daysLate: Math.max(0, day - cut),
    filedLate
  };
}

// ---------------------------------------------------------------------------
// Rate lines + amounts
// ---------------------------------------------------------------------------

function buildRateLines(supplier) {
  const count = randInt(RATE_LINES[0], RATE_LINES[1]);
  const rates = shuffle(GST_RATES).slice(0, count);
  const intra = supplier.stateCode === TRADER.stateCode;
  return rates.map((rate) => {
    const taxableRupees = randInt(1000, 250000);
    const taxablePaise = taxableRupees * 100;
    const taxPaise = Math.round(taxablePaise * rate / 100);
    const igst = intra ? 0 : taxPaise;
    const cgst = intra ? Math.floor(taxPaise / 2) : 0;
    const sgst = intra ? taxPaise - cgst : 0;
    return {
      hsn: String(randInt(1000, 9999)),
      rate,
      taxablePaise,
      igst, cgst, sgst, cess: 0,
      taxPaise
    };
  });
}

function transposeOneLine(lines) {
  const out = lines.map((l) => ({ ...l }));
  const i = randInt(0, out.length - 1);
  const l = out[i];
  const rupees = l.taxablePaise / 100;
  const newRupees = transposeDigits(rupees);
  const intraSplit = l.cgst > 0 || (l.igst === 0 && l.taxPaise > 0);
  l.taxablePaise = newRupees * 100;
  l.taxPaise = Math.round(l.taxablePaise * l.rate / 100);
  if (intraSplit) { l.cgst = Math.floor(l.taxPaise / 2); l.sgst = l.taxPaise - l.cgst; l.igst = 0; }
  else { l.igst = l.taxPaise; l.cgst = 0; l.sgst = 0; }
  return out;
}

function totalsOf(lines) {
  const t = { taxablePaise: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, taxPaise: 0 };
  for (const l of lines) {
    t.taxablePaise += l.taxablePaise;
    t.igst += l.igst; t.cgst += l.cgst; t.sgst += l.sgst; t.cess += l.cess;
    t.taxPaise += l.taxPaise;
  }
  t.valuePaise = t.taxablePaise + t.taxPaise;
  return t;
}

// ---------------------------------------------------------------------------
// Invoice construction — one canonical internal document with book + portal sides
// ---------------------------------------------------------------------------

let docSeq = 0;
function nextDocId() { return `D${String(++docSeq).padStart(6, '0')}`; }

const SUPPLY_TYPES = [['B2B', 0.90], ['DE', 0.04], ['SEZWP', 0.03], ['SEZWOP', 0.03]];
function pickSupplyType() {
  const r = rand(); let acc = 0;
  for (const [t, p] of SUPPLY_TYPES) { acc += p; if (r < acc) return t; }
  return 'B2B';
}

const imsInvType = { B2B: 'R', DE: 'DE', SEZWP: 'SEWP', SEZWOP: 'SEWOP' };
const twoBInvType = { B2B: 'R', DE: 'DE', SEZWP: 'SEZWP', SEZWOP: 'SEZWOP' };
const INELIGIBLE_REASONS = ['POS', '16(4)', 'Sec17(5)'];

function buildInvoice(supplier, period, filing, opts = {}) {
  const docType = opts.docType || 'INVOICE';
  const supplyType = opts.supplyType || (docType === 'INVOICE' ? pickSupplyType() : 'B2B');

  // Invoice number (books side), with optional duplicate reuse.
  let invoiceNoBooks;
  if (opts.duplicateOf) {
    invoiceNoBooks = opts.duplicateOf;
  } else {
    invoiceNoBooks = supplier.series.build(supplier.series.next++);
  }
  supplier.recentNumbers.push(invoiceNoBooks);
  if (supplier.recentNumbers.length > 20) supplier.recentNumbers.shift();

  const { y, m } = { y: Number(period.split('-')[0]), m: Number(period.split('-')[1]) };
  const invoiceDateBooks = isoOf(y, m, randInt(1, 28));

  const booksLines = buildRateLines(supplier);
  const booksTotals = totalsOf(booksLines);

  // A deliberate duplicate reuses a prior number but is otherwise a clean, distinct
  // document (its own date and values). It carries no other defect so phase 3 can
  // score the collision cleanly.
  const isDuplicate = !!opts.duplicateOf;
  const noDefects = opts.clean || isDuplicate;

  // Routing: RCM and ineligible bypass IMS and live only in 2B. They are a
  // routing defect in their own right, mutually exclusive with the drift defects.
  const isRcm = !noDefects && (opts.forceRcm || (docType === 'INVOICE' && chance(RATES.rcm)));
  const isIneligible = !noDefects && !isRcm && docType === 'INVOICE' && chance(RATES.ineligible);

  // Choose one matching-defect for this document (mutually exclusive).
  let defect = 'NONE';
  if (isDuplicate) {
    defect = 'DUPLICATE_INV_NO';
  } else if (opts.clean) {
    defect = 'NONE';
  } else if (isRcm) {
    defect = 'RCM';
  } else if (isIneligible) {
    defect = 'INELIGIBLE';
  } else if (supplier.profile === 'SLOPPY' && chance(RATES.sloppyValueError)) {
    defect = 'VALUE_TRANSPOSITION';
  } else {
    const r = rand();
    let acc = 0;
    if (r < (acc += RATES.invNoDrift)) defect = 'INV_NO_DRIFT';
    else if (r < (acc += RATES.dateOffByOne)) defect = 'DATE_OFF_BY_ONE';
    else if (r < (acc += RATES.gstinTypo)) defect = 'GSTIN_TYPO';
    else if (r < (acc += RATES.moderateInvNo)) defect = 'MODERATE_INV_NO';
  }

  // Portal side starts as a copy of the books side, then the defect perturbs it.
  let supplierGstinPortal = supplier.gstin;
  let invoiceNoPortal = invoiceNoBooks;
  let invoiceDatePortal = invoiceDateBooks;
  let portalLines = booksLines.map((l) => ({ ...l }));
  const flags = [];

  switch (defect) {
    case 'VALUE_TRANSPOSITION': portalLines = transposeOneLine(booksLines); break;
    case 'INV_NO_DRIFT': invoiceNoPortal = driftInvoiceNo(invoiceNoBooks); break;
    case 'MODERATE_INV_NO': invoiceNoPortal = moderateInvNoChange(invoiceNoBooks); flags.push('FUZZY_INV_NO'); break;
    case 'DATE_OFF_BY_ONE': invoiceDatePortal = addDaysISO(invoiceDateBooks, chance(0.5) ? 1 : -1); break;
    case 'GSTIN_TYPO': supplierGstinPortal = typoGstin(supplier.gstin); flags.push('GSTIN_MISMATCH'); break;
  }
  if (isDuplicate) flags.push('DUPLICATE_INV_NO');
  if (supplier.threeBUnfiled) flags.push('SUPPLIER_3B_UNFILED');

  const portalTotals = totalsOf(portalLines);

  // Presence + filing state.
  let inBooks = true, inIms, in2b, filingStatus = null;
  if (isRcm || isIneligible) {
    inIms = false; in2b = true;                         // 2B only, never IMS
  } else {
    // Duplicates are always cleanly filed on both sides; skip the ghost-miss roll.
    const ghostMiss = !isDuplicate && supplier.profile === 'GHOST' && chance(RATES.ghostUnfiled);
    if (ghostMiss) {
      inIms = false; in2b = false;                      // never filed at all
      defect = 'MISSING_IN_PORTAL';
    } else {
      inIms = true;
      // Value-mismatch docs may still be SAVED (editable, pre cut-off) -> IMS only.
      const saved = defect === 'VALUE_TRANSPOSITION' && chance(RATES.savedNotFiled);
      filingStatus = saved ? 'SAVED' : 'FILED';
      in2b = filingStatus === 'FILED';
    }
  }
  if (filing.filedLate && in2b) flags.push('LATE_FILING');

  // itc availability on the 2B side.
  let itcAvailable = true, itcReason = '';
  if (isRcm) { itcAvailable = false; itcReason = ''; }
  if (isIneligible) { itcAvailable = false; itcReason = pick(INELIGIBLE_REASONS); }

  const expectedBucket = classifyBucket({ defect, isRcm, isIneligible, inBooks, inIms, in2b });

  const contentHash = sha256Hex([
    supplierGstinPortal, normalizeInvoiceNo(invoiceNoPortal), invoiceDatePortal,
    portalTotals.taxablePaise, portalTotals.taxPaise, docType
  ].join('|'));

  return {
    docId: nextDocId(),
    period, supplier, filing,
    docType, supplyType,
    reverseCharge: isRcm,
    isIneligible,
    // books side
    invoiceNoBooks, invoiceDateBooks, booksLines, booksTotals,
    // portal side
    supplierGstinPortal, invoiceNoPortal, invoiceDatePortal, portalLines, portalTotals,
    itcAvailable, itcReason,
    inBooks, inIms, in2b, filingStatus,
    originalInvoiceNo: opts.originalInvoiceNo || null,
    originalInvoiceDate: opts.originalInvoiceDate || null,
    defect, flags, expectedBucket,
    contentHash
  };
}

function classifyBucket({ defect, isRcm, isIneligible, inBooks, inIms, in2b }) {
  if (isRcm) return 'NON_IMS';
  if (isIneligible) return 'INELIGIBLE';
  if (!inBooks) return 'MISSING_IN_BOOKS';
  if (!inIms && !in2b) return 'MISSING_IN_PORTAL';
  switch (defect) {
    case 'VALUE_TRANSPOSITION': return 'VALUE_MISMATCH';
    case 'MODERATE_INV_NO': return 'SUGGESTED';
    default: return 'MATCHED'; // NONE, INV_NO_DRIFT, DATE_OFF_BY_ONE, GSTIN_TYPO
  }
}

// Phantom: a real-looking 2B record for a supplier we never bought from.
function buildPhantom(period, filing, supplier) {
  const inv = buildInvoice(supplier, period, filing, { clean: true });
  inv.inBooks = false;
  inv.inIms = true; inv.in2b = true; inv.filingStatus = 'FILED';
  inv.defect = 'PHANTOM_2B';
  inv.flags = [];
  inv.expectedBucket = 'MISSING_IN_BOOKS';
  return inv;
}

// ---------------------------------------------------------------------------
// 2B-only, non-IMS special records: ISD, IMPG, IMPGSEZ
// ---------------------------------------------------------------------------

function buildIsd(period, filing, supplier) {
  const taxableRupees = randInt(20000, 300000);
  const taxPaise = Math.round(taxableRupees * 100 * 0.18);
  return {
    kind: 'ISD', period, supplier, filing,
    docNum: `ISD/${supplier.series.next++}`,
    docDate: isoOf(Number(period.split('-')[0]), Number(period.split('-')[1]), randInt(1, 28)),
    docType: chance(0.85) ? 'ISDI' : 'ISDC',
    igst: taxPaise, cgst: 0, sgst: 0, cess: 0,
    defect: 'ISD', expectedBucket: 'NON_IMS'
  };
}

function buildImpg(period, sez) {
  const taxableRupees = randInt(50000, 800000);
  const taxablePaise = taxableRupees * 100;
  const igst = Math.round(taxablePaise * 0.18);
  const { y, m } = { y: Number(period.split('-')[0]), m: Number(period.split('-')[1]) };
  return {
    kind: sez ? 'IMPGSEZ' : 'IMPG', period,
    portCode: `INMAA${randInt(1, 4)}`,
    boeNum: String(randInt(1000000, 9999999)),
    boeDate: isoOf(y, m, randInt(1, 28)),
    taxablePaise, igst, cess: 0,
    sezGstin: sez ? makeGstin(pick(STATE_CODES)) : null,
    defect: sez ? 'IMPGSEZ' : 'IMPG', expectedBucket: 'NON_IMS'
  };
}

// ---------------------------------------------------------------------------
// Output mapping — books/portal internal docs -> per-format shapes
// ---------------------------------------------------------------------------

function prRow(inv) {
  const t = inv.booksTotals;
  const docTypeLabel = { INVOICE: 'Invoice', DEBIT_NOTE: 'Debit Note', CREDIT_NOTE: 'Credit Note' }[inv.docType];
  return [
    inv.supplier.gstin,
    inv.supplier.tradeName,
    inv.supplyType,
    docTypeLabel,
    inv.invoiceNoBooks,
    isoToDMMMYY(inv.invoiceDateBooks),
    paiseToRupees(t.taxablePaise),
    paiseToRupees(t.igst),
    paiseToRupees(t.cgst),
    paiseToRupees(t.sgst),
    paiseToRupees(t.cess)
  ];
}

function imsBlockedFlags() {
  // Mostly permissive; occasionally a blocked flag to exercise the guard rails.
  return {
    ispendactblocked: chance(0.05) ? 'Y' : 'N',
    isRemarksBlocked: chance(0.03) ? 'Y' : 'N',
    itcRedReqBlocked: chance(0.03) ? 'Y' : 'N'
  };
}

function imsInvoiceRecord(inv) {
  const t = inv.portalTotals;
  const b = imsBlockedFlags();
  const mm = periodToMM(inv.period);
  return {
    stin: inv.supplierGstinPortal,
    tradenm: inv.supplier.tradeName,
    inum: String(inv.invoiceNoPortal),
    inv_typ: imsInvType[inv.supplyType],
    idt: isoToDDMMYYYY(inv.invoiceDatePortal),
    val: paiseToRupees(t.valuePaise),
    action: 'N',                       // trader has not acted — deemed-accept risk
    pos: inv.supplier.stateCode,
    txval: paiseToRupees(t.taxablePaise),
    iamt: paiseToRupees(t.igst),
    camt: paiseToRupees(t.cgst),
    samt: paiseToRupees(t.sgst),
    cess: paiseToRupees(t.cess),
    srcform: 'R1',
    rtnprd: mm,
    srcfilstatus: inv.filingStatus,
    rtnTyp: 'R1',
    sRtnPrd: mm,
    ...b
  };
}

function imsNoteRecord(inv) {
  const t = inv.portalTotals;
  const b = imsBlockedFlags();
  const mm = periodToMM(inv.period);
  return {
    stin: inv.supplierGstinPortal,
    tradenm: inv.supplier.tradeName,
    nt_num: String(inv.invoiceNoPortal),
    nt_dt: isoToDDMMYYYY(inv.invoiceDatePortal),
    inv_typ: imsInvType[inv.supplyType],
    val: paiseToRupees(t.valuePaise),
    action: 'N',
    pos: inv.supplier.stateCode,
    txval: paiseToRupees(t.taxablePaise),
    iamt: paiseToRupees(t.igst),
    camt: paiseToRupees(t.cgst),
    samt: paiseToRupees(t.sgst),
    cess: paiseToRupees(t.cess),
    srcform: 'R1',
    rtnprd: mm,
    srcfilstatus: inv.filingStatus,
    rtnTyp: 'R1',
    sRtnPrd: mm,
    ...b
  };
}

function twoBItems(lines) {
  return lines.map((l) => ({
    hsn: l.hsn,
    rt: l.rate,
    txval: paiseToRupees(l.taxablePaise),
    igst: paiseToRupees(l.igst),
    cgst: paiseToRupees(l.cgst),
    sgst: paiseToRupees(l.sgst),
    cess: paiseToRupees(l.cess)
  }));
}

function twoBInvEntry(inv) {
  const t = inv.portalTotals;
  return {
    inum: String(inv.invoiceNoPortal),
    dt: isoToDDMMYYYY(inv.invoiceDatePortal),
    val: paiseToRupees(t.valuePaise),
    typ: twoBInvType[inv.supplyType],
    pos: inv.supplier.stateCode,
    rev: inv.reverseCharge ? 'Y' : 'N',
    itcavl: inv.itcAvailable ? 'Y' : 'N',
    rsn: inv.itcReason || '',
    diffprcnt: 100,
    cfs: 'Y',
    chksum: inv.contentHash.slice(0, 16),
    items: twoBItems(inv.portalLines)
  };
}

function twoBNoteEntry(inv) {
  const t = inv.portalTotals;
  return {
    ntnum: String(inv.invoiceNoPortal),
    ntdt: isoToDDMMYYYY(inv.invoiceDatePortal),
    typ: inv.docType === 'CREDIT_NOTE' ? 'C' : 'D',
    val: paiseToRupees(t.valuePaise),
    pos: inv.supplier.stateCode,
    rev: inv.reverseCharge ? 'Y' : 'N',
    itcavl: inv.itcAvailable ? 'Y' : 'N',
    rsn: inv.itcReason || '',
    diffprcnt: 100,
    cfs: 'Y',
    chksum: inv.contentHash.slice(0, 16),
    items: twoBItems(inv.portalLines)
  };
}

function groundTruthEntry(inv) {
  return {
    docId: inv.docId,
    period: inv.period,
    defect: inv.defect,
    expectedBucket: inv.expectedBucket,
    flags: inv.flags,
    supplierProfile: inv.supplier.profile,
    supplierScheme: inv.supplier.scheme,
    docType: inv.docType,
    section: inv.docType === 'INVOICE' ? 'b2b'
      : (inv.docType === 'CREDIT_NOTE' ? 'b2bcn/cdnr' : 'b2bdn/cdnr'),
    presence: { inBooks: inv.inBooks, inIms: inv.inIms, in2b: inv.in2b },
    filingStatus: inv.filingStatus,
    filedLate: inv.filing.filedLate,
    daysLate: inv.filing.daysLate,
    books: inv.inBooks ? {
      supplierGstin: inv.supplier.gstin,
      invoiceNo: inv.invoiceNoBooks,
      invoiceNoNorm: normalizeInvoiceNo(inv.invoiceNoBooks),
      invoiceDate: inv.invoiceDateBooks,
      taxablePaise: inv.booksTotals.taxablePaise,
      totalTaxPaise: inv.booksTotals.taxPaise
    } : null,
    portal: (inv.inIms || inv.in2b) ? {
      supplierGstin: inv.supplierGstinPortal,
      invoiceNo: inv.invoiceNoPortal,
      invoiceNoNorm: normalizeInvoiceNo(inv.invoiceNoPortal),
      invoiceDate: inv.invoiceDatePortal,
      taxablePaise: inv.portalTotals.taxablePaise,
      totalTaxPaise: inv.portalTotals.taxPaise,
      contentHash: inv.contentHash
    } : null,
    deltaTaxablePaise: inv.inBooks && (inv.inIms || inv.in2b)
      ? inv.booksTotals.taxablePaise - inv.portalTotals.taxablePaise : null,
    deltaTotalTaxPaise: inv.inBooks && (inv.inIms || inv.in2b)
      ? inv.booksTotals.taxPaise - inv.portalTotals.taxPaise : null
  };
}

// ---------------------------------------------------------------------------
// Writers — change an output format in exactly one place.
// ---------------------------------------------------------------------------

// Column headers exactly as the official PurchaseRegister_Template_v2.4 sheet emits
// them — trailing space included, as real GSTN exports carry. The adapter must trim.
const PR_HEADERS = [
  'GSTIN of Supplier/ECO* ', 'Trade/Legal name ', 'Type of inward supplies* ',
  'Document type* ', 'Document number* ', 'Document date* ', 'Taxable value (₹)* ',
  'Integrated tax (₹) ', 'Central tax (₹) ', 'State/UT tax (₹) ', 'Cess (₹) '
];

// Indian-grouped comma string, e.g. 498100 -> "4,98,100", 35813.02 -> "35,813.02".
// Trailing ".00" is dropped to mirror the messy strings real exports produce.
function commaFormat(num) {
  const neg = num < 0;
  const s = Math.abs(num).toFixed(2);
  let [ip, fp] = s.split('.');
  const last3 = ip.length > 3 ? ip.slice(-3) : ip;
  const rest = ip.length > 3 ? ip.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') : '';
  let out = rest ? `${rest},${last3}` : last3;
  if (fp && fp !== '00') out += `.${fp}`;
  return (neg ? '-' : '') + out;
}

function writePurchaseRegister(dir, { recipient, fy, taxPeriodName, rows }) {
  // v2.4 layout: two metadata rows (recipient + FY / trade name + tax period),
  // two blank rows, the header row at row 5, data from row 6.
  const aoa = [
    ['GSTIN of recipient* :', recipient.gstin, null, 'Financial year* :', fy],
    ['Trade/Legal name:', recipient.tradeName, null, 'Tax period* :', taxPeriodName],
    [],
    [],
    PR_HEADERS,
    ...rows
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 20 }, { wch: 26 }, { wch: 4 }, { wch: 16 }, { wch: 14 },
    { wch: 14 }, { wch: 16 }, { wch: 15 }, { wch: 13 }, { wch: 14 }, { wch: 11 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Purchase Register');
  XLSX.writeFile(wb, join(dir, 'purchase_register.xlsx'));
}

const IMS_SECTIONS = ['b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna', 'ecom', 'ecoma'];

function writeIms(dir, sections) {
  const imsDetails = {};
  for (const s of IMS_SECTIONS) imsDetails[s] = sections[s] || [];
  writeFileSync(join(dir, 'ims.json'), JSON.stringify({ imsDetails }, null, 2));
}

const TWOB_SECTIONS = ['b2b', 'b2ba', 'cdnr', 'cdnra', 'isd', 'isda',
  'impg', 'impgsez', 'ecom', 'ecoma'];

function writeGstr2b(dir, { period, docdata }) {
  const filled = {};
  for (const s of TWOB_SECTIONS) filled[s] = docdata[s] || [];
  const payload = { rtnprd: periodToMMYYYY(period), docdata: filled };
  payload.chksum = sha256Hex(JSON.stringify(payload)).slice(0, 32);
  // chksum first for readability
  writeFileSync(join(dir, 'gstr2b.json'),
    JSON.stringify({ chksum: payload.chksum, rtnprd: payload.rtnprd, docdata: filled }, null, 2));
}

function writeGroundTruth(dir, period, entries) {
  writeFileSync(join(dir, 'ground_truth.json'),
    JSON.stringify({ period, trader: TRADER.gstin, documents: entries }, null, 2));
}

// ---------------------------------------------------------------------------
// Per-period generation
// ---------------------------------------------------------------------------

function groupBySupplier(invs, entryFn, sectionKey) {
  const map = new Map();
  for (const inv of invs) {
    const ctin = inv.supplierGstinPortal;
    if (!map.has(ctin)) {
      map.set(ctin, {
        ctin,
        trdnm: inv.supplier.tradeName,
        supfildt: isoToDDMMYYYY(inv.filing.dateISO),
        supprd: periodToMMYYYY(inv.period),
        [sectionKey]: []
      });
    }
    map.get(ctin)[sectionKey].push(entryFn(inv));
  }
  return [...map.values()];
}

function generatePeriod(period, suppliers) {
  const filingBySupplier = new Map();
  for (const s of suppliers) filingBySupplier.set(s.idx, computeFiling(s, period));

  const docs = [];

  // Regular documents per supplier.
  for (const supplier of suppliers) {
    const filing = filingBySupplier.get(supplier.idx);
    const n = randInt(PER_SUPPLIER_INVOICES[0], PER_SUPPLIER_INVOICES[1]);
    for (let k = 0; k < n; k++) {
      const isNote = chance(RATES.noteInsteadOfInvoice);
      const opts = {};
      if (isNote) {
        opts.docType = chance(0.6) ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
        if (supplier.recentNumbers.length) {
          opts.originalInvoiceNo = pick(supplier.recentNumbers);
        }
      }
      // Duplicate injection: reuse a recent number as a second document.
      if (!isNote && supplier.recentNumbers.length && chance(RATES.duplicateInvNo)) {
        opts.duplicateOf = supplier.recentNumbers[supplier.recentNumbers.length - 1];
      }
      docs.push(buildInvoice(supplier, period, filing, opts));
    }
  }

  // Phantoms — in 2B, not in the books.
  const nPhantom = randInt(PHANTOMS_PER_PERIOD[0], PHANTOMS_PER_PERIOD[1]);
  for (let i = 0; i < nPhantom; i++) {
    const supplier = pick(suppliers);
    docs.push(buildPhantom(period, filingBySupplier.get(supplier.idx), supplier));
  }

  // ISD / IMPG / IMPGSEZ — 2B only, never IMS.
  const isdDocs = [], impgDocs = [];
  const nIsd = randInt(ISD_PER_PERIOD[0], ISD_PER_PERIOD[1]);
  for (let i = 0; i < nIsd; i++) {
    const supplier = pick(suppliers);
    isdDocs.push(buildIsd(period, filingBySupplier.get(supplier.idx), supplier));
  }
  const nImpg = randInt(IMPG_PER_PERIOD[0], IMPG_PER_PERIOD[1]);
  for (let i = 0; i < nImpg; i++) impgDocs.push(buildImpg(period, false));
  const nImpgSez = randInt(IMPGSEZ_PER_PERIOD[0], IMPGSEZ_PER_PERIOD[1]);
  for (let i = 0; i < nImpgSez; i++) impgDocs.push(buildImpg(period, true));

  // --- Assemble output sections ---
  const prRows = docs.filter((d) => d.inBooks).map(prRow);
  // Real GSTN exports write some amounts as comma-formatted strings ("4,981").
  // Rewrite the five amount cells on a small fraction of rows so the phase 2
  // adapter's comma-stripping is genuinely exercised.
  for (const row of prRows) {
    if (chance(RATES.commaFormattedRow)) {
      for (let c = 6; c <= 10; c++) row[c] = commaFormat(row[c]);
    }
  }

  const imsInvoices = docs.filter((d) => d.inIms && d.docType === 'INVOICE');
  const imsCreditNotes = docs.filter((d) => d.inIms && d.docType === 'CREDIT_NOTE');
  const imsDebitNotes = docs.filter((d) => d.inIms && d.docType === 'DEBIT_NOTE');
  const imsSections = {
    b2b: imsInvoices.map(imsInvoiceRecord),
    b2bcn: imsCreditNotes.map(imsNoteRecord),
    b2bdn: imsDebitNotes.map(imsNoteRecord)
  };

  const twoBInvoices = docs.filter((d) => d.in2b && d.docType === 'INVOICE');
  const twoBNotes = docs.filter((d) => d.in2b && d.docType !== 'INVOICE');
  const docdata = {
    b2b: groupBySupplier(twoBInvoices, twoBInvEntry, 'inv'),
    cdnr: groupBySupplier(twoBNotes, twoBNoteEntry, 'nt'),
    isd: buildIsdSection(isdDocs),
    impg: impgDocs.filter((d) => d.kind === 'IMPG').map(impgEntry),
    impgsez: impgDocs.filter((d) => d.kind === 'IMPGSEZ').map(impgsezEntry)
  };

  // --- Ground truth ---
  const gt = docs.map(groundTruthEntry);
  for (const d of isdDocs) gt.push(isdGroundTruth(d));
  for (const d of impgDocs) gt.push(impgGroundTruth(d));

  // --- Supplier history for the risk model ---
  updateSupplierHistory(suppliers, period, docs, filingBySupplier);

  return { docs, isdDocs, impgDocs, prRows, imsSections, docdata, gt };
}

function buildIsdSection(isdDocs) {
  const map = new Map();
  for (const d of isdDocs) {
    if (!map.has(d.supplier.gstin)) {
      map.set(d.supplier.gstin, {
        ctin: d.supplier.gstin,
        trdnm: d.supplier.tradeName,
        supprd: periodToMMYYYY(d.period),
        doclist: []
      });
    }
    map.get(d.supplier.gstin).doclist.push({
      docnum: d.docNum,
      docdt: isoToDDMMYYYY(d.docDate),
      doctyp: d.docType,
      itcelg: 'Y',
      igst: paiseToRupees(d.igst),
      cgst: paiseToRupees(d.cgst),
      sgst: paiseToRupees(d.sgst),
      cess: paiseToRupees(d.cess)
    });
  }
  return [...map.values()];
}

function impgEntry(d) {
  return {
    portcode: d.portCode,
    boenum: d.boeNum,
    boedt: isoToDDMMYYYY(d.boeDate),
    refdt: isoToDDMMYYYY(d.boeDate),
    recdt: isoToDDMMYYYY(d.boeDate),
    txval: paiseToRupees(d.taxablePaise),
    igst: paiseToRupees(d.igst),
    cess: paiseToRupees(d.cess),
    isamd: 'N'
  };
}
function impgsezEntry(d) {
  return { ...impgEntry(d), sgstin: d.sezGstin };
}

function isdGroundTruth(d) {
  return {
    docId: `ISD-${d.docNum}`, period: d.period, defect: d.defect,
    expectedBucket: d.expectedBucket, flags: [], supplierProfile: d.supplier.profile,
    supplierScheme: d.supplier.scheme, docType: d.docType, section: 'isd',
    presence: { inBooks: false, inIms: false, in2b: true },
    books: null,
    portal: { supplierGstin: d.supplier.gstin, invoiceNo: d.docNum, invoiceDate: d.docDate }
  };
}
function impgGroundTruth(d) {
  return {
    docId: `${d.kind}-${d.boeNum}`, period: d.period, defect: d.defect,
    expectedBucket: d.expectedBucket, flags: [], supplierProfile: null,
    supplierScheme: null, docType: 'BOE', section: d.kind.toLowerCase(),
    presence: { inBooks: false, inIms: false, in2b: true },
    books: null,
    portal: { portCode: d.portCode, boeNum: d.boeNum, boeDate: d.boeDate,
      taxablePaise: d.taxablePaise }
  };
}

function updateSupplierHistory(suppliers, period, docs, filingBySupplier) {
  const byIdx = new Map();
  for (const d of docs) {
    if (!d.inBooks) continue; // phantoms aren't the supplier's real books activity
    const idx = d.supplier.idx;
    if (!byIdx.has(idx)) byIdx.set(idx, { expected: 0, filed: 0, missed: 0 });
    const h = byIdx.get(idx);
    h.expected++;
    if (d.in2b || d.inIms) h.filed++;
    if (!d.inIms && !d.in2b) h.missed++;
  }
  for (const s of suppliers) {
    const h = byIdx.get(s.idx) || { expected: 0, filed: 0, missed: 0 };
    const filing = filingBySupplier.get(s.idx);
    s.history.push({
      period,
      expectedCount: h.expected,
      filedCount: h.filed,
      missedCount: h.missed,
      filedLate: filing.filedLate,
      daysLate: filing.daysLate,
      threeBFiled: !s.threeBUnfiled
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const suppliers = buildSuppliers();

  const aggregateGT = [];
  const summaryRows = [];

  for (const period of PERIODS) {
    const dir = join(FIXTURES_DIR, period);
    mkdirSync(dir, { recursive: true });

    const { docs, isdDocs, impgDocs, prRows, imsSections, docdata, gt } =
      generatePeriod(period, suppliers);

    writePurchaseRegister(dir, {
      recipient: TRADER,
      fy: financialYear(period),
      taxPeriodName: MONTHS_LONG[Number(period.split('-')[1]) - 1],
      rows: prRows
    });
    writeIms(dir, imsSections);
    writeGstr2b(dir, { period, docdata });
    writeGroundTruth(dir, period, gt);

    for (const e of gt) aggregateGT.push(e);

    // Summary counters.
    const buckets = {};
    for (const e of gt) buckets[e.expectedBucket] = (buckets[e.expectedBucket] || 0) + 1;
    const imsCount = imsSections.b2b.length + imsSections.b2bcn.length + imsSections.b2bdn.length;
    const twoBCount = docs.filter((d) => d.in2b).length + isdDocs.length + impgDocs.length;
    summaryRows.push({
      Period: period,
      'PR docs': prRows.length,
      'IMS recs': imsCount,
      '2B recs': twoBCount,
      MATCHED: buckets.MATCHED || 0,
      VALUE_MISMATCH: buckets.VALUE_MISMATCH || 0,
      SUGGESTED: buckets.SUGGESTED || 0,
      MISS_PORTAL: buckets.MISSING_IN_PORTAL || 0,
      MISS_BOOKS: buckets.MISSING_IN_BOOKS || 0,
      INELIGIBLE: buckets.INELIGIBLE || 0,
      NON_IMS: buckets.NON_IMS || 0
    });
  }

  // Aggregate ground truth (single file the matching tests read) + supplier master.
  writeFileSync(join(FIXTURES_DIR, 'ground_truth.json'),
    JSON.stringify({
      trader: TRADER.gstin,
      periods: PERIODS,
      seed: SEED,
      documents: aggregateGT
    }, null, 2));

  writeFileSync(join(FIXTURES_DIR, 'suppliers.json'),
    JSON.stringify({
      trader: TRADER,
      seed: SEED,
      suppliers: suppliers.map((s) => ({
        gstin: s.gstin,
        legalName: s.legalName,
        tradeName: s.tradeName,
        stateCode: s.stateCode,
        profile: s.profile,
        scheme: s.scheme,
        cutoffDay: s.cutoffDay,
        threeBUnfiled: s.threeBUnfiled,
        history: s.history
      }))
    }, null, 2));

  // Reporting.
  console.log('\nITC Guard fixture generation');
  console.log(`  seed        ${SEED}`);
  console.log(`  trader      ${TRADER.tradeName} (${TRADER.gstin})`);
  console.log(`  suppliers   ${SUPPLIER_COUNT}`);
  printProfileBreakdown(suppliers);
  console.log(`  periods     ${PERIODS.join(', ')}`);
  console.log(`  output      ${FIXTURES_DIR}\n`);
  console.table(summaryRows);
  console.log(`\nTotal documents across all periods: ${aggregateGT.length}`);
  const defectTotals = {};
  for (const e of aggregateGT) defectTotals[e.defect] = (defectTotals[e.defect] || 0) + 1;
  console.log('Injected defect counts:');
  console.table(defectTotals);
}

function printProfileBreakdown(suppliers) {
  const byProfile = {}, byScheme = {};
  for (const s of suppliers) {
    byProfile[s.profile] = (byProfile[s.profile] || 0) + 1;
    byScheme[s.scheme] = (byScheme[s.scheme] || 0) + 1;
  }
  const profStr = Object.entries(byProfile).map(([k, v]) => `${k}:${v}`).join('  ');
  const schemeStr = Object.entries(byScheme).map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`  profiles    ${profStr}`);
  console.log(`  schemes     ${schemeStr}`);
}

main();
