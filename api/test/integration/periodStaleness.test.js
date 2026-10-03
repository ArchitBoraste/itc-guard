// A run is out of date only when records for ITS OWN period arrived after it.
//
// The audit's P2: a fresh visitor opened March and read "This run is out of date
// — 804 records arrived after this run", with the IMS download disabled. The 804
// were April's 384 IMS and 420 2B records. The run reads its ±1 month neighbours
// as match CANDIDATES, and the staleness count used the same window, so every
// month went stale the moment the next one was loaded — and re-running changed
// nothing, because the results were already right.
//
// Owns org 18.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg, seedDemoPeriod } from '../../src/services/demo.js';
import { seedDemoStory } from '../../src/services/demoStory.js';
import { getRunByPeriod } from '../../src/services/reconcile.js';
import { TEST_ORGS, ingest, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT, readJson } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.periodStaleness;
const MARCH = '2026-03';
const APRIL = '2026-04';
const MAY = '2026-05';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');

async function stalenessOf(taxPeriod) {
  return (await getRunByPeriod(ORG_ID, taxPeriod)).staleness;
}

describe('staleness counts only the run’s own period', () => {
  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID);
    await resetOrg(ORG_ID);
    // Exactly what a fresh visitor gets: March, then April, then the April story.
    await seedDemoStory(ORG_ID);
  }, 240000);

  afterAll(async () => {
    await closePool();
  });

  it('opens a fresh session with March current, so its download is not blocked', async () => {
    // The download is gated on isStale (web/src/components/ImsDownload.jsx).
    const march = await stalenessOf(MARCH);
    expect(march).toMatchObject({
      isStale: false,
      unseenRecords: 0,
      staleResults: 0,
      inputCountsKnown: true
    });
    expect((await stalenessOf(APRIL)).isStale).toBe(false);
  });

  it('does not put April out of date when May is loaded', async () => {
    await seedDemoPeriod(ORG_ID, { taxPeriod: MAY });

    expect(await stalenessOf(APRIL)).toMatchObject({ isStale: false, unseenRecords: 0 });
    expect((await stalenessOf(MARCH)).isStale).toBe(false);
    expect((await stalenessOf(MAY)).isStale).toBe(false);
  }, 240000);

  it('puts April out of date when a new April record arrives, and nothing else', async () => {
    const json = readJson(APRIL, 'ims.json');
    json.imsDetails.b2b.push({ ...json.imsDetails.b2b[0], inum: 'LATE/APRIL/1' });
    // Deliberately the path that does NOT re-run (the commit route would rebuild
    // April straight away): this is the detection on its own.
    const committed = await ingest(ORG_ID, 'IMS', 'ims.json', APRIL, asBuffer(json));
    expect(committed.inserted).toBe(1);

    expect(await stalenessOf(APRIL)).toMatchObject({ isStale: true, unseenRecords: 1 });
    // March and May hold April in their windows; the record is still not theirs.
    expect((await stalenessOf(MARCH)).isStale).toBe(false);
    expect((await stalenessOf(MAY)).isStale).toBe(false);
  }, 240000);
});
