// demo.js — the one command that puts the whole thing on a projector.
//
//   npm run demo
//
// Brings up compose, waits for the database to actually be ready (not merely
// started), applies migrations, rebuilds the demo state, and prints the URL.
//
// It does NOT open a browser. On a projector an app stealing focus and opening a
// window on the wrong screen is a worse failure than a URL you type.
//
// Idempotent: every step is either a no-op when already done (compose up,
// migrations) or wipes and rebuilds (demo:reset). Running it twice in a row, or
// thirty seconds before presenting, lands on the same state.
//
// Fails loudly. A half-started demo that looks fine until the second click is
// worse than one that refused to start, so every step is checked and every
// failure names what to do about it.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WEB_URL = 'http://localhost:5173';
const API_HEALTH = 'http://localhost:3000/health';

const RULE = '-'.repeat(68);
const TOTAL_STEPS = 7;
let step = 0;

// --- output ---------------------------------------------------------------

const heading = (text) => console.log(`\n[${++step}/${TOTAL_STEPS}] ${text}`);
const detail = (text) => console.log(`      ${text}`);

// Every failure exits here, so there is exactly one place that decides what a
// broken demo looks like on screen.
function fail(title, lines) {
  console.error(`\n${RULE}`);
  console.error(`DEMO DID NOT START - ${title}`);
  console.error(RULE);
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}

// --- process helpers ------------------------------------------------------

// Quiet: capture and return, for probes whose output is noise.
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', shell: false });
  return {
    ok: result.status === 0,
    code: result.status,
    spawnError: result.error ?? null,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  };
}

