// What the Suppliers screen says about a supplier has to be true (audit P8, P15,
// P17), with all six sample months loaded the way a visitor would load them —
// February last.
//
//   P15  every GSTIN a supplier mistyped on the portal became a supplier of its
//        own: 108 suppliers for 40, "National Supply Co" five times.
//   P8   "amounts differed on N of M documents" counted invoice-number-only
//        differences, phantoms, reverse charge and ineligible documents; it was
//        false for 22 of the 24 suppliers showing it.
//   P17  one row mixed time windows ("Periods 3 · Docs 68" beside "differed on 10
//        of 36"), and risk was scored when a month was loaded and never again:
//        after loading February last, July still read "5 months of history".
//
// Owns org 24.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool, pool } from '../../src/db/pool.js';
import { gstinDistance } from '../../src/matching/normalize.js';
import { ensureOrg, seedDemoPeriod } from '../../src/services/demo.js';
import { seedDemoStory } from '../../src/services/demoStory.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT, readJson } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.supplierFacts;
const LAST = '2026-07';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

const SAMPLE_SUPPLIERS = readJson('', 'suppliers.json').suppliers;

let server;
let base;
let view;

async function suppliersAsOf(period) {
  const res = await fetch(`${base}/api/suppliers?taxPeriod=${period}`);
  return res.json();
}

describe('supplier facts', () => {
  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID);
    await resetOrg(ORG_ID);
    await seedDemoStory(ORG_ID);
    for (const period of ['2026-05', '2026-06', '2026-07', '2026-02']) {
      await seedDemoPeriod(ORG_ID, { taxPeriod: period });
    }

    const app = createApp({
      pingDb: async () => true,
      auth: (req, res, next) => {
        req.orgId = ORG_ID;
        req.userId = null;
        req.sessionState = 'READY';
        next();
      }
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    view = await suppliersAsOf(LAST);
  }, 900000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closePool();
  });

  it('lists each of the 40 suppliers once, however often their GSTIN was mistyped', () => {
    expect(view.suppliers).toHaveLength(SAMPLE_SUPPLIERS.length);
    expect(new Set(view.suppliers.map((s) => s.gstin))).toEqual(new Set(SAMPLE_SUPPLIERS.map((s) => s.gstin)));

    const national = view.suppliers.filter((s) => /National Supply/.test(s.tradeName));
    expect(national).toHaveLength(1);
    expect(national[0].gstinVariants.length).toBeGreaterThan(0);
  });

  it('flags every mistyped GSTIN on the supplier it belongs to, with its evidence', () => {
    const variants = view.suppliers.flatMap((s) => s.gstinVariants.map((v) => ({ ...v, of: s.gstin })));
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) {
      expect(gstinDistance(variant.gstin, variant.of)).toBe(1);
      expect(['MATCHED_PARTNER', 'ONE_CHARACTER']).toContain(variant.evidence);
      expect(variant.documents).toBeGreaterThan(0);
    }
  });

  it('answers a mistyped GSTIN with the supplier it belongs to', async () => {
    const owner = view.suppliers.find((s) => s.gstinVariants.length);
    const res = await fetch(`${base}/api/suppliers/${owner.gstinVariants[0].gstin}`);
    expect(res.status).toBe(200);
    expect((await res.json()).supplier.gstin).toBe(owner.gstin);
  });

  it('counts "amounts differed" from value mismatches and nothing else', async () => {
    const [rows] = await pool.query(
      `SELECT ei.supplier_gstin AS gstin, COUNT(*) AS n
         FROM match_results mr
         JOIN runs r ON r.id = mr.run_id
         JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE mr.org_id = ? AND mr.bucket = 'VALUE_MISMATCH' AND r.tax_period IN (?)
        GROUP BY ei.supplier_gstin`,
      [ORG_ID, view.window]
    );
    const valueMismatches = new Map(rows.map((row) => [row.gstin, Number(row.n)]));
    for (const supplier of view.suppliers) {
      expect(supplier.risk.features.mismatches, supplier.tradeName).toBe(valueMismatches.get(supplier.gstin) ?? 0);
    }
    // The audit's example: Laxmi Components' two "mismatches" were invoice-number
    // differences with identical amounts.
    const laxmi = view.suppliers.find((s) => /Laxmi Components/.test(s.tradeName));
    expect(laxmi.risk.features.mismatches).toBe(valueMismatches.get(laxmi.gstin) ?? 0);
  });

  it('sums every figure on a row over the window its risk band was scored on', () => {
    expect(view.asOfPeriod).toBe(LAST);
    expect(view.window).toHaveLength(6);
    for (const supplier of view.suppliers) {
      const { features } = supplier.risk;
      expect(supplier.stats.periodsObserved, supplier.tradeName).toBe(features.periodsObserved);
      expect(supplier.stats.invoiceCount, supplier.tradeName).toBe(features.documents);
      expect(supplier.stats.lateCount, supplier.tradeName).toBe(features.lateCount);
      expect(supplier.stats.mismatchCount, supplier.tradeName).toBe(features.mismatches);
    }
  });

  it('rescores every month when one is loaded: February last still gives July six months', () => {
    const everyMonth = view.suppliers.filter((s) => s.stats.periodsObserved === 6);
    expect(everyMonth.length).toBeGreaterThan(0);
    for (const supplier of everyMonth) expect(supplier.risk.periodsObserved).toBe(6);
  });

  it('keeps an earlier month on its own window', async () => {
    const may = await suppliersAsOf('2026-05');
    expect(may.asOfPeriod).toBe('2026-05');
    expect(may.window.at(-1)).toBe('2026-05');
    for (const supplier of may.suppliers) {
      expect(supplier.stats.periodsObserved).toBeLessThanOrEqual(4);
      // A supplier first seen after May has nothing in this window, and says so.
      expect(supplier.stats.invoiceCount).toBe(supplier.risk.features.documents ?? 0);
    }
  });
});
