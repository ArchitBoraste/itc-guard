// End-to-end integration: fixture files -> uploads -> commit -> run -> results
// -> IMS action JSON, against a real MySQL.
//
// FAILS when no database is reachable. It does not skip: a green run with twenty
// silent skips reads as "phase 4 verified" and is not. See requireDatabase().
// Start one with: docker compose up -d db && cd api && npm run migrate
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { createUpload, previewUpload } from '../../src/services/ingest.js';
import {
  COUNTED_TABLES,
  ensureOrg,
  ingest as ingestFile,
  requireDatabase,
  resetOrg,
  rowCounts as countRowsFor
} from '../helpers/db.js';
import {
  confirmResult,
  createRun,
  getRun,
  listResults
} from '../../src/services/reconcile.js';
import { rebuildSupplierPeriods, getSupplierHistory, listSuppliers } from '../../src/services/supplierStats.js';
import { buildRunImsActions } from '../../src/services/imsActions.js';
import { UPLOAD_SECTIONS } from '../../src/adapters/imsActionWriter.js';
import { FIXTURES_PRESENT, groundTruth, readBuffer } from '../helpers/fixtures.js';

const PERIOD = '2026-03';
// A neighbouring period is loaded too, on purpose. The engine's ±1 month blocking
// window pulls neighbouring portal records in as match CANDIDATES; if the run also
// reported them, every one of them would surface as a phantom MISSING_IN_BOOKS.
// Seeding only one period would hide that entirely.
const NEIGHBOUR_PERIOD = '2026-02';
const ORG_ID = 1;
const TRADER_GSTIN = '27AABCS1429F1Z8';
// After 2B generation on the 14th, before GSTR-3B on the 20th: the reactive window.
const AS_OF = '2026-04-16';

const rowCounts = () => countRowsFor(ORG_ID, COUNTED_TABLES);
const ingest = (kind, filename, period = PERIOD) => ingestFile(ORG_ID, kind, filename, period);

// Fixtures are generated and gitignored. Without them there is nothing to assert
// against — also a broken environment, not something to quietly skip.
if (!FIXTURES_PRESENT) {
  throw new Error(
    'fixtures/ is missing — run `npm run gen:fixtures` from the repo root first'
  );
}

