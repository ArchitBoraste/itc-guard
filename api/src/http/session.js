// The middleware that replaces stubAuth on the public deployment.
//
// stubAuth pinned every request to org 1, which is correct for one trader on one
// laptop and wrong for a URL two judges open at once. This resolves req.orgId
// from a signed httpOnly cookie instead, creating an empty workspace on the first
// request that arrives without a usable one.
//
// The cookie lasts DEMO_SESSION_DAYS (180) and is renewed as the visitor uses the
// app, so a workspace survives refreshes and return visits. It is httpOnly,
// SameSite=Lax, and Secure wherever the site is served over HTTPS.
//
// "Usable" is checked against the database every time, not just against the
// signature. Three things all land on the same recovery path, a fresh workspace,
// rather than on an error:
//
//   no cookie          a first visit
//   a bad cookie       truncated, hand-edited, or signed by a previous boot's key
//   a stale cookie     correctly signed, but naming an org the reaper has deleted
//
// That last one is why this cannot be signature-only. Cookies outlive the orgs
// they name by design.
import { config } from '../config.js';
import { ephemeralSecret, parseCookies, setCookie, sign, unsign } from './cookies.js';
import { APP_ORG_ID, claimSession, getDemoOrg, touchSession } from '../services/demoTenancy.js';

// Resolved once. Without DEMO_SESSION_SECRET this is random per boot, so a
// restart invalidates every cookie and each visitor is handed a new workspace —
// see the warning startDemoTenancy() prints.
const SECRET = config.demo.secret ?? ephemeralSecret();

const DAY_SECONDS = 24 * 3600;

function issue(res, orgId) {
  setCookie(res, config.demo.cookieName, sign(String(orgId), SECRET), {
    maxAgeSeconds: Math.max(1, config.demo.sessionDays) * DAY_SECONDS,
    secure: config.demo.cookieSecure,
    sameSite: 'Lax'
  });
}

// Reads the cookie and returns the org it names, or null. Never throws.
async function orgFromCookie(req) {
  const raw = parseCookies(req.headers?.cookie)[config.demo.cookieName];
  if (!raw) return null;

  const value = unsign(raw, SECRET);
  if (value === null) return null;

  const orgId = Number(value);
  if (!Number.isInteger(orgId) || orgId <= 0) return null;

  // A cookie naming org 1 is refused rather than honoured. Org 1 is the
  // presenter's own data; nothing that arrives over the wire may address it.
  if (orgId === APP_ORG_ID) return null;

  const row = await getDemoOrg(orgId);
  return row?.demo_state === 'CLAIMED' ? row : null;
}

export function demoSession(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const existing = await orgFromCookie(req);
      if (existing) {
        req.orgId = Number(existing.id);
        req.sessionIsNew = false;
        // Renewed at the rate last_seen_at is written: once a minute at most.
        if (await touchSession(req.orgId)) issue(res, req.orgId);
      } else {
        const claimed = await claimSession();
        issue(res, claimed.orgId);
        req.orgId = claimed.orgId;
        req.sessionIsNew = true;
      }
      req.userId = null;
      req.sessionState = 'READY';
      req.sessionError = null;
    })
    .then(() => next())
    .catch(next);
}
