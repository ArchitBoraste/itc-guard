// demo-reset.js — one command, one known state, ready to present.
//
//   npm run demo:reset
//
// Wipes org 1 and rebuilds the demo from the fixtures. The build itself lives in
// api/src/services/demoStory.js, because the public deployment gives every
// visitor their own copy of exactly this state and there can only be one
// definition of what "this state" is. This file is the CLI over it: it names the
// database first, prints what was built, and exits non-zero if the result is not
// the state it claims to be.
//
// What it produces:
//
//   1. March and April 2026 loaded and reconciled, through the REAL upload path.
//   2. One clean invoice in April confirmed as Accept.
//   3. That same invoice revised downward by the supplier in BOTH downloads.
//   4. April re-run, which drops the confirmation and flags CONFIRMATION_RESET.
//
// ORG 1 IS WIPED. That is the point of the script, and org 1 is the presenter's
// own org — the one stubAuth serves, and the one a per-visitor deployment
// deliberately keeps out of reach (its demo_state is NULL, so the reaper cannot
// see it and a session cookie naming it is refused). Nothing else in the repo is
// allowed to delete it; this is the sanctioned exception, so it prints the
// database it is about to clear first.
//
// Idempotent: every run starts by wiping, so running it twice — or between
// practice runs, or thirty seconds before presenting — lands on the same state.
import { closePool } from '../api/src/db/pool.js';
import { describeConnection } from '../api/src/config.js';
import { ensureOrg } from '../api/src/services/demo.js';
import { STORY_PERIOD, rupees, seedDemoStory } from '../api/src/services/demoStory.js';
import { writeWorkspaceClock } from '../api/src/services/workspaceClock.js';
import { addMonths } from '../api/src/matching/normalize.js';

const ORG_ID = 1;

async function main() {
  console.log('ITC Guard — demo reset');
  console.log(`database ${describeConnection()}`);

  console.log(`\nwiping org ${ORG_ID} (the presenter's own org)`);
  await ensureOrg(ORG_ID);

  // The 16th after the story period: past 2B on the 14th, before GSTR-3B on the
  // 20th. Set first, so the runs the story builds read it.
  const clock = await writeWorkspaceClock(ORG_ID, `${addMonths(STORY_PERIOD, 1)}-16`);
  console.log(`workspace date ${clock.asOfDate}`);

  const built = await seedDemoStory(ORG_ID, { log: (line) => console.log(line) });
  const { run, target, feed, invalidated, runId } = built;

  console.log('\nverified:');
  console.log(`  ${feed.total} changes on the feed, ${feed.invalidatedCount} invalidated decision`);
  console.log(
    `  invalidated row: ${invalidated.record.invoiceNo}  ` +
      `${rupees(invalidated.deltaTotalTax ?? 0)} of tax moved`
  );
  console.log(
    `  April run #${runId} is current (${run.bucketCounts.VALUE_MISMATCH ?? 0} value mismatches)`
  );

  console.log('\nready. To present:');
  console.log(`  Summary  — April 2026, ${rupees(run.totals.expectedTotalItc)} expected credit`);
  console.log(`  Actions  — opens with "A decision you made no longer applies": ${target.invoice_no}`);
  console.log('  Upload   — drop any file to watch the period re-run itself');
  console.log(
    `\nnote: the feed lists ${feed.total} changes for this invoice, one per source. The IMS ` +
      'one is loud because it carried the decision; the 2B one is the quiet half of the panel.'
  );
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(`\nfailed: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    await closePool();
    process.exit(1);
  });
