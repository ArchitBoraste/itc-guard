// One private, pre-seeded org per visitor.
//
// THE CHOICE: a warm pool, not a "preparing your data" wait on first load.
//
// Seeding the demo story is ~4.5s locally and noticeably worse on the t3.micro
// this is deployed to — it parses an xlsx and two JSON downloads, runs the real
// ingest path twice over, reconciles two periods, then re-ingests and re-runs
// April. That is a long time to hold a judge on a spinner, and a judge who is
// made to wait on their FIRST impression of the product has already been told
// something wrong about it. So orgs are seeded ahead of time and sit idle, and a
// new visitor is handed one in a single UPDATE.
//
// The "preparing" state still exists, but as the degradation rather than the
// design: if judges arrive faster than the pool refills, the next visitor gets an
// org that is still seeding and a screen that says so. That path is also what a
// "Reset my data" click uses, since a reset is an explicit action where a few
// seconds of visible progress is honest rather than jarring. One state, two ways
// in, instead of two mechanisms.
//
// SAFETY: every write here is constrained to rows with a non-NULL demo_state.
// Org 1 (the presenter's demo) and the reserved test orgs in test/helpers/db.js
// have demo_state IS NULL, so they are outside the reach of the reaper by
// construction and not merely by an id check. assertDemoOrg() re-checks anyway.
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { traderGstinFor } from './demo.js';
import { seedDemoStory, storyFixturesReady, wipeOrgData } from './demoStory.js';

export const APP_ORG_ID = 1;

const LIVE_STATES = ['PROVISIONING', 'POOL', 'CLAIMED'];

// --- seed concurrency ------------------------------------------------------

// A 1 GB box will not survive ten simultaneous seeds. Resets jump the queue:
// somebody is watching a reset happen, whereas a pool top-up is speculative.
const seedQueue = { active: 0, waiting: [] };

function acquireSeedSlot(priority) {
  if (seedQueue.active < Math.max(1, config.demo.seedConcurrency)) {
    seedQueue.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const entry = { resolve, priority };
    if (priority) seedQueue.waiting.unshift(entry);
    else seedQueue.waiting.push(entry);
  });
}

function releaseSeedSlot() {
  const next = seedQueue.waiting.shift();
  if (next) next.resolve();
  else seedQueue.active -= 1;
}

async function withSeedSlot(fn, { priority = false } = {}) {
  await acquireSeedSlot(priority);
  try {
    return await fn();
  } finally {
    releaseSeedSlot();
  }
}

// --- guards ----------------------------------------------------------------

// Nothing in this module may write to an org that is not a demo tenant. Org 1 is
// named explicitly on top of the demo_state check because it is the one mistake
// whose cost is the presenter losing the demo mid-judging.
function assertDemoOrg(row, action) {
  if (!row) throw new Error(`${action}: org not found`);
  if (Number(row.id) === APP_ORG_ID) {
    throw new Error(`${action} refuses org ${APP_ORG_ID}: that is the application's own org`);
  }
  if (!row.demo_state) {
    throw new Error(`${action} refuses org ${row.id}: it is not a demo tenant (demo_state IS NULL)`);
  }
}

// --- reads -----------------------------------------------------------------

export async function getDemoOrg(orgId) {
  if (!Number.isInteger(Number(orgId)) || Number(orgId) <= 0) return null;
  const [rows] = await pool.query(
    `SELECT id, demo_state, claimed_at, last_seen_at, demo_error
       FROM organizations WHERE id = ?`,
    [Number(orgId)]
  );
  return rows[0] ?? null;
}

export async function tenancyStats() {
  const [rows] = await pool.query(
    `SELECT demo_state, COUNT(*) AS n
       FROM organizations WHERE demo_state IS NOT NULL GROUP BY demo_state`
  );
  const counts = { PROVISIONING: 0, POOL: 0, CLAIMED: 0, RETIRED: 0 };
  for (const row of rows) counts[row.demo_state] = Number(row.n);
  return {
    ...counts,
    live: LIVE_STATES.reduce((sum, state) => sum + counts[state], 0),
    poolSize: config.demo.poolSize,
    maxOrgs: config.demo.maxOrgs
  };
}