describe('integration: fixture period through the whole stack', () => {
  let run;
  let truthBuckets;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);

    await ingest('PURCHASE_REGISTER', 'purchase_register.xlsx');
    await ingest('IMS', 'ims.json');
    await ingest('GSTR2B', 'gstr2b.json');

    // The neighbour must not leak into this period's exception list.
    await ingest('PURCHASE_REGISTER', 'purchase_register.xlsx', NEIGHBOUR_PERIOD);
    await ingest('IMS', 'ims.json', NEIGHBOUR_PERIOD);
    await ingest('GSTR2B', 'gstr2b.json', NEIGHBOUR_PERIOD);

    run = await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });
    await rebuildSupplierPeriods(ORG_ID, PERIOD, { runId: run.id });

    truthBuckets = {};
    for (const doc of groundTruth(PERIOD).documents) {
      truthBuckets[doc.expectedBucket] = (truthBuckets[doc.expectedBucket] ?? 0) + 1;
    }
  }, 120000);

  afterAll(async () => {
    await closePool();
  });

  // --- bucket counts -------------------------------------------------------

  it('bucket counts match ground truth for the seeded period', () => {
    expect(run.bucketCounts).toEqual(truthBuckets);
  });

  it('does not report a neighbouring period’s portal rows as exceptions', async () => {
    // The neighbour's records are loaded and available as match candidates, but
    // an unmatched portal record from another period belongs to that period's run.
    const [neighbourRows] = await pool.query(
      'SELECT COUNT(*) AS n FROM portal_records WHERE org_id = ? AND tax_period = ?',
      [ORG_ID, NEIGHBOUR_PERIOD]
    );
    expect(Number(neighbourRows[0].n)).toBeGreaterThan(300);

    const [leaked] = await pool.query(
      `SELECT COUNT(*) AS n
         FROM match_results mr
         JOIN portal_records pr ON pr.id = mr.portal_record_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND mr.expected_invoice_id IS NULL
          AND pr.tax_period <> ?`,
      [ORG_ID, run.id, PERIOD]
    );
    expect(Number(leaked[0].n)).toBe(0);
    expect(run.bucketCounts.MISSING_IN_BOOKS).toBe(truthBuckets.MISSING_IN_BOOKS);
  });

  it('still reconciles the neighbouring period correctly on its own', async () => {
    const neighbourRun = await createRun({
      orgId: ORG_ID, taxPeriod: NEIGHBOUR_PERIOD, mode: 'REACTIVE', asOfDate: '2026-03-16'
    });
    const truth = {};
    for (const doc of groundTruth(NEIGHBOUR_PERIOD).documents) {
      truth[doc.expectedBucket] = (truth[doc.expectedBucket] ?? 0) + 1;
    }
    expect(neighbourRun.bucketCounts).toEqual(truth);
    const t = neighbourRun.totals;
    expect(t.claimableItc + t.atRiskItc + t.deferredItc + t.ineligibleItc).toBe(
      t.expectedTotalItc
    );
    // Two runs coexist, one per period.
    expect(neighbourRun.id).not.toBe(run.id);
  }, 120000);

  it('produces one result per ground-truth document', async () => {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM match_results WHERE org_id = ? AND run_id = ?',
      [ORG_ID, run.id]
    );
    expect(Number(rows[0].n)).toBe(groundTruth(PERIOD).documents.length);
  });

  // --- money ---------------------------------------------------------------

  it('run totals reconcile to the identity, exactly, in paise', () => {
    const t = run.totals;
    // expectedTotalItc = claimable + atRisk + deferred + ineligible
    expect(t.claimableItc + t.atRiskItc + t.deferredItc + t.ineligibleItc).toBe(
      t.expectedTotalItc
    );
    // NON_IMS is informational and sits outside expected; nothing is unaccounted.
    expect(t.expectedTotalItc + t.nonImsItc).toBe(t.grandTotalItc);
    for (const value of Object.values(t)) expect(Number.isInteger(value)).toBe(true);
  });

  it('the stored totals equal the sum of the stored per-result amounts', async () => {
    // Guards against the run header and its rows drifting apart.
    const [rows] = await pool.query(
      `SELECT total_bucket, SUM(signed_itc) AS itc
         FROM match_results WHERE org_id = ? AND run_id = ?
        GROUP BY total_bucket`,
      [ORG_ID, run.id]
    );
    const byBucket = {};
    for (const row of rows) byBucket[row.total_bucket] = Number(row.itc);

    expect(byBucket.CLAIMABLE ?? 0).toBe(run.totals.claimableItc);
    expect(byBucket.AT_RISK ?? 0).toBe(run.totals.atRiskItc);
    expect(byBucket.DEFERRED ?? 0).toBe(run.totals.deferredItc);
    expect(byBucket.INELIGIBLE ?? 0).toBe(run.totals.ineligibleItc);
    expect(byBucket.NON_IMS ?? 0).toBe(run.totals.nonImsItc);
  });

  it('subtracts credit notes instead of adding them', async () => {
    // A credit note added rather than subtracted inflates claimable ITC and
    // nothing looks broken, so assert the sign directly.
    const [rows] = await pool.query(
      `SELECT SUM(mr.signed_itc) AS signed, SUM(ei.total_tax) AS raw, COUNT(*) AS n
         FROM match_results mr
         JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND ei.doc_type = 'CREDIT_NOTE'`,
      [ORG_ID, run.id]
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
    expect(Number(rows[0].signed)).toBe(-Number(rows[0].raw));

    const [debits] = await pool.query(
      `SELECT SUM(mr.signed_itc) AS signed, SUM(ei.total_tax) AS raw, COUNT(*) AS n
         FROM match_results mr
         JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND ei.doc_type = 'DEBIT_NOTE'`,
      [ORG_ID, run.id]
    );
    expect(Number(debits[0].n)).toBeGreaterThan(0);
    // Debit notes increase the value, so they stay positive.
    expect(Number(debits[0].signed)).toBe(Number(debits[0].raw));
  });

  it('stores money as integers everywhere, never as floats', async () => {
    const [rows] = await pool.query(
      `SELECT itc_impact, signed_itc, delta_taxable_value, delta_total_tax
         FROM match_results WHERE org_id = ? AND run_id = ?`,
      [ORG_ID, run.id]
    );
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value === null) continue;
        expect(Number.isInteger(Number(value))).toBe(true);
      }
    }
  });

  // --- idempotency ---------------------------------------------------------

  it('re-running the same period leaves row counts unchanged', async () => {
    const before = await rowCounts();
    const rerun = await createRun({
      orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF
    });
    await rebuildSupplierPeriods(ORG_ID, PERIOD, { runId: rerun.id });
    const after = await rowCounts();

    expect(after).toEqual(before);
    // Replace, not version: the same run row is reused.
    expect(rerun.id).toBe(run.id);
    expect(rerun.bucketCounts).toEqual(run.bucketCounts);
    expect(rerun.totals).toEqual(run.totals);
  }, 120000);

  it('re-uploading the same source leaves portal_records count unchanged', async () => {
    const before = await rowCounts();

    const ims = await ingest('IMS', 'ims.json');
    const twoB = await ingest('GSTR2B', 'gstr2b.json');
    const register = await ingest('PURCHASE_REGISTER', 'purchase_register.xlsx');

    const after = await rowCounts();
    expect(after.portal_records).toBe(before.portal_records);
    expect(after.expected_invoices).toBe(before.expected_invoices);
    expect(after.portal_rate_lines).toBe(before.portal_rate_lines);

    // Every row was an update, not an insert.
    expect(ims.inserted).toBe(0);
    expect(twoB.inserted).toBe(0);
    expect(register.inserted).toBe(0);
    expect(ims.updated).toBe(ims.parsed);
    // Identical content means no amendment was detected.
    expect(ims.changes).toBe(0);
    expect(twoB.changes).toBe(0);
  }, 120000);

  // --- IMS action JSON -----------------------------------------------------

  it('generates an IMS action JSON with the formats the portal requires', async () => {
    const built = await buildRunImsActions(ORG_ID, run.id);
    // Must survive a round trip through text, which is how it reaches the portal.
    const parsed = JSON.parse(JSON.stringify(built.json));

    expect(parsed.rtin).toBe(TRADER_GSTIN);
    expect(parsed.reqtyp).toBe('SAVE');
    expect(Object.keys(parsed.invdata)).toEqual(UPLOAD_SECTIONS);

    const records = UPLOAD_SECTIONS.flatMap((section) => parsed.invdata[section]);
    expect(records.length).toBeGreaterThan(0);

    for (const wire of records) {
      const isNote = 'nt_num' in wire;
      // inum is a STRING, so a 16-digit numeric invoice number stays exact.
      expect(typeof wire[isNote ? 'nt_num' : 'inum']).toBe('string');
      // dd-mm-yyyy, never ISO.
      expect(wire[isNote ? 'nt_dt' : 'idt']).toMatch(/^\d{2}-\d{2}-\d{4}$/);
      // Bare 2-digit place-of-supply code, not '27-Maharashtra'.
      expect(wire.pos).toMatch(/^\d{2}$/);
      // Single-letter action code, not a label.
      expect(wire.action).toMatch(/^[ARPN]$/);
      expect(wire.stin).toMatch(/^[0-9A-Z]{15}$/);
      expect(wire.rtnprd).toMatch(/^\d{2}$/);
      expect(wire.srcform).toBeTruthy();
      // Remarks only on Reject or Pending, capped at 250 characters.
      if ('remarks' in wire) {
        expect(['R', 'P']).toContain(wire.action);
        expect(wire.remarks.length).toBeLessThanOrEqual(250);
      }
    }
  });

  it('never emits an action or remark the portal would refuse', async () => {
    const built = await buildRunImsActions(ORG_ID, run.id);
    const [blocked] = await pool.query(
      `SELECT pr.invoice_no, pr.pending_blocked, pr.remarks_blocked
         FROM match_results mr
         JOIN portal_records pr ON pr.id = mr.portal_record_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND (pr.pending_blocked = 1 OR pr.remarks_blocked = 1)`,
      [ORG_ID, run.id]
    );
    expect(blocked.length).toBeGreaterThan(0);

    const byInvoice = new Map();
    for (const section of UPLOAD_SECTIONS) {
      for (const wire of built.json.invdata[section]) {
        byInvoice.set(wire.inum ?? wire.nt_num, wire);
      }
    }
    for (const record of blocked) {
      const wire = byInvoice.get(record.invoice_no);
      if (!wire) continue;
      if (record.pending_blocked) expect(wire.action).not.toBe('P');
      if (record.remarks_blocked) expect('remarks' in wire).toBe(false);
    }
  });

  it('excludes 2B-only records, which have no IMS row to act on', async () => {
    const built = await buildRunImsActions(ORG_ID, run.id);
    const records = UPLOAD_SECTIONS.flatMap((section) => built.json.invdata[section]);
    const [imsCount] = await pool.query(
      `SELECT COUNT(*) AS n FROM match_results mr
         JOIN portal_records pr ON pr.id = mr.portal_record_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND pr.source = 'IMS'`,
      [ORG_ID, run.id]
    );
    expect(records.length).toBe(Number(imsCount[0].n));

    // ISD and import records exist for this period but must not appear.
    const [nonIms] = await pool.query(
      `SELECT COUNT(*) AS n FROM match_results
        WHERE org_id = ? AND run_id = ? AND bucket = 'NON_IMS'`,
      [ORG_ID, run.id]
    );
    expect(Number(nonIms[0].n)).toBeGreaterThan(0);
  });

  // --- confirming decisions ------------------------------------------------

  it('rejects a confirmedAction the record blocked flags disallow', async () => {
    const [rows] = await pool.query(
      `SELECT mr.id FROM match_results mr
         JOIN portal_records pr ON pr.id = mr.portal_record_id
        WHERE mr.org_id = ? AND mr.run_id = ? AND pr.pending_blocked = 1
        LIMIT 1`,
      [ORG_ID, run.id]
    );
    expect(rows.length).toBe(1);
    const resultId = rows[0].id;

    await expect(
      confirmResult(ORG_ID, resultId, { confirmedAction: 'PENDING' })
    ).rejects.toThrow(/blocked/i);

    // The same record still accepts a permitted action.
    const ok = await confirmResult(ORG_ID, resultId, { confirmedAction: 'ACCEPT' });
    expect(ok.confirmed_action).toBe('ACCEPT');
  });

  it('keeps recommended and confirmed actions separate, and emits confirmed', async () => {
    const page = await listResults(ORG_ID, run.id, { bucket: 'MISSING_IN_BOOKS', pageSize: 5 });
    expect(page.results.length).toBeGreaterThan(0);
    const target = page.results[0];
    // A record not in the books is recommended for VERIFY, never auto-rejected.
    expect(target.recommendedAction).toBe('VERIFY');
    expect(target.confirmedAction).toBeNull();

    await confirmResult(ORG_ID, target.id, { confirmedAction: 'REJECT' });

    const after = await listResults(ORG_ID, run.id, { bucket: 'MISSING_IN_BOOKS', pageSize: 5 });
    const updated = after.results.find((row) => row.id === target.id);
    expect(updated.recommendedAction).toBe('VERIFY');
    expect(updated.confirmedAction).toBe('REJECT');

    // The upload JSON emits the trader's decision, not the recommendation.
    const built = await buildRunImsActions(ORG_ID, run.id);
    const wire = UPLOAD_SECTIONS.flatMap((s) => built.json.invdata[s]).find(
      (row) => (row.inum ?? row.nt_num) === updated.portal.invoiceNo
    );
    expect(wire).toBeTruthy();
    expect(wire.action).toBe('R');
  });

  it('moves a confirmation between claimable and at-risk and rebalances', async () => {
    const before = await getRun(ORG_ID, run.id);
    const page = await listResults(ORG_ID, run.id, { bucket: 'SUGGESTED', pageSize: 1 });
    const target = page.results[0];
    expect(target.totalBucket).toBe('AT_RISK');

    await confirmResult(ORG_ID, target.id, { confirmedAction: 'ACCEPT' });
    const after = await getRun(ORG_ID, run.id);

    // Confirming a suggested match as ACCEPT makes it claimable.
    expect(after.totals.claimableItc).toBe(before.totals.claimableItc + target.signedItc);
    expect(after.totals.atRiskItc).toBe(before.totals.atRiskItc - target.signedItc);
    // And the identity still holds.
    const t = after.totals;
    expect(t.claimableItc + t.atRiskItc + t.deferredItc + t.ineligibleItc).toBe(
      t.expectedTotalItc
    );
  });

  // --- results listing -----------------------------------------------------

  it('paginates and filters results, with the score breakdown intact', async () => {
    const page = await listResults(ORG_ID, run.id, { bucket: 'VALUE_MISMATCH', page: 1, pageSize: 3 });
    expect(page.total).toBe(truthBuckets.VALUE_MISMATCH);
    expect(page.results.length).toBeLessThanOrEqual(3);

    for (const result of page.results) {
      expect(result.bucket).toBe('VALUE_MISMATCH');
      expect(result.books).toBeTruthy();
      expect(result.portal).toBeTruthy();
      expect(result.deltaTotalTax).not.toBe(0);
      // The UI has to be able to show WHY something matched.
      expect(result.scoreBreakdown.invoiceNo).toHaveProperty('similarity');
      expect(result.scoreBreakdown.invoiceNo).toHaveProperty('rule');
    }

    const second = await listResults(ORG_ID, run.id, { bucket: 'VALUE_MISMATCH', page: 2, pageSize: 3 });
    const firstIds = page.results.map((r) => r.id);
    expect(second.results.every((r) => !firstIds.includes(r.id))).toBe(true);
  });

  // --- preview -------------------------------------------------------------

  it('previews an upload without committing it', async () => {
    const created = await createUpload({
      orgId: ORG_ID,
      kind: 'PURCHASE_REGISTER',
      filename: 'purchase_register.xlsx',
      buffer: readBuffer(PERIOD, 'purchase_register.xlsx'),
      taxPeriod: PERIOD
    });
    const before = await rowCounts();
    const preview = await previewUpload(ORG_ID, created.id, { limit: 20 });

    expect(preview.detectedFormat).toBe('PR_TEMPLATE_V24');
    expect(preview.taxPeriod).toBe(PERIOD);
    expect(preview.rows).toHaveLength(20);
    expect(preview.totalRows).toBeGreaterThan(20);
    expect(preview.metadata.recipientGstin).toBe(TRADER_GSTIN);
    // Preview must not write anything.
    expect(await rowCounts()).toEqual(before);
  });

  // --- supplier stats ------------------------------------------------------

  it('derives supplier periods with the right cut-off per scheme', async () => {
    const suppliers = await listSuppliers(ORG_ID);
    expect(suppliers.length).toBeGreaterThan(0);

    const [periods] = await pool.query(
      `SELECT sp.gstr1_filed_on, sp.cut_off_date, sp.days_late, sp.filing_scheme,
              sp.appeared_in_2b, sp.appeared_in_ims, sp.invoice_count, sp.mismatch_count
         FROM supplier_periods sp
        WHERE sp.org_id = ? AND sp.tax_period = ?`,
      [ORG_ID, PERIOD]
    );
    expect(periods.length).toBeGreaterThan(0);

    for (const row of periods) {
      // The cut-off must be that supplier's: 11th monthly, 13th QRMP.
      const expectedDay = row.filing_scheme === 'QRMP' ? '13' : '11';
      expect(row.cut_off_date.slice(-2)).toBe(expectedDay);
      expect(row.cut_off_date.startsWith('2026-04')).toBe(true);

      if (row.gstr1_filed_on) {
        const filed = Date.parse(`${row.gstr1_filed_on}T00:00:00Z`);
        const cutOff = Date.parse(`${row.cut_off_date}T00:00:00Z`);
        expect(row.days_late).toBe(Math.round((filed - cutOff) / 86400000));
      } else {
        expect(row.days_late).toBeNull();
      }
      expect(Number(row.invoice_count)).toBeGreaterThanOrEqual(0);
    }

    // At least one supplier filed after their own deadline in this period.
    expect(periods.some((row) => row.days_late !== null && row.days_late > 0)).toBe(true);
    expect(periods.some((row) => row.appeared_in_2b === 1)).toBe(true);
  });

  it('counts a document seen in both IMS and 2B once, not twice', async () => {
    // A filed invoice appears in the IMS download AND in 2B. Summed naively, the
    // observed tax comes out ~1.8x expected and every supplier looks like they
    // over-reported. The stored total must equal 2B plus the IMS-only remainder.
    const [twoB] = await pool.query(
      `SELECT SUM(CASE WHEN doc_type IN ('CREDIT_NOTE','ISD_CREDIT') THEN -total_tax ELSE total_tax END) AS t
         FROM portal_records
        WHERE org_id = ? AND tax_period = ? AND source = 'GSTR2B' AND supplier_gstin IS NOT NULL`,
      [ORG_ID, PERIOD]
    );
    const [imsOnly] = await pool.query(
      `SELECT SUM(CASE WHEN i.doc_type IN ('CREDIT_NOTE','ISD_CREDIT') THEN -i.total_tax ELSE i.total_tax END) AS t
         FROM portal_records i
        WHERE i.org_id = ? AND i.tax_period = ? AND i.source = 'IMS'
          AND i.supplier_gstin IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM portal_records b
             WHERE b.org_id = i.org_id AND b.source = 'GSTR2B'
               AND b.tax_period = i.tax_period AND b.section = i.section
               AND b.invoice_no_norm = i.invoice_no_norm AND b.invoice_date = i.invoice_date
               AND b.doc_type = i.doc_type AND b.identity_seq = i.identity_seq)`,
      [ORG_ID, PERIOD]
    );
    const [stored] = await pool.query(
      'SELECT SUM(observed_total_tax) AS t FROM supplier_periods WHERE org_id = ? AND tax_period = ?',
      [ORG_ID, PERIOD]
    );

    const expectedSum = Number(twoB[0].t) + Number(imsOnly[0].t ?? 0);
    expect(Number(stored[0].t)).toBe(expectedSum);
    // And the naive double-counted figure is genuinely different, or this proves nothing.
    const [naive] = await pool.query(
      `SELECT SUM(CASE WHEN doc_type IN ('CREDIT_NOTE','ISD_CREDIT') THEN -total_tax ELSE total_tax END) AS t
         FROM portal_records
        WHERE org_id = ? AND tax_period = ? AND supplier_gstin IS NOT NULL`,
      [ORG_ID, PERIOD]
    );
    expect(Number(naive[0].t)).toBeGreaterThan(expectedSum);
  });

  it('serves a supplier period history', async () => {
    const suppliers = await listSuppliers(ORG_ID, { limit: 1 });
    const history = await getSupplierHistory(ORG_ID, suppliers[0].gstin);
    expect(history.gstin).toBe(suppliers[0].gstin);
    expect(history.periods.length).toBeGreaterThan(0);
    expect(['MONTHLY', 'QRMP']).toContain(history.filingScheme);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(history.filingSchemeConfidence);
  });
});
