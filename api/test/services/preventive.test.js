// The pre-cut-off workflow, walked through one month.
//
// The claim the product is sold on is that it acts BEFORE the deadline, while a
// supplier's mistake is still free to fix. Two things have to be true for that to
// be worth anything, and both are asserted here:
//
//   * the alert set is RANKED BY SUPPLIER RISK, not by amount. On the 5th an
//     unreported invoice from a reliable supplier is normal — GSTR-1 is not due
//     until the 11th. The fixture deliberately gives the RELIABLE supplier the
//     LARGEST rupee figure in the period, so an amount-ranked list would put them
//     at the top and a risk-ranked one must not.
//
//   * the cut-off is PER SUPPLIER. On the 12th a monthly filer is past theirs and
//     a QRMP filer still has a day. One global date would either write off credit
//     that is still recoverable or promise recovery that is already gone.
//
// The fixture is built directly against the tables rather than through the
// adapters because it needs specific FILING BEHAVIOUR over six months — reliable,
// habitually late, absent, QRMP — which no single fixture file contains. Everything
// derived from that behaviour still goes through the real code: supplier schemes
// are inferred by inferSupplierSchemes(), days-late by rebuildSupplierPeriods(),
// and the alert set by preventiveAlerts().
//
// Owns org 9.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import { normalizeInvoiceNo } from '../../src/matching/normalize.js';
import {
  assignExpectedIdentities,
  assignPortalIdentities
} from '../../src/services/identity.js';
import { rebuildSupplierPeriods } from '../../src/services/supplierStats.js';
import {
  ALERT_STATUS,
  BAND_ORDER,
  RISK_BAND_THRESHOLDS,
  RISK_BANDS,
  URGENCY,
  alertBandFor,
  preventiveAlerts,
  scoreSupplierRisk
} from '../../src/services/preventive.js';
import { TEST_ORGS, ensureOrg, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.preventive;
const TRADER_GSTIN = '27AABCS1429F9Z0';

const TARGET = '2026-07';
// Monthly filers are due on 11 Aug 2026, QRMP on the 13th, 2B generates on the
// 14th and GSTR-3B falls due on the 20th.
const HISTORY = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

const ON_TIME_DAY = 8; // by the 11th
const LATE_DAY = 15; // past the 11th
const QRMP_DAY = 12; // past the 11th, by the 13th — the QRMP signature

// Behaviour over the six months before the target period.
//
//   filedOnDayByPeriod  null = they reported nothing at all that month
//
// The target-period invoice is the one the alert is about. `imsState` says what,
// if anything, has reached IMS by the time we look.
const SUPPLIERS = [
  {
    key: 'RELIABLE',
    gstin: '27AAAAA0001A1Z5',
    name: 'Dell Agencies',
    filedOnDayByPeriod: () => ON_TIME_DAY,
    // Biggest amount in the period, on purpose. An amount-ranked list puts this
    // first; a risk-ranked one must leave it in LOW.
    target: { invoiceNo: 'DEL/2026/7001', taxable: 20000000, tax: 3600000 },
    imsState: null
  },
  {
    key: 'LATE',
    gstin: '27AAAAA0002A1Z4',
    name: 'Verma Cables',
    // Late in 4 of the last 6 months.
    filedOnDayByPeriod: (index) => (index < 4 ? LATE_DAY : ON_TIME_DAY),
    target: { invoiceNo: 'VC-2026-7002', taxable: 5000000, tax: 900000 },
    imsState: null
  },
  {
    key: 'GHOST',
    gstin: '27AAAAA0003A1Z3',
    name: 'Krishna Traders',
    // Reported once, six months ago, and nothing since — while the trader kept
    // buying from them every month.
    filedOnDayByPeriod: (index) => (index === 0 ? ON_TIME_DAY : null),
    target: { invoiceNo: 'KT/26/7003', taxable: 1000000, tax: 180000 },
    imsState: null
  },
  {
    key: 'QRMP',
    gstin: '27AAAAA0004A1Z2',
    name: 'Patel Hardware',
    // Every filing lands after the 11th but by the 13th — inferFilingScheme reads
    // that as QRMP, which moves their cut-off to the 13th.
    filedOnDayByPeriod: () => QRMP_DAY,
    target: { invoiceNo: 'PH/2026/7004', taxable: 8000000, tax: 1440000 },
    imsState: null
  },
  {
    key: 'SAVER',
    gstin: '27AAAAA0005A1Z1',
    name: 'Gupta Steel',
    filedOnDayByPeriod: () => ON_TIME_DAY,
    target: { invoiceNo: 'GS/2026/7005', taxable: 3000000, tax: 540000 },
    // Saved in IMS, not filed. Reported, but not yet safe.
    imsState: 'SAVED'
  },
  {
    key: 'FILER',
    gstin: '27AAAAA0006A1Z0',
    name: 'Mehta Traders',
    filedOnDayByPeriod: () => ON_TIME_DAY,
    target: { invoiceNo: 'MT/2026/7006', taxable: 4000000, tax: 720000 },
    // Reported and filed. Nothing to chase.
    imsState: 'FILED'
  }
];

const byKey = (key) => SUPPLIERS.find((entry) => entry.key === key);
const supplierIn = (alerts, key) =>
  alerts.suppliers.find((entry) => entry.gstin === byKey(key).gstin) ?? null;
const bandOf = (alerts, key) => supplierIn(alerts, key)?.risk.band ?? null;

// --- fixture ---------------------------------------------------------------

function money(taxable, tax) {
  return {
    taxableValue: taxable,
    igst: tax,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: tax,
    invoiceValue: taxable + tax
  };
}

function expectedRow({ supplier, taxPeriod, invoiceNo, taxable, tax, day }) {
  return {
    supplierGstin: supplier.gstin,
    supplierName: supplier.name,
    docType: 'INVOICE',
    supplyType: 'B2B',
    invoiceNo,
    invoiceNoNorm: normalizeInvoiceNo(invoiceNo),
    invoiceDate: `${taxPeriod}-${String(day).padStart(2, '0')}`,
    taxPeriod,
    ...money(taxable, tax)
  };
}

function portalRow({ source, expected, filedOn, filingStatus }) {
  return {
    source,
    section: 'b2b',
    ...expected,
    itcAvailable: 1,
    supplierFiledOn: filedOn,
    counterpartyFilingStatus: filedOn ? 'Y' : 'N',
    filingStatus,
    imsAction: source === 'IMS' ? 'N' : null,
    contentHash: computeContentHash({
      supplierGstin: expected.supplierGstin,
      invoiceNoNorm: expected.invoiceNoNorm,
      invoiceDate: expected.invoiceDate,
      taxableValue: expected.taxableValue,
      totalTax: expected.totalTax,
      docType: expected.docType
    })
  };
}

async function insertExpected(rows) {
  assignExpectedIdentities(rows);
  await pool.query(
    `INSERT INTO expected_invoices
       (org_id, supplier_gstin, supplier_name, doc_type, supply_type, invoice_no,
        invoice_no_norm, invoice_date, tax_period, taxable_value, igst, cgst, sgst,
        cess, total_tax, invoice_value, reverse_charge, identity_seq, identity_key)
     VALUES ?`,
    [
      rows.map((row) => [
        ORG_ID, row.supplierGstin, row.supplierName, row.docType, row.supplyType,
        row.invoiceNo, row.invoiceNoNorm, row.invoiceDate, row.taxPeriod,
        row.taxableValue, row.igst, row.cgst, row.sgst, row.cess, row.totalTax,
        row.invoiceValue, 0, row.identitySeq, row.identityKey
      ])
    ]
  );
}

async function insertPortal(rows) {
  assignPortalIdentities(rows);
  await pool.query(
    `INSERT INTO portal_records
       (org_id, source, section, supplier_gstin, supplier_name, doc_type, supply_type,
        invoice_no, invoice_no_norm, invoice_date, tax_period, taxable_value, igst,
        cgst, sgst, cess, total_tax, invoice_value, reverse_charge, itc_available,
        supplier_filed_on, counterparty_filing_status, filing_status, ims_action,
        content_hash, identity_seq, identity_key)
     VALUES ?`,
    [
      rows.map((row) => [
        ORG_ID, row.source, row.section, row.supplierGstin, row.supplierName,
        row.docType, row.supplyType, row.invoiceNo, row.invoiceNoNorm,
        row.invoiceDate, row.taxPeriod, row.taxableValue, row.igst, row.cgst,
        row.sgst, row.cess, row.totalTax, row.invoiceValue, 0, row.itcAvailable,
        row.supplierFiledOn, row.counterpartyFilingStatus, row.filingStatus,
        row.imsAction, row.contentHash, row.identitySeq, row.identityKey
      ])
    ]
  );
}

// History goes in as GSTR-2B only and the target period as IMS only, which is
// also what a trader actually holds mid-month: 2B for closed periods, IMS for the
// one still open. It keeps the two apart in the ±1 month blocking window as well,
// so a last-month record can never be mistaken for this month's invoice.
async function seed() {
  const expected = [];
  const portal = [];

  HISTORY.forEach((taxPeriod, index) => {
    for (const supplier of SUPPLIERS) {
      const filedDay = supplier.filedOnDayByPeriod(index);
      const row = expectedRow({
        supplier,
        taxPeriod,
        invoiceNo: `${supplier.key}/H${index}/${taxPeriod.replace('-', '')}`,
        taxable: 1100000 + index * 10000,
        tax: 198000 + index * 1800,
        day: 20
      });
      expected.push(row);
      if (filedDay === null) continue; // reported nothing at all that month

      const nextMonth = addMonth(taxPeriod);
      portal.push(
        portalRow({
          source: 'GSTR2B',
          expected: { ...row },
          filedOn: `${nextMonth}-${String(filedDay).padStart(2, '0')}`,
          filingStatus: null
        })
      );
    }
  });

  for (const supplier of SUPPLIERS) {
    const row = expectedRow({
      supplier,
      taxPeriod: TARGET,
      invoiceNo: supplier.target.invoiceNo,
      taxable: supplier.target.taxable,
      tax: supplier.target.tax,
      day: 18
    });
    expected.push(row);
    if (!supplier.imsState) continue;

    portal.push(
      portalRow({
        source: 'IMS',
        expected: { ...row },
        // A SAVED record has no filing date yet — that is exactly what makes it
        // unsafe.
        filedOn: supplier.imsState === 'FILED' ? `2026-08-${ON_TIME_DAY}` : null,
        filingStatus: supplier.imsState
      })
    );
  }

  await insertExpected(expected);
  await insertPortal(portal);

  // Every portal row is in place before the first rebuild, so scheme inference
  // sees the whole cadence at once. Rebuilding period by period as the data
  // arrived would measure the earliest months against a scheme inferred from one
  // observation and leave stale days-late behind.
  for (const taxPeriod of HISTORY) await rebuildSupplierPeriods(ORG_ID, taxPeriod);
}

function addMonth(taxPeriod) {
  const [year, month] = taxPeriod.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

// --- suite -----------------------------------------------------------------

describe('preventive alerts through the filing month', () => {
  // The four days the demo walks through: comfortably early, the eve of the
  // monthly cut-off, the day between the two cut-offs, and after 2B.
  let onThe5th;
  let onThe10th;
  let onThe12th;
  let onThe16th;

  beforeAll(async () => {
    await requireDatabase();
    await resetOrg(ORG_ID);
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await seed();

    onThe5th = await preventiveAlerts(ORG_ID, { taxPeriod: TARGET, asOfDate: '2026-08-05' });
    onThe10th = await preventiveAlerts(ORG_ID, { taxPeriod: TARGET, asOfDate: '2026-08-10' });
    onThe12th = await preventiveAlerts(ORG_ID, { taxPeriod: TARGET, asOfDate: '2026-08-12' });
    onThe16th = await preventiveAlerts(ORG_ID, { taxPeriod: TARGET, asOfDate: '2026-08-16' });
  });

  afterAll(async () => {
    await closePool();
  });

  it('infers the QRMP supplier onto the 13th and everyone else onto the 11th', () => {
    expect(supplierIn(onThe5th, 'QRMP').filingScheme).toBe('QRMP');
    expect(supplierIn(onThe5th, 'QRMP').cutOffDate).toBe('2026-08-13');
    expect(supplierIn(onThe5th, 'RELIABLE').filingScheme).toBe('MONTHLY');
    expect(supplierIn(onThe5th, 'RELIABLE').cutOffDate).toBe('2026-08-11');
  });

  // --- the 5th: most of this resolves itself --------------------------------

  describe('on the 5th', () => {
    it('does not call a reliable supplier high risk, however large the invoice', () => {
      const reliable = supplierIn(onThe5th, 'RELIABLE');
      expect(reliable.risk.band).toBe(RISK_BANDS.LOW);
      // And it is the biggest amount in the period — ranking by rupees would have
      // put it first.
      const largest = [...onThe5th.suppliers].sort(
        (a, b) => Math.abs(b.itcAtStake) - Math.abs(a.itcAtStake)
      )[0];
      expect(largest.gstin).toBe(reliable.gstin);
      expect(onThe5th.suppliers[0].risk.band).toBe(RISK_BANDS.HIGH);
    });

    it('does call the ghost and the habitually late supplier high risk', () => {
      expect(bandOf(onThe5th, 'GHOST')).toBe(RISK_BANDS.HIGH);
      expect(bandOf(onThe5th, 'LATE')).toBe(RISK_BANDS.HIGH);
    });

    it('says why in words a trader can check, not as a score', () => {
      const late = supplierIn(onThe5th, 'LATE');
      expect(late.risk.reasons.join(' ')).toContain('filed late in 4 of the last 6 months');

      const ghost = supplierIn(onThe5th, 'GHOST');
      expect(ghost.risk.reasons.join(' ')).toContain('reported nothing at all in 5 of the last 6');

      const reliable = supplierIn(onThe5th, 'RELIABLE');
      expect(reliable.risk.reasons.join(' ')).toContain(
        'filed on time in all of the last 6 months'
      );
    });

    it('is still early for a monthly filer — six days of runway', () => {
      const late = supplierIn(onThe5th, 'LATE');
      expect(late.daysToCutOff).toBe(6);
      expect(late.urgency).toBe(URGENCY.EARLY);
      expect(late.preCutOff).toBe(true);
    });

    it('totals the credit at stake per band', () => {
      const high = onThe5th.bands.find((band) => band.band === RISK_BANDS.HIGH);
      expect(high.itcAtStake).toBe(byKey('LATE').target.tax + byKey('GHOST').target.tax);
      expect(high.supplierCount).toBe(2);
      const sum = onThe5th.bands.reduce((total, band) => total + band.itcAtStake, 0);
      expect(sum).toBe(onThe5th.totals.itcAtStake);
    });
  });

  // --- escalation -----------------------------------------------------------

  it('escalates as the cut-off approaches rather than shouting on day one', () => {
    expect(supplierIn(onThe5th, 'LATE').urgency).toBe(URGENCY.EARLY); // 6 days
    expect(supplierIn(onThe10th, 'LATE').urgency).toBe(URGENCY.URGENT); // 1 day
    expect(supplierIn(onThe12th, 'LATE').urgency).toBe(URGENCY.PAST_CUTOFF);

    expect(supplierIn(onThe5th, 'LATE').urgencyRank).toBeLessThan(
      supplierIn(onThe10th, 'LATE').urgencyRank
    );
  });

  // --- the 12th: two different deadlines ------------------------------------

  describe('on the 12th', () => {
    it('leaves the QRMP supplier inside their window while the monthly one is past theirs', () => {
      const qrmp = supplierIn(onThe12th, 'QRMP');
      const monthly = supplierIn(onThe12th, 'RELIABLE');

      expect(qrmp.preCutOff).toBe(true);
      expect(qrmp.daysToCutOff).toBe(1);
      expect(qrmp.urgency).toBe(URGENCY.URGENT);

      expect(monthly.preCutOff).toBe(false);
      expect(monthly.daysToCutOff).toBe(-1);
      expect(monthly.urgency).toBe(URGENCY.PAST_CUTOFF);
    });

    it('still promises the QRMP supplier a free fix, and only them', () => {
      expect(supplierIn(onThe12th, 'QRMP').chaseMessage).toContain('at no cost to either of us');
      expect(supplierIn(onThe12th, 'RELIABLE').chaseMessage).toContain('needs GSTR-1A');
    });
  });

  // --- after the cut-off ----------------------------------------------------

  describe('after the cut-off', () => {
    it('says the credit moves to the next tax period, explicitly', () => {
      const late = supplierIn(onThe16th, 'LATE');
      expect(late.preCutOff).toBe(false);
      expect(late.consequence).toContain('GSTR-1A');
      expect(late.consequence).toContain('August 2026'); // the NEXT period
      expect(late.consequence).toContain('never July 2026');
      expect(late.chaseMessage).toContain('the next tax period, not July 2026');
    });

    it('names the next period on the alert set itself', () => {
      expect(onThe16th.nextTaxPeriod).toBe('2026-08');
      expect(onThe16th.window).toBe('REACTIVE');
    });
  });

  // --- which GROUP a supplier lands in --------------------------------------
  //
  // "Normal for this point in the month" is a claim about the calendar as much as
  // about the supplier: unreported, but their deadline has not arrived. Grouping
  // on the risk band alone made it a claim about the supplier only, so the three
  // groups held identical members on the 5th and the 16th. On the 16th "Normal"
  // still contained a supplier whose cut-off had passed a week earlier and who
  // had still filed nothing — while their own card, correctly, showed a red
  // "Cut-off passed" chip and a GSTR-1A consequence.
  //
  // The risk band itself is untouched by any of this. It describes their filing
  // RECORD, which does not change because the calendar moved.

  const groupOf = (alerts, key) => {
    const gstin = byKey(key).gstin;
    const band = alerts.bands.find((entry) =>
      entry.suppliers.some((supplier) => supplier.gstin === gstin)
    );
    return band?.band ?? null;
  };

  describe('group membership follows the as-of date', () => {
    it('puts a reliable supplier in Normal while their cut-off is still ahead', () => {
      expect(groupOf(onThe5th, 'RELIABLE')).toBe(RISK_BANDS.LOW);
      expect(supplierIn(onThe5th, 'RELIABLE').preCutOff).toBe(true);
      expect(supplierIn(onThe5th, 'RELIABLE').escalated).toBe(false);
    });

    it('takes them OUT of Normal once their cut-off has passed', () => {
      const reliable = supplierIn(onThe16th, 'RELIABLE');
      expect(reliable.preCutOff).toBe(false);

      // The bug, stated directly.
      expect(groupOf(onThe16th, 'RELIABLE')).not.toBe(RISK_BANDS.LOW);
      expect(groupOf(onThe16th, 'RELIABLE')).toBe(RISK_BANDS.MEDIUM);

      // Their RECORD is unchanged — they are still a reliable filer who is simply
      // out of time, and the screen has to keep being able to say so.
      expect(reliable.risk.band).toBe(RISK_BANDS.LOW);
      expect(reliable.escalated).toBe(true);
    });

    it('moves a supplier between groups as the date crosses their own cut-off', () => {
      // The QRMP supplier is the one that proves this is per-supplier and not one
      // global date: on the 12th the monthly filers are past their 11th and this
      // one still has a day left on their 13th.
      expect(supplierIn(onThe12th, 'QRMP').preCutOff).toBe(true);
      expect(supplierIn(onThe12th, 'RELIABLE').preCutOff).toBe(false);

      expect(groupOf(onThe12th, 'QRMP')).toBe(RISK_BANDS.LOW);
      expect(groupOf(onThe12th, 'RELIABLE')).toBe(RISK_BANDS.MEDIUM);

      // One day later their own cut-off has gone too, and they move.
      expect(groupOf(onThe16th, 'QRMP')).toBe(RISK_BANDS.MEDIUM);
      expect(supplierIn(onThe16th, 'QRMP').escalated).toBe(true);
    });

    it('shrinks Normal and grows the concern groups as the month advances', () => {
      const size = (alerts, band) =>
        alerts.bands.find((entry) => entry.band === band).supplierCount;

      const normal = [onThe5th, onThe10th, onThe12th, onThe16th].map((a) =>
        size(a, RISK_BANDS.LOW)
      );
      const concern = [onThe5th, onThe10th, onThe12th, onThe16th].map(
        (a) => size(a, RISK_BANDS.HIGH) + size(a, RISK_BANDS.MEDIUM)
      );

      // Monotonic, and it actually moves rather than merely not increasing.
      for (let i = 1; i < normal.length; i += 1) {
        expect(normal[i]).toBeLessThanOrEqual(normal[i - 1]);
        expect(concern[i]).toBeGreaterThanOrEqual(concern[i - 1]);
      }
      expect(normal.at(-1)).toBeLessThan(normal[0]);
      expect(concern.at(-1)).toBeGreaterThan(concern[0]);

      // By the 16th every cut-off has gone, so nothing can still be "normal for
      // this point in the month".
      expect(normal.at(-1)).toBe(0);
    });

    it('never leaves a past-cut-off supplier in Normal, on any of the four days', () => {
      for (const alerts of [onThe5th, onThe10th, onThe12th, onThe16th]) {
        const normal = alerts.bands.find((entry) => entry.band === RISK_BANDS.LOW);
        for (const supplier of normal.suppliers) {
          expect(supplier.preCutOff).not.toBe(false);
        }
      }
    });

    it('keeps the totals whole — regrouping moves suppliers, it does not lose them', () => {
      for (const alerts of [onThe5th, onThe10th, onThe12th, onThe16th]) {
        const grouped = alerts.bands.reduce((sum, band) => sum + band.supplierCount, 0);
        const groupedItc = alerts.bands.reduce((sum, band) => sum + band.itcAtStake, 0);
        expect(grouped).toBe(alerts.totals.supplierCount);
        expect(groupedItc).toBe(alerts.totals.itcAtStake);
      }
      // Same suppliers throughout — only their grouping moved.
      expect(onThe16th.totals.supplierCount).toBe(onThe5th.totals.supplierCount);
      expect(onThe16th.totals.itcAtStake).toBe(onThe5th.totals.itcAtStake);
    });

    it('counts the escalated members on the band, for the group header to use', () => {
      const medium = onThe16th.bands.find((entry) => entry.band === RISK_BANDS.MEDIUM);
      expect(medium.escalatedCount).toBeGreaterThan(0);
      expect(medium.pastCutOffCount).toBe(medium.supplierCount);
      expect(medium.escalatedCount).toBe(
        medium.suppliers.filter((supplier) => supplier.escalated).length
      );
    });
  });

  // --- saved is not safe ----------------------------------------------------

  it('reports a supplier who has SAVED but not FILED as not yet safe', () => {
    const saver = supplierIn(onThe5th, 'SAVER');
    expect(saver).not.toBeNull();
    expect(saver.invoices).toHaveLength(1);

    const invoice = saver.invoices[0];
    expect(invoice.status).toBe(ALERT_STATUS.SAVED_NOT_FILED);
    expect(invoice.filingStatus).toBe('SAVED');
    expect(invoice.note).toContain('Not safe yet');
    expect(saver.chaseMessage).toContain('saved but not filed yet');
  });

  it('raises nothing at all for an invoice already reported and filed', () => {
    for (const alerts of [onThe5th, onThe10th, onThe12th, onThe16th]) {
      expect(supplierIn(alerts, 'FILER')).toBeNull();
    }
  });

  // --- the message ----------------------------------------------------------

  describe('the chase message', () => {
    it('lists invoice number, date, amount and the deadline', () => {
      const ghost = supplierIn(onThe5th, 'GHOST');
      const message = ghost.chaseMessage;
      expect(message).toContain(byKey('GHOST').target.invoiceNo);
      expect(message).toContain('18 Jul 2026');
      expect(message).toContain('Rs. 10,000.00');
      expect(message).toContain('11 Aug 2026');
      expect(message).toContain('Rs. 1,800.00');
    });

    it('is ASCII only, so it survives WhatsApp, SMS and an ERP note field', () => {
      for (const supplier of onThe5th.suppliers) {
        expect(supplier.chaseMessage).toMatch(/^[\x20-\x7e\n]*$/);
        expect(supplier.chaseMessage).not.toContain('₹');
      }
    });
  });
});

// The escalation rule on its own, including the two branches the fixture cannot
// reach: a HIGH supplier (already at the top, nowhere to go) and an unresolvable
// cut-off.
describe('alertBandFor', () => {
  it('leaves everyone where they are while the cut-off is ahead', () => {
    for (const band of BAND_ORDER) {
      expect(alertBandFor(band, true)).toBe(band);
    }
  });

  it('moves a supplier up exactly one band once their cut-off has passed', () => {
    expect(alertBandFor(RISK_BANDS.LOW, false)).toBe(RISK_BANDS.MEDIUM);
    expect(alertBandFor(RISK_BANDS.MEDIUM, false)).toBe(RISK_BANDS.HIGH);
  });

  it('does not promote past the top band', () => {
    // Everything is past its cut-off after the 13th. Sending them all to HIGH
    // would leave one group holding the entire screen on the day it matters
    // most, which is the ranking doing no work at all.
    expect(alertBandFor(RISK_BANDS.HIGH, false)).toBe(RISK_BANDS.HIGH);
  });

  it('does not escalate on an unresolved cut-off', () => {
    // null is "could not work it out", not "passed". Moving somebody into a
    // concern group on the strength of a failed calculation is the same class of
    // mistake as leaving them in Normal after their deadline.
    for (const band of BAND_ORDER) {
      expect(alertBandFor(band, null)).toBe(band);
      expect(alertBandFor(band, undefined)).toBe(band);
    }
  });
});

// The banding rule on its own, without a database in the way. These are the three
// shapes the fixture models, stated as the numbers that produce them.
describe('scoreSupplierRisk', () => {
  const period = (overrides) => ({
    taxPeriod: '2026-01',
    expectedCount: 2,
    invoiceCount: 2,
    appearedIn2b: true,
    appearedInIms: true,
    daysLate: -3,
    filedLate: false,
    missed: false,
    mismatchCount: 0,
    ...overrides
  });

  it('bands a supplier with no history at all as MEDIUM, never LOW', () => {
    const risk = scoreSupplierRisk([]);
    expect(risk.band).toBe(RISK_BANDS.MEDIUM);
    expect(risk.score).toBeNull();
    expect(risk.reasons[0]).toContain('no filing history yet');
  });

  it('bands six clean months as LOW', () => {
    const risk = scoreSupplierRisk(Array.from({ length: 6 }, () => period()));
    expect(risk.band).toBe(RISK_BANDS.LOW);
    // `score` is now the model's probability rather than the heuristic's weighted
    // sum, so it is asserted as a probability well inside the LOW band rather
    // than as the exact 0 the hand-weighted version returned.
    expect(risk.score).toBeLessThan(0.15);
    expect(risk.score).toBeGreaterThanOrEqual(0);
  });

  it('bands late-in-two-of-six as MEDIUM and late-in-three as HIGH', () => {
    const withLate = (lateCount) =>
      Array.from({ length: 6 }, (_, index) =>
        index < lateCount ? period({ daysLate: 4, filedLate: true }) : period()
      );
    expect(scoreSupplierRisk(withLate(2)).band).toBe(RISK_BANDS.MEDIUM);
    expect(scoreSupplierRisk(withLate(3)).band).toBe(RISK_BANDS.HIGH);
  });

  it('measures a QRMP supplier against the 13th when it explains itself', () => {
    const risk = scoreSupplierRisk([period({ daysLate: -1 })], { scheme: 'QRMP' });
    expect(risk.reasons.join(' ')).toContain('13th');
  });

  // The cry-wolf failure arriving by a different route: one observation is 100%
  // of the evidence, so a supplier seen once who was a day late scores like a
  // chronic offender and would head the chase list on nothing.
  it('will not call a supplier HIGH on a single month of history', () => {
    const oneLateMonth = [period({ daysLate: 4, filedLate: true })];
    expect(scoreSupplierRisk(oneLateMonth).score).toBeGreaterThan(
      RISK_BAND_THRESHOLDS.high
    );
    expect(scoreSupplierRisk(oneLateMonth).band).toBe(RISK_BANDS.MEDIUM);
    expect(scoreSupplierRisk(oneLateMonth).reasons.join(' ')).toContain(
      '1 month of history so far'
    );
  });
});
