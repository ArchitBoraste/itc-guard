// Per-visitor workspaces, end to end over HTTP.
//
// What a visitor must be able to rely on:
//   * a first visit gets an EMPTY workspace of their own: the demo starts on the
//     Upload screen, so nothing is seeded;
//   * it is still theirs after a refresh or a return visit (a 180-day httpOnly
//     cookie, renewed as they use the app);
//   * nothing they do is visible to anyone else, and "Clear all data" empties
//     theirs and nobody else's;
//   * the reaper never deletes a workspace that had an upload in the last 30
//     days, and the cap still holds.
//
// Everything runs through the actual Express app with the real demoSession
// middleware. Each "browser" here is a Cookie header this file controls, so a
// malformed or stale one can be sent deliberately.
//
// Owns no reserved org id. It creates demo orgs (demo_state IS NOT NULL, ids from
// AUTO_INCREMENT at 1000+) and deletes every one of them afterwards. Org 1 and the
// TEST_ORGS ids have demo_state IS NULL and are structurally out of reach.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, pool } from '../../src/db/pool.js';
import { requireDatabase } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';

// Imported after the environment is set in beforeAll. config.demo is read lazily,
// but keeping the order explicit documents the dependency.
let createApp;
let wipeOrgData;
let reapIdleOrgs;
let tenancyStats;
let traderGstinFor;
let todayInIndia;

const COOKIE_NAME = 'itcg_session';
const SIX_MONTHS_SECONDS = 180 * 24 * 3600;

let server;
let base;

// --- a browser -------------------------------------------------------------

// The smallest thing that behaves like one: it keeps the cookie the server set
// and sends it back. `cookie` can be overwritten to forge or corrupt it, and the
// raw Set-Cookie headers of the last response are kept for their attributes.
function browser(initialCookie = null) {
  const state = { cookie: initialCookie, setCookies: [] };

  async function send(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (state.cookie) headers.cookie = state.cookie;
    const res = await fetch(`${base}${path}`, { ...options, headers });

    state.setCookies = res.headers.getSetCookie?.() ?? [];
    for (const raw of state.setCookies) {
      const pair = raw.split(';')[0];
      if (pair.startsWith(`${COOKIE_NAME}=`)) state.cookie = pair;
    }

    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const json = (method, path, payload) =>
    send(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {})
    });

  async function ingest(kind, path) {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', new Blob([readFileSync(path)]), basename(path));
    const created = await send('/api/uploads', { method: 'POST', body: form });
    expect(created.status).toBe(201);
    return json('POST', `/api/uploads/${created.body.upload.id}/commit`);
  }

  return { state, call: send, json, ingest };
}

// What one workspace holds, read over HTTP: "what the other visitor sees" is the
// claim being made.
async function contents(client) {
  const [uploads, runs, clock] = await Promise.all([
    client.call('/api/uploads'),
    client.call('/api/runs'),
    client.call('/api/workspace/clock')
  ]);
  return { uploads: uploads.body.uploads, runs: runs.body.runs, clock: clock.body.clock };
}

async function sessionOf(client) {
  const { status, body } = await client.call('/api/session');
  expect(status).toBe(200);
  return body.session;
}

