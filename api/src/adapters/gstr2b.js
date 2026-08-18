// GSTR-2B adapter: { chksum, rtnprd, docdata: { b2b, b2ba, cdnr, cdnra, isd,
// isda, impg, impgsez, ecom, ecoma } } -> PortalRecord[] with source 'GSTR2B'.
//
// Ten sections. isd/isda and impg/impgsez are the two that never enter IMS.
// Shape is three levels: supplier -> document -> items[] rate lines. Rate lines
// are summed into document totals and kept on rateLines[].
import { normalizeInvoiceNo } from '../matching/normalize.js';
import { computeContentHash } from './contentHash.js';
import {
  AdapterError,
  ddmmyyyyToISO,
  isBlank,
  mmyyyyToPeriod,
  placeOfSupplyCode,
  rupeesToPaise,
  sumRateLines,
  stripBom,
  trimOrNull,
  ynToBool
} from './values.js';

export const TWOB_SECTIONS = ['b2b', 'b2ba', 'cdnr', 'cdnra', 'isd', 'isda',
  'impg', 'impgsez', 'ecom', 'ecoma'];

// Sections that never reach IMS — they exist only in 2B.
export const NON_IMS_SECTIONS = new Set(['isd', 'isda', 'impg', 'impgsez']);

const SUPPLY_TYPES = {
  R: 'B2B',
  DE: 'DE',
  SEWP: 'SEZWP',
  SEZWP: 'SEZWP',
  SEWOP: 'SEZWOP',
  SEZWOP: 'SEZWOP'
};

const NOTE_TYPES = { C: 'CREDIT_NOTE', D: 'DEBIT_NOTE' };
const ISD_DOC_TYPES = { ISDI: 'ISD_INVOICE', ISDC: 'ISD_CREDIT' };

function parseJson(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) return input;
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  try {
    return JSON.parse(stripBom(text));
  } catch (err) {
    throw new AdapterError(`GSTR-2B file is not valid JSON: ${err.message}`);
  }
}

function requireField(record, key, at) {
  if (isBlank(record[key])) throw new AdapterError(`${key} is missing`, { at, field: key });
  return record[key];
}

function enumValue(raw, table, { field, at }) {
  const key = String(raw ?? '').trim().toUpperCase();
  const value = table[key];
  if (!value) {
    throw new AdapterError(`${field} has unknown value ${JSON.stringify(raw)}`, { at, field });
  }
  return value;
}

// items[]: { hsn, rt, txval, igst, cgst, sgst, cess }
function readRateLines(doc, at) {
  if (isBlank(doc.items)) return [];
  if (!Array.isArray(doc.items)) throw new AdapterError('items is not an array', { at });
  return doc.items.map((item, index) => {
    const itemAt = `${at}.items[${index}]`;
    return {
      hsn: trimOrNull(item.hsn),
      rate: isBlank(item.rt) ? null : Number(item.rt),
      taxableValue: rupeesToPaise(item.txval, { at: itemAt, field: 'txval' }),
      igst: rupeesToPaise(item.igst, { at: itemAt, field: 'igst' }),
      cgst: rupeesToPaise(item.cgst, { at: itemAt, field: 'cgst' }),
      sgst: rupeesToPaise(item.sgst, { at: itemAt, field: 'sgst' }),
      cess: rupeesToPaise(item.cess, { at: itemAt, field: 'cess' })
    };
  });
}

// Totals come from items[] when present; GSTN's own tool falls back to the
// document-level amounts when items is absent.
function readTotals(doc, rateLines, at) {
  if (rateLines.length) return sumRateLines(rateLines);
  if (isBlank(doc.txval) && isBlank(doc.igst) && isBlank(doc.cgst) && isBlank(doc.sgst)) {
    throw new AdapterError('document has neither items[] nor document-level amounts', { at });
  }
  return {
    taxableValue: rupeesToPaise(doc.txval, { at, field: 'txval' }),
    igst: rupeesToPaise(doc.igst, { at, field: 'igst' }),
    cgst: rupeesToPaise(doc.cgst, { at, field: 'cgst' }),
    sgst: rupeesToPaise(doc.sgst, { at, field: 'sgst' }),
    cess: rupeesToPaise(doc.cess, { at, field: 'cess' })
  };
}