// --- creating and seeding --------------------------------------------------

// Inserts an empty org in PROVISIONING and returns its id, or null when the cap
// is reached. The count and the insert share one transaction so two simultaneous
// first-visits cannot both squeeze past the ceiling.
async function createProvisioningOrg({ claimed = false } = {}) {
  return withTransaction(async (conn) => {
    const [[{ live }]] = await conn.query(
      `SELECT COUNT(*) AS live FROM organizations
        WHERE demo_state IN (?, ?, ?) FOR UPDATE`,
      LIVE_STATES
    );
    if (Number(live) >= config.demo.maxOrgs) return null;

    // gstin is UNIQUE and derived from the id, which we do not have until the
    // insert lands. A placeholder unique enough to survive the insert goes in
    // first and is corrected immediately after.
    const placeholder = `TMP${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`
      .slice(0, 15)
      .padEnd(15, 'X');

    const [result] = await conn.query(
      `INSERT INTO organizations
         (gstin, legal_name, trade_name, state_code, filer_type, demo_state, claimed_at, last_seen_at)
       VALUES (?, 'Sharma Electronics Private Limited', 'Sharma Electronics', '27', 'MONTHLY',
               'PROVISIONING', ?, NOW())`,
      [placeholder, claimed ? new Date() : null]
    );
    const orgId = Number(result.insertId);
    await conn.query('UPDATE organizations SET gstin = ? WHERE id = ?', [
      traderGstinFor(orgId),
      orgId
    ]);
    return orgId;
  });
}

async function deleteOrgRow(orgId) {
  await wipeOrgData(orgId);
  await pool.query('DELETE FROM users WHERE org_id = ?', [orgId]);
  await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [orgId]);
}

// InnoDB takes gap locks on the shared indexes of expected_invoices,
// portal_records and match_results, and it does so regardless of org_id — so two
// seeds for two DIFFERENT orgs can still deadlock against each other, and against
// the reaper's deletes. api/vitest.config.js documents the same hazard as the
// reason DB-backed suites do not run in parallel.
//
// A deadlock is not a failure, it is MySQL picking a victim and asking it to go
// again: one transaction is rolled back whole and the retry normally succeeds
// immediately. Treating it as fatal is what made a visitor land on an empty app —
// the seed died, the org was handed over anyway, and the judge saw "upload a
// purchase register" instead of the demo.
//
// Retrying is safe because seedDemoStory() begins by wiping the org, so an
// attempt always starts from the same empty state.
const RETRYABLE_DB_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const SEED_ATTEMPTS = 3;

async function seedWithRetry(orgId) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await seedDemoStory(orgId);
    } catch (err) {
      if (!RETRYABLE_DB_ERRORS.has(err.code) || attempt >= SEED_ATTEMPTS) throw err;
      console.warn(
        `[demo] seeding org ${orgId} hit ${err.code}; retrying (${attempt}/${SEED_ATTEMPTS - 1})`
      );
      // Brief, increasing back-off so the two losers of a deadlock do not
      // immediately collide again.
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

// Seeds an org that is already in PROVISIONING and moves it to `finalState`.
// A failure is recorded on the row rather than thrown at whoever happened to
// trigger it — the visitor is not the one who can fix a missing fixture.
async function seedInto(orgId, finalState, { priority = false } = {}) {
  try {
    await withSeedSlot(() => seedWithRetry(orgId), { priority });
    await pool.query(
      'UPDATE organizations SET demo_state = ?, demo_error = NULL WHERE id = ?',
      [finalState, orgId]
    );
    return { ok: true };
  } catch (err) {
    const message = String(err.message ?? err).slice(0, 255);
    console.error(`[demo] seeding org ${orgId} failed: ${message}`);
    if (finalState === 'POOL') {
      // Never handed out, so there is nothing to preserve. Drop it rather than
      // leaving a half-seeded row for the next visitor to be given.
      await deleteOrgRow(orgId).catch((cleanupErr) =>
        console.error(`[demo] could not clean up org ${orgId}: ${cleanupErr.message}`)
      );
    } else {
      // Somebody is holding a cookie for this one. Give it back to them with the
      // reason attached, so GET /api/session can show a retry instead of an
      // empty app.
      await pool.query(
        "UPDATE organizations SET demo_state = 'CLAIMED', demo_error = ? WHERE id = ?",
        [message, orgId]
      );
    }
    return { ok: false, error: message };
  }
}

// --- claiming --------------------------------------------------------------

// SKIP LOCKED is what makes this safe under concurrent first-visits: two requests
// racing for the pool take different rows instead of blocking on the same one.
async function claimFromPool() {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id FROM organizations
        WHERE demo_state = 'POOL'
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!rows.length) return null;
    const orgId = Number(rows[0].id);
    await conn.query(
      "UPDATE organizations SET demo_state = 'CLAIMED', claimed_at = NOW(), last_seen_at = NOW() WHERE id = ?",
      [orgId]
    );
    return orgId;
  });
}