// A visitor who has reconciled August as of 5 Sep: something worth isolating.
async function withAugust(client) {
  await sessionOf(client);
  expect((await client.json('PUT', '/api/workspace/clock', { asOfDate: '2026-09-05' })).status).toBe(200);
  expect((await client.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
  expect((await client.ingest('IMS', demoIms('aug', '2026-09-05'))).status).toBe(200);
  const run = await client.json('POST', '/api/runs', { taxPeriod: '2026-08' });
  expect(run.status).toBe(201);
  return run.body.run;
}

const listen = (app) =>
  new Promise((resolve) => {
    const created = app.listen(0, () => resolve(created));
  });

// --- setup -----------------------------------------------------------------

async function demoOrgIds() {
  const [rows] = await pool.query('SELECT id FROM organizations WHERE demo_state IS NOT NULL');
  return rows.map((row) => Number(row.id));
}

let preexisting = new Set();

beforeAll(async () => {
  await requireDatabase();

  process.env.DEMO_TENANCY = 'on';
  process.env.DEMO_SESSION_SECRET = 'test-secret-not-for-deployment';
  process.env.DEMO_COOKIE_SECURE = 'true';
  process.env.DEMO_SESSION_DAYS = '180';
  process.env.DEMO_MAX_ORGS = '40';
  process.env.DEMO_IDLE_MINUTES = '180';
  process.env.DEMO_RETAIN_DAYS = '30';

  ({ createApp } = await import('../../src/app.js'));
  ({ wipeOrgData } = await import('../../src/services/demoStory.js'));
  ({ reapIdleOrgs, tenancyStats } = await import('../../src/services/demoTenancy.js'));
  ({ traderGstinFor } = await import('../../src/services/demo.js'));
  ({ todayInIndia } = await import('../../src/services/workspaceClock.js'));

  // Demo orgs that were already here are not this suite's to delete.
  preexisting = new Set(await demoOrgIds());

  server = await listen(createApp({ pingDb: async () => true }));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  process.env.DEMO_TENANCY = 'off';
  for (const orgId of await demoOrgIds()) {
    if (orgId === 1 || preexisting.has(orgId)) continue;
    await wipeOrgData(orgId);
    await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [orgId]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
});

// --- a first visit ---------------------------------------------------------

describe('a new visitor', () => {
  it('gets an empty workspace of their own', async () => {
    const visitor = browser();
    const session = await sessionOf(visitor);

    expect(session).toMatchObject({ state: 'READY', isNew: true, perVisitor: true });
    expect(session.orgId).toBeGreaterThan(1);

    expect(await contents(visitor)).toEqual({
      uploads: [],
      runs: [],
      clock: { asOfDate: todayInIndia(), today: todayInIndia(), followsToday: true }
    });

    // Its own trader identity: organizations.gstin is globally unique.
    const org = (await visitor.call('/api/org')).body.org;
    expect(org.id).toBe(session.orgId);
    expect(org.gstin).toBe(traderGstinFor(session.orgId));
  });

  it('is handed a long-lived httpOnly, Secure, SameSite=Lax cookie', async () => {
    const visitor = browser();
    await sessionOf(visitor);
    const cookie = visitor.state.setCookies.find((raw) => raw.startsWith(`${COOKIE_NAME}=`));
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(new RegExp(`; Max-Age=${SIX_MONTHS_SECONDS}(;|$)`));
  });
});

describe('a returning visitor', () => {
  it('keeps the same workspace across refreshes and return visits', async () => {
    const visitor = browser();
    const first = await sessionOf(visitor);
    const run = await withAugust(visitor);

    const again = await sessionOf(visitor);
    expect(again).toMatchObject({ orgId: first.orgId, isNew: false });

    // Days later, a new tab: the same cookie, the same workspace, the same data.
    const later = browser(visitor.state.cookie);
    expect((await sessionOf(later)).orgId).toBe(first.orgId);
    const held = await contents(later);
    expect(held.runs.map((entry) => entry.id)).toEqual([run.id]);
    expect(held.uploads).toHaveLength(2);
    expect(held.clock).toMatchObject({ asOfDate: '2026-09-05', followsToday: false });
  });

  it('has the cookie renewed as they use the app, at most once a minute', async () => {
    const visitor = browser();
    await sessionOf(visitor);
    await sessionOf(visitor);
    expect(visitor.state.setCookies.join()).toMatch(new RegExp(`Max-Age=${SIX_MONTHS_SECONDS}`));
    await sessionOf(visitor);
    expect(visitor.state.setCookies).toEqual([]);
  });
});

// --- isolation -------------------------------------------------------------

describe('two workspaces', () => {
  it('cannot see each other', async () => {
    const alice = browser();
    const bob = browser();
    const aliceRun = await withAugust(alice);
    await sessionOf(bob);

    expect(await contents(bob)).toMatchObject({ uploads: [], runs: [], clock: { followsToday: true } });

    // Bob names Alice's run and one of her results directly. Every query filters
    // on org_id, so neither is found.
    expect((await bob.call(`/api/runs/${aliceRun.id}`)).status).toBe(404);
    expect((await bob.call(`/api/runs/${aliceRun.id}/results`)).status).toBe(404);
    const aliceResults = (await alice.call(`/api/runs/${aliceRun.id}/results?pageSize=500`)).body.results;
    const stolen = await bob.json('PATCH', `/api/results/${aliceResults[0].id}`, { confirmedAction: 'ACCEPT' });
    expect(stolen.status).toBe(404);
  });
});

describe('Clear all data', () => {
  it("empties the caller's workspace, the date included, and nobody else's", async () => {
    const alice = browser();
    const bob = browser();
    const aliceSession = await sessionOf(alice);
    await withAugust(alice);
    await withAugust(bob);
    const bobBefore = await contents(bob);

    const cleared = await alice.json('POST', '/api/workspace/clear');
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toEqual({ orgId: aliceSession.orgId });

    expect((await sessionOf(alice)).orgId).toBe(aliceSession.orgId);
    expect(await contents(alice)).toEqual({
      uploads: [],
      runs: [],
      clock: { asOfDate: todayInIndia(), today: todayInIndia(), followsToday: true }
    });
    expect(await contents(bob)).toEqual(bobBefore);
  });

  it('is refused where there is one shared workspace', async () => {
    const visitor = browser();
    await sessionOf(visitor);
    process.env.DEMO_TENANCY = 'off';
    try {
      const refused = await visitor.json('POST', '/api/workspace/clear');
      expect(refused.status).toBe(409);
    } finally {
      process.env.DEMO_TENANCY = 'on';
    }
  });
});

// --- cookies that cannot be honoured -----------------------------------------

describe('a cookie that cannot be honoured starts a fresh, empty workspace', () => {
  it.each([
    ['not signed at all', `${COOKIE_NAME}=12345`],
    ['a forged signature', `${COOKIE_NAME}=12345.aaaabbbbccccdddd`],
    ['empty', `${COOKIE_NAME}=`],
    ['not a number', `${COOKIE_NAME}=abc.def`],
    ['a broken percent escape', `${COOKIE_NAME}=%E0%A4%A`],
    ['naming the presenter org', `${COOKIE_NAME}=1.anything`]
  ])('%s', async (_label, cookie) => {
    const visitor = browser(cookie);
    const session = await sessionOf(visitor);
    expect(session.orgId).toBeGreaterThan(1);
    expect(session.isNew).toBe(true);
    expect((await contents(visitor)).runs).toEqual([]);
  });

  it('a correctly signed cookie naming a workspace that has been deleted', async () => {
    const visitor = browser();
    const session = await sessionOf(visitor);
    await wipeOrgData(session.orgId);
    await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [session.orgId]);

    const returning = browser(visitor.state.cookie);
    const after = await sessionOf(returning);
    expect(after.orgId).not.toBe(session.orgId);
    expect(after.isNew).toBe(true);
  });
});

// --- the reaper --------------------------------------------------------------

const ageWorkspace = (orgId, days) =>
  pool.query('UPDATE organizations SET last_seen_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE id = ?', [days, orgId]);
const ageUploads = (orgId, days) =>
  pool.query('UPDATE uploads SET created_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE org_id = ?', [days, orgId]);
const exists = async (orgId) =>
  (await pool.query('SELECT id FROM organizations WHERE id = ?', [orgId]))[0].length === 1;

describe('the reaper', () => {
  it('deletes an idle empty workspace', async () => {
    const visitor = browser();
    const { orgId } = await sessionOf(visitor);
    await ageWorkspace(orgId, 2);
    expect(await reapIdleOrgs()).toContain(orgId);
    expect(await exists(orgId)).toBe(false);
  });

  it('keeps an idle workspace that had an upload in the last 30 days', async () => {
    const visitor = browser();
    const { orgId } = await sessionOf(visitor);
    await withAugust(visitor);
    await ageUploads(orgId, 29);
    await ageWorkspace(orgId, 29);
    expect(await reapIdleOrgs()).not.toContain(orgId);
    expect(await exists(orgId)).toBe(true);
  });

  it('deletes an idle workspace whose uploads are all older than that', async () => {
    const visitor = browser();
    const { orgId } = await sessionOf(visitor);
    await withAugust(visitor);
    await ageUploads(orgId, 31);
    await ageWorkspace(orgId, 31);
    expect(await reapIdleOrgs()).toContain(orgId);
    expect(await exists(orgId)).toBe(false);
  });

  it('deletes what is left of the seeded pool, and never touches org 1', async () => {
    const [created] = await pool.query(
      `INSERT INTO organizations (gstin, legal_name, state_code, demo_state, last_seen_at)
       VALUES ('POOLLEFTOVER001', 'Leftover', '27', 'POOL', NOW())`
    );
    const [[appBefore]] = await pool.query('SELECT COUNT(*) AS n FROM uploads WHERE org_id = 1');

    expect(await reapIdleOrgs()).toContain(Number(created.insertId));

    const [[appAfter]] = await pool.query('SELECT COUNT(*) AS n FROM uploads WHERE org_id = 1');
    expect(Number(appAfter.n)).toBe(Number(appBefore.n));
    const [[org1]] = await pool.query('SELECT demo_state FROM organizations WHERE id = 1');
    expect(org1?.demo_state ?? null).toBeNull();
  });
});

describe('the cap', () => {
  it('reclaims an idle unused workspace for a new visitor, and refuses when there is none', async () => {
    const savedMax = process.env.DEMO_MAX_ORGS;
    try {
      const idle = browser();
      const { orgId: idleOrg } = await sessionOf(idle);
      await ageWorkspace(idleOrg, 1);

      process.env.DEMO_MAX_ORGS = String((await tenancyStats()).live);

      // At the cap, the idle empty workspace makes room.
      const arriving = browser();
      const arrived = await sessionOf(arriving);
      expect(arrived.isNew).toBe(true);
      expect(await exists(idleOrg)).toBe(false);

      // Every other workspace is in use or holds a recent upload: refused, with a
      // stated reason and a status the UI can render.
      const turnedAway = await browser().call('/api/session');
      expect(turnedAway.status).toBe(503);
      expect(turnedAway.body.error).toBe('demo_at_capacity');
      expect(turnedAway.body.message).toMatch(/capacity/i);
    } finally {
      process.env.DEMO_MAX_ORGS = savedMax;
    }
  });
});