function baseRecord({
  section,
  supplierGstin,
  supplierName,
  docType,
  supplyType,
  invoiceNo,
  invoiceDate,
  taxPeriod,
  totals,
  rateLines,
  orgId
}) {
  const invoiceNoNorm = normalizeInvoiceNo(invoiceNo);
  const totalTax = totals.igst + totals.cgst + totals.sgst + totals.cess;
  const now = new Date();

  return {
    id: null,
    orgId: orgId ?? null,
    source: 'GSTR2B',
    section,
    supplierGstin,
    supplierName,
    docType,
    supplyType,
    invoiceNo,
    invoiceNoNorm,
    invoiceDate,
    taxPeriod,
    placeOfSupply: null,
    taxableValue: totals.taxableValue,
    igst: totals.igst,
    cgst: totals.cgst,
    sgst: totals.sgst,
    cess: totals.cess,
    totalTax,
    invoiceValue: null,
    reverseCharge: false,
    itcAvailable: null,
    itcIneligibleReason: null,
    supplierFiledOn: null,
    counterpartyFilingStatus: null,
    supplierReturnPeriod: null,
    differentialPercent: null,
    // 2B is a filed snapshot by construction: only filed records reach it.
    filingStatus: 'FILED',
    // IMS actions live on the IMS source, not here.
    imsAction: null,
    pendingBlocked: false,
    remarksBlocked: false,
    itcReductionBlocked: false,
    originalInvoiceNo: null,
    originalInvoiceDate: null,
    portCode: null,
    sourceForm: null,
    contentHash: computeContentHash({
      supplierGstin,
      invoiceNoNorm,
      invoiceDate,
      taxableValue: totals.taxableValue,
      totalTax,
      docType
    }),
    firstSeenAt: now,
    lastSeenAt: now,
    rateLines
  };
}

// ---------------------------------------------------------------------------
// Supplier-grouped document sections: b2b / b2ba / cdnr / cdnra / ecom / ecoma
// ---------------------------------------------------------------------------

