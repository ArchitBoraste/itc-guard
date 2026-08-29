// The demo state, as a service.
//
// This is `npm run demo:reset` with the CLI taken off it. It used to live only in
// tools/demo-reset.js, which was fine while org 1 was the only org; now every
// visitor gets their own copy of exactly this state, so there can only be one
// implementation of it. tools/demo-reset.js is a thin wrapper over these
// functions and produces the same result it always did.
//
// What it builds, in order:
//
//   1. March and April 2026 loaded and reconciled, through the REAL upload path.
//   2. One clean invoice in April confirmed as Accept — a decision the trader
//      made and would have filed.
//   3. That same invoice then revised downward by the supplier in BOTH the IMS
//      and GSTR-2B downloads, and re-ingested.
//   4. April re-run, which drops the confirmation and flags CONFIRMATION_RESET.
//
// What that produces on screen is the story the product exists to tell: the
// change feed opens with exactly ONE invalidated decision, and the row it names
// is one the trader had already signed off.
//
// Why both sources in step 3: the engine merges the same document seen in IMS and
// 2B into one result, keyed on supplier, number, date, type AND money. Changing
// only IMS un-merges the pair — the books row then matches the untouched 2B
// record and the IMS row becomes MISSING_IN_BOOKS, a DIFFERENT result with a
// different identity, so the confirmation is silently orphaned instead of
// visibly reset and the demo shows nothing. Changing both keeps them merged.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { ServiceError, commitUpload, createUpload } from './ingest.js';
import { confirmResult, getRun, rerunPeriodIfRun } from './reconcile.js';
import { listChangesForRun } from './syncDiff.js';
import { seedDemoPeriod } from './demo.js';

// March gives the period switcher something to switch to, and gives the supplier
// history two points to draw a line between. April is the period the demo opens
// on and the one that carries the invalidated decision.
export const STORY_PERIODS = Object.freeze(['2026-03', '2026-04']);
export const STORY_PERIOD = '2026-04';

const STORY_FILES = Object.freeze(['purchase_register.xlsx', 'ims.json', 'gstr2b.json']);

// The revision the supplier makes: taxable value down by Rs. 5,000, with the tax
// components scaled to match so the record stays internally consistent — a
// mistyped base, which is what a real transposition looks like.
const REDUCE_TAXABLE_BY_PAISE = 500000;

