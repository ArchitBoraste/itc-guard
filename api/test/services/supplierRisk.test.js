// supplier_risk: the record of what the trader was told, and when.
//
// The band is cheap to recompute, so this table is not a cache the app depends
// on. It exists because "what did this say on the 5th" stops being answerable the
// moment the underlying periods move on, and that is exactly the question someone
// asks after a credit goes missing.
//
// The guards are asserted again HERE, end to end through the database, rather
// than only as unit tests on score.js — the whole point of them is that nothing
// between the model and the screen can undo them.
//
// Owns org 11.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import { normalizeInvoiceNo } from '../../src/matching/normalize.js';
import { assignPortalIdentities, assignExpectedIdentities } from '../../src/services/identity.js';
import { rebuildSupplierPeriods } from '../../src/services/supplierStats.js';
import { rebuildSupplierRisk, supplierRiskMap } from '../../src/services/supplierRisk.js';
import { TEST_ORGS, ensureOrg, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.supplierRisk;
const TRADER_GSTIN = '27AABCS1429F11Z';

const HISTORY = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const AS_OF_PERIOD = '2026-06';

const ON_TIME = 8;
const LATE = 15;

// Four suppliers, chosen so each exercises a different path through the scorer.
const SUPPLIERS = [
  {
    key: 'RELIABLE',
    gstin: '27BBBBB0001B1Z5',
    name: 'Steady Supplies',
    months: HISTORY.length,
    filedOnDay: () => ON_TIME
  },
  {
    key: 'LATE',
    gstin: '27BBBBB0002B1Z4',
    name: 'Tardy Traders',
    months: HISTORY.length,
    filedOnDay: (index) => (index < 4 ? LATE : ON_TIME)
  },
  {
    // Seen once, and that once was late. The model rates them extreme; the
    // thin-history guard must cap the band at MEDIUM anyway.
    key: 'NEWCOMER',
    gstin: '27BBBBB0003B1Z3',
    name: 'Fresh Imports',
    months: 1,
    filedOnDay: () => LATE
  },
  {
    // Files on the deadline itself, every month. The 11th IS the deadline, so
    // this is ON TIME — the boundary the "Late" column and the reasons have to
    // agree about. Deepak Sales Corp on the demo screen was read as an off-by-one
    // here; it was not, and this pins the predicate so it stays that way.
    key: 'ON_THE_DEADLINE',
    gstin: '27BBBBB0005B1Z1',
    name: 'Exactly Punctual',
    months: HISTORY.length,
    filedOnDay: () => 11
  },
  {
    // Reported in the first month and never again, while the trader kept buying.
    // No training row ever looked like this, so the model has no term for it and
    // the hand-weighted scorer has to take over.
    key: 'GHOST',
    gstin: '27BBBBB0004B1Z2',
    name: 'Vanishing Works',
    months: HISTORY.length,
    filedOnDay: (index) => (index === 0 ? ON_TIME : null)
  }
];

const byKey = (key) => SUPPLIERS.find((entry) => entry.key === key);
const riskOf = (map, key) => map.get(byKey(key).gstin) ?? null;

function addMonth(taxPeriod) {
  const [year, month] = taxPeriod.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

async function seed() {
  const expected = [];
  const portal = [];

  HISTORY.forEach((taxPeriod, index) => {
    for (const supplier of SUPPLIERS) {
      // A supplier with a short history only exists in the most recent months.
      if (index < HISTORY.length - supplier.months) continue;

      const invoiceNo = `${supplier.key}/${taxPeriod.replace('-', '')}`;
      const row = {
        supplierGstin: supplier.gstin,
        supplierName: supplier.name,
        docType: 'INVOICE',
        supplyType: 'B2B',
        invoiceNo,
        invoiceNoNorm: normalizeInvoiceNo(invoiceNo),
        invoiceDate: `${taxPeriod}-18`,
        taxPeriod,
        taxableValue: 1000000,
        igst: 180000,
        cgst: 0,
        sgst: 0,
        cess: 0,
        totalTax: 180000,
        invoiceValue: 1180000
      };
      expected.push(row);

      const day = supplier.filedOnDay(index - (HISTORY.length - supplier.months));
      if (day === null) continue; // reported nothing at all that month

      portal.push({
        ...row,
        source: 'GSTR2B',
        section: 'b2b',
        itcAvailable: 1,
        supplierFiledOn: `${addMonth(taxPeriod)}-${String(day).padStart(2, '0')}`,
        counterpartyFilingStatus: 'Y',
        filingStatus: null,
        imsAction: null,
        contentHash: computeContentHash(row)
      });
    }
  });

  assignExpectedIdentities(expected);
  assignPortalIdentities(portal);

  await pool.query(
    `INSERT INTO expected_invoices
       (org_id, supplier_gstin, supplier_name, doc_type, supply_type, invoice_no,
        invoice_no_norm, invoice_date, tax_period, taxable_value, igst, cgst, sgst,
        cess, total_tax, invoice_value, reverse_charge, identity_seq, identity_key)
     VALUES ?`,
    [expected.map((r) => [
      ORG_ID, r.supplierGstin, r.supplierName, r.docType, r.supplyType, r.invoiceNo,
      r.invoiceNoNorm, r.invoiceDate, r.taxPeriod, r.taxableValue, r.igst, r.cgst,
      r.sgst, r.cess, r.totalTax, r.invoiceValue, 0, r.identitySeq, r.identityKey
    ])]
  );

  await pool.query(
    `INSERT INTO portal_records
       (org_id, source, section, supplier_gstin, supplier_name, doc_type, supply_type,
        invoice_no, invoice_no_norm, invoice_date, tax_period, taxable_value, igst,
        cgst, sgst, cess, total_tax, invoice_value, reverse_charge, itc_available,
        supplier_filed_on, counterparty_filing_status, filing_status, ims_action,
        content_hash, identity_seq, identity_key)
     VALUES ?`,
    [portal.map((r) => [
      ORG_ID, r.source, r.section, r.supplierGstin, r.supplierName, r.docType,
      r.supplyType, r.invoiceNo, r.invoiceNoNorm, r.invoiceDate, r.taxPeriod,
      r.taxableValue, r.igst, r.cgst, r.sgst, r.cess, r.totalTax, r.invoiceValue,
      0, r.itcAvailable, r.supplierFiledOn, r.counterpartyFilingStatus,
      r.filingStatus, r.imsAction, r.contentHash, r.identitySeq, r.identityKey
    ])]
  );

  for (const period of HISTORY) await rebuildSupplierPeriods(ORG_ID, period);
}

describe('supplier_risk', () => {
  let stored;

  beforeAll(async () => {
    await requireDatabase();
    await resetOrg(ORG_ID);
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await seed();
    await rebuildSupplierRisk(ORG_ID, AS_OF_PERIOD);
    stored = await supplierRiskMap(ORG_ID, AS_OF_PERIOD);
  });

  afterAll(async () => {
    await closePool();
  });

  it('stores a band per supplier for the period being worked on', () => {
    expect(stored.size).toBe(SUPPLIERS.length);
    for (const supplier of SUPPLIERS) {
      expect(stored.get(supplier.gstin).asOfPeriod).toBe(AS_OF_PERIOD);
    }
  });

  it('separates a reliable supplier from a habitually late one', () => {
    expect(riskOf(stored, 'RELIABLE').band).toBe('LOW');
    expect(riskOf(stored, 'LATE').band).toBe('HIGH');
  });

  it('records which scorer produced each band', () => {
    // Without this a stored band is unreadable after a retrain — there would be
    // no way to tell a model verdict from a fallback.
    expect(riskOf(stored, 'RELIABLE').source).toBe('MODEL');
    expect(riskOf(stored, 'LATE').source).toBe('MODEL');
  });

  it('keeps the plain-English reasons alongside the band', () => {
    const late = riskOf(stored, 'LATE');
    expect(late.reasons.join(' ')).toContain('filed late in 4 of the last 6 months');
    // Never a bare number in what gets shown.
    for (const reason of late.reasons) expect(reason).not.toMatch(/0\.\d{3,}/);
  });

  // --- the guards, end to end -----------------------------------------------

  it('caps a supplier seen once at MEDIUM however bad the month was', () => {
    const newcomer = riskOf(stored, 'NEWCOMER');
    expect(newcomer.periodsObserved).toBe(1);
    expect(newcomer.band).toBe('MEDIUM');
    expect(newcomer.guard).toBe('THIN_HISTORY');
    expect(newcomer.reasons.join(' ')).toContain('provisional');
  });

  it('falls back to the heuristic for a supplier the model has no term for', () => {
    // Nothing in the training corpus ever failed to reach 2B, so filed_ratio_6m
    // was dropped and the model rates this supplier as clean. The heuristic reads
    // the fact directly.
    const ghost = riskOf(stored, 'GHOST');
    expect(ghost.source).toBe('HEURISTIC');
    expect(ghost.band).toBe('HIGH');
    expect(ghost.reasons.join(' ')).toContain('reported nothing at all in 5 of the last 6 months');
  });

// --- the cut-off boundary ------------------------------------------------

  describe('a filing landing exactly on the cut-off', () => {
    it('is on time, not late', async () => {
      const [rows] = await pool.query(
        `SELECT sp.tax_period, sp.gstr1_filed_on, sp.cut_off_date, sp.days_late, sp.filed_late
           FROM supplier_periods sp
           JOIN suppliers s ON s.id = sp.supplier_id AND s.org_id = sp.org_id
          WHERE sp.org_id = ? AND s.gstin = ? ORDER BY sp.tax_period`,
        [ORG_ID, byKey('ON_THE_DEADLINE').gstin]
      );
      expect(rows).toHaveLength(HISTORY.length);
      for (const row of rows) {
        // Filed on the 11th against an 11th cut-off.
        expect(row.gstr1_filed_on.slice(8)).toBe('11');
        expect(row.cut_off_date.slice(8)).toBe('11');
        expect(Number(row.days_late)).toBe(0);
        expect(Number(row.filed_late)).toBe(0);
      }
    });

    it('is described as on time by the reasons too', () => {
      const punctual = riskOf(stored, 'ON_THE_DEADLINE');
      expect(punctual.features.lateCount).toBe(0);
      expect(punctual.reasons.join(' ')).toContain('filed on time in all of the last 6 months');
      expect(punctual.reasons.join(' ')).not.toContain('filed late');
    });
  });

  // --- the column and the sentence beside it -------------------------------
  //
  // The bug: the Late column aggregated every observed period while the reasons
  // covered only the periods BEFORE the one on screen. A supplier early one month
  // and late the next read "Late 1" next to "filed on time in all of the last 1
  // month". Both true, about different spans, neither saying which.
  //
  // Both now come from one feature object over one window, so they cannot say
  // different things about the same supplier.
  describe('the counts a row shows and the counts its reasons quote', () => {
    it('come from the same window, for every supplier', () => {
      for (const supplier of SUPPLIERS) {
        const risk = riskOf(stored, supplier.key);
        const { features, reasons } = risk;
        const text = reasons.join(' ');

        if (features.lateCount > 0) {
          expect(text).toContain(`filed late in ${features.lateCount} of the last`);
        } else {
          expect(text).not.toContain('filed late in');
        }
        // The window the sentences quote is the one the counts were taken over.
        if (features.periodsObserved > 0 && text.includes('of the last')) {
          expect(text).toContain(`of the last ${features.periodsObserved} month`);
        }
      }
    });

    it('counts the most recent period, not just the ones before it', () => {
      // ON_THE_DEADLINE and RELIABLE both have a row in AS_OF_PERIOD itself. An
      // exclusive window would report one period fewer than the table shows.
      expect(riskOf(stored, 'RELIABLE').features.periodsObserved).toBe(HISTORY.length);
      expect(riskOf(stored, 'ON_THE_DEADLINE').features.periodsObserved).toBe(HISTORY.length);
    });
  });

  // --- rebuild behaviour ----------------------------------------------------

  it('replaces the period in place rather than accumulating rows', async () => {
    await rebuildSupplierRisk(ORG_ID, AS_OF_PERIOD);
    await rebuildSupplierRisk(ORG_ID, AS_OF_PERIOD);
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM supplier_risk WHERE org_id = ? AND as_of_period = ?',
      [ORG_ID, AS_OF_PERIOD]
    );
    expect(Number(rows[0].n)).toBe(SUPPLIERS.length);
  });

  it('keeps each period separately, so an old verdict stays recoverable', async () => {
    await rebuildSupplierRisk(ORG_ID, '2026-04');
    const [rows] = await pool.query(
      'SELECT DISTINCT as_of_period FROM supplier_risk WHERE org_id = ? ORDER BY as_of_period',
      [ORG_ID]
    );
    expect(rows.map((row) => row.as_of_period)).toEqual(['2026-04', AS_OF_PERIOD]);

    // Reading as of April must not hand back July's answer.
    const april = await supplierRiskMap(ORG_ID, '2026-04');
    expect(april.get(byKey('LATE').gstin).asOfPeriod).toBe('2026-04');
  });
});