// The first-request path. Returns { orgId, state } where state is READY when the
// visitor got a warm org and PROVISIONING when they are first in the queue for a
// cold one.
export async function claimSession() {
  const warm = await claimFromPool();
  if (warm !== null) {
    // Refilling is fire-and-forget: the visitor already has their org and must
    // not wait on the next one being built.
    void topUpPool();
    return { orgId: warm, state: 'READY' };
  }

  // Pool empty. Before making anyone wait, see whether an idle org can be
  // reclaimed to stay under the cap.
  const orgId = (await createProvisioningOrg({ claimed: true })) ?? (await reclaimForCapacity());
  if (orgId === null) {
    const error = new Error(
      'the demo is at capacity right now — a few sessions are already open. Try again in a minute.'
    );
    error.status = 503;
    error.code = 'demo_at_capacity';
    // A 5xx, but a deliberate one whose message is for the visitor to read.
    // Without this the production responder would redact it to "something went
    // wrong", and someone turned away at the door would be told nothing useful.
    error.expose = true;
    throw error;
  }

  void seedInto(orgId, 'CLAIMED', { priority: true }).then(() => topUpPool());
  return { orgId, state: 'PROVISIONING' };
}

// At the cap with an empty pool: delete the least recently seen claimed org that
// has been idle for at least a quarter of the normal TTL, and reuse the headroom.
// Somebody who has not touched the app for 45 minutes loses their session so
// somebody standing in front of it can have one.
async function reclaimForCapacity() {
  const graceMinutes = Math.max(5, Math.floor(config.demo.idleMinutes / 4));
  const [rows] = await pool.query(
    `SELECT id FROM organizations
      WHERE demo_state = 'CLAIMED'
        AND id <> ?
        AND last_seen_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
      ORDER BY last_seen_at ASC LIMIT 1`,
    [APP_ORG_ID, graceMinutes]
  );
  if (!rows.length) return null;
  const victim = await getDemoOrg(rows[0].id);
  assertDemoOrg(victim, 'reclaimForCapacity');
  console.log(`[demo] at capacity — reclaiming idle org ${victim.id}`);
  await deleteOrgRow(victim.id);
  return createProvisioningOrg({ claimed: true });
}

// --- keeping a session alive ----------------------------------------------

// last_seen_at drives the reaper, so it has to be written — but not on every
// request. The app makes several calls per screen and this would otherwise be a
// write per read. A minute of resolution is far finer than a three-hour TTL needs.
const touchedAt = new Map();
const TOUCH_INTERVAL_MS = 60_000;

export async function touchSession(orgId) {
  const now = Date.now();
  if (now - (touchedAt.get(orgId) ?? 0) < TOUCH_INTERVAL_MS) return;
  touchedAt.set(orgId, now);
  await pool
    .query("UPDATE organizations SET last_seen_at = NOW() WHERE id = ? AND demo_state = 'CLAIMED'", [
      orgId
    ])
    .catch((err) => console.error(`[demo] could not touch org ${orgId}: ${err.message}`));
}

// --- reset -----------------------------------------------------------------

