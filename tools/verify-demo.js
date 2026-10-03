// verify-demo.js — the live demo's story, replayed against the app.
//
//   npm run verify:demo
//
// A fresh visitor workspace, driven over HTTP exactly as the Upload screen drives
// it. For August and then September: set the workspace date to each IMS snapshot,
// upload that day's download, reconcile, and check; then GSTR-2B on the 14th.
//
// Two kinds of check, both read from the API the screens use:
//   portal    every document is on the portal side, or not, with the saved/filed
//             status and the tax the timeline (tools/demo-timeline.js) says
//   story     the counts and totals the demo brief promises (STORY below)
//
// Every document's verdict is printed at every step, so a failing check comes
// with what the app showed instead. The workspace is deleted afterwards. Exits
// non-zero if any check fails.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERIODS,
  PERIOD_KEYS,
  REGISTER,
  imsFileName,
  imsSnapshot,
  registerFileName,
  stateOn,
  supplierOf,
  twoBDocuments,
  twoBFileName
} from './demo-timeline.js';

process.env.DEMO_TENANCY = 'on';
process.env.DEMO_SESSION_SECRET ??= `verify-demo-${process.pid}-${Date.now()}`;

const { createApp } = await import('../api/src/app.js');
const { closePool, pool } = await import('../api/src/db/pool.js');
const { describeConnection } = await import('../api/src/config.js');
const { wipeOrgData } = await import('../api/src/services/demoStory.js');
const { formatPaise } = await import('../api/src/matching/recommend.js');

const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo');
const rupees = (paise) => `Rs ${formatPaise(paise)}`;

// --- the story's promises ------------------------------------------------------

// Results are named by invoice number: the books number, or the portal's for a
// document the books do not have.
const STORY = {
  'aug:2026-09-05': [openDecisions(['MS-878'])],
  'aug:2026-09-10': [openDecisions(['MS-878', 'BA/219'])],
  'aug:2026-09-11': [
    openDecisions(['MS-878', 'BA/219', 'NS-612', 'RT-760']),
    notFiledYet([
      { supplier: 'patel', status: 'NOT_REPORTED' },
      { supplier: 'anand', status: 'SAVED_NOT_FILED' },
      { supplier: 'krishna', status: 'NOT_REPORTED', daysToCutOff: 2 }
    ])
  ],
  'aug:2026-09-14': [twoBTotals({ books: 4266000, exact: 1890000, open: 1440000, notFiled: 936000 })],
  'sep:2026-10-05': [nationalSavedInsideFreeFix()],
  'sep:2026-10-10': [nationalMatchedExactly()]
};

const nameOf = (row) => row.books?.invoiceNo ?? row.portal?.invoiceNo;

function openDecisions(expected) {
  return {
    name: `needs a decision: ${expected.length} (${expected.join(', ')})`,
    check: ({ run, results }) => {
      const open = results.filter((row) => row.needsDecision).map(nameOf).sort();
      const pass = run.openDecisions.count === expected.length &&
        JSON.stringify(open) === JSON.stringify([...expected].sort());
      return { pass, actual: `${run.openDecisions.count} (${open.join(', ') || 'none'})` };
    }
  };
}

function notFiledYet(expected) {
  const describe = (entry) =>
    `${supplierOf(entry.supplier).name} ${entry.status}` +
    (entry.daysToCutOff === undefined ? '' : ` ${entry.daysToCutOff}d left`);
  return {
    name: `not filed yet: ${expected.map(describe).join('; ')}`,
    check: ({ alerts }) => {
      const listed = alerts.suppliers.map((entry) => ({
        supplier: entry.gstin,
        statuses: entry.invoices.map((invoice) => invoice.status),
        daysToCutOff: entry.daysToCutOff
      }));
      const pass = listed.length === expected.length && expected.every((entry) => {
        const found = listed.find((row) => row.supplier === supplierOf(entry.supplier).gstin);
        return found && found.statuses.join() === entry.status &&
          (entry.daysToCutOff === undefined || found.daysToCutOff === entry.daysToCutOff);
      });
      const actual = alerts.suppliers
        .map((entry) => `${entry.tradeName} ${entry.invoices.map((i) => i.status).join('+')} ${entry.daysToCutOff}d left`)
        .join('; ');
      return { pass, actual: actual || 'nobody listed' };
    }
  };
}