export function rupees(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}Rs. ${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

const fixturePath = (period, name) => join(config.fixturesDir ?? '', period, name);
const readFixture = (period, name) => JSON.parse(readFileSync(fixturePath(period, name), 'utf8'));
const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');

// Checked before anything is wiped. A reset that clears an org and only then
// discovers the fixtures are not mounted leaves the visitor with nothing.
export function requireStoryFixtures() {
  if (!config.fixturesDir) {
    throw new ServiceError(
      'no fixtures directory on disk — run "npm run gen:fixtures" and make sure it is ' +
        'mounted into the api container',
      503,
      'fixtures_missing'
    );
  }
  for (const period of STORY_PERIODS) {
    for (const name of STORY_FILES) {
      const path = fixturePath(period, name);
      if (!existsSync(path)) {
        throw new ServiceError(
          `missing fixture ${path} — run: npm run gen:fixtures`,
          503,
          'fixtures_missing'
        );
      }
    }
  }
}

export function storyFixturesReady() {
  try {
    requireStoryFixtures();
    return true;
  } catch {
    return false;
  }
}

// Child rows first: org FKs are RESTRICT, parent FKs are CASCADE.
//
// Deliberately takes the org id rather than reading it from anywhere. Callers
// that must not wipe an arbitrary org do their own checking — see the reaper's
// assertDemoOrg() and tools/demo-reset.js, which is the sanctioned exception for
// org 1.
export async function wipeOrgData(orgId) {
  const statements = [
    'DELETE FROM match_results WHERE org_id = ?',
    'DELETE FROM runs WHERE org_id = ?',
    'DELETE FROM record_changes WHERE org_id = ?',
    'DELETE FROM supplier_periods WHERE org_id = ?',
    'DELETE FROM supplier_risk WHERE org_id = ?',
    'DELETE FROM suppliers WHERE org_id = ?',
    'DELETE FROM expected_rate_lines WHERE org_id = ?',
    'DELETE FROM expected_invoices WHERE org_id = ?',
    'DELETE FROM portal_rate_lines WHERE org_id = ?',
    'DELETE FROM portal_records WHERE org_id = ?',
    'DELETE FROM uploads WHERE org_id = ?'
  ];
  for (const sql of statements) await pool.query(sql, [orgId]);
}

// The invoice the demo is about.
//
// Chosen from the data rather than hard-coded, because fixtures/ is generated and
// gitignored — a hard-coded invoice number would break the moment anyone runs
// gen:fixtures. The ORDER BY makes the choice deterministic, so the same fixtures
// always produce the same demo, and every visitor's copy tells the same story.
//
// It has to be: clean to start with (MATCHED, so an Accept is the honest
// decision), present in IMS (so there is something to act on), filed (so the
// remedy is a reject rather than a phone call), actionable (no blocked flags),
// and UNIQUE by number within its source — the fixtures contain deliberate
// duplicate invoice numbers, and patching a file by number has to hit exactly one
// record. Largest tax first, so the credit at stake is worth a slide.
async function pickStoryInvoice(orgId, runId) {
  const [rows] = await pool.query(
    `SELECT mr.id AS result_id, pr.id AS portal_id, pr.supplier_gstin, pr.supplier_name,
            pr.invoice_no, pr.invoice_date,
            ei.taxable_value, ei.igst, ei.cgst, ei.sgst, ei.cess, ei.total_tax
       FROM match_results mr
       JOIN portal_records pr ON pr.id = mr.portal_record_id
       JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
      WHERE mr.org_id = ? AND mr.run_id = ? AND mr.bucket = 'MATCHED'
        AND pr.source = 'IMS' AND pr.filing_status = 'FILED' AND pr.section = 'b2b'
        AND pr.pending_blocked = 0 AND pr.remarks_blocked = 0
        AND ei.taxable_value > ?
        AND NOT EXISTS (
              SELECT 1 FROM portal_records q
               WHERE q.org_id = pr.org_id AND q.source = pr.source AND q.id <> pr.id
                 AND q.supplier_gstin = pr.supplier_gstin AND q.invoice_no = pr.invoice_no)
      ORDER BY ei.total_tax DESC, pr.id
      LIMIT 1`,
    [orgId, runId, REDUCE_TAXABLE_BY_PAISE * 2]
  );

  if (!rows.length) {
    throw new Error(
      `no clean, filed, uniquely-numbered IMS invoice in ${STORY_PERIOD} to build the ` +
        'demo around — regenerate the fixtures (npm run gen:fixtures)'
    );
  }
  return rows[0];
}

// Scales every tax component by the same ratio as the taxable value, so the
// record still adds up at the rate it was issued at. The adapters derive
// totalTax from the components, so setting these sets the total.
function revisedAmounts(books) {
  const taxable = Number(books.taxable_value);
  const newTaxable = taxable - REDUCE_TAXABLE_BY_PAISE;
  const factor = newTaxable / taxable;
  const scale = (value) => Math.round(Number(value) * factor);

  const igst = scale(books.igst);
  const cgst = scale(books.cgst);
  const sgst = scale(books.sgst);
  const cess = scale(books.cess);

  return { taxable: newTaxable, igst, cgst, sgst, cess, totalTax: igst + cgst + sgst + cess };
}

const toRupees = (paise) => Number((paise / 100).toFixed(2));

// Rewrites the one record in the IMS download. Returns how many it touched, so a
// silent zero-hit patch cannot produce a demo with no story in it.
function reviseIms(json, { gstin, invoiceNo, amounts }) {
  let touched = 0;
  const out = { imsDetails: {} };
  for (const [section, rows] of Object.entries(json.imsDetails)) {
    out.imsDetails[section] = rows.map((row) => {
      if (row.stin !== gstin || String(row.inum ?? row.nt_num) !== invoiceNo) return row;
      touched += 1;
      return {
        ...row,
        txval: toRupees(amounts.taxable),
        iamt: toRupees(amounts.igst),
        camt: toRupees(amounts.cgst),
        samt: toRupees(amounts.sgst),
        cess: toRupees(amounts.cess),
        val: toRupees(amounts.taxable + amounts.totalTax)
      };
    });
  }
  return { json: out, touched };
}

// The same revision on the 2B side. Rate lines collapse to one line summing to
// the revised total, which is what the adapter reads.
function revise2b(json, { gstin, invoiceNo, amounts }) {
  let touched = 0;
  const out = { ...json, docdata: {} };
  for (const [section, groups] of Object.entries(json.docdata)) {
    out.docdata[section] = (groups ?? []).map((group) => {
      if (group.ctin !== gstin) return group;
      const copy = { ...group };
      const fix = (doc) => {
        if (String(doc.inum ?? doc.ntnum ?? doc.nt_num) !== invoiceNo) return doc;
        touched += 1;
        return {
          ...doc,
          val: toRupees(amounts.taxable + amounts.totalTax),
          items: [
            {
              hsn: doc.items?.[0]?.hsn ?? null,
              rt: doc.items?.[0]?.rt ?? 18,
              txval: toRupees(amounts.taxable),
              igst: toRupees(amounts.igst),
              cgst: toRupees(amounts.cgst),
              sgst: toRupees(amounts.sgst),
              cess: toRupees(amounts.cess)
            }
          ]
        };
      };
      if (Array.isArray(copy.inv)) copy.inv = copy.inv.map(fix);
      if (Array.isArray(copy.nt)) copy.nt = copy.nt.map(fix);
      return copy;
    });
  }
  return { json: out, touched };
}

async function ingest(orgId, kind, filename, taxPeriod, buffer) {
  const created = await createUpload({ orgId, kind, filename, buffer, taxPeriod });
  return commitUpload(orgId, created.id);
}

// seedDemoStory(orgId, { log }) -> a summary of the state it just guaranteed.
//
// Wipes the org's data first, so it is idempotent: running it twice — or between
// practice runs, or thirty seconds before presenting, or because a judge pressed
// "Reset my data" — lands on the same state.
//
// It asserts the outcome rather than assuming it. A copy of the demo that came
// out with zero invalidated decisions, or with a stale run, is not the demo; the
// caller needs to know that happened rather than hand it to someone.
export async function seedDemoStory(orgId, { log = () => {} } = {}) {
  requireStoryFixtures();

  await wipeOrgData(orgId);

  const runs = {};
  for (const period of STORY_PERIODS) {
    const seeded = await seedDemoPeriod(orgId, { taxPeriod: period });
    runs[period] = seeded.run;
    const rows = seeded.uploads.reduce((sum, upload) => sum + upload.parsed, 0);
    log(`seeded ${period}  run #${seeded.runId}  ${rows} rows`);
  }

  const runId = runs[STORY_PERIOD].id;
  const target = await pickStoryInvoice(orgId, runId);
  const amounts = revisedAmounts(target);

  log(`the demo invoice: ${target.invoice_no}  ${target.supplier_name} (${target.supplier_gstin})`);
  log(
    `  books        taxable ${rupees(Number(target.taxable_value))}  ` +
      `tax ${rupees(Number(target.total_tax))}`
  );

  // 1. The trader reviews it, agrees, and accepts.
  await confirmResult(orgId, target.result_id, { confirmedAction: 'ACCEPT' });
  log('  confirmed    ACCEPT');

  // 2. The supplier revises it — in both downloads, so the pair stays merged.
  const key = { gstin: target.supplier_gstin, invoiceNo: target.invoice_no, amounts };
  const ims = reviseIms(readFixture(STORY_PERIOD, 'ims.json'), key);
  const twoB = revise2b(readFixture(STORY_PERIOD, 'gstr2b.json'), key);
  if (ims.touched !== 1 || twoB.touched !== 1) {
    throw new Error(
      `expected to revise exactly one record per source, revised ${ims.touched} in IMS ` +
        `and ${twoB.touched} in 2B — the demo would show the wrong thing`
    );
  }
  log(`  supplier now taxable ${rupees(amounts.taxable)}  tax ${rupees(amounts.totalTax)}`);

  const imsCommit = await ingest(orgId, 'IMS', 'ims.json', STORY_PERIOD, asBuffer(ims.json));
  const twoBCommit = await ingest(orgId, 'GSTR2B', 'gstr2b.json', STORY_PERIOD, asBuffer(twoB.json));
  log(`  re-ingested  ${imsCommit.changes} IMS change, ${twoBCommit.changes} 2B change`);

  // 3. Rebuild, which is what drops the confirmation.
  const rerun = await rerunPeriodIfRun(orgId, STORY_PERIOD);
  if (!rerun.ran) {
    throw new Error(`could not re-run ${STORY_PERIOD}: ${rerun.message ?? rerun.reason}`);
  }

  // --- the state this function exists to guarantee -------------------------
  const feed = await listChangesForRun(orgId, runId);
  const run = await getRun(orgId, runId);

  if (feed.invalidatedCount !== 1) {
    throw new Error(
      `expected exactly 1 invalidated decision, got ${feed.invalidatedCount}. ` +
        'The demo is not in the state it claims to be — do not present this.'
    );
  }
  if (run.staleness.isStale) {
    throw new Error(
      'the April run came out stale, so the screen would open on "this run is out of ' +
        'date" instead of the change feed. Do not present this.'
    );
  }

  const invalidated = feed.changes.find((change) => change.review.invalidatedDecision);

  return {
    orgId,
    periods: STORY_PERIODS,
    storyPeriod: STORY_PERIOD,
    runId,
    run,
    target,
    amounts,
    feed,
    invalidated
  };
}
