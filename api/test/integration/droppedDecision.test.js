// "1 decision you made was dropped" stays on screen until it is answered.
//
// The audit's P14: on the scripted April story (Mahavir Sales Corp 06-17/AMD/3538,
// revised down Rs 5,000 after the trader accepted it), pressing "Re-run
// reconciliation" erased the banner and the row's reset flag although nothing
// had been decided again — and the out-of-date banner (P2) told the trader to
// press exactly that button. Only two things answer the warning: deciding the row
// again, or dismissing it.
//
// Driven over HTTP, the way the web app re-runs, decides and dismisses.
//
// Owns org 19.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { seedDemoStory } from '../../src/services/demoStory.js';
import { TEST_ORGS, ingest, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.droppedDecision;
const APRIL = '2026-04';
const STORY_INVOICE = '06-17/AMD/3538';
const RESET = 'CONFIRMATION_RESET';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

let server;
let base;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

async function aprilRun() {
  return (await call('GET', `/api/runs?taxPeriod=${APRIL}`)).body.run;
}

// "Re-run reconciliation": the same payload RerunControl sends.
async function rerun() {
  const run = await aprilRun();
  const { status } = await call('POST', '/api/runs', {
    taxPeriod: run.taxPeriod,
    mode: run.mode,
    asOfDate: run.asOfDate,
    filingScheme: run.filingScheme
  });
  expect(status).toBe(201);
}

async function results() {
  const run = await aprilRun();
  return (await call('GET', `/api/runs/${run.id}/results?pageSize=500`)).body.results;
}

const storyRow = async () => (await results()).find((row) => row.books?.invoiceNo === STORY_INVOICE);
const resetRows = async () => (await results()).filter((row) => row.flags.includes(RESET));

async function invalidatedCount() {
  const run = await aprilRun();
  return (await call('GET', `/api/changes?runId=${run.id}`)).body.invalidatedCount;
}

describe('a dropped decision stays flagged until the trader answers it', () => {
  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID);
    await resetOrg(ORG_ID);
    await seedDemoStory(ORG_ID);

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
  }, 240000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closePool();
  });

  it('opens on exactly one dropped decision: the Mahavir story', async () => {
    const flagged = await resetRows();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].books.invoiceNo).toBe(STORY_INVOICE);
    expect(flagged[0].confirmedAction).toBeNull();
    expect(await invalidatedCount()).toBe(1);
  });

  it('survives Re-run reconciliation, because nothing was decided again', async () => {
    await rerun();
    await rerun();

    const flagged = await resetRows();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].books.invoiceNo).toBe(STORY_INVOICE);
    expect(flagged[0].confirmedAction).toBeNull();
    expect(flagged[0].needsDecision).toBe(true);
    expect(await invalidatedCount()).toBe(1);
  }, 120000);

  it('clears when dismissed, stays cleared across a re-run, and decides nothing', async () => {
    const row = await storyRow();
    const first = await call('POST', `/api/results/${row.id}/dismiss-reset`);
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ id: row.id, dismissed: true });
    expect(first.body.result.flags).not.toContain(RESET);

    // Idempotent: a second click finds nothing to take off.
    const again = await call('POST', `/api/results/${row.id}/dismiss-reset`);
    expect(again.body.result.dismissed).toBe(false);

    await rerun();
    expect(await resetRows()).toHaveLength(0);
    expect(await invalidatedCount()).toBe(0);
    // The record is still waiting on a decision; only the warning went.
    const after = await storyRow();
    expect(after.confirmedAction).toBeNull();
    expect(after.needsDecision).toBe(true);
  }, 120000);

  it('refuses to dismiss a result it cannot find', async () => {
    const { status, body } = await call('POST', '/api/results/999999999/dismiss-reset');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('clears the moment the row is decided again — and N is not deciding', async () => {
    // A second drop: the trader accepts the revised record, then the supplier puts
    // the original back (the unrevised April files), which resets that decision.
    const row = await storyRow();
    expect((await call('PATCH', `/api/results/${row.id}`, { confirmedAction: 'ACCEPT' })).status).toBe(200);
    await ingest(ORG_ID, 'IMS', 'ims.json', APRIL);
    await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', APRIL);
    await rerun();

    let flagged = await resetRows();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].books.invoiceNo).toBe(STORY_INVOICE);
    expect(flagged[0].confirmedAction).toBeNull();

    // N is never a decision, so it does not answer the warning.
    await call('PATCH', `/api/results/${flagged[0].id}`, { confirmedAction: 'NO_ACTION' });
    await rerun();
    flagged = await resetRows();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].confirmedAction).toBe('NO_ACTION');

    // A real decision does, immediately rather than at the next re-run.
    await call('PATCH', `/api/results/${flagged[0].id}`, { confirmedAction: 'ACCEPT' });
    expect(await resetRows()).toHaveLength(0);

    await rerun();
    expect(await resetRows()).toHaveLength(0);
    expect((await storyRow()).confirmedAction).toBe('ACCEPT');
  }, 180000);
});
