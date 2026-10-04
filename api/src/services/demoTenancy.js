// One private workspace per visitor.
//
// A visitor's first request creates an EMPTY org and hands it over in the same
// request: the demo starts on the Upload screen with nothing in it, so there is
// no seeding to wait for and no pool of seeded orgs to keep warm. The signed
// cookie naming it lasts 180 days (http/session.js), so the workspace survives
// refreshes and return visits.
//
// What keeps the database bounded: a hard cap on live workspaces, and a reaper
// that deletes a workspace nobody has touched for a while. The reaper never
// deletes a workspace with an upload in the last 30 days, however idle: someone
// who built a demo yesterday must find it there tomorrow.
//
// SAFETY: every write here is constrained to rows with a non-NULL demo_state.
// Org 1 (the presenter's own org) and the reserved test orgs in
// test/helpers/db.js have demo_state IS NULL, so they are outside the reach of the
// reaper by construction and not merely by an id check. assertDemoOrg() re-checks.
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { traderGstinFor } from './demo.js';
import { wipeOrgData } from './demoStory.js';
import { ServiceError } from './ingest.js';

export const APP_ORG_ID = 1;

// Workspaces counted against the cap. POOL and PROVISIONING are left over from
// the seeded pool this replaced; nothing creates them now and the reaper deletes
// them, but until it does they still hold rows.
const COUNTED_STATES = ['CLAIMED', 'POOL', 'PROVISIONING'];

// --- guards ----------------------------------------------------------------

// Nothing in this module may write to an org that is not a demo tenant. Org 1 is
// named explicitly on top of the demo_state check because it is the one mistake
// whose cost is the presenter losing the demo.
function assertDemoOrg(row, action) {
  if (!row) throw new Error(`${action}: org not found`);
  if (Number(row.id) === APP_ORG_ID) {
    throw new Error(`${action} refuses org ${APP_ORG_ID}: that is the application's own org`);
  }
  if (!row.demo_state) {
    throw new Error(`${action} refuses org ${row.id}: it is not a demo tenant (demo_state IS NULL)`);
  }
}

// An org worth keeping: an upload within the retention window. Shared by the
// reaper and the reclaim at the cap, so the two cannot disagree. Reads the org as o.
const HAS_RECENT_UPLOAD = `EXISTS (
  SELECT 1 FROM uploads u
   WHERE u.org_id = o.id AND u.created_at > DATE_SUB(NOW(), INTERVAL ? DAY))`;

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
    live: COUNTED_STATES.reduce((sum, state) => sum + counts[state], 0),
    maxOrgs: config.demo.maxOrgs
  };
}

// --- creating ----------------------------------------------------------------

