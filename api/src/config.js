import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DEFAULT_MATERIALITY_TOLERANCE_PAISE } from './matching/recommend.js';

// Absolute paths derived from this module's own URL, never from process.cwd().
// Tests run from api/, tools run from the repo root, and the container runs from
// /app — all three have to resolve the same file.
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..');

export const ENV_FILES = [join(API_DIR, '.env'), join(REPO_ROOT, '.env')];

// Fixture bundle used by the demo seed. Mounted at /app/fixtures in the container,
// sitting at <repo>/fixtures when the api runs on the host.
const FIXTURE_CANDIDATES = [join(API_DIR, 'fixtures'), join(REPO_ROOT, 'fixtures')];

// Snapshot before loading so we can tell where each value actually came from.
const preexisting = new Set(Object.keys(process.env));

// override: false — a real environment variable beats the file. That is required
// for Docker Compose, which injects DB_HOST=db / DB_PORT=3306 for the api
// container and must win over the host-facing values in the repo-root .env.
//
// The cost of that rule is real: any UNRELATED DB_* left set in the shell also
// wins, and silently points the app at the wrong database. That is what
// describeConnection() below exists to make visible.
const loaded = dotenv.config({ path: ENV_FILES, override: false });

const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

// 'environment' — inherited from the shell or injected by compose; beats the file.
// 'env-file'    — supplied by one of ENV_FILES.
// 'default'     — not set anywhere; the fallback below is in use.
function sourceOf(key) {
  if (preexisting.has(key)) return 'environment';
  if (loaded.parsed && key in loaded.parsed) return 'env-file';
  return 'default';
}

export const envSources = Object.fromEntries(DB_KEYS.map((key) => [key, sourceOf(key)]));

export const envFilesFound = ENV_FILES.filter((path) => existsSync(path));

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: process.env.DB_USER ?? 'itc',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'itc_guard'
  },
  fixturesDir:
    process.env.FIXTURES_DIR ?? FIXTURE_CANDIDATES.find((path) => existsSync(path)) ?? null,

  // Per-visitor demo tenancy. Off by default so `npm test` and a local dev run
  // keep the old single-org behaviour; the public deployment sets DEMO_TENANCY=on.
  //
  // Read lazily, unlike the db block above. These are deployment knobs rather
  // than connection settings, nothing caches them across a request, and reading
  // them at access time means a test can turn tenancy on without having to win a
  // race against module load order.
  get demo() {
    return demoConfig();
  },

  // Supplier email, read lazily for the same reason as demo. Every value comes from
  // the environment and none is ever logged.
  get mail() {
    return mailConfig();
  },

  // Recommendation tuning, read lazily for the same reason as demo.
  get matching() {
    return {
      // A value mismatch whose total tax differs by no more than this many paise
      // is accepted as immaterial. See DEFAULT_MATERIALITY_TOLERANCE_PAISE.
      materialityTolerancePaise: paiseSetting(
        'MATERIALITY_TOLERANCE_PAISE',
        DEFAULT_MATERIALITY_TOLERANCE_PAISE
      )
    };
  }
};

// A money setting is integer paise. Anything else is refused by name rather than
// parsed into a number nobody meant.
function paiseSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of paise, 0 or more (got "${raw}")`);
  }
  return value;
}

const env = (name) => (process.env[name] ?? '').trim();

// Google's fast, low-cost stable model at the time of writing; GEMINI_MODEL overrides.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

function mailConfig() {
  const port = Number(env('SMTP_PORT') || 465);
  const smtp = { host: env('SMTP_HOST'), port, secure: port === 465, user: env('SMTP_USER'), pass: env('SMTP_PASS') };
  return {
    // Not configured -> the Email button stays a mailto link and no poller runs.
    enabled: Boolean(smtp.host && smtp.user && smtp.pass),
    smtp,
    imap: { host: env('IMAP_HOST'), port: 993, user: smtp.user, pass: smtp.pass },
    // Lower-cased addresses the app may send to. Empty sends to nobody.
    allowlist: env('EMAIL_ALLOWLIST').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    dailyLimit: Number(env('EMAIL_DAILY_LIMIT') || 30),
    pollSeconds: Number(env('IMAP_POLL_SECONDS') || 30),
    gemini: { apiKey: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL }
  };
}

function demoConfig() {
  return {
    enabled: (process.env.DEMO_TENANCY ?? 'off').toLowerCase() === 'on',
    cookieName: process.env.DEMO_COOKIE_NAME ?? 'itcg_session',
    // No built-in default on purpose. A hard-coded fallback secret in a public
    // repo is a forgeable cookie; an absent one is replaced by a random key at
    // boot, which merely means cookies do not survive a restart.
    secret: process.env.DEMO_SESSION_SECRET ?? null,
    // Secure in production unless told otherwise; a local http run needs it off.
    cookieSecure: (process.env.DEMO_COOKIE_SECURE ?? String(process.env.NODE_ENV === 'production'))
      .toLowerCase() === 'true',
    // How long a visitor's cookie lasts, renewed as they use the app. A workspace
    // has to survive coming back to the demo days later.
    sessionDays: Number(process.env.DEMO_SESSION_DAYS ?? 180),
    // Hard ceiling on live workspaces. Org 1 and the reserved test orgs are not
    // demo orgs and never count towards it. An empty workspace is one row, so the
    // cap bounds disk, not memory; see DEMO_MAX_ORGS in .env.prod.example.
    maxOrgs: Number(process.env.DEMO_MAX_ORGS ?? 200),
    // A workspace untouched for this long is deleted, unless it was uploaded to
    // within retainDays.
    idleMinutes: Number(process.env.DEMO_IDLE_MINUTES ?? 180),
    retainDays: Number(process.env.DEMO_RETAIN_DAYS ?? 30),
    // How often the reaper runs.
    sweepMinutes: Number(process.env.DEMO_SWEEP_MINUTES ?? 5)
  };
}

// user@host:port/database — never the password.
export function connectionTarget() {
  return `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`;
}

// One line naming the target AND where it came from. Without the provenance half,
// a stale DB_HOST in the shell looks exactly like a correct one.
export function describeConnection() {
  const fromEnvironment = DB_KEYS.filter((key) => envSources[key] === 'environment');
  let provenance;
  if (fromEnvironment.length === DB_KEYS.length) {
    provenance = 'all from environment';
  } else if (fromEnvironment.length === 0) {
    provenance = `from ${envFilesFound.length ? 'env file' : 'built-in defaults'}`;
  } else {
    provenance =
      `${fromEnvironment.join(', ')} from environment (overriding the env file), rest from file`;
  }
  return `${connectionTarget()}  [${provenance}]`;
}
