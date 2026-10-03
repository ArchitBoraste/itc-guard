// Before cut-off matches the books against IMS alone, and two kinds of books row
// must never be paired there.
//
//   * A document that never enters IMS (reverse charge, ITC-ineligible, ISD,
//     imports) has no true partner in IMS. Matched anyway, the engine hands it the
//     nearest unrelated record above 0.70; that record is FILED, so the screen
//     drops the document from both the list and "Left out". On the April sample
//     the audit (P16) found reverse-charge 1582J paired with the phantom 1587J
//     (0.7175), six days apart with 35% less tax.
//   * A record filed for ANOTHER period cannot settle this period's document, and
//     pairing with one hides it the same way: ineligible C/2654 took March's
//     C/2650 (0.701). Summary matches over the ±1 month window on purpose — a late
//     report can still pair there — but this screen is about this period's return.
//
// The rows below copy those shapes and score above 0.70 under the shipped weights,
// so the old matching reproduces both drops.
//
// Owns org 20.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import { reconcile } from '../../src/matching/index.js';
import { normalizeInvoiceNo } from '../../src/matching/normalize.js';
import { assignExpectedIdentities, assignPortalIdentities } from '../../src/services/identity.js';
import { preventiveAlerts } from '../../src/services/preventive.js';
import { TEST_ORGS, ensureOrg, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.preventivePairing;
const TRADER_GSTIN = '27AABCS1429F8Z0';
const PERIOD = '2026-04';
const PREVIOUS = '2026-03';
const AS_OF = '2026-05-16';

// Taxable within 2%, 35% less tax (a different rate), six days apart, a number
// one digit off: the profile of both audit pairs.
const decoyOf = (books, { invoiceNo, invoiceDate, taxPeriod }) => ({
  ...books,
  invoiceNo,
  invoiceDate,
  taxPeriod,
  taxableValue: 9811000,
  igst: 1177320,
  totalTax: 1177320
});

function books({ gstin, name, invoiceNo, invoiceDate }) {
  return {
    supplierGstin: gstin,
    supplierName: name,
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo,
    invoiceDate,
    taxPeriod: PERIOD,
    taxableValue: 10000000,
    igst: 1800000,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 1800000
  };
}

const RCM = books({
  gstin: '27AAAAA0021A1Z7', name: 'Reverse Charge Supplier', invoiceNo: '1582J', invoiceDate: '2026-04-12'
});
const INELIGIBLE = books({
  gstin: '27AAAAA0022A1Z6', name: 'Blocked Credit Supplier', invoiceNo: 'C/2654', invoiceDate: '2026-04-02'
});
const ORDINARY = books({
  gstin: '27AAAAA0023A1Z5', name: 'Ordinary Supplier', invoiceNo: 'OS/4410', invoiceDate: '2026-04-03'
});

function portalRow(row, { source, section = 'b2b', reverseCharge = 0, itcAvailable = 1 }) {
  const invoiceNoNorm = normalizeInvoiceNo(row.invoiceNo);
  return {
    ...row,
    invoiceNoNorm,
    invoiceValue: row.taxableValue + row.totalTax,
    source,
    section,
    reverseCharge,
    itcAvailable: source === 'GSTR2B' ? itcAvailable : null,
    supplierFiledOn: source === 'GSTR2B' ? '2026-05-08' : null,
    filingStatus: source === 'IMS' ? 'FILED' : null,
    imsAction: source === 'IMS' ? 'N' : null,
    contentHash: computeContentHash({
      supplierGstin: row.supplierGstin,
      invoiceNoNorm,
      invoiceDate: row.invoiceDate,
      taxableValue: row.taxableValue,
      totalTax: row.totalTax,
      docType: row.docType
    })
  };
}

const PORTAL = [
  // 1582J's own record is in 2B, on reverse charge; a phantom filed in IMS sits nearby.
  portalRow(RCM, { source: 'GSTR2B', reverseCharge: 1 }),
  portalRow(decoyOf(RCM, { invoiceNo: '1587J', invoiceDate: '2026-04-18', taxPeriod: PERIOD }), { source: 'IMS' }),
  // C/2654's own record is in 2B, ITC unavailable; March's IMS holds C/2650.
  portalRow(INELIGIBLE, { source: 'GSTR2B', itcAvailable: 0 }),
  portalRow(decoyOf(INELIGIBLE, { invoiceNo: 'C/2650', invoiceDate: '2026-03-27', taxPeriod: PREVIOUS }), { source: 'IMS' }),
  // An ordinary invoice reported nowhere yet; March's IMS holds a near-namesake.
  portalRow(decoyOf(ORDINARY, { invoiceNo: 'OS/4416', invoiceDate: '2026-03-28', taxPeriod: PREVIOUS }), { source: 'IMS' })
];

async function seed() {
  const expected = [RCM, INELIGIBLE, ORDINARY].map((row) => ({
    ...row,
    invoiceNoNorm: normalizeInvoiceNo(row.invoiceNo),
    invoiceValue: row.taxableValue + row.totalTax
  }));
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

  const portal = PORTAL.map((row) => ({ ...row }));
  assignPortalIdentities(portal);
  await pool.query(
    `INSERT INTO portal_records
       (org_id, source, section, supplier_gstin, supplier_name, doc_type, supply_type,
        invoice_no, invoice_no_norm, invoice_date, tax_period, taxable_value, igst,
        cgst, sgst, cess, total_tax, invoice_value, reverse_charge, itc_available,
        supplier_filed_on, filing_status, ims_action, content_hash, identity_seq,
        identity_key)
     VALUES ?`,
    [
      portal.map((row) => [
        ORG_ID, row.source, row.section, row.supplierGstin, row.supplierName,
        row.docType, row.supplyType, row.invoiceNo, row.invoiceNoNorm,
        row.invoiceDate, row.taxPeriod, row.taxableValue, row.igst, row.cgst,
        row.sgst, row.cess, row.totalTax, row.invoiceValue, row.reverseCharge,
        row.itcAvailable, row.supplierFiledOn, row.filingStatus, row.imsAction,
        row.contentHash, row.identitySeq, row.identityKey
      ])
    ]
  );
}

const listedNumbers = (alerts) =>
  alerts.suppliers.flatMap((supplier) => supplier.invoices.map((invoice) => invoice.invoiceNo));

describe('Before cut-off never pairs a document with a record that cannot be its own', () => {
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

  it('builds decoys the matcher would take, so the test means something', () => {
    const imsOnly = PORTAL.filter((row) => row.source === 'IMS');
    const pairs = reconcile([RCM, INELIGIBLE, ORDINARY].map((row, id) => ({
      ...row, id, invoiceNoNorm: normalizeInvoiceNo(row.invoiceNo)
    })), imsOnly, { taxPeriod: PERIOD });
    const paired = pairs.filter((result) => result.expected && result.portal);
    expect(paired.map((result) => result.expected.invoiceNo).sort()).toEqual(['1582J', 'C/2654', 'OS/4410']);
    for (const result of paired) expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it('leaves out the reverse-charge document instead of pairing it with the phantom', () => {
    expect(alerts.excluded.byReason.REVERSE_CHARGE.count).toBe(1);
    expect(listedNumbers(alerts)).not.toContain('1582J');
  });

  it('leaves out the ineligible document instead of pairing it with last month’s record', () => {
    expect(alerts.excluded.byReason.ITC_INELIGIBLE.count).toBe(1);
    expect(listedNumbers(alerts)).not.toContain('C/2654');
  });

  it('counts both in the "Left out" line, rupees included', () => {
    expect(alerts.excluded).toMatchObject({
      invoiceCount: 2,
      supplierCount: 2,
      itcAtStake: RCM.totalTax + INELIGIBLE.totalTax
    });
  });

  it('lists an ordinary document whose only near-namesake was filed for another period', () => {
    const invoice = alerts.suppliers
      .flatMap((supplier) => supplier.invoices)
      .find((entry) => entry.invoiceNo === ORDINARY.invoiceNo);
    expect(invoice).toBeTruthy();
    expect(invoice.status).toBe('NOT_REPORTED');
    expect(invoice.portalRecordId).toBeNull();
    expect(alerts.totals.invoiceCount).toBe(1);
  });
});
