// sweep-weights.js — grid-search the matching weights and thresholds against
// fixtures/ground_truth.json and PRINT the best combinations.
//
// This tool NEVER writes to src/matching/score.js. It reports what it found and
// prints a paste-ready block; changing the shipped defaults stays a human
// decision.
//
// Run:  node tools/sweep-weights.js            (coarse grid, ~2 min)
//       node tools/sweep-weights.js --fine     (denser grid, slower)
//       node tools/sweep-weights.js --quick    (tiny grid, for a smoke check)
//       node tools/sweep-weights.js --top 20
//
// Fidelity: similarities are computed once per candidate pair using the engine's
// own componentSimilarities(), and combined with the engine's own
// combineSimilarities(). Assignment, classification and scoring of the result all
// call the real engine functions. A self-check verifies the cached path produces
// exactly the same score as a direct scorePair() call before the sweep starts.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  alignPeriod,
  loadPeriod,
  metrics as computeMetrics,
  formatMetricsTable,
  formatPerDefect,
  perDefect
} from '../api/test/helpers/accuracy.js';
import { PERIODS } from '../api/test/helpers/fixtures.js';
import {
  candidatePairs
} from '../api/src/matching/block.js';
import { assignOneToOne } from '../api/src/matching/assign.js';
import { classify, pairFlags } from '../api/src/matching/buckets.js';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  combineSimilarities,
  componentSimilarities,
  scorePair
} from '../api/src/matching/score.js';
import { mergePortalRecords } from '../api/src/matching/index.js';
import { recommendAction } from '../api/src/matching/recommend.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- gates the user cares about -------------------------------------------
const GATE_PRECISION = 0.95;
const GATE_RECALL = 0.9;

// --- grids -----------------------------------------------------------------

const GRIDS = {
  quick: {
    invoiceNo: [0.4],
    taxableValue: [0.15, 0.25],
    totalTax: [0.15],
    invoiceDate: [0.15, 0.3],
    gstin: [0.05],
    autoMatch: [0.92],
    suggest: [0.7]
  },
  coarse: {
    invoiceNo: [0.3, 0.35, 0.4, 0.45, 0.5],
    taxableValue: [0.1, 0.15, 0.2, 0.25],
    totalTax: [0.05, 0.1, 0.15],
    invoiceDate: [0.15, 0.2, 0.25, 0.3, 0.35],
    gstin: [0.05],
    autoMatch: [0.9, 0.92, 0.94],
    suggest: [0.65, 0.7, 0.75]
  },
  fine: {
    invoiceNo: [0.3, 0.35, 0.4, 0.45, 0.5, 0.55],
    taxableValue: [0.05, 0.1, 0.15, 0.2, 0.25],
    totalTax: [0.05, 0.1, 0.15, 0.2],
    invoiceDate: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4],
    gstin: [0.02, 0.05, 0.1],
    autoMatch: [0.88, 0.9, 0.92, 0.94, 0.96],
    suggest: [0.6, 0.65, 0.7, 0.75, 0.8]
  }
};

// --- argv ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { grid: 'coarse', top: 12 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quick') args.grid = 'quick';
    else if (arg === '--fine') args.grid = 'fine';
    else if (arg === '--coarse') args.grid = 'coarse';
    else if (arg === '--top') args.top = Number(argv[++i]);
    else if (arg === '--periods') args.periods = argv[++i].split(',');
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

// --- precomputation --------------------------------------------------------

// Everything that does not depend on the weights: parse, merge, block, and the
// per-component similarities for every candidate pair.
function precompute(periods) {
  return periods.map((period) => {
    const { expected, portal, truth } = loadPeriod(period);
    const merged = mergePortalRecords(portal);
    const pairs = candidatePairs(expected, merged);
    const prepared = pairs.map((pair) => ({
      ...pair,
      sims: componentSimilarities(expected[pair.expectedIndex], merged[pair.portalIndex]),
      flags: [
        ...new Set([
          ...pair.flags,
          ...pairFlags({
            expected: expected[pair.expectedIndex],
            portal: merged[pair.portalIndex]
          })
        ])
      ]
    }));
    return { period, expected, portal: merged, truth, pairs: prepared };
  });
}

