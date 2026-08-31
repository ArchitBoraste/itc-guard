// What "not in IMS" actually means on the Before cut-off screen.
//
// The screen matches the books against IMS ALONE — correctly, because IMS is the
// only source that exists before the cut-off and the only one that shows a record
// a supplier has merely SAVED. But every books row with no IMS record was then
// told "the supplier has not even saved it yet", and on the April sample that
// sentence was false on 32 of 34 rows: those documents had been FILED weeks
// earlier and were sitting in GSTR-2B. Most of them are reverse-charge or
// Sec 17(5) records, which per docs/gst-lifecycle-reference.md never enter IMS at
// all — absence from IMS is their correct and permanent state.
//
// So the fix is not to the matching, and deliberately not to the counts. Every
// row still appears and every total is unchanged; what changes is what the row is
// allowed to CLAIM about why it is there. This suite pins both halves of that:
// the annotation is right, and the arithmetic did not move.
//
// Owns org 13.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import { normalizeInvoiceNo } from '../../src/matching/normalize.js';
import {
  assignExpectedIdentities,
  assignPortalIdentities
} from '../../src/services/identity.js';
import { STATUS_NOTE, preventiveAlerts } from '../../src/services/preventive.js';
import { TEST_ORGS, ensureOrg, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.preventiveTwoB;
const TRADER_GSTIN = '27AABCS1429F7Z2';
const PERIOD = '2026-07';
// Past every supplier's cut-off, which is when this screen is at its most wrong:
// each of these rows is being called an emergency.
const AS_OF = '2026-08-16';

// One supplier per shape, so a failure names the shape rather than a row number.
const CASES = [
  {
    key: 'RCM',
    gstin: '27AAAAA0011A1Z9',
    name: 'Anand Systems',
    invoiceNo: 'L-KNP/2786/06-17',
    taxable: 52146800,
    tax: 7422591,
    twoB: { reverseCharge: 1, itcAvailable: 1, section: 'b2b' },
    reason: 'REVERSE_CHARGE'
  },
  {
    key: 'INELIGIBLE',
    gstin: '27AAAAA0012A1Z8',
    name: 'Om Hardware',
    invoiceNo: '3/2930',
    taxable: 21863500,
    tax: 3705759,
    // Sec 17(5) blocked credit: filed, in 2B, ITC unavailable, never in IMS.
    twoB: { reverseCharge: 0, itcAvailable: 0, section: 'b2b' },
    reason: 'ITC_INELIGIBLE'
  },
  {
    key: 'IMPORT',
    gstin: '27AAAAA0013A1Z7',
    name: 'Coastal Imports',
    invoiceNo: 'BOE/7788',
    taxable: 9000000,
    tax: 1620000,
    twoB: { reverseCharge: 0, itcAvailable: 1, section: 'impg' },
    reason: 'NON_IMS_SECTION'
  },
  {
    key: 'STALE_IMS_FILE',
    gstin: '27AAAAA0014A1Z6',
    name: 'Verma Cables',
    invoiceNo: 'VC/2026/9001',
    taxable: 4000000,
    tax: 720000,
    // An ordinary B2B invoice: filed, in 2B, and absent from IMS only because
    // this IMS download is older than the 2B one. Chasing is the wrong advice —
    // re-downloading is the right one.
    twoB: { reverseCharge: 0, itcAvailable: 1, section: 'b2b' },
    reason: null
  },
  {
    key: 'NOWHERE',
    gstin: '27AAAAA0015A1Z5',
    name: 'Krishna Traders',
    invoiceNo: 'KT/26/7003',
    taxable: 1000000,
    tax: 180000,
    // In neither IMS nor 2B. The one shape the original sentence was true of.
    twoB: null,
    reason: null
  }
];

const byKey = (key) => CASES.find((entry) => entry.key === key);

function invoiceFor(alerts, key) {
  const supplier = alerts.suppliers.find((entry) => entry.gstin === byKey(key).gstin);
  return supplier?.invoices?.[0] ?? null;
}

// --- fixture ---------------------------------------------------------------

function booksRow(entry) {
  return {
    supplierGstin: entry.gstin,
    supplierName: entry.name,
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo: entry.invoiceNo,
    invoiceNoNorm: normalizeInvoiceNo(entry.invoiceNo),
    invoiceDate: `${PERIOD}-12`,
    taxPeriod: PERIOD,
    taxableValue: entry.taxable,
    igst: entry.tax,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: entry.tax,
    invoiceValue: entry.taxable + entry.tax
  };
}

// The trader's purchase register carries no reverse-charge and no ITC-eligibility
// column — the GSTN v2.4 template has eleven columns and neither is among them.
// That is not an oversight in the fixture, it is the reason the guards inside
// alertItemFor() never fired on the real data: the only place those two facts
// exist is the 2B record.
function twoBRow(entry, books) {
  return {
    ...books,
    source: 'GSTR2B',
    section: entry.twoB.section,
    reverseCharge: entry.twoB.reverseCharge,
    itcAvailable: entry.twoB.itcAvailable,
    supplierFiledOn: '2026-08-07',
    counterpartyFilingStatus: 'Y',
    filingStatus: null,
    imsAction: null,
    contentHash: computeContentHash({
      supplierGstin: books.supplierGstin,
      invoiceNoNorm: books.invoiceNoNorm,
      invoiceDate: books.invoiceDate,
      taxableValue: books.taxableValue,
      totalTax: books.totalTax,
      docType: books.docType
    })
  };
}

async function seed() {
  const expected = [];
  const portal = [];
  for (const entry of CASES) {
    const books = booksRow(entry);
    expected.push(books);
    if (entry.twoB) portal.push(twoBRow(entry, books));
  }

  assignExpectedIdentities(expected);
  await pool.query(
    `INSERT INTO expected_invoices
       (org_id, supplier_gstin, supplier_name, doc_type, supply_type, invoice_no,
        invoice_no_norm, invoice_date, tax_period, taxable_value, igst, cgst, sgst,
        cess, total_tax, invoice_value, reverse_charge, identity_seq, identity_key)
     VALUES ?`,
    [
      expected.map((row) => [
        ORG_ID, row.supplierGstin, row.supplierName, row.docType, row.supplyType,
        row.invoiceNo, row.invoiceNoNorm, row.invoiceDate, row.taxPeriod,
        row.taxableValue, row.igst, row.cgst, row.sgst, row.cess, row.totalTax,
        row.invoiceValue, 0, row.identitySeq, row.identityKey
      ])
    ]
  );

  assignPortalIdentities(portal);
  await pool.query(
    `INSERT INTO portal_records
       (org_id, source, section, supplier_gstin, supplier_name, doc_type, supply_type,
        invoice_no, invoice_no_norm, invoice_date, tax_period, taxable_value, igst,
        cgst, sgst, cess, total_tax, invoice_value, reverse_charge, itc_available,
        supplier_filed_on, counterparty_filing_status, filing_status, ims_action,
        content_hash, identity_seq, identity_key)
     VALUES ?`,
    [
      portal.map((row) => [
        ORG_ID, row.source, row.section, row.supplierGstin, row.supplierName,
        row.docType, row.supplyType, row.invoiceNo, row.invoiceNoNorm,
        row.invoiceDate, row.taxPeriod, row.taxableValue, row.igst, row.cgst,
        row.sgst, row.cess, row.totalTax, row.invoiceValue, row.reverseCharge,
        row.itcAvailable, row.supplierFiledOn, row.counterpartyFilingStatus,
        row.filingStatus, row.imsAction, row.contentHash, row.identitySeq,
        row.identityKey
      ])
    ]
  );
}

// --- suite -----------------------------------------------------------------

describe('what "not in IMS" is allowed to claim', () => {
  let alerts;

  beforeAll(async () => {
    await requireDatabase();
    await resetOrg(ORG_ID);
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await seed();
    alerts = await preventiveAlerts(ORG_ID, { taxPeriod: PERIOD, asOfDate: AS_OF });
  }, 60000);

  afterAll(async () => {
    await resetOrg(ORG_ID);
    await closePool();
  });

  it('still lists every unreported document — the counts do not move', () => {
    // The whole point of doing this as an annotation rather than a filter. A
    // reverse-charge purchase IS still credit the trader has to account for; it
    // is only the sentence about chasing the supplier that was wrong.
    expect(alerts.totals.invoiceCount).toBe(CASES.length);
    expect(alerts.totals.supplierCount).toBe(CASES.length);
    expect(alerts.totals.itcAtStake).toBe(
      CASES.reduce((sum, entry) => sum + entry.tax, 0)
    );
  });

  it('counts how many of them GSTR-2B already carries', () => {
    expect(alerts.totals.inGstr2bCount).toBe(4);
    expect(alerts.totals.neverEntersImsCount).toBe(3);
  });

  it.each([
    ['RCM', 'REVERSE_CHARGE'],
    ['INELIGIBLE', 'ITC_INELIGIBLE'],
    ['IMPORT', 'NON_IMS_SECTION']
  ])('says a %s record can never enter IMS at all', (key, reason) => {
    const invoice = invoiceFor(alerts, key);
    expect(invoice.status).toBe('NOT_REPORTED');
    expect(invoice.inGstr2b).toBe(true);
    expect(invoice.neverEntersImsReason).toBe(reason);
    expect(invoice.gstr2bFiledOn).toBe('2026-08-07');
    // The claim that was false: the supplier filed this three weeks ago.
    expect(invoice.note).not.toContain('has not even saved it yet');
    expect(invoice.note).toContain('Already in your GSTR-2B');
    // "never enters IMS" for a single record, "never enter IMS" for the ISD and
    // import sections, which the note speaks about as a class.
    expect(invoice.note).toContain('never enter');
  });

  it('blames the IMS download, not the supplier, for an ordinary filed invoice', () => {
    const invoice = invoiceFor(alerts, 'STALE_IMS_FILE');
    expect(invoice.inGstr2b).toBe(true);
    // Filed and IMS-eligible: it should be in IMS, so this one really is worth
    // acting on — but by re-downloading, not by phoning anybody.
    expect(invoice.neverEntersImsReason).toBeNull();
    expect(invoice.note).toContain('Already in your GSTR-2B');
    expect(invoice.note).toContain('re-download IMS');
    expect(invoice.note).not.toContain('has not even saved it yet');
  });

  it('keeps the original sentence for a document that is genuinely nowhere', () => {
    const invoice = invoiceFor(alerts, 'NOWHERE');
    expect(invoice.inGstr2b).toBe(false);
    expect(invoice.gstr2bFiledOn).toBeNull();
    expect(invoice.neverEntersImsReason).toBeNull();
    expect(invoice.note).toBe(STATUS_NOTE.NOT_REPORTED);
  });
});