// Inserts an empty, claimed workspace and returns its id, or null at the cap. The
// count and the insert share one transaction so two simultaneous first visits
// cannot both squeeze past the ceiling.
async function createWorkspaceOrg() {
  return withTransaction(async (conn) => {
    const [[{ live }]] = await conn.query(
      'SELECT COUNT(*) AS live FROM organizations WHERE demo_state IN (?) FOR UPDATE',
      [COUNTED_STATES]
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
               'CLAIMED', NOW(), NOW())`,
      [placeholder]
    );
    const orgId = Number(result.insertId);
    await conn.query('UPDATE organizations SET gstin = ? WHERE id = ?', [traderGstinFor(orgId), orgId]);
    return orgId;
  });
}

async function deleteOrgRow(orgId) {
  await wipeOrgData(orgId);
  await pool.query('DELETE FROM users WHERE org_id = ?', [orgId]);
  await pool.query('DELETE FROM organizations WHERE id = ? AND demo_state IS NOT NULL', [orgId]);
}

// The first-request path: a new, empty workspace -> { orgId, state: 'READY' }.
export async function claimSession() {
  const orgId = (await createWorkspaceOrg()) ?? (await reclaimForCapacity());
  if (orgId === null) {
    const error = new Error(
      'the demo is at capacity right now: every workspace is in use. Try again in a minute.'
    );
    error.status = 503;
    error.code = 'demo_at_capacity';
    // A 5xx, but a deliberate one whose message is for the visitor to read.
    // Without this the production responder would redact it to "something went
    // wrong", and someone turned away at the door would be told nothing useful.
    error.expose = true;
    throw error;
  }
  return { orgId, state: 'READY' };
}

// At the cap: delete the least recently seen workspace that may go, and reuse the
// headroom. Leftovers of the old pool go first; then a claimed workspace idle for
// a quarter of the normal TTL with no upload in the retention window. A workspace
// someone uploaded to this month is never taken, even to let a new visitor in.
async function reclaimForCapacity() {
  const graceMinutes = Math.max(5, Math.floor(config.demo.idleMinutes / 4));
  const [rows] = await pool.query(
    `SELECT o.id FROM organizations o
      WHERE o.id <> ?
        AND (o.demo_state IN ('POOL', 'RETIRED')
          OR (o.demo_state = 'CLAIMED'
              AND o.last_seen_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
              AND NOT ${HAS_RECENT_UPLOAD}))
      ORDER BY o.demo_state = 'CLAIMED', o.last_seen_at ASC
      LIMIT 1`,
    [APP_ORG_ID, graceMinutes, config.demo.retainDays]
  );
  if (!rows.length) return null;
  const victim = await getDemoOrg(rows[0].id);
  assertDemoOrg(victim, 'reclaimForCapacity');
  console.log(`[demo] at capacity: reclaiming workspace ${victim.id}`);
  await deleteOrgRow(victim.id);
  return createWorkspaceOrg();
}

// --- keeping a session alive -------------------------------------------------

// last_seen_at drives the reaper, so it has to be written, but not on every
// request: the app makes several calls per screen. A minute of resolution is far
// finer than the idle TTL needs. Returns whether it wrote, so the caller can
// renew the cookie at the same rate.
const touchedAt = new Map();
const TOUCH_INTERVAL_MS = 60_000;

export async function touchSession(orgId) {
  const now = Date.now();
  if (now - (touchedAt.get(orgId) ?? 0) < TOUCH_INTERVAL_MS) return false;
  touchedAt.set(orgId, now);
  await pool
    .query("UPDATE organizations SET last_seen_at = NOW() WHERE id = ? AND demo_state = 'CLAIMED'", [
      orgId
    ])
    .catch((err) => console.error(`[demo] could not touch org ${orgId}: ${err.message}`));
  return true;
}

// --- clear all data ------------------------------------------------------------

// "Clear all data": the caller's workspace back to how a new visitor gets it.
// Every upload, run, decision and supplier detail goes, and the date follows
// today again. The cookie, the org id and the trader GSTIN stay, so nothing else
// changes for the visitor and nobody else's workspace is touched.
//
// perVisitor false is the single-trader mode (DEMO_TENANCY off): the caller is
// the one stubbed trader, and it is their data that goes. A visitor's workspace
// is never cleared that way, whatever the request says.
export async function clearWorkspace(orgId, { perVisitor = true } = {}) {
  const row = await getDemoOrg(orgId);
  if (perVisitor) {
    assertDemoOrg(row, 'clearWorkspace');
  } else if (!row) {
    throw new ServiceError('workspace not found', 404, 'not_found');
  } else if (row.demo_state) {
    throw new ServiceError(
      'this deployment has one trader, and this is a visitor workspace: it is not cleared from here',
      409,
      'conflict'
    );
  }
  await wipeOrgData(orgId);
  await pool.query(
    `UPDATE organizations
        SET as_of_date = NULL, demo_error = NULL,
            last_seen_at = IF(demo_state IS NULL, last_seen_at, NOW())
      WHERE id = ?`,
    [orgId]
  );
  return { orgId: Number(orgId) };
}

// --- the reaper ----------------------------------------------------------------

// Deletes what nobody is using, restricted to demo tenants:
//
//   RETIRED, POOL  finished with, or left over from the seeded pool
//   PROVISIONING   a seed from before the pool was retired that never finished
//   CLAIMED        idle for idleMinutes AND no upload in the last retainDays
export async function reapIdleOrgs() {
  const idle = Math.max(5, config.demo.idleMinutes);
  const [rows] = await pool.query(
    `SELECT o.id, o.demo_state FROM organizations o
      WHERE o.demo_state IS NOT NULL
        AND o.id <> ?
        AND (o.demo_state IN ('RETIRED', 'POOL')
          OR (o.demo_state = 'PROVISIONING' AND o.last_seen_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
          OR (o.demo_state = 'CLAIMED'
              AND o.last_seen_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
              AND NOT ${HAS_RECENT_UPLOAD}))
      LIMIT 50`,
    [APP_ORG_ID, idle, config.demo.retainDays]
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
  if (deleted.length) console.log(`[demo] reaped ${deleted.length} idle workspace(s): ${deleted.join(', ')}`);
  return deleted;
}

// Started from index.js only, so importing the app in a test never starts a timer.
export function startDemoTenancy() {
  if (!config.demo.enabled) {
    console.log('[demo] per-visitor workspaces are OFF (set DEMO_TENANCY=on to enable)');
    return () => {};
  }
  if (!config.demo.secret) {
    console.warn(
      '[demo] DEMO_SESSION_SECRET is not set: signing cookies with a key generated at ' +
        'boot. Workspaces will not survive a restart.'
    );
  }
  console.log(
    `[demo] per-visitor workspaces ON: cap ${config.demo.maxOrgs}, idle TTL ` +
      `${config.demo.idleMinutes}m, kept ${config.demo.retainDays} days after an upload`
  );

  const run = () => reapIdleOrgs().catch((err) => console.error(`[demo] sweep failed: ${err.message}`));
  run();
  const timer = setInterval(run, Math.max(1, config.demo.sweepMinutes) * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
