// Purchase-register adapter. Two accepted layouts:
//
//   PR_TEMPLATE_V24  the GSTR-2B matching tool's PurchaseRegister template v2.4
//                    .xlsx, sheet 'Purchase Register'. ONE ROW PER DOCUMENT.
//   GSTR2_CSV        the Returns Offline Tool GSTR-2 section CSV.
//                    ONE ROW PER INVOICE x TAX RATE — rows must be grouped.
//
// Output: ExpectedInvoice[] with money in integer paise and ISO dates.
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { normalizeInvoiceNo } from '../matching/normalize.js';
import {
  AdapterError,
  financialYearMonthToPeriod,
  isBlank,
  isoToPeriod,
  placeOfSupplyCode,
  registerDateToISO,
  rupeesToPaise,
  sumRateLines,
  stripBom,
  trimOrNull,
  ynToBool
} from './values.js';

export const FORMAT_TEMPLATE_V24 = 'PR_TEMPLATE_V24';
export const FORMAT_GSTR2_CSV = 'GSTR2_CSV';
export const FORMAT_UNKNOWN = 'UNKNOWN';

const SHEET_NAME = 'Purchase Register';
const HEADER_ROW = 5; // 1-based; data starts at row 6
const METADATA_ROWS = 2;

// Header text carries trailing spaces, asterisks and a rupee glyph. Match on a
// normalised form — never on exact equality.
function normalizeHeader(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[₹*().]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Canonical field <- every header spelling the two documented templates use.
const HEADER_ALIASES = new Map(
  Object.entries({
    supplierGstin: ['gstin of supplier/eco', 'gstin of supplier', 'gstin of supplier/eco '],
    supplierName: ['trade/legal name', 'trade / legal name', 'legal name'],
    supplyType: ['type of inward supplies', 'invoice type'],
    docType: ['document type'],
    invoiceNo: [
      'document number',
      'invoice number',
      'note/refund voucher number'
    ],
    invoiceDate: [
      'document date',
      'invoice date',
      'note/refund voucher date'
    ],
    invoiceValue: ['invoice value', 'document value'],
    placeOfSupply: ['place of supply'],
    reverseCharge: ['reverse charge'],
    rate: ['rate'],
    taxableValue: ['taxable value'],
    igst: ['integrated tax', 'integrated tax paid'],
    cgst: ['central tax', 'central tax paid'],
    sgst: ['state/ut tax', 'state/ut tax paid'],
    cess: ['cess', 'cess paid'],
    itcEligibility: ['eligibility for itc'],
    originalInvoiceNo: ['invoice/advance payment voucher number'],
    originalInvoiceDate: ['invoice/advance payment voucher date']
  }).flatMap(([field, headers]) => headers.map((h) => [normalizeHeader(h), field]))
);

const REQUIRED_FIELDS = ['supplierGstin', 'invoiceNo', 'invoiceDate', 'taxableValue'];

// Every canonical field a columnMap may point at, in the order a mapping UI
// should offer them. Derived from the alias table so the two cannot drift.
export const MAPPABLE_FIELDS = Object.freeze([...new Set(HEADER_ALIASES.values())]);

export { REQUIRED_FIELDS };

// 'Type of inward supplies' (v2.4) and 'Invoice Type' (GSTR-2 CSV) are different
// vocabularies for the same canonical supplyType.
const SUPPLY_TYPES = new Map(
  Object.entries({
    b2b: 'B2B',
    regular: 'B2B',
    de: 'DE',
    'deemed exp': 'DE',
    'deemed export': 'DE',
    'deemed exports': 'DE',
    sezwp: 'SEZWP',
    sewp: 'SEZWP',
    'sez supplies with payment': 'SEZWP',
    sezwop: 'SEZWOP',
    sewop: 'SEZWOP',
    'sez supplies without payment': 'SEZWOP'
  })
);

const DOC_TYPES = new Map(
  Object.entries({
    invoice: 'INVOICE',
    inv: 'INVOICE',
    i: 'INVOICE',
    'debit note': 'DEBIT_NOTE',
    d: 'DEBIT_NOTE',
    'credit note': 'CREDIT_NOTE',
    c: 'CREDIT_NOTE'
  })
);

function looksLikeZip(buffer) {
  return buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b; // 'PK'
}

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  throw new AdapterError('expected a Buffer, Uint8Array or string');
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function detectFormat(input) {
  const buffer = asBuffer(input);

  if (looksLikeZip(buffer)) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: HEADER_ROW + 1 });
      const sheet = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
      if (!sheet) return FORMAT_UNKNOWN;
      const rows = sheetRows(sheet, HEADER_ROW + 1);
      const mapped = mapHeaderRow(rows[HEADER_ROW - 1] ?? []);
      return REQUIRED_FIELDS.every((f) => f in mapped) ? FORMAT_TEMPLATE_V24 : FORMAT_UNKNOWN;
    } catch {
      return FORMAT_UNKNOWN;
    }
  }

  const text = stripBom(buffer.toString('utf8'));
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes(',')) return FORMAT_UNKNOWN;
  const mapped = mapHeaderRow(Papa.parse(firstLine).data[0] ?? []);
  return REQUIRED_FIELDS.every((f) => f in mapped) ? FORMAT_GSTR2_CSV : FORMAT_UNKNOWN;
}

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