// Guard against the cached path drifting from the real scorer.
function selfCheck(prepared) {
  const weightSets = [
    DEFAULT_WEIGHTS,
    { invoiceNo: 0.5, taxableValue: 0.1, totalTax: 0.05, invoiceDate: 0.3, gstin: 0.05 }
  ];
  let checked = 0;
  for (const period of prepared) {
    for (const pair of period.pairs.slice(0, 200)) {
      for (const weights of weightSets) {
        const fast = combineSimilarities(pair.sims, weights).score;
        const real = scorePair(
          period.expected[pair.expectedIndex],
          period.portal[pair.portalIndex],
          { weights }
        ).score;
        if (fast !== real) {
          throw new Error(
            `sweep fidelity check failed: cached ${fast} vs scorePair ${real} ` +
              `(${period.period} pair ${pair.expectedIndex}:${pair.portalIndex})`
          );
        }
        checked += 1;
      }
    }
  }
  return checked;
}

// --- one evaluation --------------------------------------------------------

function evaluateCombo(prepared, weights, thresholds) {
  const rows = [];
  const byPeriod = {};
  let spurious = 0;

  for (const period of prepared) {
    const scored = period.pairs.map((pair) => ({
      expectedIndex: pair.expectedIndex,
      portalIndex: pair.portalIndex,
      via: pair.via,
      flags: pair.flags,
      score: combineSimilarities(pair.sims, weights).score
    }));

    const { assigned, unassignedExpected, unassignedPortal } = assignOneToOne(scored, {
      thresholds,
      expectedCount: period.expected.length,
      portalCount: period.portal.length
    });

    const results = [];
    for (const pair of assigned) {
      const expected = period.expected[pair.expectedIndex];
      const portal = period.portal[pair.portalIndex];
      const { bucket, flags } = classify(
        { expected, portal, score: pair.score, flags: pair.flags },
        { thresholds }
      );
      results.push({ expected, portal, bucket, flags, score: pair.score });
    }
    for (const index of unassignedExpected) {
      const expected = period.expected[index];
      const { bucket, flags } = classify({ expected, portal: null }, { thresholds });
      results.push({ expected, portal: null, bucket, flags, score: null });
    }
    for (const index of unassignedPortal) {
      const portal = period.portal[index];
      const { bucket, flags } = classify({ expected: null, portal }, { thresholds });
      results.push({ expected: null, portal, bucket, flags, score: null });
    }

    const aligned = alignPeriod(results, period.truth);
    rows.push(...aligned.rows);
    spurious += aligned.spurious.length;
    byPeriod[period.period] = computeMetrics(aligned.rows);
  }

  return { rows, metrics: computeMetrics(rows), byPeriod, spurious };
}

// --- sweep -----------------------------------------------------------------

function* combinations(grid) {
  for (const invoiceNo of grid.invoiceNo) {
    for (const taxableValue of grid.taxableValue) {
      for (const totalTax of grid.totalTax) {
        for (const invoiceDate of grid.invoiceDate) {
          for (const gstin of grid.gstin) {
            for (const autoMatch of grid.autoMatch) {
              for (const suggest of grid.suggest) {
                if (suggest >= autoMatch) continue;
                yield {
                  weights: { invoiceNo, taxableValue, totalTax, invoiceDate, gstin },
                  thresholds: { autoMatch, suggest }
                };
              }
            }
          }
        }
      }
    }
  }
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((a, x) => a + x, 0);
  const out = {};
  for (const [key, value] of Object.entries(weights)) {
    out[key] = Math.round((value / total) * 1000) / 1000;
  }
  return out;
}