function readSupplierGroup(group, sectionKey, groupIndex, ctx) {
  const at = `docdata.${sectionKey}[${groupIndex}]`;
  const isNoteSection = sectionKey === 'cdnr' || sectionKey === 'cdnra';
  const isAmendment = sectionKey.endsWith('a');

  // b2b/cdnr identify the supplier as ctin; the e-commerce sections identify the
  // operator, which GSTN labels etin. Accept either rather than guess one.
  const gstinRaw = group.ctin ?? group.etin;
  if (isBlank(gstinRaw)) {
    throw new AdapterError('supplier GSTIN (ctin/etin) is missing', { at, field: 'ctin' });
  }
  const supplierGstin = String(gstinRaw).trim().toUpperCase();
  const supplierName = trimOrNull(group.trdnm);
  const supplierFiledOn = isBlank(group.supfildt)
    ? null
    : ddmmyyyyToISO(group.supfildt, { at, field: 'supfildt' });
  const supplierReturnPeriod = isBlank(group.supprd)
    ? null
    : mmyyyyToPeriod(group.supprd, { at, field: 'supprd' });

  const documents = isNoteSection ? group.nt : group.inv;
  if (!Array.isArray(documents)) {
    throw new AdapterError(
      `${isNoteSection ? 'nt' : 'inv'} is missing or not an array`,
      { at, field: isNoteSection ? 'nt' : 'inv' }
    );
  }

  return documents.map((doc, docIndex) => {
    const docAt = `${at}.${isNoteSection ? 'nt' : 'inv'}[${docIndex}]`;

    // Notes number themselves ntnum/ntdt; the offline utility also writes
    // nt_num/nt_dt on the IMS side, so accept both spellings.
    const numberRaw = isNoteSection
      ? doc.ntnum ?? doc.nt_num
      : doc.inum;
    const dateRaw = isNoteSection ? doc.ntdt ?? doc.nt_dt : doc.dt;
    if (isBlank(numberRaw)) {
      throw new AdapterError(`${isNoteSection ? 'ntnum' : 'inum'} is missing`, { at: docAt });
    }
    if (isBlank(dateRaw)) {
      throw new AdapterError(`${isNoteSection ? 'ntdt' : 'dt'} is missing`, { at: docAt });
    }

    // For notes, typ is the note type (C/D). For invoices, typ is the supply type.
    const docType = isNoteSection
      ? enumValue(requireField(doc, 'typ', docAt), NOTE_TYPES, { field: 'typ', at: docAt })
      : 'INVOICE';
    const supplyType = isNoteSection
      ? null
      : enumValue(requireField(doc, 'typ', docAt), SUPPLY_TYPES, { field: 'typ', at: docAt });

    const rateLines = readRateLines(doc, docAt);
    const totals = readTotals(doc, rateLines, docAt);

    const record = baseRecord({
      section: sectionKey,
      supplierGstin,
      supplierName,
      docType,
      supplyType,
      invoiceNo: String(numberRaw).trim(),
      invoiceDate: ddmmyyyyToISO(dateRaw, { at: docAt, field: isNoteSection ? 'ntdt' : 'dt' }),
      taxPeriod: ctx.taxPeriod,
      totals,
      rateLines,
      orgId: ctx.orgId
    });

    record.supplierFiledOn = supplierFiledOn;
    record.supplierReturnPeriod = supplierReturnPeriod;
    record.counterpartyFilingStatus = trimOrNull(group.cfs) ?? trimOrNull(doc.cfs);
    record.placeOfSupply = placeOfSupplyCode(doc.pos, { at: docAt, field: 'pos' });
    record.invoiceValue = isBlank(doc.val)
      ? null
      : rupeesToPaise(doc.val, { at: docAt, field: 'val' });
    record.reverseCharge = ynToBool(doc.rev, { at: docAt, field: 'rev', fallback: false });
    record.itcAvailable = ynToBool(doc.itcavl, { at: docAt, field: 'itcavl', fallback: null });
    record.itcIneligibleReason = trimOrNull(doc.rsn);
    // diffprcnt absent means 100 per cent of the tax is available.
    record.differentialPercent = isBlank(doc.diffprcnt) ? 100 : Number(doc.diffprcnt);

    if (isAmendment) {
      // Amendment sections name the original document; unverified against a real
      // 2B download (b2ba/cdnra are empty in every fixture), so read only if present.
      record.originalInvoiceNo = trimOrNull(doc.oinum ?? doc.ont_num);
      const originalDate = doc.oidt ?? doc.ont_dt;
      record.originalInvoiceDate = isBlank(originalDate)
        ? null
        : ddmmyyyyToISO(originalDate, { at: docAt, field: 'oidt' });
    }

    return record;
  });
}

// ---------------------------------------------------------------------------
// isd / isda — doclist[] with itcelg, and no taxable value in the format
// ---------------------------------------------------------------------------

function readIsdGroup(group, sectionKey, groupIndex, ctx) {
  const at = `docdata.${sectionKey}[${groupIndex}]`;
  const supplierGstin = String(requireField(group, 'ctin', at)).trim().toUpperCase();
  const supplierName = trimOrNull(group.trdnm);
  const supplierReturnPeriod = isBlank(group.supprd)
    ? null
    : mmyyyyToPeriod(group.supprd, { at, field: 'supprd' });

  if (!Array.isArray(group.doclist)) {
    throw new AdapterError('doclist is missing or not an array', { at, field: 'doclist' });
  }

  return group.doclist.map((doc, docIndex) => {
    const docAt = `${at}.doclist[${docIndex}]`;
    const totals = {
      // An ISD document distributes credit — the section carries no taxable value.
      taxableValue: 0,
      igst: rupeesToPaise(doc.igst, { at: docAt, field: 'igst' }),
      cgst: rupeesToPaise(doc.cgst, { at: docAt, field: 'cgst' }),
      sgst: rupeesToPaise(doc.sgst, { at: docAt, field: 'sgst' }),
      cess: rupeesToPaise(doc.cess, { at: docAt, field: 'cess' })
    };

    const record = baseRecord({
      section: sectionKey,
      supplierGstin,
      supplierName,
      docType: enumValue(requireField(doc, 'doctyp', docAt), ISD_DOC_TYPES, {
        field: 'doctyp',
        at: docAt
      }),
      supplyType: null,
      invoiceNo: String(requireField(doc, 'docnum', docAt)).trim(),
      invoiceDate: ddmmyyyyToISO(requireField(doc, 'docdt', docAt), { at: docAt, field: 'docdt' }),
      taxPeriod: ctx.taxPeriod,
      totals,
      rateLines: [],
      orgId: ctx.orgId
    });

    record.supplierReturnPeriod = supplierReturnPeriod;
    // ISD eligibility is itcelg here, not itcavl.
    record.itcAvailable = ynToBool(doc.itcelg, { at: docAt, field: 'itcelg', fallback: null });
    return record;
  });
}

