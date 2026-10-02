// verify-answer-key.js — the app, checked against the independent audit answer key.
//
//   npm run verify:answer-key
//
// Builds a fresh org the way a visitor's demo copy is built (March and April with
// the scripted Mahavir story, through demoStory), loads the other four fixture
// periods through the same upload path, re-runs every period as of the 16th, and
// compares what the APP stored against docs/audit/answer-key.json.
//
// The expected side is data only: answer-key.json, plus fixtures/*/ground_truth.json
// for the per-document check — answer-key.json carries aggregates, and the ground
// truth is the file it joins every raw record to. Nothing from answer-key.mjs is
// imported, and nothing in the app imports this.
//
// Per period:
//   docs     every ground-truth document lands in its bucket with the right partner
//   totals   the seven run totals equal the key to the paisa
//   identity claimable + at risk + deferred + ineligible = expected; + outside IMS = grand
//   VM recs  each value mismatch's recommendation against the brief (briefAt16)
//   open     the run's open-decision count against the key's real decision count
//   decided  every value mismatch decided as the app recommends: totals move by the
//            accepted amount only (an accepted invoice claims min(books, portal), an
//            accepted credit note reverses max(books, portal)) and open decisions
//            fall by the mismatches decided
//
// Exits non-zero if anything fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, describeConnection } from '../api/src/config.js';
import { closePool, pool } from '../api/src/db/pool.js';
import { ensureOrg, seedDemoPeriod } from '../api/src/services/demo.js';
import { STORY_PERIODS, rupees, seedDemoStory } from '../api/src/services/demoStory.js';
import { confirmResult, createRun, getRun } from '../api/src/services/reconcile.js';
import { rebuildSupplierStats } from '../api/src/services/supplierRisk.js';
import { TEST_ORGS } from '../api/test/helpers/db.js';

const ORG_ID = TEST_ORGS.answerKey;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(REPO_ROOT, 'docs', 'audit', 'answer-key.json');
const KEY = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
const PERIODS = Object.keys(KEY.periods).sort();

// The brief's verdict, in the app's recommendation vocabulary.
const BRIEF_ACTION = {
  'ACCEPT+CHASE_DIFFERENCE': 'ACCEPT',
  REJECT: 'REJECT',
  CHASE_SUPPLIER: 'CHASE_SUPPLIER'
};

// Recommendations that are an IMS decision when confirmed. Anything else is a
// workflow state and is left open.
const DECIDES = new Set(['ACCEPT', 'REJECT', 'PENDING']);

const TOTALS = [
  ['expected', 'expectedTotalItc'],
  ['claimable', 'claimableItc'],
  ['atRisk', 'atRiskItc'],
  ['deferred', 'deferredItc'],
  ['ineligible', 'ineligibleItc'],
  ['nonIms', 'nonImsItc'],
  ['grand', 'grandTotalItc']
];

// --- expected side ----------------------------------------------------------

function groundTruth(period) {
  const path = join(config.fixturesDir, period, 'ground_truth.json');
  const docs = JSON.parse(readFileSync(path, 'utf8')).documents;
  // The scripted story revises one April invoice after it was accepted. The key
  // carries the revised amounts; the ground truth file predates the revision.
  if (period !== KEY.story.period) return docs;
  return docs.map((doc) =>
    doc.docId === KEY.story.docId
      ? {
          ...doc,
          expectedBucket: 'VALUE_MISMATCH',
          portal: { ...doc.portal, taxablePaise: KEY.story.revised.taxable }
        }
      : doc
  );
}

const booksKey = (gstin, invoiceNo, date, taxable) => `B|${gstin}|${invoiceNo}|${date}|${taxable}`;

function truthPortalKey(portal) {
  if (portal.portCode) return `I|${portal.portCode}|${portal.boeNum}|${portal.boeDate}`;
  return `P|${portal.supplierGstin}|${portal.invoiceNo}|${portal.invoiceDate}|${portal.taxablePaise ?? 0}`;
}

const truthBooksKey = (doc) =>
  booksKey(doc.books.supplierGstin, doc.books.invoiceNo, doc.books.invoiceDate, doc.books.taxablePaise);

const inPortal = (doc) => doc.presence.inIms || doc.presence.in2b;

const itcSign = (docType) => (docType === 'CREDIT_NOTE' ? -1 : 1);

