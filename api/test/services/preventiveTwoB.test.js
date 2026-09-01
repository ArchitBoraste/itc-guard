// What Before cut-off is allowed to put in front of a trader.
//
// The screen means one thing: credit the books expect that has not safely reached
// IMS yet AND that somebody can still do something about. Reverse-charge,
// ITC-ineligible, ISD and import records reach GSTR-2B directly and never enter
// IMS (CLAUDE.md domain fact 5). Absence from IMS is their correct, permanent,
// finished state — there is no IMS row to accept, no supplier error to correct,
// and nobody to phone.
//
// They were listed anyway, because the two guards in alertItemFor() that were
// meant to catch them read the purchase register, and the GSTN v2.4 template has
// eleven columns and carries neither reverse charge nor ITC eligibility. On the
// April sample that put 32 of 36 documents and 21 of 24 suppliers on a screen
// headed "who to chase", offered a copy-ready chase message for each of them, and
// counted Rs 12.50 L of their money as "at stake".
//
// The fix is exclusion, not annotation: out of the bands, out of every supplier's
// invoice list, out of every rupee total. A supplier whose every document is one
// of these disappears from this screen. Summary still accounts for all of them
// under Outside IMS and Ineligible, and is untouched.
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
// Past every supplier's cut-off, which is when this screen was at its most wrong:
// each of these rows was being called an emergency.
const AS_OF = '2026-08-16';

// One supplier per shape, so a failure names the shape rather than a row number.
// `chaseable` is the whole assertion: only the last two belong on this screen.
const CASES = [
  {
    key: 'RCM',
    gstin: '27AAAAA0011A1Z9',
    name: 'Anand Systems',
    invoiceNo: 'L-KNP/2786/06-17',
    taxable: 52146800,
    tax: 7422591,
    twoB: { reverseCharge: 1, itcAvailable: 1, section: 'b2b' },
    chaseable: false,
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
    chaseable: false,
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
    chaseable: false,
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
    // this IMS download is older than the 2B one. This one IS actionable — by
    // re-downloading, not by phoning — so it stays.
    twoB: { reverseCharge: 0, itcAvailable: 1, section: 'b2b' },
    chaseable: true,
    reason: null
  },
  // Two books rows sharing a number, one portal record. The engine matches the
  // record to TWIN_MATCHED (identical amounts) and leaves TWIN_ORPHAN with
  // nothing. An index keyed on supplier + number hands the same record to both.
  {
    key: 'TWIN_MATCHED',
    gstin: '27AAAAA0016A1Z4',
    name: 'Patel Systems',
    invoiceNo: '1-02668',
    taxable: 2867600,
    tax: 802928,
    twoB: { reverseCharge: 0, itcAvailable: 1, section: 'b2b' },
    ims: true,
    chaseable: false,
    settled: true,
    reason: null
  },
  {
    key: 'TWIN_ORPHAN',
    gstin: '27AAAAA0016A1Z4',
    name: 'Patel Systems',
    invoiceNo: '1-02668',
    taxable: 3786900,
    tax: 681642,
    twoB: null,
    chaseable: true,
    reason: null
  },
  {
    key: 'NOWHERE',
    gstin: '27AAAAA0015A1Z5',
    name: 'Krishna Traders',
    invoiceNo: 'KT/26/7003',
    taxable: 1000000,
    tax: 180000,
    // In neither IMS nor 2B. The genuine article: somebody has to phone them.
    twoB: null,
    chaseable: true,
    reason: null
  }
];

const chaseable = CASES.filter((entry) => entry.chaseable);
// Not chaseable AND not settled: the ones that belong in the excluded tally.
// A settled document is off the screen because it is finished, not set aside.
const setAside = CASES.filter((entry) => !entry.chaseable && !entry.settled);

const byKey = (key) => CASES.find((entry) => entry.key === key);

function supplierIn(alerts, key) {
  return alerts.suppliers.find((entry) => entry.gstin === byKey(key).gstin) ?? null;
}