// ---------------------------------------------------------------------------
// impg / impgsez — no supplier GSTIN; keyed on portcode + boenum
// ---------------------------------------------------------------------------

function readImportRecord(doc, sectionKey, index, ctx) {
  const at = `docdata.${sectionKey}[${index}]`;
  const boeNumber = String(requireField(doc, 'boenum', at)).trim();
  const portCode = String(requireField(doc, 'portcode', at)).trim();

  const totals = {
    taxableValue: rupeesToPaise(requireField(doc, 'txval', at), { at, field: 'txval' }),
    igst: rupeesToPaise(doc.igst, { at, field: 'igst' }),
    // Imports are IGST + cess only — there are no central/state heads.
    cgst: 0,
    sgst: 0,
    cess: rupeesToPaise(doc.cess, { at, field: 'cess' })
  };

  const record = baseRecord({
    section: sectionKey,
    // Overseas imports have no supplier GSTIN at all. impgsez names the SEZ
    // supplier, but the key is unverified against a real download, so it is read
    // only if present rather than guessed.
    supplierGstin: trimOrNull(doc.sgstin)?.toUpperCase() ?? null,
    supplierName: null,
    docType: 'BOE',
    supplyType: null,
    invoiceNo: boeNumber,
    invoiceDate: ddmmyyyyToISO(requireField(doc, 'boedt', at), { at, field: 'boedt' }),
    taxPeriod: ctx.taxPeriod,
    totals,
    rateLines: [],
    orgId: ctx.orgId
  });

  record.portCode = portCode;
  return record;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// parse(json, options?) -> PortalRecord[]
//   options { orgId, taxPeriod }  taxPeriod overrides the envelope's rtnprd
export function parse(input, options = {}) {
  const payload = parseJson(input);
  const docdata = payload.docdata;
  if (!docdata || typeof docdata !== 'object') {
    throw new AdapterError('GSTR-2B JSON has no docdata envelope');
  }

  const unknown = Object.keys(docdata).filter((key) => !TWOB_SECTIONS.includes(key));
  if (unknown.length) {
    throw new AdapterError(`GSTR-2B JSON has unknown section(s): ${unknown.join(', ')}`);
  }

  const taxPeriod =
    options.taxPeriod ??
    (isBlank(payload.rtnprd)
      ? null
      : mmyyyyToPeriod(payload.rtnprd, { field: 'rtnprd' }));
  if (!taxPeriod) {
    throw new AdapterError('GSTR-2B JSON has no rtnprd and no taxPeriod was supplied');
  }

  const ctx = { taxPeriod, orgId: options.orgId ?? null };
  const records = [];

  for (const sectionKey of TWOB_SECTIONS) {
    const rows = docdata[sectionKey];
    if (isBlank(rows)) continue;
    if (!Array.isArray(rows)) throw new AdapterError(`docdata.${sectionKey} is not an array`);

    rows.forEach((row, index) => {
      if (sectionKey === 'isd' || sectionKey === 'isda') {
        records.push(...readIsdGroup(row, sectionKey, index, ctx));
      } else if (sectionKey === 'impg' || sectionKey === 'impgsez') {
        records.push(readImportRecord(row, sectionKey, index, ctx));
      } else {
        records.push(...readSupplierGroup(row, sectionKey, index, ctx));
      }
    });
  }

  return records;
}

// The blocking key differs for imports, which carry no GSTIN.
export function identityKey(record) {
  return record.portCode
    ? [record.source, record.section, record.portCode, record.invoiceNo, record.taxPeriod].join('|')
    : [record.source, record.section, record.supplierGstin, record.invoiceNoNorm, record.invoiceDate].join('|');
}