// What accepting a mismatch is worth: the smaller figure for an invoice or debit
// note, the larger reversal for a credit note.
function acceptedItc(mismatch, docType) {
  const pick = docType === 'CREDIT_NOTE' ? Math.max : Math.min;
  return itcSign(docType) * pick(mismatch.booksTax, mismatch.portalTax);
}

// --- app side ---------------------------------------------------------------

async function loadResults(runId) {
  const [rows] = await pool.query(
    `SELECT mr.id, mr.bucket, mr.recommended_action, mr.confirmed_action,
            ei.supplier_gstin AS b_gstin, ei.invoice_no AS b_no, ei.invoice_date AS b_date,
            ei.taxable_value AS b_taxable,
            pr.supplier_gstin AS p_gstin, pr.invoice_no AS p_no, pr.invoice_date AS p_date,
            pr.taxable_value AS p_taxable, pr.port_code AS p_port, pr.id AS p_id
       FROM match_results mr
       LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
       LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
      WHERE mr.org_id = ? AND mr.run_id = ?`,
    [ORG_ID, runId]
  );
  return rows.map((row) => ({
    ...row,
    booksKey: row.b_no === null ? null : booksKey(row.b_gstin, row.b_no, row.b_date, Number(row.b_taxable)),
    portalKey:
      row.p_id === null
        ? null
        : row.p_port
          ? `I|${row.p_port}|${row.p_no}|${row.p_date}`
          : `P|${row.p_gstin}|${row.p_no}|${row.p_date}|${Number(row.p_taxable)}`
  }));
}

// Builds before batch 1 exposed no open-decision field; the only app-wide count
// was Summary's "N need a decision", which summed every non-MATCHED bucket.
function appOpenDecisions(run) {
  if (run.openDecisions) return run.openDecisions.count;
  return Object.entries(run.bucketCounts)
    .filter(([bucket]) => bucket !== 'MATCHED')
    .reduce((sum, [, n]) => sum + n, 0);
}

// --- checks -----------------------------------------------------------------

function documentFailure(doc, result) {
  if (!result) return 'no result';
  if (result.bucket !== doc.expectedBucket) {
    return `bucket ${result.bucket}, expected ${doc.expectedBucket}`;
  }
  const partner = inPortal(doc) ? truthPortalKey(doc.portal) : null;
  if (doc.books && result.portalKey !== partner) {
    return `paired with ${result.portalKey ?? 'nothing'}, expected ${partner ?? 'nothing'}`;
  }
  return null;
}

function checkDocuments(truth, results) {
  const byBooks = new Map(results.filter((r) => r.booksKey).map((r) => [r.booksKey, r]));
  const byPortal = new Map(results.filter((r) => !r.booksKey).map((r) => [r.portalKey, r]));
  const claimed = new Set();
  const failures = [];

  for (const doc of truth) {
    const result = doc.books ? byBooks.get(truthBooksKey(doc)) : byPortal.get(truthPortalKey(doc.portal));
    if (result) claimed.add(result.id);
    const failure = documentFailure(doc, result);
    if (failure) failures.push(`${doc.docId} ${failure}`);
  }

  const correct = truth.length - failures.length;
  const spurious = results.filter((r) => !claimed.has(r.id)).length;
  if (spurious) failures.push(`${spurious} result(s) belong to no ground-truth document`);
  return { pass: failures.length === 0, correct, total: truth.length, failures };
}

function compareTotals(appTotals, expected) {
  const diffs = TOTALS.filter(([keyName, appName]) => appTotals[appName] !== expected[keyName]).map(
    ([keyName, appName]) => `${keyName} ${rupees(appTotals[appName])} vs key ${rupees(expected[keyName])}`
  );
  return { pass: diffs.length === 0, diffs };
}

function identityHolds(t) {
  return (
    t.claimableItc + t.atRiskItc + t.deferredItc + t.ineligibleItc === t.expectedTotalItc &&
    t.expectedTotalItc + t.nonImsItc === t.grandTotalItc
  );
}

function checkRecommendations(mismatches, resultFor) {
  const failures = [];
  for (const vm of mismatches) {
    const result = resultFor(vm.docId);
    const expected = BRIEF_ACTION[vm.briefAt16];
    if (result?.recommended_action !== expected) {
      failures.push(
        `${vm.supplier} ${vm.invoiceNo} (${vm.direction}, dTax ${rupees(vm.dTax)}): ` +
          `app ${result?.recommended_action ?? 'no result'}, brief ${vm.briefAt16}`
      );
    }
  }
  return { pass: failures.length === 0, agree: mismatches.length - failures.length, total: mismatches.length, failures };
}