function invoiceFor(alerts, key) {
  return supplierIn(alerts, key)?.invoices?.[0] ?? null;
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

// reverse_charge is written as 0 on EVERY books row on purpose. That is not a
// lazy fixture — it is the real shape of the input. The GSTN v2.4 purchase
// register has no reverse-charge and no ITC-eligibility column, so the trader's
// own file cannot say which of these are RCM, and the 2B record is the only place
// the fact exists. A fixture that helpfully set the flag on the books side would
// pass while the production path stayed broken.
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
    // The matched twin is in IMS as well as 2B — that is what makes it settled
    // and what leaves the orphan with nothing on either side.
    if (entry.ims) {
      portal.push({
        ...twoBRow(entry, books),
        source: 'IMS',
        filingStatus: 'FILED',
        supplierFiledOn: null,
        imsAction: 'N'
      });
    }
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

describe('Before cut-off lists only what can actually be chased', () => {
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

  it.each(setAside.map((entry) => [entry.key, entry.gstin]))(
    'drops the %s supplier from the screen entirely',
    (key, gstin) => {
      expect(supplierIn(alerts, key)).toBeNull();
      // Not merely absent from the supplier list — absent from every band too,
      // which is what the screen actually renders.
      for (const band of alerts.bands) {
        expect(band.suppliers.map((entry) => entry.gstin)).not.toContain(gstin);
      }
    }
  );

  it.each(setAside.map((entry) => [entry.key, entry.invoiceNo]))(
    'leaves no trace of the %s invoice in any group',
    (key, invoiceNo) => {
      const rendered = JSON.stringify({ bands: alerts.bands, suppliers: alerts.suppliers });
      expect(rendered).not.toContain(invoiceNo);
    }
  );

  // The bug: twoBIndex() kept one record per supplier + normalised invoice
  // number, so the orphan was handed the twin's 2B record and the screen told the
  // trader their IMS download was stale and to re-download it. The download was
  // current, the record quoted belonged to a different document, and the advice
  // would not have helped. The lookup runs the real matcher now, so the engine's
  // one-to-one assignment decides who owns the record.
  it('does not hand a books row a 2B record already matched to its twin', () => {
    const orphan = invoiceFor(alerts, 'TWIN_ORPHAN');
    expect(orphan).not.toBeNull();
    expect(orphan.totalTax).toBe(byKey('TWIN_ORPHAN').tax);

    // No 2B claim at all is the correct answer here — better than a confident
    // wrong one, which is what the index produced.
    expect(orphan.inGstr2b).toBe(false);
    expect(orphan.gstr2bFiledOn).toBeNull();
    expect(orphan.note).not.toContain('GSTR-2B');
    expect(orphan.note).not.toContain('re-download');
  });

  it('leaves the settled twin off the screen entirely', () => {
    // It is in IMS and FILED: locked in, nothing to chase, and not "set aside"
    // either — it simply has no business on a screen about unfinished business.
    const rows = alerts.suppliers.flatMap((supplier) => supplier.invoices);
    const twin = byKey('TWIN_MATCHED');
    expect(rows.filter((row) => row.totalTax === twin.tax)).toHaveLength(0);
  });

  it('counts only the chaseable documents in the totals', () => {
    expect(alerts.totals.invoiceCount).toBe(chaseable.length);
    expect(alerts.totals.supplierCount).toBe(
      new Set(chaseable.map((entry) => entry.gstin)).size
    );
    expect(alerts.totals.itcAtStake).toBe(
      chaseable.reduce((sum, entry) => sum + entry.tax, 0)
    );
    // And not one rupee of the set-aside money leaked into a band.
    const banded = alerts.bands.reduce((sum, band) => sum + band.itcAtStake, 0);
    expect(banded).toBe(alerts.totals.itcAtStake);
  });

  it('reports what it set aside rather than dropping it silently', () => {
    expect(alerts.excluded.invoiceCount).toBe(setAside.length);
    expect(alerts.excluded.supplierCount).toBe(setAside.length);
    expect(alerts.excluded.itcAtStake).toBe(
      setAside.reduce((sum, entry) => sum + entry.tax, 0)
    );
    for (const entry of setAside) {
      expect(alerts.excluded.byReason[entry.reason].count).toBe(1);
    }
    // The tally is INFORMATIONAL. If it were ever folded into the headline the
    // screen would be back to claiming this money is at stake.
    expect(alerts.excluded.itcAtStake).not.toBe(alerts.totals.itcAtStake);
  });

  it('keeps a filed invoice that is only missing from a stale IMS download', () => {
    const invoice = invoiceFor(alerts, 'STALE_IMS_FILE');
    expect(invoice).not.toBeNull();
    expect(invoice.inGstr2b).toBe(true);
    expect(invoice.excludedReason).toBeNull();
    // Actionable, but the action is a re-download rather than a phone call.
    expect(invoice.note).toContain('Already in your GSTR-2B');
    expect(invoice.note).toContain('re-download IMS');
  });

  it('keeps a document that is genuinely nowhere, and still says so plainly', () => {
    const invoice = invoiceFor(alerts, 'NOWHERE');
    expect(invoice).not.toBeNull();
    expect(invoice.inGstr2b).toBe(false);
    expect(invoice.excludedReason).toBeNull();
    expect(invoice.note).toBe(STATUS_NOTE.NOT_REPORTED);
  });

  it('offers a chase message only to suppliers there is something to chase about', () => {
    for (const supplier of alerts.suppliers) {
      expect(supplier.chaseMessage).toBeTruthy();
      // Every invoice quoted in a chase message must be one the supplier can
      // actually act on. The reverse-charge rows used to end up in here.
      for (const entry of setAside) {
        expect(supplier.chaseMessage).not.toContain(entry.invoiceNo);
      }
    }
  });
});
