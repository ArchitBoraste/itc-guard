// Per-visitor demo tenancy, end to end over HTTP.
//
// The bug this exists to prevent is the one the feature was built for: two judges
// open the same URL, one of them confirms a decision, and it changes what the
// other is looking at. That is not a subtle failure — it reads as the product
// being broken — so it is asserted here against real cookies and a real database
// rather than against the service functions.
//
// Everything runs through the actual Express app with the real demoSession
// middleware. fetch does not manage a cookie jar, which is exactly what is wanted:
// each "browser" here is a Cookie header this file controls, so a malformed or
// stale one can be sent deliberately.
//
// Owns no reserved org id. It creates demo orgs (demo_state IS NOT NULL, ids from
// AUTO_INCREMENT at 1000+) and deletes every one of them afterwards. Org 1 and the
// TEST_ORGS ids have demo_state IS NULL and are structurally out of reach.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, pool } from '../../src/db/pool.js';
import { requireDatabase } from '../helpers/db.js';

// Imported after the environment is set in beforeAll — config.demo is read
// lazily, but keeping the order explicit documents the dependency.
let createApp;
let wipeOrgData;
let topUpPool;
let reapIdleOrgs;
let tenancyStats;
let traderGstinFor;

const COOKIE_NAME = 'itcg_session';

let server;
let base;

// --- a browser -------------------------------------------------------------