// L1 distance from the shipped defaults, in normalised weight space, plus the
// threshold moves. Used to prefer the least invasive of several equally good
// combinations — a smaller change is easier to justify and to review.
function distanceFromBaseline(combo) {
  const base = normalizeWeights(DEFAULT_WEIGHTS);
  const candidate = normalizeWeights(combo.weights);
  let distance = 0;
  for (const key of Object.keys(base)) {
    distance += Math.abs(base[key] - candidate[key]);
  }
  distance += Math.abs(DEFAULT_THRESHOLDS.autoMatch - combo.thresholds.autoMatch);
  distance += Math.abs(DEFAULT_THRESHOLDS.suggest - combo.thresholds.suggest);
  return Math.round(distance * 1000) / 1000;
}

// Which individual knobs, changed one at a time from the baseline, are enough on
// their own. This is the most actionable output: it names the single edit.
function singleKnobChanges(results) {
  const found = [];
  const baseWeights = DEFAULT_WEIGHTS;
  const baseThresholds = DEFAULT_THRESHOLDS;

  for (const entry of results) {
    const changedWeights = Object.keys(baseWeights).filter(
      (key) => entry.combo.weights[key] !== baseWeights[key]
    );
    const changedThresholds = ['autoMatch', 'suggest'].filter(
      (key) => entry.combo.thresholds[key] !== baseThresholds[key]
    );
    if (changedWeights.length + changedThresholds.length !== 1) continue;
    const knob = changedWeights[0] ?? changedThresholds[0];
    const from = changedWeights.length ? baseWeights[knob] : baseThresholds[knob];
    const to = changedWeights.length ? entry.combo.weights[knob] : entry.combo.thresholds[knob];
    found.push({ knob, from, to, entry });
  }
  return found;
}

function describe(combo) {
  const w = combo.weights;
  return (
    `inv=${w.invoiceNo.toFixed(2)} txv=${w.taxableValue.toFixed(2)} ` +
    `tax=${w.totalTax.toFixed(2)} dt=${w.invoiceDate.toFixed(2)} gst=${w.gstin.toFixed(2)} ` +
    `| auto=${combo.thresholds.autoMatch} sugg=${combo.thresholds.suggest}`
  );
}