// The four figures the 2B step shows: the books, what matched exactly (the run's
// claimable), the open mismatches and the typo at their books amount, and what was
// never filed (the run's deferred).
function twoBTotals(expected) {
  return {
    name:
      `2B totals: books ${rupees(expected.books)}, exact ${rupees(expected.exact)}, ` +
      `open ${rupees(expected.open)}, not filed ${rupees(expected.notFiled)}`,
    check: ({ run, results }) => {
      const sum = (rows) => rows.reduce((total, row) => total + row.signedItc, 0);
      const actual = {
        books: sum(results.filter((row) => row.books)),
        exact: run.totals.claimableItc,
        open: sum(results.filter((row) => row.books && ['VALUE_MISMATCH', 'SUGGESTED'].includes(row.bucket))),
        notFiled: run.totals.deferredItc
      };
      const pass = Object.keys(expected).every((key) => actual[key] === expected[key]);
      return {
        pass,
        actual: `books ${rupees(actual.books)}, exact ${rupees(actual.exact)}, open ${rupees(actual.open)}, ` +
          `not filed ${rupees(actual.notFiled)}`
      };
    }
  };
}

function nationalSavedInsideFreeFix() {
  return {
    name: 'National NS-701 saved with a different amount, inside the free-fix window',
    check: ({ results, alerts }) => {
      const row = results.find((entry) => entry.books?.invoiceNo === 'NS-701');
      const alert = alerts.suppliers.find((entry) => entry.gstin === supplierOf('national').gstin);
      const pass = row?.bucket === 'VALUE_MISMATCH' && row.portal?.filingStatus === 'SAVED' &&
        row.recommendedAction === 'CHASE_SUPPLIER' && !row.flags.includes('CUTOFF_PASSED') &&
        alert?.invoices.some((invoice) => invoice.status === 'SAVED_VALUE_MISMATCH') && alert.preCutOff === true;
      return { pass, actual: `${row?.bucket} ${row?.portal?.filingStatus} ${row?.recommendedAction}` };
    }
  };
}

function nationalMatchedExactly() {
  return {
    name: 'National NS-701 matched exactly',
    check: ({ results }) => {
      const row = results.find((entry) => entry.books?.invoiceNo === 'NS-701');
      const pass = row?.bucket === 'MATCHED' && row.portal?.filingStatus === 'FILED' &&
        row.portal.totalTax === row.books.totalTax && row.portal.taxableValue === row.books.taxableValue;
      return { pass, actual: `${row?.bucket} ${row?.portal?.filingStatus}` };
    }
  };
}

// --- the portal side, per document -----------------------------------------------

// What the timeline says the app's portal side holds for each document of the
// period after this step: which documents, in what state.
function expectedPortal(periodKey, date, { twoB = false } = {}) {
  const snapshots = PERIODS[periodKey].snapshots;
  const lastIms = snapshots.filter((day) => day <= date).at(-1);
  const present = new Map(imsSnapshot(periodKey, lastIms).map(({ doc }) => [doc.id, doc]));
  if (twoB) for (const { doc } of twoBDocuments(periodKey)) present.set(doc.id, doc);
  return [...present.values()].map((doc) => ({ doc, state: stateOn(doc, date) }));
}