// --- the decided state ------------------------------------------------------

async function claimable(runId) {
  return (await getRun(ORG_ID, runId)).totals.claimableItc;
}

// The audit's Task 3 story: the trader overrides Mahavir to Accept. Claimable has
// to rise by the portal's figure — the credit actually on offer — not the books'.
async function storyAcceptDelta(runId, resultFor) {
  const result = resultFor(KEY.story.docId);
  const before = await claimable(runId);
  await confirmResult(ORG_ID, result.id, { confirmedAction: 'ACCEPT' });
  const delta = (await claimable(runId)) - before;
  return { delta, expected: KEY.story.revised.tax, books: KEY.story.books.tax, pass: delta === KEY.story.revised.tax };
}

async function decideMismatches(runId) {
  const [open] = await pool.query(
    `SELECT id, recommended_action FROM match_results
      WHERE org_id = ? AND run_id = ? AND bucket = 'VALUE_MISMATCH' AND confirmed_action IS NULL`,
    [ORG_ID, runId]
  );
  for (const row of open) {
    if (DECIDES.has(row.recommended_action)) {
      await confirmResult(ORG_ID, row.id, { confirmedAction: row.recommended_action });
    }
  }
}

function decidedExpectation(period, key, docTypeOf) {
  const shift = key.valueMismatches
    .filter((vm) => BRIEF_ACTION[vm.briefAt16] === 'ACCEPT')
    .reduce((sum, vm) => sum + acceptedItc(vm, docTypeOf(vm.docId)), 0);
  const decided = key.valueMismatches.filter((vm) => DECIDES.has(BRIEF_ACTION[vm.briefAt16])).length;
  return {
    totals: { ...key.totalsAtRunAsOf, claimable: key.totalsAtRunAsOf.claimable + shift, atRisk: key.totalsAtRunAsOf.atRisk - shift },
    open: key.decisionNeededCount - decided,
    shift
  };
}

// --- main -------------------------------------------------------------------

async function buildOrg() {
  await ensureOrg(ORG_ID);
  await seedDemoStory(ORG_ID);
  for (const period of PERIODS.filter((p) => !STORY_PERIODS.includes(p))) {
    await seedDemoPeriod(ORG_ID, { taxPeriod: period });
  }
  // Every period again, now that all six are loaded: each run's ±1 month candidate
  // window has to see the neighbours the key was computed with.
  const runs = {};
  for (const period of PERIODS) {
    const run = await createRun({ orgId: ORG_ID, taxPeriod: period, mode: 'REACTIVE', asOfDate: KEY.periods[period].runAsOf });
    await rebuildSupplierStats(ORG_ID, period, { runId: run.id });
    runs[period] = run.id;
  }
  return runs;
}

async function verifyPeriod(period, runId) {
  const key = KEY.periods[period];
  const truth = groundTruth(period);
  const truthById = new Map(truth.map((doc) => [doc.docId, doc]));
  const results = await loadResults(runId);
  const byBooks = new Map(results.filter((r) => r.booksKey).map((r) => [r.booksKey, r]));
  const resultFor = (docId) => byBooks.get(truthBooksKey(truthById.get(docId)));
  const run = await getRun(ORG_ID, runId);

  const out = {
    period,
    docs: checkDocuments(truth, results),
    totals: compareTotals(run.totals, key.totalsAtRunAsOf),
    identity: identityHolds(run.totals),
    recs: checkRecommendations(key.valueMismatches, resultFor),
    open: { app: appOpenDecisions(run), key: key.decisionNeededCount }
  };
  out.open.pass = out.open.app === out.open.key;

  if (period === KEY.story.period) out.story = await storyAcceptDelta(runId, resultFor);
  await decideMismatches(runId);

  const expectation = decidedExpectation(period, key, (docId) => truthById.get(docId).docType);
  const decidedRun = await getRun(ORG_ID, runId);
  out.decided = {
    ...compareTotals(decidedRun.totals, expectation.totals),
    identity: identityHolds(decidedRun.totals),
    claimableBefore: run.totals.claimableItc,
    claimableAfter: decidedRun.totals.claimableItc,
    shift: expectation.shift
  };
  out.decidedOpen = { app: appOpenDecisions(decidedRun), expected: expectation.open };
  out.decidedOpen.pass = out.decidedOpen.app === out.decidedOpen.expected;
  return out;
}