// Reads the sheet as a dense array-of-arrays so row numbers stay absolute —
// blank rows 3 and 4 must not shift the header off row 5.
function sheetRows(sheet, limit = Infinity) {
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: true,
    defval: null
  });
  return limit === Infinity ? rows : rows.slice(0, limit);
}

// columnMap (optional) maps a canonical field -> the header text or 0-based
// column index in this particular file, for traders not using a GSTN template.
function mapHeaderRow(headerCells, columnMap = null) {
  const mapped = {};

  headerCells.forEach((cell, index) => {
    const field = HEADER_ALIASES.get(normalizeHeader(cell));
    if (field && !(field in mapped)) mapped[field] = index;
  });

  if (columnMap) {
    for (const [field, target] of Object.entries(columnMap)) {
      if (typeof target === 'number') {
        mapped[field] = target;
        continue;
      }
      const wanted = normalizeHeader(target);
      const index = headerCells.findIndex((cell) => normalizeHeader(cell) === wanted);
      if (index < 0) {
        throw new AdapterError(
          `columnMap points ${field} at a header that is not in the file: ${JSON.stringify(target)}`
        );
      }
      mapped[field] = index;
    }
  }

  return mapped;
}

function requireFields(mapped, at) {
  const missing = REQUIRED_FIELDS.filter((f) => !(f in mapped));
  if (missing.length) {
    throw new AdapterError(
      `purchase register is missing required column(s): ${missing.join(', ')}`,
      { at }
    );
  }
}

// ---------------------------------------------------------------------------
// Row -> canonical parts
// ---------------------------------------------------------------------------

function cell(row, mapped, field) {
  const index = mapped[field];
  return index === undefined ? null : row[index] ?? null;
}

function enumValue(raw, table, { field, at, fallback }) {
  if (isBlank(raw)) {
    if (fallback !== undefined) return fallback;
    throw new AdapterError(`${field} is empty`, { at, field });
  }
  const key = String(raw).trim().toLowerCase();
  const value = table.get(key);
  if (!value) {
    throw new AdapterError(`${field} has unknown value ${JSON.stringify(raw)}`, { at, field });
  }
  return value;
}

