// IMS download adapter: { imsDetails: { b2b, b2ba, b2bdn, b2bdna, b2bcn,
// b2bcna, ecom, ecoma } } -> PortalRecord[] with source 'IMS'.
//
// Eight sections. Notes carry nt_num/nt_dt instead of inum/idt; amendments carry
// the original document as oinum/oidt (invoices) or ont_num/ont_dt (notes).
import { normalizeInvoiceNo } from '../matching/normalize.js';
import { computeContentHash } from './contentHash.js';
import {
  AdapterError,
  ddmmyyyyToISO,
  isBlank,
  periodFromMMAndDate,
  placeOfSupplyCode,
  rupeesToPaise,
  stripBom,
  trimOrNull,
  ynToBool
} from './values.js';

export const IMS_SECTIONS = ['b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna', 'ecom', 'ecoma'];

// IMS section -> the canonical 10-value section vocabulary (which is GSTR-2B's).
// Debit and credit notes share 2B's cdnr; docType keeps them apart, which is what
// lets imsActionWriter map a record back to its exact IMS section.
const SECTION_SHAPE = {
  b2b: { section: 'b2b', docType: 'INVOICE', numberKey: 'inum', dateKey: 'idt' },
  b2ba: {
    section: 'b2ba',
    docType: 'INVOICE',
    numberKey: 'inum',
    dateKey: 'idt',
    originalNumberKey: 'oinum',
    originalDateKey: 'oidt'
  },
  b2bdn: { section: 'cdnr', docType: 'DEBIT_NOTE', numberKey: 'nt_num', dateKey: 'nt_dt' },
  b2bdna: {
    section: 'cdnra',
    docType: 'DEBIT_NOTE',
    numberKey: 'nt_num',
    dateKey: 'nt_dt',
    originalNumberKey: 'ont_num',
    originalDateKey: 'ont_dt'
  },
  b2bcn: { section: 'cdnr', docType: 'CREDIT_NOTE', numberKey: 'nt_num', dateKey: 'nt_dt' },
  b2bcna: {
    section: 'cdnra',
    docType: 'CREDIT_NOTE',
    numberKey: 'nt_num',
    dateKey: 'nt_dt',
    originalNumberKey: 'ont_num',
    originalDateKey: 'ont_dt'
  },
  ecom: { section: 'ecom', docType: 'INVOICE', numberKey: 'inum', dateKey: 'idt' },
  ecoma: {
    section: 'ecoma',
    docType: 'INVOICE',
    numberKey: 'inum',
    dateKey: 'idt',
    originalNumberKey: 'oinum',
    originalDateKey: 'oidt'
  }
};

// inv_typ. The 2B tool normalises SEWP/SEWOP to SEZWP/SEZWOP — accept both.
const SUPPLY_TYPES = {
  R: 'B2B',
  DE: 'DE',
  SEWP: 'SEZWP',
  SEZWP: 'SEZWP',
  SEWOP: 'SEZWOP',
  SEZWOP: 'SEZWOP'
};

const FILING_STATUSES = { SAVED: 'SAVED', FILED: 'FILED' };
const ACTIONS = new Set(['A', 'R', 'P', 'N']);

function parseJson(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) return input;
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  try {
    return JSON.parse(stripBom(text));
  } catch (err) {
    throw new AdapterError(`IMS file is not valid JSON: ${err.message}`);
  }
}

function requireField(record, key, at) {
  if (isBlank(record[key])) throw new AdapterError(`${key} is missing`, { at, field: key });
  return record[key];
}

