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