// "Reset my data": wipe and rebuild the caller's own org, in place. The cookie,
// the org id and the trader GSTIN all stay the same — only the data underneath is
// rebuilt, so nobody else's session is touched and the visitor does not have to
// notice anything changed except that they are back at the start.
//
// Deliberately NOT a swap for a fresh pooled org, which would also have been
// instant: repeated resets would drain the pool that new arrivals depend on, and
// a reset is a click somebody is watching, where a progress state is fine.
export async function resetSession(orgId) {
  const row = await getDemoOrg(orgId);
  assertDemoOrg(row, 'resetSession');
  if (row.demo_state === 'PROVISIONING') return { state: 'PROVISIONING', alreadyRunning: true };

  await pool.query(
    "UPDATE organizations SET demo_state = 'PROVISIONING', demo_error = NULL, last_seen_at = NOW() WHERE id = ?",
    [orgId]
  );
  void seedInto(orgId, 'CLAIMED', { priority: true });
  return { state: 'PROVISIONING', alreadyRunning: false };
}

// --- the pool and the reaper ----------------------------------------------

let toppingUp = false;

export async function topUpPool() {
  if (toppingUp || !config.demo.enabled) return { created: 0, reason: toppingUp ? 'busy' : 'off' };
  if (!storyFixturesReady()) return { created: 0, reason: 'fixtures_missing' };
  toppingUp = true;
  let created = 0;
  try {
    for (;;) {
      const stats = await tenancyStats();
      const ready = stats.POOL + stats.PROVISIONING;
      if (ready >= config.demo.poolSize) break;
      if (stats.live >= config.demo.maxOrgs) break;
      const orgId = await createProvisioningOrg();
      if (orgId === null) break;
      const result = await seedInto(orgId, 'POOL');
      if (!result.ok) break; // a failing seed will keep failing; stop hammering it
      created += 1;
    }
  } finally {
    toppingUp = false;
  }
  return { created };
}

// Deletes what nobody is using. Three categories, all restricted to demo tenants:
//
//   RETIRED       — explicitly finished with
//   CLAIMED idle  — nobody has presented this cookie for idleMinutes
//   PROVISIONING  — stuck; a seed that started and never finished (a crash, or a
//                   restart mid-seed). Given a generous window first.
export async function reapIdleOrgs() {
  const idle = Math.max(5, config.demo.idleMinutes);
  const [rows] = await pool.query(
    `SELECT id, demo_state FROM organizations
      WHERE demo_state IS NOT NULL
        AND id <> ?
        AND (
              demo_state = 'RETIRED'
           OR (demo_state = 'CLAIMED'      AND last_seen_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
           OR (demo_state = 'PROVISIONING' AND last_seen_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
        )
      LIMIT 50`,
    [APP_ORG_ID, idle]
  );

  const deleted = [];
  for (const row of rows) {
    try {
      assertDemoOrg(row, 'reapIdleOrgs');
      await deleteOrgRow(row.id);
      touchedAt.delete(Number(row.id));
      deleted.push(Number(row.id));
    } catch (err) {
      console.error(`[demo] could not reap org ${row.id}: ${err.message}`);
    }
  }
  if (deleted.length) console.log(`[demo] reaped ${deleted.length} idle org(s): ${deleted.join(', ')}`);
  return deleted;
}

export async function sweep() {
  const reaped = await reapIdleOrgs();
  const { created } = await topUpPool();
  return { reaped, created };
}

// Started from index.js only, so importing the app in a test never starts a timer.
export function startDemoTenancy() {
  if (!config.demo.enabled) {
    console.log('[demo] per-visitor tenancy is OFF (set DEMO_TENANCY=on to enable)');
    return () => {};
  }
  if (!config.demo.secret) {
    console.warn(
      '[demo] DEMO_SESSION_SECRET is not set — signing cookies with a key generated at ' +
        'boot. Sessions will not survive a restart.'
    );
  }
  console.log(
    `[demo] per-visitor tenancy ON — pool ${config.demo.poolSize}, cap ${config.demo.maxOrgs}, ` +
      `idle TTL ${config.demo.idleMinutes}m`
  );

  const run = () =>
    sweep().catch((err) => console.error(`[demo] sweep failed: ${err.message}`));

  run();
  const timer = setInterval(run, Math.max(1, config.demo.sweepMinutes) * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
