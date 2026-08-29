// The middleware that replaces stubAuth on the public deployment.
//
// stubAuth pinned every request to org 1, which is correct for one trader on one
// laptop and wrong for a URL two judges open at once. This resolves req.orgId
// from a signed httpOnly cookie instead, minting a session on the first request
// that arrives without a usable one.
//
// "Usable" is checked against the database every time, not just against the
// signature. Three things all land on the same recovery path — a fresh session —
// rather than on an error:
//
//   no cookie          a first visit
//   a bad cookie       truncated, hand-edited, or signed by a previous boot's key
//   a stale cookie     correctly signed, but naming an org the reaper has deleted
//
// That last one is the reason this cannot be signature-only. Cookies outlive the
// orgs they name by design.
import { config } from '../config.js';
import { ephemeralSecret, parseCookies, setCookie, sign, unsign } from './cookies.js';
import { APP_ORG_ID, claimSession, getDemoOrg, touchSession } from '../services/demoTenancy.js';

// Resolved once. Without DEMO_SESSION_SECRET this is random per boot, so a
// restart invalidates every cookie and each visitor is handed a new org — see
// the warning startDemoTenancy() prints.
const SECRET = config.demo.secret ?? ephemeralSecret();

const LIVE = new Set(['CLAIMED', 'PROVISIONING']);

function issue(res, orgId) {
  setCookie(res, config.demo.cookieName, sign(String(orgId), SECRET), {
    maxAgeSeconds: Math.max(1, config.demo.sessionHours) * 3600,
    secure: config.demo.cookieSecure
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
  if (!row || !LIVE.has(row.demo_state)) return null;
  return row;
}

export function demoSession(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const existing = await orgFromCookie(req);
      if (existing) {
        req.orgId = Number(existing.id);
        req.userId = null;
        req.sessionState = existing.demo_state === 'PROVISIONING' ? 'PROVISIONING' : 'READY';
        req.sessionError = existing.demo_error ?? null;
        req.sessionIsNew = false;
        await touchSession(req.orgId);
        return;
      }

      const claimed = await claimSession();
      issue(res, claimed.orgId);
      req.orgId = claimed.orgId;
      req.userId = null;
      req.sessionState = claimed.state;
      req.sessionError = null;
      req.sessionIsNew = true;
    })
    .then(() => next())
    .catch(next);
}

// Everything except the session routes needs an org that actually has data in it.
// 409 rather than 503: the request is fine, the session is simply not ready yet,
// and the web app knows to switch to the preparing screen on this code.
export function requireReadySession(req, res, next) {
  if (req.sessionState === 'PROVISIONING') {
    return res.status(409).json({
      error: 'session_provisioning',
      message: 'your demo data is still being prepared'
    });
  }
  next();
}