function portalChecks(periodKey, date, results, options) {
  const checks = [];
  const present = expectedPortal(periodKey, date, options);
  const onPortal = new Set(present.filter(({ doc }) => doc.books?.period === periodKey).map(({ doc }) => doc.books.invoiceNo));

  for (const { doc, state } of present) {
    const own = doc.books?.period === periodKey;
    const row = own
      ? results.find((entry) => entry.books?.invoiceNo === doc.books.invoiceNo)
      : results.find((entry) => entry.portal?.invoiceNo === doc.invoiceNo && entry.portal.supplierGstin === doc.supplier.gstin);
    const where = own ? '' : doc.books ? ` (${doc.books.period} books)` : ' (not in books)';
    const pass = row?.portal?.invoiceNo === doc.invoiceNo && row.portal.filingStatus === state.status &&
      row.portal.totalTax === state.amounts.totalTax;
    checks.push({
      kind: 'portal',
      name: `${doc.supplier.name} ${doc.invoiceNo}${where}: ${state.status} ${rupees(state.amounts.totalTax)}`,
      pass,
      actual: row?.portal
        ? `${row.portal.invoiceNo} ${row.portal.filingStatus} ${rupees(row.portal.totalTax)}`
        : row ? 'no portal side' : 'not shown in this period'
    });
  }

  for (const doc of REGISTER[periodKey].filter((entry) => !onPortal.has(entry.invoiceNo))) {
    const row = results.find((entry) => entry.books?.invoiceNo === doc.invoiceNo);
    checks.push({
      kind: 'portal',
      name: `${doc.supplier.name} ${doc.invoiceNo}: not on the portal`,
      pass: Boolean(row) && row.portal === null,
      actual: row?.portal ? `${row.portal.invoiceNo} ${row.portal.filingStatus}` : row ? 'not on the portal' : 'no result'
    });
  }
  return checks;
}

// --- a browser ---------------------------------------------------------------------

function browser(base) {
  let cookie = null;

  async function send(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${base}${path}`, { ...options, headers });
    for (const raw of res.headers.getSetCookie?.() ?? []) cookie = raw.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const json = (method, path, payload) =>
    send(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });

  async function upload(kind, path) {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', new Blob([readFileSync(path)]), basename(path));
    return send('/api/uploads', { method: 'POST', body: form });
  }

  async function must(promise, what) {
    const res = await promise;
    if (res.status >= 300) throw new Error(`${what}: ${res.status} ${res.body?.message ?? ''}`);
    return res.body;
  }

  async function ingest(kind, path) {
    const created = await must(upload(kind, path), `upload ${basename(path)}`);
    return must(json('POST', `/api/uploads/${created.upload.id}/commit`), `commit ${basename(path)}`);
  }

  return { send, json, upload, ingest, must };
}

// --- one step ------------------------------------------------------------------------

async function snapshotOf(client, taxPeriod) {
  const { run } = await client.must(client.send(`/api/runs?taxPeriod=${taxPeriod}`), 'read run');
  const { results } = await client.must(client.send(`/api/runs/${run.id}/results?pageSize=500`), 'read results');
  const { alerts } = await client.must(client.send(`/api/alerts?taxPeriod=${taxPeriod}`), 'read alerts');
  return { run, results, alerts };
}

function printRows({ run, results }) {
  console.log(
    `  run as of ${run.asOfDate}: claimable ${rupees(run.totals.claimableItc)}, at risk ` +
      `${rupees(run.totals.atRiskItc)}, deferred ${rupees(run.totals.deferredItc)}; ` +
      `${run.openDecisions.count} need a decision`
  );
  const rows = [...results].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const row of rows) {
    const portal = row.portal ? `${row.portal.invoiceNo} ${row.portal.filingStatus}` : '-';
    console.log(
      `    ${nameOf(row).padEnd(9)} ${(row.books?.supplierName ?? row.portal?.supplierName ?? '').padEnd(20)} ` +
        `${row.bucket.padEnd(18)} ${String(row.recommendedAction).padEnd(15)} portal ${portal.padEnd(16)}` +
        `${row.needsDecision ? ' needs a decision' : ''}`
    );
  }
}

async function step(client, { periodKey, date, label, upload, twoB = false }) {
  const taxPeriod = PERIODS[periodKey].taxPeriod;
  await client.must(client.json('PUT', '/api/workspace/clock', { asOfDate: date }), `set the date to ${date}`);
  await client.ingest(upload.kind, upload.path);
  await client.must(client.json('POST', '/api/runs', { taxPeriod }), `reconcile ${taxPeriod}`);

  const view = await snapshotOf(client, taxPeriod);
  console.log(`\n${periodKey}  ${label}  ${basename(upload.path)}`);
  printRows(view);

  const checks = [
    ...portalChecks(periodKey, date, view.results, { twoB }),
    ...(STORY[`${periodKey}:${date}`] ?? []).map((entry) => ({ kind: 'story', name: entry.name, ...entry.check(view) }))
  ];
  for (const check of checks.filter((entry) => entry.kind === 'story' || !entry.pass)) {
    console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.kind.padEnd(6)} ${check.name}${check.pass ? '' : `\n          app: ${check.actual}`}`);
  }
  const portalPassed = checks.filter((entry) => entry.kind === 'portal' && entry.pass).length;
  console.log(`  ${portalPassed}/${checks.filter((entry) => entry.kind === 'portal').length} documents on the portal side as the timeline says`);
  return checks.map((check) => ({ ...check, step: `${periodKey} ${label}` }));
}