// The smallest thing that behaves like one: it keeps the cookie the server set
// and sends it back. `cookie` can be overwritten to forge or corrupt it.
function browser(initialCookie = null) {
  const state = { cookie: initialCookie };

  async function call(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (state.cookie) headers.cookie = state.cookie;
    const res = await fetch(`${base}${path}`, { ...options, headers });

    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const pair = raw.split(';')[0];
      if (pair.startsWith(`${COOKIE_NAME}=`)) state.cookie = pair;
    }

    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body };
  }

  return {
    state,
    call,
    json: (method, path, payload) =>
      call(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {})
      }),

    // Mints or resumes the session and waits out any seeding. The pool is warmed
    // in beforeAll so this normally returns on the first call.
    async ready({ timeoutMs = 90_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { status, body } = await call('/api/session');
        if (status !== 200) throw new Error(`GET /api/session -> ${status}`);
        if (body.session.state === 'READY') return body.session;
        if (Date.now() > deadline) {
          throw new Error(`session never became READY (last state ${body.session.state})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
}

// What each session sees. Read over HTTP rather than out of the database,
// because "what the other judge sees" is the claim being made.
async function snapshot(client) {
  const runs = (await client.call('/api/runs')).body.runs;
  const april = runs.find((run) => run.taxPeriod === '2026-04');
  const results = (await client.call(`/api/runs/${april.id}/results?pageSize=500`)).body;
  const changes = (await client.call(`/api/changes?runId=${april.id}`)).body;
  return {
    runCount: runs.length,
    runId: april.id,
    resultTotal: results.total,
    confirmed: results.results.filter((row) => row.confirmedAction).length,
    invalidatedCount: changes.invalidatedCount,
    claimableItc: april.totals.claimableItc
  };
}

const listen = (app) =>
  new Promise((resolve) => {
    const created = app.listen(0, () => resolve(created));
  });

// --- setup -----------------------------------------------------------------

const createdOrgIds = new Set();

// NOTE ON CLEANUP. Orgs this suite creates are deleted once, in afterAll, after
// seeding has been quiesced — never between cases.
//
// Deleting them in an afterEach (to keep the footprint small) raced the pool:
// claiming a warm org fires an unawaited topUpPool(), which counts live orgs and
// creates more, while afterEach deleted them underneath it. The two disagreed
// about the live count often enough that roughly one run in three tripped the
// org cap and failed an unrelated assertion. afterAll finds every row with a
// non-NULL demo_state, so nothing is missed by waiting.

async function rememberNewOrgs() {
  const [rows] = await pool.query('SELECT id FROM organizations WHERE demo_state IS NOT NULL');
  for (const row of rows) createdOrgIds.add(Number(row.id));
}

beforeAll(async () => {
  await requireDatabase();

  process.env.DEMO_TENANCY = 'on';
  process.env.DEMO_SESSION_SECRET = 'test-secret-not-for-deployment';
  // Two warm orgs so the isolation tests do not each pay for a seed, and a low
  // cap so nothing here can run away with the developer's database.
  process.env.DEMO_POOL_SIZE = '2';
  // The suite claims ~19 orgs across all cases and holds them to the end, so this
  // is deliberate headroom: no case should ever meet the cap by accident. The
  // ceiling behaviour itself is asserted directly, and on purpose, in "the
  // reaper" — which lowers this to exactly the live count for that one test.
  process.env.DEMO_MAX_ORGS = '30';
  process.env.DEMO_IDLE_MINUTES = '180';

  ({ createApp } = await import('../../src/app.js'));
  ({ wipeOrgData } = await import('../../src/services/demoStory.js'));
  ({ topUpPool, reapIdleOrgs, tenancyStats } = await import('../../src/services/demoTenancy.js'));
  ({ traderGstinFor } = await import('../../src/services/demo.js'));

  server = await listen(createApp({ pingDb: async () => true }));
  base = `http://127.0.0.1:${server.address().port}`;

  await topUpPool();
  await rememberNewOrgs();
}, 300_000);

// Claiming a warm org kicks off a background top-up, so a seed can still be
// running after the last assertion. Deleting an org's uploads while it is being
// seeded trips the portal_records -> uploads foreign key, so the pool is turned
// off and allowed to finish before anything is removed.
async function settleSeeds({ timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [[{ n }]] = await pool.query(
      "SELECT COUNT(*) AS n FROM organizations WHERE demo_state = 'PROVISIONING'"
    );
    if (Number(n) === 0 || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function quiesceTenancy() {
  process.env.DEMO_TENANCY = 'off';
  process.env.DEMO_POOL_SIZE = '0';
  await settleSeeds();
}

afterAll(async () => {
  await quiesceTenancy();
  await rememberNewOrgs();
  for (const orgId of createdOrgIds) {
    if (orgId === 1) continue; // never, under any circumstance
    await wipeOrgData(orgId);
    await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [orgId]);
  }
  // Nothing this suite created may outlive it, so say so rather than trusting it.
  const [leftovers] = await pool.query(
    'SELECT id FROM organizations WHERE demo_state IS NOT NULL'
  );
  if (leftovers.length) {
    console.error(`[test] left ${leftovers.length} demo org(s) behind: ${leftovers.map((r) => r.id).join(', ')}`);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
}, 180_000);

// --- tests -----------------------------------------------------------------

describe('a visitor gets their own seeded org', () => {
  it('hands out a distinct org, with the demo story already in it', async () => {
    const judge = browser();
    const session = await judge.ready();

    expect(session.orgId).toBeGreaterThan(1);
    expect(session.perVisitor).toBe(true);
    expect(judge.state.cookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));

    const view = await snapshot(judge);
    // The state demo:reset produces: two periods, and exactly one decision that
    // was made and then invalidated by the supplier's revision.
    expect(view.runCount).toBe(2);
    expect(view.invalidatedCount).toBe(1);
    expect(view.resultTotal).toBeGreaterThan(0);

    // Its own trader identity, because organizations.gstin is globally unique and
    // stays that way.
    const org = (await judge.call('/api/org')).body.org;
    expect(org.id).toBe(session.orgId);
    expect(org.gstin).toBe(traderGstinFor(session.orgId));
    expect(org.gstin).not.toBe('27AABCS1429F1Z8');
  });

  it('keeps the same org across requests that carry the cookie', async () => {
    const judge = browser();
    const first = await judge.ready();
    const second = (await judge.call('/api/session')).body.session;
    expect(second.orgId).toBe(first.orgId);
    expect(second.isNew).toBe(false);
  });
});

describe('two sessions cannot see each other', () => {
  it('a confirmation in one leaves the other untouched', async () => {
    const alice = browser();
    const bob = browser();
    const aliceSession = await alice.ready();
    const bobSession = await bob.ready();

    expect(aliceSession.orgId).not.toBe(bobSession.orgId);

    const before = await snapshot(bob);

    // Alice confirms one of her own recommendations.
    const aliceView = await snapshot(alice);
    const aliceResults = (
      await alice.call(`/api/runs/${aliceView.runId}/results?pageSize=500`)
    ).body.results;
    const target = aliceResults.find(
      (row) => row.recommendedAction === 'ACCEPT' && !row.confirmedAction
    );
    expect(target, 'the seeded demo should contain an un-confirmed ACCEPT').toBeTruthy();

    const patched = await alice.json('PATCH', `/api/results/${target.id}`, {
      confirmedAction: 'ACCEPT'
    });
    expect(patched.status).toBe(200);

    const aliceAfter = await snapshot(alice);
    expect(aliceAfter.confirmed).toBe(aliceView.confirmed + 1);

    const after = await snapshot(bob);
    expect(after).toEqual(before);
  });

  it('refuses a result id belonging to another session', async () => {
    const alice = browser();
    const bob = browser();
    await alice.ready();
    await bob.ready();

    const aliceView = await snapshot(alice);
    const aliceResults = (
      await alice.call(`/api/runs/${aliceView.runId}/results?pageSize=500`)
    ).body.results;

    // Bob names one of Alice's result ids directly. Every query filters on
    // org_id, so it is not his to confirm and the row is simply not found.
    const stolen = await bob.json('PATCH', `/api/results/${aliceResults[0].id}`, {
      confirmedAction: 'ACCEPT'
    });
    expect(stolen.status).toBe(404);

    // And her run, by id.
    const peek = await bob.call(`/api/runs/${aliceView.runId}`);
    expect(peek.status).toBe(404);

    // And its results: a 404 like the run, not 200 with an empty list (audit
    // P26). Nothing leaked either way; an answer that looks like "no rows" is
    // simply the wrong one.
    const peekResults = await bob.call(`/api/runs/${aliceView.runId}/results`);
    expect(peekResults.status).toBe(404);
    expect(peekResults.body.error).toBe('not_found');
  });
});

describe('reset', () => {
  it('rebuilds only the calling org', async () => {
    const alice = browser();
    const bob = browser();
    const aliceSession = await alice.ready();
    await bob.ready();

    // Both of them make a decision, so both have something a reset would clear.
    for (const client of [alice, bob]) {
      const view = await snapshot(client);
      const rows = (await client.call(`/api/runs/${view.runId}/results?pageSize=500`)).body.results;
      const target = rows.find((row) => row.recommendedAction === 'ACCEPT' && !row.confirmedAction);
      await client.json('PATCH', `/api/results/${target.id}`, { confirmedAction: 'ACCEPT' });
    }

    const bobBefore = await snapshot(bob);
    const aliceBefore = await snapshot(alice);
    expect(aliceBefore.confirmed).toBeGreaterThan(0);

    const reset = await alice.json('POST', '/api/session/reset');
    expect(reset.status).toBe(202);
    expect(reset.body.session.state).toBe('PROVISIONING');

    // Everything else is closed while it rebuilds, and says why rather than 500ing.
    const during = await alice.call('/api/runs');
    expect([200, 409]).toContain(during.status);
    if (during.status === 409) expect(during.body.error).toBe('session_provisioning');

    const back = await alice.ready();
    expect(back.orgId).toBe(aliceSession.orgId); // same org, same cookie

    const aliceAfter = await snapshot(alice);
    expect(aliceAfter.confirmed).toBe(0);
    expect(aliceAfter.invalidatedCount).toBe(1); // the story is back
    expect(aliceAfter.runCount).toBe(2);

    // Bob did not notice.
    expect(await snapshot(bob)).toEqual(bobBefore);
  }, 180_000);
});

describe('a cookie that cannot be honoured starts a fresh session', () => {
  it('no cookie at all', async () => {
    const visitor = browser();
    const { status, body } = await visitor.call('/api/session');
    expect(status).toBe(200);
    expect(body.session.orgId).toBeGreaterThan(1);
    expect(body.session.isNew).toBe(true);
  });

  it.each([
    ['not signed at all', `${COOKIE_NAME}=12345`],
    ['a forged signature', `${COOKIE_NAME}=12345.aaaabbbbccccdddd`],
    ['empty', `${COOKIE_NAME}=`],
    ['not a number', `${COOKIE_NAME}=abc.def`],
    ['a broken percent escape', `${COOKIE_NAME}=%E0%A4%A`],
    ['naming the presenter org', `${COOKIE_NAME}=1.anything`]
  ])('%s', async (_label, cookie) => {
    const visitor = browser(cookie);
    const { status, body } = await visitor.call('/api/session');
    expect(status).toBe(200);
    expect(body.session.orgId).toBeGreaterThan(1);
    expect(body.session.isNew).toBe(true);

    // And the app works from there, rather than merely not erroring.
    await visitor.ready();
    const runs = await visitor.call('/api/runs');
    expect(runs.status).toBe(200);
    expect(runs.body.runs.length).toBe(2);
  });

  it('a correctly signed cookie naming an org that has been deleted', async () => {
    const judge = browser();
    const session = await judge.ready();
    const cookie = judge.state.cookie;

    // The reaper's exact deletion, applied now.
    await wipeOrgData(session.orgId);
    await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [
      session.orgId
    ]);
    createdOrgIds.delete(session.orgId);

    // Same browser, same cookie, next morning.
    const returning = browser(cookie);
    const after = await returning.ready();
    expect(after.orgId).not.toBe(session.orgId);
    expect(after.orgId).toBeGreaterThan(1);

    const view = await snapshot(returning);
    expect(view.runCount).toBe(2);
    expect(view.invalidatedCount).toBe(1);
  }, 180_000);
});

describe('the reaper', () => {
  it('deletes an idle claimed org and leaves org 1 and the pool alone', async () => {
    const judge = browser();
    const session = await judge.ready();

    const [[appBefore]] = await pool.query(
      'SELECT COUNT(*) AS n FROM runs WHERE org_id = 1'
    );

    // Age it past the idle TTL.
    await pool.query(
      'UPDATE organizations SET last_seen_at = DATE_SUB(NOW(), INTERVAL 10 DAY) WHERE id = ?',
      [session.orgId]
    );

    const reaped = await reapIdleOrgs();
    expect(reaped).toContain(session.orgId);
    createdOrgIds.delete(session.orgId);

    const [gone] = await pool.query('SELECT id FROM organizations WHERE id = ?', [session.orgId]);
    expect(gone.length).toBe(0);

    // Org 1 is untouched — it has demo_state IS NULL, so the sweep cannot see it.
    const [[appAfter]] = await pool.query('SELECT COUNT(*) AS n FROM runs WHERE org_id = 1');
    expect(Number(appAfter.n)).toBe(Number(appBefore.n));

    const [[org1]] = await pool.query('SELECT demo_state FROM organizations WHERE id = 1');
    expect(org1.demo_state).toBeNull();
  });

  it('never exceeds the configured ceiling', async () => {
    const stats = await tenancyStats();
    expect(stats.live).toBeLessThanOrEqual(stats.maxOrgs);
  });

  // The database cannot grow without limit over several days of judging, so at
  // some point a new arrival has to be refused. It has to be refused CLEANLY —
  // a stated reason and a status the UI can render, not a stack trace.
  it('refuses a new session rather than growing past the cap', async () => {
    const savedMax = process.env.DEMO_MAX_ORGS;
    const savedPool = process.env.DEMO_POOL_SIZE;
    try {
      // Stop the pool refilling itself, and let any refill already in flight
      // finish — otherwise a fresh POOL org appears between measuring and asking,
      // and the visitor is (correctly) served instead of turned away.
      process.env.DEMO_POOL_SIZE = '0';
      await settleSeeds();

      // Drain what is pooled, so the next visitor genuinely needs a new org.
      await pool.query("UPDATE organizations SET demo_state = 'RETIRED' WHERE demo_state = 'POOL'");

      // Exactly what is live, so there is no headroom left for one more.
      const stats = await tenancyStats();
      process.env.DEMO_MAX_ORGS = String(stats.live);

      const turnedAway = await browser().call('/api/session');
      expect(turnedAway.status).toBe(503);
      expect(turnedAway.body.error).toBe('demo_at_capacity');
      expect(turnedAway.body.message).toMatch(/capacity/i);
    } finally {
      process.env.DEMO_MAX_ORGS = savedMax;
      process.env.DEMO_POOL_SIZE = savedPool;
      await reapIdleOrgs();
    }
  });
});
