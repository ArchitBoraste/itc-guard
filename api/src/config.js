import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Absolute paths derived from this module's own URL, never from process.cwd().
// Tests run from api/, tools run from the repo root, and the container runs from
// /app — all three have to resolve the same file.
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..');

export const ENV_FILES = [join(API_DIR, '.env'), join(REPO_ROOT, '.env')];

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
  }
};

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