function toPortalRecord(record, sectionKey, index, options) {
  const shape = SECTION_SHAPE[sectionKey];
  const at = `imsDetails.${sectionKey}[${index}]`;

  const invoiceNo = String(requireField(record, shape.numberKey, at)).trim();
  const invoiceDate = ddmmyyyyToISO(requireField(record, shape.dateKey, at), {
    at,
    field: shape.dateKey
  });

  const supplyTypeRaw = String(requireField(record, 'inv_typ', at)).trim().toUpperCase();
  const supplyType = SUPPLY_TYPES[supplyTypeRaw];
  if (!supplyType) {
    throw new AdapterError(`inv_typ has unknown value ${JSON.stringify(record.inv_typ)}`, {
      at,
      field: 'inv_typ'
    });
  }

  const filingStatusRaw = String(requireField(record, 'srcfilstatus', at)).trim().toUpperCase();
  const filingStatus = FILING_STATUSES[filingStatusRaw];
  if (!filingStatus) {
    throw new AdapterError(
      `srcfilstatus has unknown value ${JSON.stringify(record.srcfilstatus)}`,
      { at, field: 'srcfilstatus' }
    );
  }

  const imsAction = String(requireField(record, 'action', at)).trim().toUpperCase();
  if (!ACTIONS.has(imsAction)) {
    throw new AdapterError(`action has unknown value ${JSON.stringify(record.action)}`, {
      at,
      field: 'action'
    });
  }

  const igst = rupeesToPaise(record.iamt, { at, field: 'iamt' });
  const cgst = rupeesToPaise(record.camt, { at, field: 'camt' });
  const sgst = rupeesToPaise(record.samt, { at, field: 'samt' });
  const cess = rupeesToPaise(record.cess, { at, field: 'cess' });
  const taxableValue = rupeesToPaise(requireField(record, 'txval', at), {
    at,
    field: 'txval',
    required: true
  });
  const totalTax = igst + cgst + sgst + cess;

  const supplierGstin = String(requireField(record, 'stin', at)).trim().toUpperCase();
  const invoiceNoNorm = normalizeInvoiceNo(invoiceNo);
  const now = new Date();

  return {
    id: null,
    orgId: options.orgId ?? null,
    source: 'IMS',
    section: shape.section,
    supplierGstin,
    supplierName: trimOrNull(record.tradenm),
    docType: shape.docType,
    supplyType,
    invoiceNo,
    invoiceNoNorm,
    invoiceDate,
    taxPeriod:
      options.taxPeriod ??
      periodFromMMAndDate(requireField(record, 'rtnprd', at), invoiceDate, {
        at,
        field: 'rtnprd'
      }),
    placeOfSupply: placeOfSupplyCode(record.pos, { at, field: 'pos' }),
    taxableValue,
    igst,
    cgst,
    sgst,
    cess,
    totalTax,
    invoiceValue: isBlank(record.val) ? null : rupeesToPaise(record.val, { at, field: 'val' }),
    // RCM records never enter IMS at all (they appear only in 2B), so an IMS
    // record is by definition not reverse-charge. There is no rev field here.
    reverseCharge: false,
    // itcavl / rsn / supfildt are GSTR-2B fields — IMS carries none of them.
    itcAvailable: null,
    itcIneligibleReason: null,
    supplierFiledOn: null,
    counterpartyFilingStatus: null,
    supplierReturnPeriod: null,
    differentialPercent: null,
    filingStatus,
    imsAction,
    pendingBlocked: ynToBool(record.ispendactblocked, {
      at,
      field: 'ispendactblocked',
      fallback: false
    }),
    remarksBlocked: ynToBool(record.isRemarksBlocked, {
      at,
      field: 'isRemarksBlocked',
      fallback: false
    }),
    itcReductionBlocked: ynToBool(record.itcRedReqBlocked, {
      at,
      field: 'itcRedReqBlocked',
      fallback: false
    }),
    originalInvoiceNo: shape.originalNumberKey
      ? trimOrNull(record[shape.originalNumberKey])
      : null,
    originalInvoiceDate:
      shape.originalDateKey && !isBlank(record[shape.originalDateKey])
        ? ddmmyyyyToISO(record[shape.originalDateKey], { at, field: shape.originalDateKey })
        : null,
    portCode: null,
    sourceForm: trimOrNull(record.srcform) ?? trimOrNull(record.rtnTyp),
    contentHash: computeContentHash({
      supplierGstin,
      invoiceNoNorm,
      invoiceDate,
      taxableValue,
      totalTax,
      docType: shape.docType
    }),
    firstSeenAt: now,
    lastSeenAt: now,
    // IMS records carry no items[] — there is no rate detail on this source.
    rateLines: [],
    errorMessage: trimOrNull(record.error_msg)
  };
}

export const FORMAT_IMS_JSON = 'IMS_JSON';
export const FORMAT_UNKNOWN = 'UNKNOWN';

// Sniffs the download envelope. Lives here because imsDetails / imsDetailsErr are
// portal field names, and those appear only inside adapters/.
export function detectFormat(input) {
  try {
    const payload = parseJson(input);
    return payload.imsDetails || payload.imsDetailsErr ? FORMAT_IMS_JSON : FORMAT_UNKNOWN;
  } catch {
    return FORMAT_UNKNOWN;
  }
}

// parse(json, options?) -> PortalRecord[]
//   options { orgId, taxPeriod }  taxPeriod overrides the MM-only rtnprd derivation
export function parse(input, options = {}) {
  const payload = parseJson(input);
  // Post-upload error responses come back under imsDetailsErr with the same shape.
  const details = payload.imsDetails ?? payload.imsDetailsErr;
  if (!details || typeof details !== 'object') {
    throw new AdapterError('IMS JSON has no imsDetails envelope');
  }

  const unknown = Object.keys(details).filter((key) => !IMS_SECTIONS.includes(key));
  if (unknown.length) {
    throw new AdapterError(`IMS JSON has unknown section(s): ${unknown.join(', ')}`);
  }

  const records = [];
  for (const sectionKey of IMS_SECTIONS) {
    const rows = details[sectionKey];
    if (isBlank(rows)) continue;
    if (!Array.isArray(rows)) {
      throw new AdapterError(`imsDetails.${sectionKey} is not an array`);
    }
    rows.forEach((record, index) => {
      records.push(toPortalRecord(record, sectionKey, index, options));
    });
  }
  return records;
}
