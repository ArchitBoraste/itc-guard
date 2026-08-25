// GET /api/suppliers has to arrive with the bands already computed.
//
// The bug this pins: `rebuildSupplierRisk` was called from ONE place, the
// POST /api/runs handler, while `rebuildSupplierPeriods` was called from five.
// So every other way of completing a run — the demo seeder, tools/seed-demo.js,
// and rerunPeriodIfRun on an upload commit — left supplier_risk empty, and
// `npm run demo:reset` (which DELETEs the table and reseeds through the demo
// path) left the Suppliers screen reading "not scored yet" for all 64 suppliers,
// directly beneath a panel explaining the model's ROC AUC.
//
// Two rules are asserted end to end, through the real route:
//
//   1. a supplier the behaviour table knows about ALWAYS gets a band. Phase 7
//      settled that no filing history means MEDIUM — never LOW, and never blank.
//   2. "not scored yet" is reachable only for a supplier with no behaviour row
//      at all, which is the one state where there is genuinely nothing to say.
//
// Owns org 12. stubAuth pins requests to org 1 (the running demo), so the route
// is mounted with an auth stub for THIS org instead — see apiRouter({ auth }).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import { normalizeInvoiceNo } from '../../src/matching/normalize.js';
import { assignExpectedIdentities, assignPortalIdentities } from '../../src/services/identity.js';
import { rebuildSupplierStats } from '../../src/services/supplierRisk.js';
import { TEST_ORGS, ensureOrg, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.suppliersRoute;
const TRADER_GSTIN = '27AABCS1429F12Z';

const PERIODS = ['2026-04', '2026-05', '2026-06'];
const AS_OF_PERIOD = '2026-06';

const ON_TIME = 8;
const LATE = 15;

const SUPPLIERS = [
  {
    // Present in all three periods, so two of them fall inside the scoring
    // window for 2026-06. This is the shape the demo actually has.
    key: 'STEADY',
    gstin: '27CCCCC0001C1Z5',
    name: 'Steady Supplies',
    from: 0,
    filedOnDay: () => ON_TIME
  },
  {
    key: 'LATE',
    gstin: '27CCCCC0002C1Z4',
    name: 'Tardy Traders',
    from: 0,
    filedOnDay: (index) => (index < 2 ? LATE : ON_TIME)
  },
  {
    // First seen in the as-of period itself: a behaviour row exists, but nothing
    // before it. Cold start — MEDIUM, and emphatically not a blank cell.
    key: 'COLD',
    gstin: '27CCCCC0003C1Z3',
    name: 'Newly Onboarded',
    from: 2,
    filedOnDay: () => ON_TIME
  }
];

// A supplier row with NO supplier_periods row anywhere — the portal named them in
// a period that was never reconciled. The only case that may render unscored.
const UNSEEN = { gstin: '27CCCCC0004C1Z2', name: 'Never Reconciled' };

const byKey = (key) => SUPPLIERS.find((entry) => entry.key === key);

function addMonth(taxPeriod) {
  const [year, month] = taxPeriod.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

async function seed() {
  const expected = [];
  const portal = [];

  PERIODS.forEach((taxPeriod, index) => {
    for (const supplier of SUPPLIERS) {
      if (index < supplier.from) continue;

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
      portal.push({
        ...row,
        source: 'GSTR2B',
        section: 'b2b',
        itcAvailable: 1,
        supplierFiledOn: `${addMonth(taxPeriod)}-${String(
          supplier.filedOnDay(index - supplier.from)
        ).padStart(2, '0')}`,
        counterpartyFilingStatus: 'Y',
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
        supplier_filed_on, counterparty_filing_status, content_hash, identity_seq,
        identity_key)
     VALUES ?`,
    [portal.map((r) => [
      ORG_ID, r.source, r.section, r.supplierGstin, r.supplierName, r.docType,
      r.supplyType, r.invoiceNo, r.invoiceNoNorm, r.invoiceDate, r.taxPeriod,
      r.taxableValue, r.igst, r.cgst, r.sgst, r.cess, r.totalTax, r.invoiceValue,
      0, r.itcAvailable, r.supplierFiledOn, r.counterpartyFilingStatus,
      r.contentHash, r.identitySeq, r.identityKey
    ])]
  );

  // The whole post-run rebuild, exactly as every run path now calls it.
  for (const period of PERIODS) await rebuildSupplierStats(ORG_ID, period);

  // Added AFTER the rebuilds so it never acquires a behaviour row.
  await pool.query(
    `INSERT INTO suppliers (org_id, gstin, legal_name, trade_name, state_code)
     VALUES (?, ?, ?, ?, ?)`,
    [ORG_ID, UNSEEN.gstin, UNSEEN.name, UNSEEN.name, '27']
  );
}

describe('GET /api/suppliers', () => {
  let server;
  let body;

  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    expect(res.status).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    await requireDatabase();
    await resetOrg(ORG_ID);
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await seed();

    const app = createApp({
      pingDb: async () => true,
      auth: (req, res, next) => {
        req.orgId = ORG_ID;
        req.userId = null;
        next();
      }
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    body = await get(`/api/suppliers?taxPeriod=${AS_OF_PERIOD}`);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  const supplier = (key) => body.suppliers.find((entry) => entry.gstin === byKey(key).gstin);

  it('returns a band and topFactors for a supplier with two observed periods', () => {
    const steady = supplier('STEADY');
    expect(steady.stats.periodsObserved).toBe(PERIODS.length);

    // The thing that was broken: risk was null for every supplier.
    expect(steady.risk).not.toBeNull();
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(steady.risk.band);

    // Two periods inside the scoring window, so the model ran rather than the
    // cold-start fallback, and it can say which features moved the score.
    expect(steady.risk.periodsObserved).toBe(2);
    expect(steady.risk.source).toBe('MODEL');
    expect(steady.risk.topFactors.length).toBeGreaterThan(0);
    for (const factor of steady.risk.topFactors) {
      expect(typeof factor.feature).toBe('string');
      expect(['RAISES', 'LOWERS']).toContain(factor.direction);
    }
  });

  it('gives every supplier the behaviour table knows about a band', () => {
    const scored = body.suppliers.filter((entry) => entry.risk);
    // Everyone except the one with no behaviour row.
    expect(scored).toHaveLength(SUPPLIERS.length);
    for (const entry of scored) expect(entry.risk.band).toBeTruthy();
  });

  it('separates a habitually late supplier from a steady one', () => {
    expect(supplier('LATE').risk.reasons.join(' ')).toContain('filed late in 2 of the last 2 months');
    expect(supplier('STEADY').risk.reasons.join(' ')).toContain('filed on time');
  });

  // Cold start. This is the case the window filter used to swallow: a supplier
  // present in the behaviour table but with nothing before the as-of period came
  // back from the query at all, got no supplier_risk row, and rendered blank.
  it('bands a supplier with no prior history as MEDIUM, not as unscored', () => {
    const cold = supplier('COLD');
    expect(cold.risk).not.toBeNull();
    expect(cold.risk.band).toBe('MEDIUM');
    expect(cold.risk.band).not.toBe('LOW');
    expect(cold.risk.periodsObserved).toBe(0);
    expect(cold.risk.guard).toBe('NO_HISTORY');
    expect(cold.risk.reasons.join(' ')).toContain('no filing history yet');
  });

  it('leaves only a supplier with no behaviour row unscored', () => {
    const unseen = body.suppliers.find((entry) => entry.gstin === UNSEEN.gstin);
    expect(unseen).toBeDefined();
    expect(unseen.stats.periodsObserved).toBe(0);
    expect(unseen.risk ?? null).toBeNull();

    // And it is the ONLY one.
    const unscored = body.suppliers.filter((entry) => !entry.risk);
    expect(unscored.map((entry) => entry.gstin)).toEqual([UNSEEN.gstin]);
  });

  it('reports which scorer produced the bands, so the screen can say so', () => {
    expect(body.model.source).toBe('MODEL');
    expect(body.model.synthetic).toBe(true);
  });

  // The route must not depend on any other screen having been visited. Bands are
  // written by the run, so a plain GET on a freshly seeded org already has them.
  it('does not require the alerts or runs screen to have been opened first', async () => {
    const fresh = await get('/api/suppliers');
    expect(fresh.suppliers.filter((entry) => entry.risk).length).toBe(SUPPLIERS.length);
  });
});
