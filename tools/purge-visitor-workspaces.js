// purge-visitor-workspaces.js — list or delete visitor workspaces. Never org 1.
//
//   node tools/purge-visitor-workspaces.js                    list every one
//   node tools/purge-visitor-workspaces.js --all              what --all --yes would delete
//   node tools/purge-visitor-workspaces.js --all --yes        delete every visitor workspace
//   node tools/purge-visitor-workspaces.js --org 1234 --yes   delete just that one
//
// On the server, from the api image (after migrations, which it needs):
//
//   dc run --rm api node /app/tools/purge-visitor-workspaces.js --all --yes
//
// A visitor workspace is an org with demo_state set: the claimed ones, and what is
// left of the old seeded pool. Org 1 (the presenter's) and the test orgs have
// demo_state NULL and are never listed, and deleteVisitorWorkspace() re-checks
// each one before it goes. A visitor whose workspace is deleted is handed a new,
// empty one on their next request; nothing errors.
//
// Without --yes nothing is deleted. Prints the database it is pointed at first.
import { closePool } from '../api/src/db/pool.js';
import { describeConnection } from '../api/src/config.js';
import {
  APP_ORG_ID,
  deleteVisitorWorkspace,
  listVisitorWorkspaces
} from '../api/src/services/demoTenancy.js';

function parseArgs(argv) {
  const args = { all: false, yes: false, orgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') args.all = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--org') args.orgs.push(...String(argv[++i] ?? '').split(','));
    else if (arg.startsWith('--org=')) args.orgs.push(...arg.slice(6).split(','));
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.orgs = args.orgs.filter(Boolean).map(Number);
  if (args.orgs.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('--org takes org ids');
  if (args.orgs.includes(APP_ORG_ID)) throw new Error(`org ${APP_ORG_ID} is the presenter's and is never deleted here`);
  if (args.all && args.orgs.length) throw new Error('--all and --org are exclusive');
  return args;
}

const describe = (row) =>
  `  org ${String(row.id).padEnd(6)} ${String(row.demo_state).padEnd(12)} created ${row.created_at}  ` +
  `last seen ${row.last_seen_at ?? '-'}  ${row.uploads} upload(s)` +
  (row.last_upload_at ? `, last ${row.last_upload_at}` : '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('ITC Guard — visitor workspaces');
  console.log(`database ${describeConnection()}`);

  const all = await listVisitorWorkspaces();
  const counts = all.reduce((acc, row) => ({ ...acc, [row.demo_state]: (acc[row.demo_state] ?? 0) + 1 }), {});
  console.log(`\n${all.length} visitor workspace(s)` +
    (all.length ? `: ${Object.entries(counts).map(([state, n]) => `${n} ${state}`).join(', ')}` : ''));

  const targets = args.all ? all : all.filter((row) => args.orgs.includes(row.id));
  const missing = args.orgs.filter((id) => !all.some((row) => row.id === id));
  if (missing.length) console.log(`not visitor workspaces (or gone already): ${missing.join(', ')}`);

  if (!args.all && !args.orgs.length) {
    for (const row of all) console.log(describe(row));
    return;
  }
  for (const row of targets) console.log(describe(row));
  if (!args.yes) {
    console.log(`\n${targets.length} would be deleted. Add --yes to delete them.`);
    return;
  }

  let deleted = 0;
  for (const row of targets) {
    try {
      await deleteVisitorWorkspace(row.id);
      deleted += 1;
    } catch (err) {
      console.error(`  could not delete org ${row.id}: ${err.message}`);
    }
  }
  const left = await listVisitorWorkspaces();
  console.log(`\ndeleted ${deleted} of ${targets.length}; ${left.length} visitor workspace(s) left`);
  if (deleted !== targets.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`failed: ${err.message}`);
    process.exitCode = 2;
  })
  .finally(closePool);