// Loud: stream straight through, for the long steps where silence reads as a hang.
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: false });
    child.on('error', (error) => resolve({ ok: false, code: null, spawnError: error }));
    child.on('close', (code) => resolve({ ok: code === 0, code, spawnError: null }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until `check` returns true or the budget runs out. Keeps the last failure
// reason so the timeout message can say what it was still waiting on.
async function waitFor({ label, timeoutMs, intervalMs = 2000, check }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response yet';
  let announced = false;
  while (Date.now() < deadline) {
    const outcome = await check();
    if (outcome === true) return { ok: true };
    if (typeof outcome === 'string') last = outcome;
    if (!announced) {
      detail(`waiting for ${label} (up to ${Math.round(timeoutMs / 1000)}s)`);
      announced = true;
    }
    await sleep(intervalMs);
  }
  return { ok: false, last };
}

// --- step 1: is Docker there, and is it running ---------------------------

function checkDocker() {
  heading('Checking Docker');

  const version = capture('docker', ['version', '--format', '{{.Server.Version}}']);

  if (version.spawnError?.code === 'ENOENT') {
    fail('Docker is not installed, or is not on PATH', [
      '  `docker` could not be run at all.',
      '',
      '  Install Docker Desktop from https://docs.docker.com/desktop/ and make',
      '  sure a NEW terminal can run:  docker version'
    ]);
  }

  if (!version.ok) {
    // The daemon being down is by far the most common cause, and its error text
    // ("cannot connect to the Docker daemon", or a named-pipe message on Windows)
    // is not something anyone should have to interpret at 9am on stage.
    fail('Docker is installed but not running', [
      '  The Docker engine did not answer.',
      ...(version.stderr ? ['', `  docker said: ${version.stderr.split('\n')[0]}`] : []),
      '',
      '  Start Docker Desktop, wait until it reports Running, then:',
      '',
      '      npm run demo',
      '',
      '  Check it yourself with:  docker version'
    ]);
  }

  detail(`docker engine ${version.stdout}`);

  const compose = capture('docker', ['compose', 'version', '--short']);
  if (!compose.ok) {
    fail('Docker Compose v2 is not available', [
      '  `docker compose version` failed. This project needs Compose v2 — the',
      '  built-in subcommand, not the old standalone `docker-compose`.',
      ...(compose.stderr ? ['', `  docker said: ${compose.stderr.split('\n')[0]}`] : []),
      '',
      '  Docker Desktop ships it. On Linux, install the docker-compose-plugin package.'
    ]);
  }
  detail(`docker compose ${compose.stdout}`);
}

// --- step 2: the configuration every later step reads ---------------------

function ensureEnvFile() {
  heading('Checking configuration');

  const envPath = join(REPO_ROOT, '.env');
  const examplePath = join(REPO_ROOT, '.env.example');

  if (existsSync(envPath)) {
    detail('.env present, left alone');
    return;
  }
  if (!existsSync(examplePath)) {
    fail('no .env, and no .env.example to copy', [
      `  Expected one of these to exist:  ${envPath}`,
      `                                   ${examplePath}`,
      '',
      '  This looks like an incomplete checkout of the repository.'
    ]);
  }
  copyFileSync(examplePath, envPath);
  detail('.env created from .env.example (the defaults are what the demo wants)');
}

// --- step 3: bring the stack up -------------------------------------------

async function composeUp() {
  heading('Starting containers');

  const result = await run('docker', ['compose', 'up', '-d', '--build']);
  if (!result.ok) {
    fail('docker compose up failed', [
      '  The output above says why. The usual causes:',
      '',
      '  * a port is already taken - 3000 (api), 5173 (web) or 3307 (mysql).',
      '    Stop whatever holds it, or change the ports in docker-compose.yml.',
      '  * an earlier container is wedged:',
      '',
      '        docker compose down',
      '',
      '  * the database volume predates the current schema. This DELETES the',
      '    database and rebuilds it from scratch:',
      '',
      '        docker compose down -v'
    ]);
  }
}

// --- step 4: wait for the database to be genuinely ready ------------------

// `docker compose ps --format json` prints one object per line on Compose v2 and
// a single array on some builds. Accept both rather than pinning a version.
function composePs() {
  const result = capture('docker', ['compose', 'ps', '--format', 'json']);
  if (!result.ok || !result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}

async function waitForDb() {
  heading('Waiting for MySQL');

  // MySQL initialises its data directory on the very first boot, which is slow —
  // and that is exactly the run (a cold `down -v`) where giving up early would be
  // most confusing. Hence four minutes rather than one.
  const outcome = await waitFor({
    label: 'the database healthcheck',
    timeoutMs: 240_000,
    check: () => {
      const db = composePs().find((entry) => entry.Service === 'db');
      if (!db) return 'the db container is not running';
      if (db.State !== 'running') return `db container is ${db.State}`;
      if (db.Health === 'healthy') return true;
      return `db health is ${db.Health || 'not reported yet'}`;
    }
  });

  if (!outcome.ok) {
    fail('MySQL never became healthy', [
      `  Last seen: ${outcome.last}`,
      '',
      '  Read its log:',
      '',
      '      docker compose logs db',
      '',
      '  A data directory left behind by an older MySQL image will not start. This',
      '  DELETES the database and rebuilds it from scratch:',
      '',
      '      docker compose down -v'
    ]);
  }
  detail('healthy');
}

// --- step 5: schema ---------------------------------------------------------

async function migrate() {
  heading('Applying migrations');

  // Run in the container, so this step depends on nothing on the host: not Node
  // modules, not host-facing DB_* values. Already-applied files are a no-op.
  const result = await run('docker', ['compose', 'exec', '-T', 'api', 'npm', 'run', 'migrate']);
  if (!result.ok) {
    fail('migrations failed', [
      '  The migration runner names the database it is about to modify as its',
      '  first line - check that it is the one you expect.',
      '',
      '  A stale DB_* variable beats the .env file. Check what the container sees:',
      '',
      '      docker compose exec api env | grep ^DB_'
    ]);
  }
}

// --- step 6: the demo state -------------------------------------------------

async function installHostDeps() {
  detail('api/node_modules is missing - installing it (first run only)');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await run(npm, ['install', '--prefix', join(REPO_ROOT, 'api')]);
  if (!result.ok) {
    fail('npm install failed in api/', [
      '  The demo builder runs on the host and imports the API services directly,',
      '  so it needs api/node_modules for the MySQL and spreadsheet libraries.',
      '',
      '  Try it by hand:',
      '',
      '      cd api && npm install'
    ]);
  }
}

async function ensureFixtures() {
  // fixtures/ is generated and gitignored, so a fresh clone has none. Generation
  // is deterministic — one committed seed, the same 2,461 documents every time —
  // so doing it here is safe, but only when they are genuinely absent.
  if (existsSync(join(REPO_ROOT, 'fixtures', 'ground_truth.json'))) {
    detail('fixtures present');
    return;
  }
  detail('fixtures/ is empty - generating from the committed seed (deterministic)');
  const result = await run(process.execPath, [join(REPO_ROOT, 'tools', 'generate-fixtures.js')]);
  if (!result.ok) {
    fail('fixture generation failed', [
      '  Run it on its own to see the error:',
      '',
      '      npm run gen:fixtures'
    ]);
  }
}

async function buildDemoState() {
  heading('Building the demo state');

  if (!existsSync(join(REPO_ROOT, 'api', 'node_modules'))) await installHostDeps();
  await ensureFixtures();

  // demo-reset runs on the host: it imports the API's own services, and the image
  // does not carry tools/. It reaches MySQL over the published 3307 mapping, which
  // is what the repo-root .env is written for.
  const result = await run(process.execPath, [join(REPO_ROOT, 'tools', 'demo-reset.js')]);
  if (!result.ok) {
    fail('demo:reset failed', [
      '  The output above names the reason. demo:reset refuses to report success',
      '  unless the state it built is exactly the one it promises, so a failure',
      '  here means the demo would have shown the wrong thing.',
      '',
      '  It prints the database it connected to on its second line. If that is not',
      '  itc@127.0.0.1:3307/itc_guard, a DB_* variable in this shell is beating',
      '  the .env file:',
      '',
      '      env | grep ^DB_          (bash)',
      '      Get-ChildItem Env:DB_*   (powershell)'
    ]);
  }
}

// --- step 7: confirm both servers actually answer --------------------------

async function probe(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    return { ok: false, status: 0 };
  }
}

async function waitForServers() {
  heading('Checking the API and the web server');

  const api = await waitFor({
    label: 'the API health check',
    timeoutMs: 90_000,
    check: async () => {
      const response = await probe(API_HEALTH);
      if (!response.ok) return `no answer from ${API_HEALTH}`;
      const body = await response.json().catch(() => null);
      if (body?.db !== true) return 'the API is up but cannot reach the database';
      return true;
    }
  });

  if (!api.ok) {
    fail('the API never came up', [`  Last seen: ${api.last}`, '', '      docker compose logs api']);
  }
  detail('api ok, database reachable');

  const web = await waitFor({
    label: 'the Vite dev server',
    timeoutMs: 90_000,
    check: async () => ((await probe(WEB_URL)).ok ? true : `no answer from ${WEB_URL}`)
  });

  if (!web.ok) {
    fail('the web server never came up', [
      `  Last seen: ${web.last}`,
      '',
      '      docker compose logs web'
    ]);
  }
  detail('web ok');
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log('ITC Guard - demo');
  console.log('bringing up the stack and rebuilding the presentable state');

  checkDocker();
  ensureEnvFile();
  await composeUp();
  await waitForDb();
  await migrate();
  await buildDemoState();
  await waitForServers();

  console.log(`\n${RULE}`);
  console.log(`  ITC Guard is running at   ${WEB_URL}`);
  console.log('');
  console.log('  Open it yourself. This command deliberately does not launch a');
  console.log('  browser - a window opening on the wrong screen mid-presentation');
  console.log('  is not something you can undo.');
  console.log('');
  console.log(`  API health   ${API_HEALTH}`);
  console.log('  Stop it      docker compose down');
  console.log('  Rebuild just the demo state, nothing restarted:  npm run demo:reset');
  console.log(RULE);
}

main().catch((error) => {
  fail('unexpected error', [
    `  ${error?.message ?? error}`,
    '',
    ...(error?.stack ? error.stack.split('\n').slice(1, 4) : [])
  ]);
});