function readRow(row, mapped, at) {
  const gstin = trimOrNull(cell(row, mapped, 'supplierGstin'));
  if (!gstin) throw new AdapterError('supplier GSTIN is empty', { at });

  const invoiceNo = trimOrNull(cell(row, mapped, 'invoiceNo'));
  if (!invoiceNo) throw new AdapterError('document number is empty', { at });

  const rateRaw = cell(row, mapped, 'rate');

  return {
    supplierGstin: gstin.toUpperCase(),
    supplierName: trimOrNull(cell(row, mapped, 'supplierName')),
    supplyType: enumValue(cell(row, mapped, 'supplyType'), SUPPLY_TYPES, {
      field: 'type of inward supplies',
      at,
      fallback: 'B2B'
    }),
    docType: enumValue(cell(row, mapped, 'docType'), DOC_TYPES, {
      field: 'document type',
      at,
      fallback: 'INVOICE'
    }),
    invoiceNo,
    invoiceNoNorm: normalizeInvoiceNo(invoiceNo),
    invoiceDate: registerDateToISO(cell(row, mapped, 'invoiceDate'), {
      at,
      field: 'document date'
    }),
    placeOfSupply: placeOfSupplyCode(cell(row, mapped, 'placeOfSupply'), { at }),
    reverseCharge:
      ynToBool(cell(row, mapped, 'reverseCharge'), { field: 'reverse charge', at, fallback: false }),
    itcEligibility: trimOrNull(cell(row, mapped, 'itcEligibility')),
    originalInvoiceNo: trimOrNull(cell(row, mapped, 'originalInvoiceNo')),
    originalInvoiceDate: isBlank(cell(row, mapped, 'originalInvoiceDate'))
      ? null
      : registerDateToISO(cell(row, mapped, 'originalInvoiceDate'), {
        at,
        field: 'original document date'
      }),
    invoiceValue: isBlank(cell(row, mapped, 'invoiceValue'))
      ? null
      : rupeesToPaise(cell(row, mapped, 'invoiceValue'), { at, field: 'invoice value' }),
    rate: isBlank(rateRaw) ? null : Number(String(rateRaw).replace(/[%\s]/g, '')),
    taxableValue: rupeesToPaise(cell(row, mapped, 'taxableValue'), {
      at,
      field: 'taxable value',
      required: true
    }),
    igst: rupeesToPaise(cell(row, mapped, 'igst'), { at, field: 'integrated tax' }),
    cgst: rupeesToPaise(cell(row, mapped, 'cgst'), { at, field: 'central tax' }),
    sgst: rupeesToPaise(cell(row, mapped, 'sgst'), { at, field: 'state/ut tax' }),
    cess: rupeesToPaise(cell(row, mapped, 'cess'), { at, field: 'cess' }),
    sourceRowNo: null
  };
}

function toExpectedInvoice(parts, { taxPeriod, orgId, rateLines }) {
  return {
    id: null,
    orgId: orgId ?? null,
    supplierGstin: parts.supplierGstin,
    supplierName: parts.supplierName,
    docType: parts.docType,
    supplyType: parts.supplyType,
    invoiceNo: parts.invoiceNo,
    invoiceNoNorm: parts.invoiceNoNorm,
    invoiceDate: parts.invoiceDate,
    taxPeriod: taxPeriod ?? isoToPeriod(parts.invoiceDate),
    placeOfSupply: parts.placeOfSupply,
    taxableValue: parts.taxableValue,
    igst: parts.igst,
    cgst: parts.cgst,
    sgst: parts.sgst,
    cess: parts.cess,
    totalTax: parts.igst + parts.cgst + parts.sgst + parts.cess,
    invoiceValue: parts.invoiceValue,
    reverseCharge: parts.reverseCharge,
    itcEligibility: parts.itcEligibility,
    originalInvoiceNo: parts.originalInvoiceNo,
    originalInvoiceDate: parts.originalInvoiceDate,
    sourceRowNo: parts.sourceRowNo,
    rateLines
  };
}

// ---------------------------------------------------------------------------
// PR_TEMPLATE_V24 — one row per document, so no grouping pass
// ---------------------------------------------------------------------------

