// Builds the IMS upload envelope from PortalRecords plus the trader's chosen
// actions:
//
//   { rtin, reqtyp: 'SAVE', invdata: { b2b, b2ba, b2bdn, b2bdna, b2bcn, b2bcna,
//                                      ecom, ecoma } }
//
// Wire rules the portal enforces, all of them load-bearing:
//   * inum / nt_num are STRINGS — a 16-digit numeric invoice number must not be
//     emitted as a JSON number.
//   * dates are dd-mm-yyyy, never ISO.
//   * pos is the bare 2-digit state code, action is a single letter.
//   * remarks appear ONLY on R or P, max 250 chars.
//   * blocked flags are absolute: one violation and the portal rejects the whole
//     upload, not just the offending record.
import { AdapterError, boolToYN, isBlank, isoToDDMMYYYY, periodToMM } from './values.js';

export const UPLOAD_SECTIONS = ['b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna',
  'ecom', 'ecoma'];

export const REMARKS_MAX_LENGTH = 250;

const ACTIONS = new Set(['A', 'R', 'P', 'N']);
const REMARKABLE_ACTIONS = new Set(['R', 'P']);

// Canonical section + docType -> IMS upload section. Debit and credit notes both
// arrive as 'cdnr'; docType is what separates them on the way back out.
const NOTE_SECTIONS = {
  cdnr: { DEBIT_NOTE: 'b2bdn', CREDIT_NOTE: 'b2bcn' },
  cdnra: { DEBIT_NOTE: 'b2bdna', CREDIT_NOTE: 'b2bcna' }
};

const IMS_INV_TYPES = { B2B: 'R', DE: 'DE', SEZWP: 'SEWP', SEZWOP: 'SEWOP' };

function paiseToRupees(paise) {
  return Number((Math.round(paise) / 100).toFixed(2));
}

function uploadSectionFor(record, at) {
  if (record.section === 'b2b' || record.section === 'b2ba') return record.section;
  if (record.section === 'ecom' || record.section === 'ecoma') return record.section;

  const notes = NOTE_SECTIONS[record.section];
  if (notes) {
    const section = notes[record.docType];
    if (section) return section;
    throw new AdapterError(
      `section ${record.section} with docType ${record.docType} has no IMS section`,
      { at }
    );
  }

  // isd/isda and impg/impgsez never enter IMS — there is nothing to act on.
  throw new AdapterError(
    `section ${record.section} is not actionable in IMS (2B-only section)`,
    { at }
  );
}

function normalizeDecisions({ decisions, records, actionFor }) {
  if (decisions) return decisions;
  if (!records) throw new AdapterError('either decisions or records must be supplied');
  if (typeof actionFor !== 'function') {
    throw new AdapterError('records requires an actionFor(record) callback');
  }
  return records.map((record) => {
    const chosen = actionFor(record);
    return typeof chosen === 'string' ? { record, action: chosen } : { record, ...chosen };
  });
}

function recordLabel(record, index) {
  return `decision[${index}] ${record?.invoiceNo ?? '(no invoice no)'}`;
}

