// Loading a sample period again never silently undoes what changed since.
//
// The audit's P23: re-loading April from Upload put the original sample files
// back, so Mahavir Sales Corp 06-17/AMD/3538 — revised down Rs 5,000 after the
// trader accepted it, the scripted demo story — was MATCHED again and the story
// was gone, with nothing said. A commit now replaces its period, which would make
// that worse, so the reload refuses with the reason instead. A period that is
// still exactly the sample reloads as before.
//
// Owns org 23.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg, seedDemoPeriod } from '../../src/services/demo.js';
import { STORY_PERIOD, seedDemoStory } from '../../src/services/demoStory.js';
import { getRunByPeriod, listResults } from '../../src/services/reconcile.js';
import { listChangesForRun } from '../../src/services/syncDiff.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.sampleReload;
const MARCH = '2026-03';
const STORY_INVOICE = '06-17/AMD/3538';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

async function storyRow() {
  const run = await getRunByPeriod(ORG_ID, STORY_PERIOD);
  const page = await listResults(ORG_ID, run.id, { bucket: 'VALUE_MISMATCH', pageSize: 500 });
  return page.results.find((row) => row.books?.invoiceNo === STORY_INVOICE) ?? null;
}

describe('re-loading a sample period', () => {
  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID);
    await resetOrg(ORG_ID);
    await seedDemoStory(ORG_ID);
  }, 240000);

  afterAll(async () => {
    await closePool();
  });

  it('refuses to re-load April, which would undo the demo story, and says why', async () => {
    await expect(seedDemoPeriod(ORG_ID, { taxPeriod: STORY_PERIOD })).rejects.toMatchObject({
      status: 409,
      code: 'sample_reload_refused',
      message: expect.stringContaining('demo story')
    });

    // Nothing was touched: the revision, and the decision it dropped, still stand.
    expect(await storyRow()).toBeTruthy();
    const run = await getRunByPeriod(ORG_ID, STORY_PERIOD);
    expect((await listChangesForRun(ORG_ID, run.id)).invalidatedCount).toBe(1);
  }, 120000);

  it('still re-loads a period that is exactly the sample', async () => {
    const reloaded = await seedDemoPeriod(ORG_ID, { taxPeriod: MARCH });
    // The same files again: nothing new, nothing changed, nothing replaced.
    expect(reloaded.uploads.map((upload) => upload.inserted)).toEqual([0, 0, 0]);
    expect(reloaded.uploads.map((upload) => upload.replaced)).toEqual([0, 0, 0]);
    expect(reloaded.uploads.every((upload) => !upload.changes)).toBe(true);
    expect(reloaded.run.staleness.isStale).toBe(false);
    expect(await storyRow()).toBeTruthy();
  }, 120000);
});