function parseTemplateV24(buffer, columnMap, options) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new AdapterError(`workbook has no '${SHEET_NAME}' sheet`);

  const rows = sheetRows(sheet);
  const mapped = mapHeaderRow(rows[HEADER_ROW - 1] ?? [], columnMap);
  requireFields(mapped, `row ${HEADER_ROW}`);

  // Row 1: recipient GSTIN + financial year. Row 2: trade name + tax period.
  const metadata = readMetadata(rows.slice(0, METADATA_ROWS));
  const taxPeriod =
    options.taxPeriod ??
    (metadata.financialYear && metadata.taxPeriodName
      ? financialYearMonthToPeriod(metadata.financialYear, metadata.taxPeriodName, {
        at: `row ${METADATA_ROWS}`
      })
      : null);

  const invoices = [];
  for (let i = HEADER_ROW; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (row.every((value) => isBlank(value))) continue;
    const at = `row ${i + 1}`;
    const parts = readRow(row, mapped, at);
    parts.sourceRowNo = i + 1;
    // The v2.4 template has no Rate column: there is no rate detail to keep.
    invoices.push(toExpectedInvoice(parts, { ...options, taxPeriod, rateLines: [] }));
  }

  return { invoices, metadata, taxPeriod };
}

const METADATA_LABELS = new Map(
  Object.entries({
    'gstin of recipient': 'recipientGstin',
    'trade/legal name': 'recipientName',
    'financial year': 'financialYear',
    'tax period': 'taxPeriodName'
  })
);

