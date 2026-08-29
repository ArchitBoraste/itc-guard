// Signed cookies, hand-rolled.
//
// The whole requirement is "an httpOnly cookie holding an org id that a visitor
// cannot edit into someone else's". That is an HMAC and a header, so it is those
// rather than a dependency: cookie-parser plus cookie-signature would add two
// packages to sign one integer.
//
// The signature covers the value only. It is not an expiring token — expiry is
// the cookie's own Max-Age, and the server re-checks that the org named still
// exists and is still claimed on every request. A cookie surviving past either is
// treated as absent, not as an error.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // a hand-mangled %-escape is still a value we can reject
    }
  }
  return out;
}

const b64url = (buffer) => buffer.toString('base64url');

function mac(value, secret) {
  return b64url(createHmac('sha256', secret).update(value).digest());
}

export function sign(value, secret) {
  return `${value}.${mac(String(value), secret)}`;
}

// Returns the value, or null for anything that is not a signature we produced.
// Every rejection path returns null rather than throwing: a malformed cookie is
// an ordinary event (an old deploy, a truncated header, someone poking at it),
// and it has to land the visitor on a fresh session, not on a 500.
export function unsign(signed, secret) {
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const value = signed.slice(0, dot);
  const provided = signed.slice(dot + 1);
  const expected = mac(value, secret);
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a wrong length is not a secret worth protecting.
  if (provided.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return value;
}

// Appends rather than replaces: another handler may already have set one.
export function setCookie(res, name, value, { maxAgeSeconds, secure = false, sameSite = 'Lax' } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`
  ];
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (secure) parts.push('Secure');

  const existing = res.getHeader('Set-Cookie');
  const header = parts.join('; ');
  if (!existing) res.setHeader('Set-Cookie', header);
  else res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, header] : [existing, header]);
}

export function clearCookie(res, name, { secure = false } = {}) {
  setCookie(res, name, '', { maxAgeSeconds: 0, secure });
}

// Used when DEMO_SESSION_SECRET is unset. Cookies then die with the process,
// which is a restart handing everyone a new org — recoverable, and far better
// than a signing key that is public because it lives in the repo.
export function ephemeralSecret() {
  return randomBytes(32).toString('hex');
}
