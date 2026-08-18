// Value-level conversions used by every adapter. Money crosses into integer
// paise here and dates into ISO yyyy-mm-dd here — nowhere downstream.
// No portal field names in this file; it only knows about shapes of values.

export class AdapterError extends Error {
  constructor(message, context = {}) {
    super(context.at ? `${context.at}: ${message}` : message);
    this.name = 'AdapterError';
    this.code = 'adapter_parse_error';
    this.context = context;
  }
}

const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Portal downloads and trader CSVs are frequently UTF-8 with a BOM, which would
// otherwise end up glued to the first header or JSON brace.
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

// Portal JSON and register cells carry RUPEES — either a number (28469.23) or a
// comma-grouped string in Indian digit grouping ("5,16,195", "91,959.54").
// Returns integer paise. Parsing goes through a fixed-2-decimal string so binary
// float error can never round a paise off.
export function rupeesToPaise(value, context = {}) {
  if (isBlank(value)) {
    if (context.required) throw new AdapterError(`${context.field ?? 'amount'} is empty`, context);
    return 0;
  }

  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AdapterError(`${context.field ?? 'amount'} is not a finite number`, context);
    }
    text = value.toFixed(2);
  } else {
    // Strip thousands separators, currency symbols and stray spaces.
    text = String(value).replace(/[,\s ₹]/g, '');
    if (!/^-?\d*(\.\d*)?$/.test(text) || text === '' || text === '-' || text === '.') {
      throw new AdapterError(
        `${context.field ?? 'amount'} is not a number: ${JSON.stringify(value)}`,
        context
      );
    }
  }

  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);

  const [whole = '0', fraction = ''] = text.split('.');
  // Round at the third decimal rather than truncating.
  const paise =
    BigInt(whole === '' ? '0' : whole) * 100n +
    BigInt(fraction.slice(0, 2).padEnd(2, '0') || '0') +
    (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);

  const signed = negative ? -paise : paise;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AdapterError(`${context.field ?? 'amount'} exceeds safe integer paise`, context);
  }
  return Number(signed);
}

// ---------------------------------------------------------------------------
// Dates — three input formats, one internal representation
// ---------------------------------------------------------------------------

function isoOf(y, m, d, context) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) {
    throw new AdapterError(`${context.field ?? 'date'} is not a real date`, context);
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Excel stores dates as days since 1899-12-30 (the 1900 leap-year bug included).
function serialToISO(serial, context) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const dt = new Date(ms);
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), context);
}

function twoDigitYear(yy) {
  return yy < 70 ? 2000 + yy : 1900 + yy;
}

// 'dd-mm-yyyy' — the IMS and GSTR-2B wire format.
export function ddmmyyyyToISO(value, context = {}) {
  if (isBlank(value)) throw new AdapterError(`${context.field ?? 'date'} is empty`, context);
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(value).trim());
  if (!m) {
    throw new AdapterError(
      `${context.field ?? 'date'} is not dd-mm-yyyy: ${JSON.stringify(value)}`,
      context
    );
  }
  return isoOf(Number(m[3]), Number(m[2]), Number(m[1]), context);
}

// 'd-MMM-yy' — the purchase-register format ('2-Mar-26'). Also accepts a real
// Date cell or an Excel serial, which is what a hand-saved .xlsx often carries.
export function registerDateToISO(value, context = {}) {
  if (isBlank(value)) throw new AdapterError(`${context.field ?? 'date'} is empty`, context);

  if (value instanceof Date) {
    return isoOf(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), context);
  }
  if (typeof value === 'number') return serialToISO(value, context);

  const text = String(value).trim();

  const named = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2}|\d{4})$/.exec(text);
  if (named) {
    const name = named[2].toLowerCase();
    let month = MONTHS_SHORT.indexOf(name.slice(0, 3)) + 1;
    if (MONTHS_LONG.indexOf(name) >= 0) month = MONTHS_LONG.indexOf(name) + 1;
    if (month < 1) {
      throw new AdapterError(`${context.field ?? 'date'} has unknown month ${named[2]}`, context);
    }
    const year = named[3].length === 2 ? twoDigitYear(Number(named[3])) : Number(named[3]);
    return isoOf(year, month, Number(named[1]), context);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (numeric) return isoOf(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]), context);

  throw new AdapterError(
    `${context.field ?? 'date'} is not d-MMM-yy: ${JSON.stringify(value)}`,
    context
  );
}