const display = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;
};

async function playMonth(client, periodKey) {
  const period = PERIODS[periodKey];
  const dir = join(DEMO_DIR, periodKey);
  const checks = [];

  await client.must(client.json('PUT', '/api/workspace/clock', { asOfDate: period.snapshots[0] }), 'set the date');
  await client.ingest('PURCHASE_REGISTER', join(dir, registerFileName(periodKey)));

  if (periodKey === 'aug') {
    // The trader knows Krishna files quarterly; nothing in August's data can show it.
    await client.must(
      client.json('PUT', `/api/suppliers/${supplierOf('krishna').gstin}/filing-scheme`, { scheme: 'QRMP' }),
      'mark Krishna quarterly'
    );
    // GSTR-2B does not exist yet on the 5th.
    const early = await client.upload('GSTR2B', join(dir, twoBFileName(periodKey)));
    checks.push({
      step: `${periodKey} ${display(period.snapshots[0])}`,
      kind: 'rule',
      name: 'GSTR-2B refused before the 14th',
      pass: early.status === 409 && early.body?.error === 'gstr2b_not_generated',
      actual: `${early.status} ${early.body?.error ?? ''}`
    });
    console.log(`\n${periodKey}  GSTR-2B on ${display(period.snapshots[0])}: ${early.status} ${early.body?.message ?? ''}`);
  }

  for (const date of period.snapshots) {
    checks.push(...(await step(client, {
      periodKey, date, label: display(date),
      upload: { kind: 'IMS', path: join(dir, imsFileName(periodKey, date)) }
    })));
  }
  checks.push(...(await step(client, {
    periodKey, date: period.twoBOn, label: `${display(period.twoBOn)} GSTR-2B`, twoB: true,
    upload: { kind: 'GSTR2B', path: join(dir, twoBFileName(periodKey)) }
  })));
  return checks;
}

// --- main ------------------------------------------------------------------------------

async function main() {
  console.log('ITC Guard — the demo story, replayed');
  console.log(`database ${describeConnection()}`);

  const server = await new Promise((resolve) => {
    const listening = createApp({ pingDb: async () => true }).listen(0, () => resolve(listening));
  });
  const client = browser(`http://127.0.0.1:${server.address().port}`);
  let orgId = null;

  try {
    const { session } = await client.must(client.send('/api/session'), 'open a workspace');
    orgId = session.orgId;
    const uploads = (await client.must(client.send('/api/uploads'), 'list uploads')).uploads;
    const runs = (await client.must(client.send('/api/runs'), 'list runs')).runs;
    const checks = [{
      step: 'start',
      kind: 'rule',
      name: 'a new visitor starts with an empty workspace',
      pass: session.isNew && !uploads.length && !runs.length,
      actual: `${uploads.length} uploads, ${runs.length} runs`
    }];
    console.log(`workspace ${orgId}: ${uploads.length} uploads, ${runs.length} runs`);

    for (const periodKey of PERIOD_KEYS) checks.push(...(await playMonth(client, periodKey)));

    // August as it reads once September's data is in, for the record.
    console.log('\naug  re-read at the last workspace date');
    printRows(await snapshotOf(client, PERIODS.aug.taxPeriod));

    const failed = checks.filter((check) => !check.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks pass`);
    for (const check of failed) {
      console.log(`  FAIL  ${check.step}  ${check.kind}  ${check.name}\n        app: ${check.actual}`);
    }
    console.log(failed.length ? '\nSOME CHECKS FAIL' : '\nALL CHECKS PASS');
    return failed.length === 0;
  } finally {
    if (orgId) {
      await wipeOrgData(orgId);
      await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [orgId]);
    }
    await new Promise((resolve) => server.close(resolve));
  }
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