// buildImsActionJson({ rtin, decisions })                     -> { json, warnings }
// buildImsActionJson({ rtin, records, actionFor })            -> { json, warnings }
//
// decisions: [{ record, action, remarks?, itcReduction? }]
//   itcReduction: { required: bool, igst, cgst, sgst, cess }  paise, Accept only
export function buildImsActionJson(input) {
  const { rtin } = input;
  if (isBlank(rtin)) throw new AdapterError('rtin (the trader GSTIN) is required');

  const decisions = normalizeDecisions(input);
  const warnings = [];
  const invdata = {};
  for (const section of UPLOAD_SECTIONS) invdata[section] = [];

  decisions.forEach((decision, index) => {
    const { record } = decision;
    if (!record) throw new AdapterError(`decision[${index}] has no record`);
    const at = recordLabel(record, index);

    // Only IMS-sourced records carry the srcform/rtnprd and blocked flags the
    // upload needs; a 2B record has no IMS identity to act on.
    if (record.source !== 'IMS') {
      throw new AdapterError(
        `record came from ${record.source}, but the IMS upload needs IMS-sourced records`,
        { at }
      );
    }

    const action = String(decision.action ?? '').trim().toUpperCase();
    if (!ACTIONS.has(action)) {
      throw new AdapterError(
        `action must be one of A/R/P/N, got ${JSON.stringify(decision.action)}`,
        { at }
      );
    }

    // Pending on a pending-blocked record would have the portal reject the whole
    // upload. Refuse loudly rather than quietly rewriting the trader's decision.
    if (action === 'P' && record.pendingBlocked) {
      throw new AdapterError('action P is blocked on this record (ispendactblocked=Y)', { at });
    }

    const section = uploadSectionFor(record, at);
    const isNote = section.startsWith('b2bdn') || section.startsWith('b2bcn');
    const isAmendment = section.endsWith('a');

    if (isBlank(record.placeOfSupply)) {
      throw new AdapterError('placeOfSupply is required for the IMS upload (pos)', { at });
    }
    if (isBlank(record.sourceForm)) {
      throw new AdapterError('sourceForm is required for the IMS upload (srcform)', { at });
    }

    const wire = {
      stin: record.supplierGstin,
      // Always a string: a numeric invoice number must not be coerced.
      [isNote ? 'nt_num' : 'inum']: String(record.invoiceNo),
      inv_typ: imsInvType(record, at),
      [isNote ? 'nt_dt' : 'idt']: isoToDDMMYYYY(record.invoiceDate),
      val: paiseToRupees(record.invoiceValue ?? record.taxableValue + record.totalTax),
      action,
      pos: record.placeOfSupply,
      txval: paiseToRupees(record.taxableValue),
      iamt: paiseToRupees(record.igst),
      camt: paiseToRupees(record.cgst),
      samt: paiseToRupees(record.sgst),
      cess: paiseToRupees(record.cess),
      srcform: record.sourceForm,
      rtnprd: periodToMM(record.taxPeriod)
    };

    if (isAmendment && !isBlank(record.originalInvoiceNo)) {
      wire[isNote ? 'ont_num' : 'oinum'] = String(record.originalInvoiceNo);
      if (!isBlank(record.originalInvoiceDate)) {
        wire[isNote ? 'ont_dt' : 'oidt'] = isoToDDMMYYYY(record.originalInvoiceDate);
      }
    }

    const remarks = applyRemarks(decision, record, action, at, warnings);
    if (remarks !== null) wire.remarks = remarks;

    applyItcReduction(decision, record, action, at, wire);

    invdata[section].push(wire);
  });

  return {
    json: { rtin, reqtyp: 'SAVE', invdata },
    warnings
  };
}

function imsInvType(record, at) {
  // Notes carry no supply type on the 2B side; IMS still wants inv_typ, and a
  // note against a regular supply is 'R'.
  const supplyType = record.supplyType ?? 'B2B';
  const invType = IMS_INV_TYPES[supplyType];
  if (!invType) {
    throw new AdapterError(`supplyType ${JSON.stringify(record.supplyType)} has no inv_typ`, { at });
  }
  return invType;
}

// Returns the remarks to emit, or null to omit the key entirely.
function applyRemarks(decision, record, action, at, warnings) {
  if (isBlank(decision.remarks)) return null;

  if (!REMARKABLE_ACTIONS.has(action)) {
    warnings.push({ at, code: 'REMARKS_DROPPED_ACTION', message: `remarks dropped: not valid on action ${action}` });
    return null;
  }
  if (record.remarksBlocked) {
    warnings.push({ at, code: 'REMARKS_DROPPED_BLOCKED', message: 'remarks dropped: isRemarksBlocked=Y' });
    return null;
  }

  const text = String(decision.remarks).trim();
  if (text.length > REMARKS_MAX_LENGTH) {
    warnings.push({
      at,
      code: 'REMARKS_TRUNCATED',
      message: `remarks truncated from ${text.length} to ${REMARKS_MAX_LENGTH} chars`
    });
    return text.slice(0, REMARKS_MAX_LENGTH);
  }
  return text;
}

function applyItcReduction(decision, record, action, at, wire) {
  if (!decision.itcReduction) return;

  if (record.itcReductionBlocked) {
    throw new AdapterError('ITC reduction is blocked on this record (itcRedReqBlocked=Y)', { at });
  }
  // Per the offline utility: the ITC-reduction block applies to Accepted records.
  if (action !== 'A') {
    throw new AdapterError(`ITC reduction is only valid on action A, got ${action}`, { at });
  }

  const { required = true, igst = 0, cgst = 0, sgst = 0, cess = 0 } = decision.itcReduction;
  wire.itc_red_req = boolToYN(required);
  wire.decl_igst = paiseToRupees(igst);
  wire.decl_cgst = paiseToRupees(cgst);
  wire.decl_sgst = paiseToRupees(sgst);
  wire.decl_cess = paiseToRupees(cess);
}

// Convenience for writing the file: stable key order, 2-space indent.
export function serializeImsActionJson(json) {
  return JSON.stringify(json, null, 2);
}
