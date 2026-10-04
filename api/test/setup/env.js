// Vitest setup: resolve the database configuration before any test module loads.
//
// Vitest runs with cwd = api/, so anything resolving .env relative to the working
// directory finds nothing. src/config.js already derives its paths from its own
// module URL, so importing it here is all that is needed — and importing it rather
// than calling dotenv a second time keeps ONE loader. A second dotenv.config()
// would populate process.env before config.js snapshots it, and config.js would
// then report every value as coming from the environment, which is exactly the
// warning that must stay trustworthy.
//
// Loading is override:false, matching src/config.js: a real environment variable
// still wins so Docker Compose can inject DB_HOST=db. The cost is that a stale
// DB_* left in the shell also wins, which is why the resolved target is printed
// once at the top of every run.
import { existsSync } from 'node:fs';
import { describeConnection, ENV_FILES } from '../../src/config.js';

if (!process.env.ITC_QUIET_ENV) {
  const found = ENV_FILES.filter((path) => existsSync(path));
  console.log(
    `[test env] ${found.length ? `env file: ${found.join(', ')}` : 'no .env file found'}\n` +
      `[test env] database ${describeConnection()}`
  );
}

// Suites run single-trader unless they turn tenancy on themselves, as the tenancy
// suite does. A DEMO_TENANCY=on from the environment (docker compose's default for
// local dev) must not change what every other suite exercises.
process.env.DEMO_TENANCY = 'off';

// Nor may a developer's mail settings: no suite sends a real email, polls a real
// mailbox or calls Gemini. The email suites configure a fake transport themselves.
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'IMAP_HOST', 'EMAIL_ALLOWLIST', 'GEMINI_API_KEY', 'GEMINI_MODEL']) {
  delete process.env[name];
}
