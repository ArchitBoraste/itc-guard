// Accuracy harness: run the engine over the fixture periods and score the
// predicted bucket against ground truth.
//
// Shared by test/matching/accuracy.test.js and tools/sweep-weights.js so there is
// exactly one definition of the metric.
//
// The engine never sees a ground-truth field. Alignment below keys on document
// IDENTITY only (supplier, number, date, amount) — never on docId, defect or
// expectedBucket. If the matcher could see a label the metric would be worthless.
import { parse as parseRegister } from '../../src/adapters/purchaseRegister.js';
import { parse as parseIms } from '../../src/adapters/ims.js';
import { parse as parse2b } from '../../src/adapters/gstr2b.js';
import { BUCKETS } from '../../src/matching/buckets.js';
import { reconcile } from '../../src/matching/index.js';
import { PERIODS, groundTruth, readBuffer, readJson } from './fixtures.js';

export const BUCKET_LIST = Object.values(BUCKETS);
export const UNPREDICTED = 'UNPREDICTED';

export function loadPeriod(period) {
  return {
    period,
    expected: parseRegister(readBuffer(period, 'purchase_register.xlsx')),
    portal: [
      ...parseIms(readJson(period, 'ims.json')),
      ...parse2b(readJson(period, 'gstr2b.json'))
    ],
    truth: groundTruth(period)
  };
}

// --- alignment -------------------------------------------------------------

function booksKey(gstin, invoiceNo, invoiceDate, taxablePaise) {
  return `B|${gstin}|${invoiceNo}|${invoiceDate}|${taxablePaise}`;
}

// Every key a ground-truth document could be found under.
function truthKeys(doc) {
  const keys = [];
  if (doc.books) {
    keys.push(
      booksKey(
        doc.books.supplierGstin,
        doc.books.invoiceNo,
        doc.books.invoiceDate,
        doc.books.taxablePaise
      )
    );
  }
  if (doc.portal) {
    if (doc.portal.portCode) {
      keys.push(`P|IMP|${doc.portal.portCode}|${doc.portal.boeNum}|${doc.portal.boeDate}`);
    }
    if (doc.portal.contentHash) keys.push(`P|H|${doc.portal.contentHash}`);
    keys.push(
      `P|X|${doc.portal.supplierGstin}|${doc.portal.invoiceNo}|${doc.portal.invoiceDate}`
    );
  }
  return keys;
}

// Candidate keys for a result, most specific first.
function resultKeys(result) {
  if (result.expected) {
    const e = result.expected;
    return [booksKey(e.supplierGstin, e.invoiceNo, e.invoiceDate, e.taxableValue)];
  }
  const p = result.portal;
  if (!p) return [];
  const keys = [];
  if (p.portCode) keys.push(`P|IMP|${p.portCode}|${p.invoiceNo}|${p.invoiceDate}`);
  if (p.contentHash) keys.push(`P|H|${p.contentHash}`);
  keys.push(`P|X|${p.supplierGstin}|${p.invoiceNo}|${p.invoiceDate}`);
  return keys;
}

// alignPeriod(results, truth) -> { rows, spurious }
//   rows: one per ground-truth document, with the predicted bucket (or
//         UNPREDICTED when the engine produced no result for it at all)
export function alignPeriod(results, truth) {
  const byKey = new Map();
  for (const doc of truth.documents) {
    for (const key of truthKeys(doc)) {
      if (!byKey.has(key)) byKey.set(key, doc);
    }
  }

  const predictionFor = new Map(); // docId -> result
  const spurious = [];

  for (const result of results) {
    let doc = null;
    for (const key of resultKeys(result)) {
      const candidate = byKey.get(key);
      if (candidate && !predictionFor.has(candidate.docId)) {
        doc = candidate;
        break;
      }
      if (candidate && !doc) doc = candidate;
    }
    if (!doc) {
      spurious.push(result);
      continue;
    }
    if (predictionFor.has(doc.docId)) {
      // Two results claiming the same document: a double count, which is a real
      // error rather than something to quietly drop.
      spurious.push(result);
      continue;
    }
    predictionFor.set(doc.docId, result);
  }

  const rows = truth.documents.map((doc) => {
    const result = predictionFor.get(doc.docId) ?? null;
    return {
      docId: doc.docId,
      period: doc.period,
      defect: doc.defect,
      expectedBucket: doc.expectedBucket,
      predictedBucket: result ? result.bucket : UNPREDICTED,
      correct: result ? result.bucket === doc.expectedBucket : false,
      result,
      truth: doc
    };
  });

  return { rows, spurious };
}

// --- metrics ---------------------------------------------------------------