// Labels sit in one cell with their value in the next non-empty cell to the right.
function readMetadata(metadataRows) {
  const metadata = {
    recipientGstin: null,
    recipientName: null,
    financialYear: null,
    taxPeriodName: null
  };
  for (const row of metadataRows) {
    (row ?? []).forEach((cellValue, index) => {
      if (isBlank(cellValue)) return;
      const label = normalizeHeader(String(cellValue).replace(/:/g, ' '));
      const field = METADATA_LABELS.get(label);
      if (!field) return;
      for (let j = index + 1; j < row.length; j += 1) {
        if (!isBlank(row[j])) {
          metadata[field] = String(row[j]).trim();
          return;
        }
      }
    });
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// GSTR2_CSV — one row per invoice x rate, grouped on (gstin, docNo, docDate)
// ---------------------------------------------------------------------------

function parseGstr2Csv(buffer, columnMap, options) {
  const text = stripBom(buffer.toString('utf8'));
  const { data, errors } = Papa.parse(text, { skipEmptyLines: 'greedy' });
  if (errors.length) {
    const first = errors[0];
    throw new AdapterError(`csv is malformed: ${first.message}`, { at: `row ${first.row + 1}` });
  }
  if (!data.length) throw new AdapterError('csv is empty');

  const mapped = mapHeaderRow(data[0], columnMap);
  requireFields(mapped, 'row 1');

  // Rate rows for one document must collapse into a single ExpectedInvoice.
  const groups = new Map();
  for (let i = 1; i < data.length; i += 1) {
    const row = data[i];
    if (row.every((value) => isBlank(value))) continue;
    const at = `row ${i + 1}`;
    const parts = readRow(row, mapped, at);
    parts.sourceRowNo = i + 1;

    const key = [parts.supplierGstin, parts.invoiceNoNorm, parts.invoiceDate].join('|');
    const group = groups.get(key);
    if (group) {
      group.rateLines.push(rateLineOf(parts));
      continue;
    }
    groups.set(key, { head: parts, rateLines: [rateLineOf(parts)] });
  }

  const invoices = [...groups.values()].map(({ head, rateLines }) => {
    const totals = sumRateLines(rateLines);
    return toExpectedInvoice(
      { ...head, ...totals },
      { ...options, taxPeriod: options.taxPeriod, rateLines }
    );
  });

  return { invoices, metadata: null, taxPeriod: options.taxPeriod ?? null };
}

function rateLineOf(parts) {
  return {
    // The GSTR-2 CSV has no HSN column — the format simply does not carry it.
    hsn: null,
    rate: parts.rate,
    taxableValue: parts.taxableValue,
    igst: parts.igst,
    cgst: parts.cgst,
    sgst: parts.sgst,
    cess: parts.cess
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Which parser to run.
//
// A columnMap is the trader naming their own columns, so detection failing is the
// expected case rather than a fatal one — refusing the file anyway would make the
// whole columnMap parameter unreachable. The fallback is limited to CSV on
// purpose: a CSV header is row 1 by definition, whereas an arbitrary .xlsx puts
// its header at an unknown row and guessing wrong would silently read a data row
// as the titles. Without a columnMap, an unrecognised file is still refused.
function resolveFormat(buffer, columnMap, options) {
  if (options.format) return options.format;
  const detected = detectFormat(buffer);
  if (detected !== FORMAT_UNKNOWN) return detected;
  if (columnMap && !looksLikeZip(buffer)) return FORMAT_GSTR2_CSV;
  return FORMAT_UNKNOWN;
}

function refuse(buffer) {
  return new AdapterError(
    looksLikeZip(buffer)
      ? 'unrecognised purchase-register format — this .xlsx is not the v2.4 template, and ' +
        'a spreadsheet’s header row cannot be located reliably. Export it as CSV and map the ' +
        'columns, or use the GSTN template.'
      : 'unrecognised purchase-register format — expected the v2.4 .xlsx template or a GSTR-2 CSV'
  );
}

// parse(buffer, columnMap?, options?) -> ExpectedInvoice[]
//   columnMap  { canonicalField: headerText | columnIndex } for non-template files
//   options    { taxPeriod, orgId, format }
export function parse(input, columnMap = null, options = {}) {
  const buffer = asBuffer(input);
  const format = resolveFormat(buffer, columnMap, options);

  if (format === FORMAT_TEMPLATE_V24) return parseTemplateV24(buffer, columnMap, options).invoices;
  if (format === FORMAT_GSTR2_CSV) return parseGstr2Csv(buffer, columnMap, options).invoices;

  throw refuse(buffer);
}

// Same parse, plus the file-level metadata the header rows carry.
export function parseWithMetadata(input, columnMap = null, options = {}) {
  const buffer = asBuffer(input);
  const format = resolveFormat(buffer, columnMap, options);

  if (format === FORMAT_TEMPLATE_V24) {
    return { format, ...parseTemplateV24(buffer, columnMap, options) };
  }
  if (format === FORMAT_GSTR2_CSV) {
    return { format, ...parseGstr2Csv(buffer, columnMap, options) };
  }
  throw refuse(buffer);
}

// describeColumns(buffer) -> { format, layout, mappable, headerRow, headers[],
//                              mapped, mappableFields, requiredFields, missingFields }
//
// Reads ONLY the header row, and never throws on an unrecognised file — which is
// exactly the case it exists for. When detectFormat returns UNKNOWN the caller
// needs the trader's own column titles in order to ask which is which, and
// parse() cannot supply them because it refuses to run at all.
export function describeColumns(input) {
  const buffer = asBuffer(input);
  const isXlsx = looksLikeZip(buffer);
  const headerCells = isXlsx ? xlsxHeaderCells(buffer) : csvHeaderCells(buffer);
  const mapped = mapHeaderRow(headerCells);

  const format = detectFormat(buffer);

  return {
    format,
    layout: isXlsx ? 'XLSX' : 'CSV',
    // Whether a columnMap can rescue this file. See resolveFormat: a spreadsheet
    // that is not the template has no locatable header row.
    mappable: format !== FORMAT_UNKNOWN || !isXlsx,
    // 1-based, to match what the trader sees in their spreadsheet.
    headerRow: isXlsx ? HEADER_ROW : 1,
    headers: headerCells.map((cell, index) => ({
      index,
      text: isBlank(cell) ? '' : String(cell).trim()
    })),
    mapped,
    mappableFields: MAPPABLE_FIELDS,
    requiredFields: REQUIRED_FIELDS,
    missingFields: REQUIRED_FIELDS.filter((field) => !(field in mapped))
  };
}

function xlsxHeaderCells(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: HEADER_ROW + 1 });
    const sheet = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    return sheetRows(sheet, HEADER_ROW + 1)[HEADER_ROW - 1] ?? [];
  } catch {
    return [];
  }
}

function csvHeaderCells(buffer) {
  const text = stripBom(buffer.toString('utf8'));
  const firstLine = text.split('\n')[0].replace(/\r$/, '');
  return Papa.parse(firstLine).data[0] ?? [];
}
