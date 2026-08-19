// End-to-end matching accuracy against fixtures/ground_truth.json.
//
// The engine is scored on the bucket it predicts for every one of the ~2,460
// ground-truth documents across all six fixture periods. It never sees docId,
// defect or expectedBucket — alignment keys on document identity only, so the
// number below measures matching, not label leakage.
//
// Assertions are on the AGGREGATE macro precision and recall. Macro weights a
// 16-document bucket the same as a 2,000-document one; micro (plain accuracy)
// would be flattered by the 85% of documents that are clean matches.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUCKET_LIST,
  UNPREDICTED,
  evaluate,
  formatByPeriod,
  formatConfusionMatrix,
  formatMetricsTable,
  formatPerDefect
} from '../helpers/accuracy.js';
import { FIXTURES_PRESENT, PERIODS } from '../helpers/fixtures.js';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from '../../src/matching/score.js';

const GATE_PRECISION = 0.95;
const GATE_RECALL = 0.9;

const describeFixtures = FIXTURES_PRESENT ? describe : describe.skip;

describeFixtures('matching accuracy vs ground truth', () => {
  let run;

  beforeAll(() => {
    run = evaluate();

    // The report is the deliverable of this test as much as the assertions are.
    const m = run.metrics;
    const lines = [
      '',
      '='.repeat(100),
      'ITC GUARD — MATCHING ACCURACY',
      '='.repeat(100),
      `weights:    ${JSON.stringify(DEFAULT_WEIGHTS)}`,
      `thresholds: ${JSON.stringify(DEFAULT_THRESHOLDS)}`,
      `documents:  ${m.total} across ${PERIODS.length} periods`,
      '',
      '--- per period ---',
      formatByPeriod(run.byPeriod),
      '',
      '--- per bucket (aggregated over all periods) ---',
      formatMetricsTable(m),
      '',
      '--- per defect type ---',
      formatPerDefect(run.perDefect),
      '',
      '--- confusion matrix ---',
      formatConfusionMatrix(run.confusion),
      '',
      `gates: macro precision >= ${GATE_PRECISION} · macro recall >= ${GATE_RECALL}`,
      `result: precision ${(m.macro.precision * 100).toFixed(2)}%  ` +
        `recall ${(m.macro.recall * 100).toFixed(2)}%  f1 ${(m.macro.f1 * 100).toFixed(2)}%`,
      `unaligned (double-counted) results: ${run.spurious.length}`,
      '='.repeat(100),
      ''
    ];
    console.log(lines.join('\n'));
  });

  // --- the gates ----------------------------------------------------------

  it(`aggregate macro precision >= ${GATE_PRECISION}`, () => {
    expect(run.metrics.macro.precision).toBeGreaterThanOrEqual(GATE_PRECISION);
  });

  it(`aggregate macro recall >= ${GATE_RECALL}`, () => {
    expect(run.metrics.macro.recall).toBeGreaterThanOrEqual(GATE_RECALL);
  });

  // --- structural guards: stop the gates being satisfied the wrong way -----

  it('scores every ground-truth document exactly once', () => {
    const expectedTotal = PERIODS.reduce(
      (n, period) => n + run.byPeriod[period].documentCount,
      0
    );
    expect(run.metrics.total).toBe(expectedTotal);
    expect(new Set(run.rows.map((r) => r.docId)).size).toBe(expectedTotal);
  });

  it('predicts every bucket that occurs in ground truth', () => {
    // A classifier that simply never emits a rare bucket would still post a
    // respectable micro score; macro catches it, and so does this.
    for (const bucket of BUCKET_LIST) {
      const b = run.metrics.perBucket[bucket];
      if (b.support === 0) continue;
      expect(b.predicted, `${bucket} was never predicted`).toBeGreaterThan(0);
      expect(b.tp, `${bucket} was never predicted correctly`).toBeGreaterThan(0);
    }
  });

  it('leaves almost no document unpredicted', () => {
    const unpredicted = run.rows.filter((r) => r.predictedBucket === UNPREDICTED);
    // An unpredicted document means the engine split one document into two
    // one-sided results. Allowed to be rare, never routine.
    expect(unpredicted.length / run.metrics.total).toBeLessThan(0.01);
  });

  it('holds up in every individual period, not just in aggregate', () => {
    for (const period of PERIODS) {
      const m = run.byPeriod[period].metrics;
      expect(m.macro.precision, `${period} precision`).toBeGreaterThanOrEqual(GATE_PRECISION);
      expect(m.macro.recall, `${period} recall`).toBeGreaterThanOrEqual(GATE_RECALL);
    }
  });

  // --- per-defect expectations the build spec calls out -------------------

  it('resolves duplicated invoice numbers instead of giving up on them', () => {
    // Same (supplier, invoice number), different date or amount. One-to-one
    // assignment has to pick the right partner for each; both belong in MATCHED.
    const duplicates = run.rows.filter((r) => r.defect === 'DUPLICATE_INV_NO');
    expect(duplicates.length).toBeGreaterThan(0);
    expect(run.perDefect.DUPLICATE_INV_NO.recall).toBe(1);
    for (const row of duplicates) expect(row.predictedBucket).toBe('MATCHED');
  });

  it('recovers a typo’d GSTIN through the fallback blocking pass', () => {
    const typos = run.rows.filter((r) => r.defect === 'GSTIN_TYPO');
    expect(typos.length).toBeGreaterThan(0);
    for (const row of typos) {
      expect(row.predictedBucket).toBe('MATCHED');
      // and it must be visibly flagged, not silently absorbed
      expect(row.result.flags).toContain('GSTIN_MISMATCH');
    }
  });

  it('keeps ISD, imports and RCM out of the exception list', () => {
    // These exist in 2B and never in IMS. Surfacing them as unmatched would bury
    // the exceptions that actually need action.
    const nonIms = run.rows.filter((r) => ['ISD', 'IMPG', 'IMPGSEZ', 'RCM'].includes(r.defect));
    expect(nonIms.length).toBeGreaterThan(0);
    for (const row of nonIms) {
      expect(row.predictedBucket).toBe('NON_IMS');
      expect(row.result.recommendedAction).toBe('NO_ACTION');
    }
  });

  it('absorbs normalisation-only invoice-number drift as a clean match', () => {
    const drift = run.rows.filter((r) => r.defect === 'INV_NO_DRIFT');
    expect(drift.length).toBeGreaterThan(0);
    expect(run.perDefect.INV_NO_DRIFT.recall).toBe(1);
  });

  it('sends a residual invoice-number difference to a human, not to ACCEPT', () => {
    const fuzzy = run.rows.filter((r) => r.defect === 'MODERATE_INV_NO');
    expect(fuzzy.length).toBeGreaterThan(0);
    for (const row of fuzzy) {
      expect(row.predictedBucket).toBe('SUGGESTED');
      expect(row.result.recommendedAction).toBe('VERIFY');
      expect(row.result.requiresConfirmation).toBe(true);
    }
  });

  it('catches every value transposition as a money difference', () => {
    const transposed = run.rows.filter((r) => r.defect === 'VALUE_TRANSPOSITION');
    expect(transposed.length).toBeGreaterThan(0);
    expect(run.perDefect.VALUE_TRANSPOSITION.recall).toBeGreaterThanOrEqual(0.95);
    for (const row of transposed.filter((r) => r.correct)) {
      expect(row.result.deltaTotalTax).not.toBe(0);
      expect(row.result.itcAtRisk).toBeGreaterThan(0);
    }
  });

  it('never recommends ACCEPT on a bucket that needs a human', () => {
    const needsHuman = new Set(['SUGGESTED', 'MISSING_IN_BOOKS', 'VALUE_MISMATCH']);
    for (const row of run.rows) {
      if (!row.result || !needsHuman.has(row.result.bucket)) continue;
      expect(row.result.recommendedAction).not.toBe('ACCEPT');
    }
  });

  it('never recommends REJECT without demanding confirmation', () => {
    // A wrong reject costs the trader a month of credit and raises the supplier's
    // liability, so nothing may be auto-applied.
    const rejects = run.rows.filter((r) => r.result?.recommendedAction === 'REJECT');
    for (const row of rejects) expect(row.result.requiresConfirmation).toBe(true);
  });

  it('never emits an IMS action or remark that the portal would refuse', () => {
    for (const row of run.rows) {
      const result = row.result;
      if (!result?.portal) continue;
      if (result.portal.pendingBlocked) expect(result.imsActionCode).not.toBe('P');
      if (result.portal.remarksBlocked) expect(result.remarks).toBeNull();
      if (result.remarks) {
        expect(['R', 'P']).toContain(result.imsActionCode);
        expect(result.remarks.length).toBeLessThanOrEqual(250);
      }
    }
  });

  it('persists a score breakdown for every matched pair', () => {
    // The UI has to be able to show WHY something matched.
    const paired = run.rows.filter((r) => r.result?.expected && r.result?.portal);
    expect(paired.length).toBeGreaterThan(0);
    for (const row of paired) {
      const breakdown = row.result.scoreBreakdown;
      expect(breakdown).toBeTruthy();
      for (const key of ['invoiceNo', 'taxableValue', 'totalTax', 'invoiceDate', 'gstin']) {
        expect(breakdown[key]).toBeTruthy();
        expect(breakdown[key]).toHaveProperty('similarity');
        expect(breakdown[key]).toHaveProperty('weight');
        expect(breakdown[key]).toHaveProperty('rule');
      }
      // Never scored on fields the purchase-register template does not carry.
      expect(Object.keys(breakdown)).not.toContain('placeOfSupply');
      expect(Object.keys(breakdown)).not.toContain('invoiceValue');
    }
  });

  it('is deterministic across runs', () => {
    const again = evaluate();
    expect(again.metrics.macro).toEqual(run.metrics.macro);
    expect(again.rows.map((r) => r.predictedBucket)).toEqual(
      run.rows.map((r) => r.predictedBucket)
    );
  });
});