const mark = (pass) => (pass ? 'PASS' : 'FAIL');
const cell = (text, width) => String(text).padEnd(width);

function printReport(reports) {
  const columns = [
    ['period', 9], ['docs', 16], ['totals', 8], ['identity', 10], ['VM recs', 14],
    ['open app/key', 18], ['decided totals', 16], ['decided open', 16]
  ];
  console.log(columns.map(([name, width]) => cell(name, width)).join(''));
  console.log('-'.repeat(columns.reduce((n, [, w]) => n + w, 0)));
  for (const r of reports) {
    console.log(
      [
        cell(r.period, 9),
        cell(`${r.docs.correct}/${r.docs.total} ${mark(r.docs.pass)}`, 16),
        cell(mark(r.totals.pass), 8),
        cell(mark(r.identity), 10),
        cell(`${r.recs.agree}/${r.recs.total} ${mark(r.recs.pass)}`, 14),
        cell(`${r.open.app}/${r.open.key} ${mark(r.open.pass)}`, 18),
        cell(mark(r.decided.pass && r.decided.identity), 16),
        cell(`${r.decidedOpen.app}/${r.decidedOpen.expected} ${mark(r.decidedOpen.pass)}`, 16)
      ].join('')
    );
  }

  const docs = reports.reduce((acc, r) => [acc[0] + r.docs.correct, acc[1] + r.docs.total], [0, 0]);
  console.log(`\nall periods: ${docs[0]}/${docs[1]} documents in the right bucket with the right partner`);

  console.log('\nclaimable once every value mismatch is decided as recommended (key -> app):');
  for (const r of reports) {
    console.log(
      `  ${r.period}  ${rupees(r.decided.claimableBefore)} -> ${rupees(r.decided.claimableAfter)}` +
        `  (expected shift ${rupees(r.decided.shift)})`
    );
  }

  const story = reports.find((r) => r.story)?.story;
  if (story) {
    console.log(
      `\nstory ${KEY.story.supplier} ${KEY.story.invoiceNo}: Accept moved claimable by ${rupees(story.delta)}; ` +
        `expected ${rupees(story.expected)} (portal), not ${rupees(story.books)} (books)  ${mark(story.pass)}`
    );
  }

  for (const r of reports) {
    const lines = [
      ...r.docs.failures.slice(0, 5).map((f) => `docs      ${f}`),
      ...r.totals.diffs.map((d) => `totals    ${d}`),
      ...(r.identity ? [] : ['identity  does not hold']),
      ...r.recs.failures.map((f) => `VM rec    ${f}`),
      ...(r.open.pass ? [] : [`open      app ${r.open.app}, key ${r.open.key}`]),
      ...r.decided.diffs.map((d) => `decided   ${d}`),
      ...(r.decided.identity ? [] : ['decided   identity does not hold']),
      ...(r.decidedOpen.pass ? [] : [`decided   open ${r.decidedOpen.app}, expected ${r.decidedOpen.expected}`])
    ];
    if (r.docs.failures.length > 5) lines.splice(5, 0, `docs      ...and ${r.docs.failures.length - 5} more`);
    if (!lines.length) continue;
    console.log(`\n${r.period} failures:`);
    for (const line of lines) console.log(`  ${line}`);
  }
}

function allPass(reports) {
  return reports.every(
    (r) =>
      r.docs.pass && r.totals.pass && r.identity && r.recs.pass && r.open.pass &&
      r.decided.pass && r.decided.identity && r.decidedOpen.pass && (r.story?.pass ?? true)
  );
}

async function main() {
  console.log('ITC Guard — app vs audit answer key');
  console.log(`database ${describeConnection()}  org ${ORG_ID}`);
  console.log(`key ${KEY_PATH}\n`);

  const runs = await buildOrg();
  const reports = [];
  for (const period of PERIODS) reports.push(await verifyPeriod(period, runs[period]));

  printReport(reports);
  const ok = allPass(reports);
  console.log(`\n${ok ? 'ALL CHECKS PASS' : 'SOME CHECKS FAIL'}`);
  return ok;
}

main()
  .then(async (ok) => {
    await closePool();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(`\nfailed: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    await closePool();
    process.exit(2);
  });