export function isoToDDMMYYYY(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}-${m}-${y}`;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

// '032026' (2B rtnprd) -> '2026-03'
export function mmyyyyToPeriod(value, context = {}) {
  const m = /^(\d{2})(\d{4})$/.exec(String(value ?? '').trim());
  if (!m) {
    throw new AdapterError(`return period is not mmyyyy: ${JSON.stringify(value)}`, context);
  }
  const month = Number(m[1]);
  if (month < 1 || month > 12) {
    throw new AdapterError(`return period has month ${month}`, context);
  }
  return `${m[2]}-${m[1]}`;
}

export function periodToMM(period) {
  return String(period).split('-')[1];
}

export function isoToPeriod(iso) {
  return String(iso).slice(0, 7);
}

// IMS records carry the return period as MM only (rtnprd: '03') — the year is
// nowhere in the record. Derive it from the document date, allowing for a
// December document reported in the January period and vice versa.
export function periodFromMMAndDate(mm, docDateISO, context = {}) {
  const month = Number(String(mm ?? '').trim());
  if (!(month >= 1 && month <= 12)) {
    throw new AdapterError(`return period is not mm: ${JSON.stringify(mm)}`, context);
  }
  const [docYear, docMonth] = docDateISO.split('-').map(Number);
  let year = docYear;
  if (docMonth === 12 && month === 1) year = docYear + 1;
  else if (docMonth === 1 && month === 12) year = docYear - 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Financial year + month name from the register header: '2025-26' + 'March' -> '2026-03'.
export function financialYearMonthToPeriod(financialYear, monthName, context = {}) {
  const fy = /^(\d{4})\s*-\s*(\d{2}|\d{4})$/.exec(String(financialYear ?? '').trim());
  if (!fy) {
    throw new AdapterError(
      `financial year is not yyyy-yy: ${JSON.stringify(financialYear)}`,
      context
    );
  }
  const name = String(monthName ?? '').trim().toLowerCase();
  // Exact match only. A prefix match would silently read the quarter
  // 'April-June' as April.
  let month = MONTHS_LONG.indexOf(name) + 1;
  if (month < 1 && name.length === 3) month = MONTHS_SHORT.indexOf(name) + 1;
  if (month < 1) {
    // The template's dropdown also offers quarters ('April-June'), which name a
    // range rather than one period — refuse instead of guessing which month.
    throw new AdapterError(
      `tax period is not a single month: ${JSON.stringify(monthName)}`,
      context
    );
  }
  const startYear = Number(fy[1]);
  // Indian FY runs April..March: Apr-Dec sit in the first year, Jan-Mar the second.
  const year = month >= 4 ? startYear : startYear + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Small field conversions
// ---------------------------------------------------------------------------

// The register writes place of supply as code AND name ('29-Karnataka'); IMS
// wants the bare code ('29').
export function placeOfSupplyCode(value, context = {}) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  const m = /^(\d{1,2})\b/.exec(text);
  if (!m) {
    throw new AdapterError(
      `place of supply has no state code: ${JSON.stringify(value)}`,
      context
    );
  }
  return m[1].padStart(2, '0');
}

// Portal Y/N flags. Anything else is a bug we want to hear about, not coerce.
export function ynToBool(value, { field = 'flag', fallback = null, at } = {}) {
  if (isBlank(value)) return fallback;
  const text = String(value).trim().toUpperCase();
  if (text === 'Y') return true;
  if (text === 'N') return false;
  throw new AdapterError(`${field} is not Y/N: ${JSON.stringify(value)}`, { at, field });
}

export function boolToYN(value) {
  return value ? 'Y' : 'N';
}

export function trimOrNull(value) {
  return isBlank(value) ? null : String(value).trim();
}

export function sumRateLines(rateLines) {
  const totals = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const line of rateLines) {
    totals.taxableValue += line.taxableValue;
    totals.igst += line.igst;
    totals.cgst += line.cgst;
    totals.sgst += line.sgst;
    totals.cess += line.cess;
  }
  return totals;
}