export function confusionMatrix(rows) {
  const matrix = new Map();
  for (const row of rows) {
    if (!matrix.has(row.expectedBucket)) matrix.set(row.expectedBucket, new Map());
    const predicted = matrix.get(row.expectedBucket);
    predicted.set(row.predictedBucket, (predicted.get(row.predictedBucket) ?? 0) + 1);
  }
  return matrix;
}

// Per-bucket precision/recall/F1, plus macro, micro and support-weighted means.
//
// Macro is the headline: it weights a 16-document bucket the same as a
// 2000-document one, so a rare bucket cannot be ignored. Micro equals plain
// accuracy in a single-label problem, which flatters a dataset that is 85% one
// class, so it is reported but not asserted on.
export function metrics(rows) {
  const perBucket = {};
  let correct = 0;

  for (const bucket of BUCKET_LIST) {
    perBucket[bucket] = { support: 0, predicted: 0, tp: 0, fp: 0, fn: 0 };
  }

  for (const row of rows) {
    if (row.correct) correct += 1;
    const expected = perBucket[row.expectedBucket];
    if (expected) expected.support += 1;
    const predicted = perBucket[row.predictedBucket];
    if (predicted) predicted.predicted += 1;

    if (row.expectedBucket === row.predictedBucket) {
      if (expected) expected.tp += 1;
    } else {
      if (expected) expected.fn += 1;
      if (predicted) predicted.fp += 1;
    }
  }

  for (const bucket of BUCKET_LIST) {
    const b = perBucket[bucket];
    b.precision = b.tp + b.fp > 0 ? b.tp / (b.tp + b.fp) : null;
    b.recall = b.support > 0 ? b.tp / b.support : null;
    b.f1 =
      b.precision !== null && b.recall !== null && b.precision + b.recall > 0
        ? (2 * b.precision * b.recall) / (b.precision + b.recall)
        : null;
  }

  // Macro over buckets that actually occur in ground truth. A bucket with
  // support but no predictions scores precision 0, not "excluded" — otherwise
  // never predicting a hard class would look like a perfect score.
  const present = BUCKET_LIST.filter((b) => perBucket[b].support > 0);
  const mean = (values) => (values.length ? values.reduce((a, x) => a + x, 0) / values.length : 0);

  const macro = {
    precision: mean(present.map((b) => perBucket[b].precision ?? 0)),
    recall: mean(present.map((b) => perBucket[b].recall ?? 0)),
    f1: mean(present.map((b) => perBucket[b].f1 ?? 0))
  };

  const totalSupport = present.reduce((n, b) => n + perBucket[b].support, 0);
  const weighted = {
    precision:
      present.reduce((n, b) => n + (perBucket[b].precision ?? 0) * perBucket[b].support, 0) /
      (totalSupport || 1),
    recall:
      present.reduce((n, b) => n + (perBucket[b].recall ?? 0) * perBucket[b].support, 0) /
      (totalSupport || 1),
    f1:
      present.reduce((n, b) => n + (perBucket[b].f1 ?? 0) * perBucket[b].support, 0) /
      (totalSupport || 1)
  };

  const accuracy = rows.length ? correct / rows.length : 0;

  return {
    total: rows.length,
    correct,
    accuracy,
    perBucket,
    macro,
    micro: { precision: accuracy, recall: accuracy, f1: accuracy },
    weighted
  };
}

// Per-defect scoring. A defect type maps to exactly one expected bucket, so what
// is meaningful here is recall (did we classify these correctly). Precision is not
// defined per defect: predictions carry no defect label, and the engine never sees
// one.
export function perDefect(rows) {
  const out = {};
  for (const row of rows) {
    const entry = (out[row.defect] ??= {
      n: 0,
      correct: 0,
      expectedBucket: row.expectedBucket,
      predicted: {}
    });
    entry.n += 1;
    if (row.correct) entry.correct += 1;
    entry.predicted[row.predictedBucket] = (entry.predicted[row.predictedBucket] ?? 0) + 1;
  }
  for (const entry of Object.values(out)) entry.recall = entry.n ? entry.correct / entry.n : 0;
  return out;
}

// --- full run --------------------------------------------------------------

// evaluate(options) -> { rows, byPeriod, metrics, perDefect, confusion, spurious }
// options are passed straight through to reconcile(), which is how the sweep tool
// tries alternative weights and thresholds.
export function evaluate(options = {}, periods = PERIODS) {
  const allRows = [];
  const byPeriod = {};
  const spurious = [];

  for (const period of periods) {
    const { expected, portal, truth } = loadPeriod(period);
    const results = reconcile(expected, portal, { ...options, taxPeriod: period });
    const aligned = alignPeriod(results, truth);
    allRows.push(...aligned.rows);
    spurious.push(...aligned.spurious.map((r) => ({ period, result: r })));
    byPeriod[period] = {
      metrics: metrics(aligned.rows),
      resultCount: results.length,
      documentCount: truth.documents.length
    };
  }

  return {
    rows: allRows,
    byPeriod,
    metrics: metrics(allRows),
    perDefect: perDefect(allRows),
    confusion: confusionMatrix(allRows),
    spurious
  };
}