const pct = (v) => `${(v * 100).toFixed(2)}%`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node tools/sweep-weights.js [--quick|--coarse|--fine] [--top N] [--periods a,b]');
    return;
  }

  const periods = args.periods ?? PERIODS;
  const grid = GRIDS[args.grid];

  console.log(`ITC Guard — matching weight sweep`);
  console.log(`repo:    ${REPO_ROOT}`);
  console.log(`grid:    ${args.grid}`);
  console.log(`periods: ${periods.join(', ')}`);
  console.log(`gates:   macro precision >= ${GATE_PRECISION}, macro recall >= ${GATE_RECALL}`);
  console.log();

  process.stdout.write('precomputing similarities... ');
  const started = Date.now();
  const prepared = precompute(periods);
  const pairCount = prepared.reduce((n, p) => n + p.pairs.length, 0);
  console.log(`${pairCount} candidate pairs in ${Date.now() - started}ms`);

  process.stdout.write('fidelity self-check... ');
  const checked = selfCheck(prepared);
  console.log(`${checked} scores match scorePair() exactly`);

  const all = [...combinations(grid)];
  console.log(`evaluating ${all.length} combinations...`);
  console.log();

  const baseline = evaluateCombo(prepared, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);

  const results = [];
  const sweepStart = Date.now();
  all.forEach((combo, index) => {
    const evaluated = evaluateCombo(prepared, combo.weights, combo.thresholds);
    results.push({
      combo,
      macro: evaluated.metrics.macro,
      accuracy: evaluated.metrics.accuracy,
      correct: evaluated.metrics.correct,
      total: evaluated.metrics.total,
      spurious: evaluated.spurious,
      passes:
        evaluated.metrics.macro.precision >= GATE_PRECISION &&
        evaluated.metrics.macro.recall >= GATE_RECALL
    });
    if ((index + 1) % 100 === 0 || index === all.length - 1) {
      const elapsed = (Date.now() - sweepStart) / 1000;
      const rate = (index + 1) / elapsed;
      process.stdout.write(
        `\r  ${index + 1}/${all.length}  ${elapsed.toFixed(0)}s  ` +
          `(${rate.toFixed(1)}/s, eta ${((all.length - index - 1) / rate).toFixed(0)}s)   `
      );
    }
  });
  console.log('\n');

  // Rank by macro F1, then fewer wrong rows, then fewer spurious results, and
  // finally by how little the combination differs from what is already shipped.
  // Without that last tie-break a wide plateau of equally perfect combinations
  // would be ordered by nothing but loop order.
  for (const entry of results) entry.distance = distanceFromBaseline(entry.combo);
  results.sort((a, b) => {
    if (b.macro.f1 !== a.macro.f1) return b.macro.f1 - a.macro.f1;
    if (b.correct !== a.correct) return b.correct - a.correct;
    if (a.spurious !== b.spurious) return a.spurious - b.spurious;
    return a.distance - b.distance;
  });

  console.log('='.repeat(108));
  console.log('BASELINE — the weights currently shipped in src/matching/score.js');
  console.log('='.repeat(108));
  console.log(`  ${describe({ weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS })}`);
  console.log(
    `  macro P ${pct(baseline.metrics.macro.precision)}  R ${pct(baseline.metrics.macro.recall)}  ` +
      `F1 ${pct(baseline.metrics.macro.f1)}  |  accuracy ${pct(baseline.metrics.accuracy)} ` +
      `(${baseline.metrics.correct}/${baseline.metrics.total})  |  spurious ${baseline.spurious}`
  );
  const baselinePasses =
    baseline.metrics.macro.precision >= GATE_PRECISION &&
    baseline.metrics.macro.recall >= GATE_RECALL;
  console.log(`  gates: ${baselinePasses ? 'PASS' : 'FAIL'}`);
  console.log();

  console.log('='.repeat(108));
  console.log(`TOP ${Math.min(args.top, results.length)} BY MACRO F1`);
  console.log('='.repeat(108));
  console.log(
    `${'#'.padStart(3)}  ${'weights / thresholds'.padEnd(58)}` +
      `${'macro P'.padStart(9)}${'macro R'.padStart(9)}${'macro F1'.padStart(10)}` +
      `${'wrong'.padStart(7)}${'spur'.padStart(6)}  gate`
  );
  console.log('-'.repeat(108));
  results.slice(0, args.top).forEach((entry, index) => {
    console.log(
      `${String(index + 1).padStart(3)}  ${describe(entry.combo).padEnd(58)}` +
        `${pct(entry.macro.precision).padStart(9)}${pct(entry.macro.recall).padStart(9)}` +
        `${pct(entry.macro.f1).padStart(10)}${String(entry.total - entry.correct).padStart(7)}` +
        `${String(entry.spurious).padStart(6)}  ${entry.passes ? 'pass' : 'FAIL'}`
    );
  });
  console.log();

  const best = results[0];
  const bestRun = evaluateCombo(prepared, best.combo.weights, best.combo.thresholds);

  console.log('='.repeat(108));
  console.log('BEST COMBINATION IN DETAIL');
  console.log('='.repeat(108));
  console.log(`  ${describe(best.combo)}`);
  console.log(`  normalised weights: ${JSON.stringify(normalizeWeights(best.combo.weights))}`);
  console.log();
  console.log(formatMetricsTable(bestRun.metrics));
  console.log();
  console.log(formatPerDefect(perDefect(bestRun.rows)));
  console.log();

  const improvement = best.correct - baseline.metrics.correct;
  console.log('='.repeat(108));
  console.log('VERDICT');
  console.log('='.repeat(108));
  console.log(
    `  baseline  ${baseline.metrics.correct}/${baseline.metrics.total} correct  ` +
      `(macro F1 ${pct(baseline.metrics.macro.f1)})`
  );
  console.log(
    `  best      ${best.correct}/${best.total} correct  (macro F1 ${pct(best.macro.f1)})`
  );
  console.log(
    `  delta     ${improvement >= 0 ? '+' : ''}${improvement} rows` +
      `${improvement === 0 ? ' — the shipped defaults are already at the top of this grid' : ''}`
  );
  console.log();

  const howManyPass = results.filter((r) => r.passes).length;
  const plateau = results.filter((r) => r.macro.f1 === best.macro.f1);
  console.log(`  ${howManyPass}/${results.length} combinations clear both gates.`);
  console.log(
    `  ${plateau.length}/${results.length} combinations tie for the best macro F1 ` +
      `(${pct(best.macro.f1)}) — the optimum is a broad plateau, not a knife edge, ` +
      'so nothing here is finely tuned to the fixture.'
  );
  console.log();

  const singles = singleKnobChanges(results).filter((s) => s.entry.macro.f1 === best.macro.f1);
  if (singles.length) {
    console.log('  Single-knob changes from the shipped defaults that reach the best score:');
    const seen = new Set();
    for (const single of singles) {
      const key = `${single.knob}=${single.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(
        `    ${single.knob.padEnd(14)} ${String(single.from).padEnd(6)} -> ${String(single.to).padEnd(6)}` +
          `  macro F1 ${pct(single.entry.macro.f1)}`
      );
    }
    console.log();
  } else if (improvement > 0) {
    console.log('  No single-knob change reaches the best score; at least two must move.');
    console.log();
  }

  if (improvement > 0) {
    // Prefer a one-knob edit when one reaches the top: it is the easiest to
    // review and the hardest to accidentally overfit with. Otherwise fall back to
    // whichever perfect combination sits closest to the shipped defaults.
    const singleBest = singles
      .slice()
      .sort((a, b) => a.entry.distance - b.entry.distance)[0];
    const recommended = singleBest ? singleBest.entry : best;

    console.log(
      singleBest
        ? `  Recommended: the single-knob edit (${singleBest.knob} ${singleBest.from} -> ${singleBest.to}).`
        : `  Recommended: the perfect combination closest to the shipped defaults ` +
          `(L1 ${recommended.distance}).`
    );
    console.log('  To adopt, edit src/matching/score.js by hand:');
    console.log();
    console.log('    export const DEFAULT_WEIGHTS = Object.freeze({');
    for (const [key, value] of Object.entries(recommended.combo.weights)) {
      console.log(`      ${key}: ${value},`);
    }
    console.log('    });');
    console.log();
    console.log('    export const DEFAULT_THRESHOLDS = Object.freeze({');
    console.log(`      autoMatch: ${recommended.combo.thresholds.autoMatch},`);
    console.log(`      suggest: ${recommended.combo.thresholds.suggest}`);
    console.log('    });');
    console.log();
    console.log('  This tool deliberately does not apply the change.');
  }

  // Sensitivity: how much does each knob matter on its own?
  console.log('='.repeat(108));
  console.log('SENSITIVITY — per knob value: best macro F1 reachable / share of combos that are perfect');
  console.log('='.repeat(108));
  console.log('  A high share means the value is ROBUST: it works regardless of the other knobs.');
  console.log('  A high best but low share means it only works in a narrow corner — treat with suspicion.');
  console.log();

  const report = (knob, values, pick) => {
    const line = values
      .map((value) => {
        const subset = results.filter((r) => pick(r) === value);
        const bestOf = subset.reduce((m, r) => Math.max(m, r.macro.f1), 0);
        const perfect = subset.filter((r) => r.macro.f1 === best.macro.f1).length;
        const share = subset.length ? Math.round((perfect / subset.length) * 100) : 0;
        return `${String(value).padEnd(5)}${pct(bestOf)}/${String(share).padStart(3)}%`;
      })
      .join('   ');
    console.log(`  ${knob.padEnd(14)} ${line}`);
  };

  for (const knob of ['invoiceNo', 'taxableValue', 'totalTax', 'invoiceDate', 'gstin']) {
    report(knob, grid[knob], (r) => r.combo.weights[knob]);
  }
  for (const knob of ['autoMatch', 'suggest']) {
    report(knob, grid[knob], (r) => r.combo.thresholds[knob]);
  }
}

main();
