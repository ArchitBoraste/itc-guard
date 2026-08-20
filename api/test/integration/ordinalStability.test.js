// identity_key contains an ORDINAL, and an ordinal is only safe if it is derived
// from the data rather than from arrival order.
//
// Two invoices in 2026-04 share supplier, invoice number, date and doc type and
// differ only in amount (the DUPLICATE_INV_NO defect at its hardest). Amounts are
// deliberately excluded from identity_key so an amended record stays an UPDATE, so
// those two can only be told apart by an ordinal. If that ordinal followed ingest
// order, re-uploading the same file with its rows in a different order would
// renumber them, every identity_key would change, and portal_records would grow on
// every upload.
//
// Owns org 2 so it cannot disturb the other integration suites.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import {
  ensureOrg,
  ingest,
  requireDatabase,
  resetOrg,
  rowCounts,
  seededShuffle
} from '../helpers/db.js';
import { FIXTURES_PRESENT, readBuffer, readJson } from '../helpers/fixtures.js';

const ORG_ID = 2;
// Distinct GSTIN: organizations is UNIQUE on gstin, so sharing one would make
// ensureOrg update org 1 instead of creating this suite's own org.
const TRADER_GSTIN = '27AABCS1429F2Z7';
// 2026-04 is the period that actually contains an ordinal-separated pair.
const PERIOD = '2026-04';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

// Reorders every array in the download without changing a single value:
// section arrays, supplier groups, and the documents inside each group.
function shuffleIms(json, seed) {
  const out = { imsDetails: {} };
  for (const [section, rows] of Object.entries(json.imsDetails)) {
    out.imsDetails[section] = seededShuffle(rows, seed);
  }
  return out;
}

function shuffle2b(json, seed) {
  const out = { ...json, docdata: {} };
  for (const [section, groups] of Object.entries(json.docdata)) {
    out.docdata[section] = seededShuffle(groups, seed).map((group) => {
      const copy = { ...group };
      if (Array.isArray(copy.inv)) copy.inv = seededShuffle(copy.inv, seed + 1);
      if (Array.isArray(copy.nt)) copy.nt = seededShuffle(copy.nt, seed + 2);
      if (Array.isArray(copy.doclist)) copy.doclist = seededShuffle(copy.doclist, seed + 3);
      return copy;
    });
  }
  return out;
}

const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');

async function identitySnapshot() {
  const [rows] = await pool.query(
    `SELECT identity_key, identity_seq, source, section, supplier_gstin,
            invoice_no_norm, invoice_date, doc_type, taxable_value, total_tax, content_hash
       FROM portal_records WHERE org_id = ?
      ORDER BY identity_key`,
    [ORG_ID]
  );
  return rows.map((row) => ({ ...row, taxable_value: Number(row.taxable_value) }));
}

describe('ingest ordinal stability under row reordering', () => {
  let before;
  let beforeCounts;
  let collisionGroup;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);

    await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD);
    await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD);

    before = await identitySnapshot();
    beforeCounts = await rowCounts(ORG_ID);

    // The pair that can only be separated by an ordinal.
    const [groups] = await pool.query(
      `SELECT source, section, supplier_gstin, invoice_no_norm, invoice_date, doc_type,
              COUNT(*) AS n
         FROM portal_records WHERE org_id = ?
        GROUP BY source, section, supplier_gstin, invoice_no_norm, invoice_date, doc_type
       HAVING COUNT(*) > 1`,
      [ORG_ID]
    );
    collisionGroup = groups;
  }, 180000);

  afterAll(async () => {
    await closePool();
  });

  it('the fixture really does contain an ordinal-separated pair', () => {
    // Without this the rest of the suite would pass vacuously.
    expect(collisionGroup.length).toBeGreaterThan(0);
    const seqs = before.filter((row) => row.identity_seq > 0);
    expect(seqs.length).toBeGreaterThan(0);
  });

  it('re-uploading with rows shuffled does not grow portal_records', async () => {
    const imsShuffled = shuffleIms(readJson(PERIOD, 'ims.json'), 7);
    const twoBShuffled = shuffle2b(readJson(PERIOD, 'gstr2b.json'), 11);

    // Sanity: the shuffle actually reordered something.
    expect(JSON.stringify(imsShuffled)).not.toBe(
      JSON.stringify(readJson(PERIOD, 'ims.json'))
    );

    const ims = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(imsShuffled));
    const twoB = await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD, asBuffer(twoBShuffled));

    expect(ims.inserted).toBe(0);
    expect(twoB.inserted).toBe(0);
    expect(ims.updated).toBe(ims.parsed);
    expect(twoB.updated).toBe(twoB.parsed);

    const after = await rowCounts(ORG_ID);
    expect(after.portal_records).toBe(beforeCounts.portal_records);
    expect(after.portal_rate_lines).toBe(beforeCounts.portal_rate_lines);
  }, 180000);

  it('assigns the identical identity_key set, ordinals included', async () => {
    const after = await identitySnapshot();
    expect(after.map((row) => row.identity_key)).toEqual(before.map((row) => row.identity_key));
  });

  it('keeps each ordinal attached to the same amounts', async () => {
    // The real risk is not a changed count but a SWAP: #0 and #1 trading places
    // would leave the count identical while silently moving money between two
    // different invoices.
    const after = await identitySnapshot();
    const byKey = new Map(after.map((row) => [row.identity_key, row]));

    for (const row of before) {
      const match = byKey.get(row.identity_key);
      expect(match, `identity_key ${row.identity_key} vanished`).toBeTruthy();
      expect(match.identity_seq).toBe(row.identity_seq);
      expect(match.taxable_value).toBe(row.taxable_value);
      expect(match.content_hash).toBe(row.content_hash);
    }
  });

  it('detects no spurious amendments — same content means no change rows', async () => {
    // A renumbered ordinal would look like an amended record, so an empty
    // record_changes is independent evidence that nothing moved.
    const [changes] = await pool.query(
      'SELECT COUNT(*) AS n FROM record_changes WHERE org_id = ?',
      [ORG_ID]
    );
    expect(Number(changes[0].n)).toBe(0);
  });

  it('survives a differently-seeded shuffle too', async () => {
    const ims = await ingest(
      ORG_ID, 'IMS', 'ims.json', PERIOD,
      asBuffer(shuffleIms(readJson(PERIOD, 'ims.json'), 999))
    );
    expect(ims.inserted).toBe(0);

    const after = await identitySnapshot();
    expect(after.map((row) => row.identity_key)).toEqual(before.map((row) => row.identity_key));
    expect(await rowCounts(ORG_ID)).toMatchObject({
      portal_records: beforeCounts.portal_records
    });
  }, 180000);

  it('also holds for the purchase register', async () => {
    const registerBefore = (await rowCounts(ORG_ID)).expected_invoices;
    await ingest(ORG_ID, 'PURCHASE_REGISTER', 'purchase_register.xlsx', PERIOD);
    const first = (await rowCounts(ORG_ID)).expected_invoices;
    expect(first).toBeGreaterThan(registerBefore);

    // Same bytes again: still no growth.
    const again = await ingest(
      ORG_ID, 'PURCHASE_REGISTER', 'purchase_register.xlsx', PERIOD,
      readBuffer(PERIOD, 'purchase_register.xlsx')
    );
    expect(again.inserted).toBe(0);
    expect((await rowCounts(ORG_ID)).expected_invoices).toBe(first);
  }, 180000);
});