// --- reporting -------------------------------------------------------------

const pct = (value) => (value === null ? '    -  ' : `${(value * 100).toFixed(2)}%`.padStart(7));

export function formatConfusionMatrix(confusion) {
  const columns = [...BUCKET_LIST, UNPREDICTED];
  const used = columns.filter((c) =>
    [...confusion.values()].some((row) => (row.get(c) ?? 0) > 0)
  );
  const short = (name) => name.replace(/_/g, ' ').split(' ').map((w) => w.slice(0, 4)).join('.');

  const lines = [];
  const header = `${'expected \\ predicted'.padEnd(20)}${used.map((c) => short(c).padStart(11)).join('')}`;
  lines.push(header);
  lines.push('-'.repeat(header.length));
  for (const bucket of BUCKET_LIST) {
    const row = confusion.get(bucket);
    if (!row) continue;
    const cells = used.map((c) => {
      const n = row.get(c) ?? 0;
      return (n === 0 ? '.' : String(n)).padStart(11);
    });
    lines.push(`${bucket.padEnd(20)}${cells.join('')}`);
  }
  lines.push('');
  lines.push(`columns: ${used.map((c) => `${short(c)}=${c}`).join('  ')}`);
  return lines.join('\n');
}

export function formatMetricsTable(m) {
  const lines = [];
  lines.push(
    `${'bucket'.padEnd(20)}${'support'.padStart(8)}${'pred'.padStart(7)}` +
      `${'precision'.padStart(11)}${'recall'.padStart(9)}${'F1'.padStart(9)}`
  );
  lines.push('-'.repeat(64));
  for (const bucket of BUCKET_LIST) {
    const b = m.perBucket[bucket];
    if (b.support === 0 && b.predicted === 0) continue;
    lines.push(
      `${bucket.padEnd(20)}${String(b.support).padStart(8)}${String(b.predicted).padStart(7)}` +
        `${pct(b.precision).padStart(11)}${pct(b.recall).padStart(9)}${pct(b.f1).padStart(9)}`
    );
  }
  lines.push('-'.repeat(64));
  for (const [name, value] of [['macro', m.macro], ['weighted', m.weighted], ['micro', m.micro]]) {
    lines.push(
      `${name.padEnd(20)}${''.padStart(8)}${''.padStart(7)}` +
        `${pct(value.precision).padStart(11)}${pct(value.recall).padStart(9)}${pct(value.f1).padStart(9)}`
    );
  }
  return lines.join('\n');
}

export function formatPerDefect(defects) {
  const lines = [];
  lines.push(
    `${'defect'.padEnd(22)}${'n'.padStart(6)}${'correct'.padStart(9)}${'recall'.padStart(9)}` +
      '   expected bucket        (mispredictions)'
  );
  lines.push('-'.repeat(100));
  for (const name of Object.keys(defects).sort()) {
    const d = defects[name];
    const wrong = Object.entries(d.predicted)
      .filter(([bucket]) => bucket !== d.expectedBucket)
      .map(([bucket, n]) => `${bucket}:${n}`)
      .join(' ');
    lines.push(
      `${name.padEnd(22)}${String(d.n).padStart(6)}${String(d.correct).padStart(9)}` +
        `${pct(d.recall).padStart(9)}   ${d.expectedBucket.padEnd(20)} ${wrong}`
    );
  }
  return lines.join('\n');
}

export function formatByPeriod(byPeriod) {
  const lines = [];
  lines.push(
    `${'period'.padEnd(10)}${'docs'.padStart(7)}${'results'.padStart(9)}${'accuracy'.padStart(10)}` +
      `${'macro P'.padStart(10)}${'macro R'.padStart(10)}${'macro F1'.padStart(10)}`
  );
  lines.push('-'.repeat(66));
  for (const [period, entry] of Object.entries(byPeriod)) {
    const m = entry.metrics;
    lines.push(
      `${period.padEnd(10)}${String(entry.documentCount).padStart(7)}` +
        `${String(entry.resultCount).padStart(9)}${pct(m.accuracy).padStart(10)}` +
        `${pct(m.macro.precision).padStart(10)}${pct(m.macro.recall).padStart(10)}` +
        `${pct(m.macro.f1).padStart(10)}`
    );
  }
  return lines.join('\n');
}
