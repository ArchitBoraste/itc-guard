// Which earlier documents are still waiting on a supplier fix (services/carryOver.js),
// and when the supplier can still make it (corrections.nextChance).
import { describe, expect, it } from 'vitest';
import { NEEDED, earlierItems, hasArrived, neededFix } from '../../src/services/carryOver.js';
import { nextChance } from '../../src/services/corrections.js';

const OPTIONS = { materialityTolerancePaise: 100 };

// A result row as reconcile.loadEarlierRows() reads it.
const own = (id, bucket, overrides = {}) => ({
  id,
  run_period: '2026-08',
  tax_period: '2026-08',
  linked_period: null,
  bucket,
  portal_record_id: null,
  delta_total_tax: null,
  ...overrides
});
const link = (id, runPeriod, overrides = {}) => ({
  id,
  run_period: runPeriod,
  tax_period: '2026-08',
  linked_period: '2026-08',
  bucket: 'MATCHED',
  portal_filing_status: 'FILED',
  ...overrides
});

describe('neededFix', () => {
  it('names what its own run left the supplier to fix', () => {
    expect(neededFix(own(1, 'MISSING_IN_PORTAL'), OPTIONS)).toBe(NEEDED.NOT_FILED);
    expect(neededFix(own(1, 'MISSING_IN_PORTAL', { portal_record_id: 9 }), OPTIONS)).toBe(NEEDED.SAVED_NOT_FILED);
    expect(neededFix(own(1, 'VALUE_MISMATCH', { delta_total_tax: -90000 }), OPTIONS)).toBe(NEEDED.VALUE_MISMATCH);
  });

  it('needs nothing for a match, a phantom, a number-only difference or rounding', () => {
    for (const bucket of ['MATCHED', 'MISSING_IN_BOOKS', 'SUGGESTED', 'NON_IMS', 'INELIGIBLE']) {
      expect(neededFix(own(1, bucket), OPTIONS), bucket).toBeNull();
    }
    expect(neededFix(own(1, 'VALUE_MISMATCH', { delta_total_tax: 60 }), OPTIONS)).toBeNull();
  });
});

describe('hasArrived', () => {
  it('is a filed record, never a saved one', () => {
    expect(hasArrived(link(1, '2026-09'))).toBe(true);
    expect(hasArrived(link(1, '2026-09', { portal_filing_status: 'SAVED' }))).toBe(false);
    expect(hasArrived(link(1, '2026-09', { bucket: 'MISSING_IN_PORTAL', portal_filing_status: 'SAVED' }))).toBe(false);
  });
});

describe('earlierItems', () => {
  const rows = [
    own(1, 'MISSING_IN_PORTAL'),
    own(2, 'VALUE_MISMATCH', { delta_total_tax: 54000 }),
    own(3, 'MATCHED'),
    link(1, '2026-09'),
    link(2, '2026-10', { portal_filing_status: 'SAVED' }),
    link(2, '2026-11')
  ];
  const byId = (items) => new Map(items.map((item) => [item.row.id, item]));

  it('reads September: one arrives there, one still waits, one never needed anything', () => {
    const items = byId(earlierItems(rows, '2026-09', OPTIONS));
    expect(items.get(1)).toMatchObject({ open: true, closedIn: null, link: expect.objectContaining({ run_period: '2026-09' }) });
    expect(items.get(2)).toMatchObject({ open: true, link: null, laterLink: expect.objectContaining({ run_period: '2026-11' }) });
    expect(items.get(3)).toMatchObject({ needed: null, open: false });
  });

  it('closes a document once an earlier period received it', () => {
    const items = byId(earlierItems(rows, '2026-10', OPTIONS));
    expect(items.get(1)).toMatchObject({ open: false, closedIn: '2026-09' });
    // Only saved in October: still open, and October's run holds the sighting.
    expect(items.get(2)).toMatchObject({ open: true, closedIn: null, link: expect.objectContaining({ portal_filing_status: 'SAVED' }) });
  });

  it('only reads documents from before the period', () => {
    expect(earlierItems(rows, '2026-08', OPTIONS)).toEqual([]);
  });
});

describe('nextChance', () => {
  it('is the supplier’s own cut-off for the period, or the next one still ahead', () => {
    expect(nextChance('2026-10-05', '2026-09')).toEqual({ date: '2026-10-11', reachesPeriod: '2026-09', scheme: 'MONTHLY' });
    expect(nextChance('2026-10-05', '2026-09', 'QRMP')).toMatchObject({ date: '2026-10-13' });
    expect(nextChance('2026-10-11', '2026-09')).toMatchObject({ date: '2026-10-11' });
    expect(nextChance('2026-10-14', '2026-09')).toEqual({ date: '2026-11-11', reachesPeriod: '2026-10', scheme: 'MONTHLY' });
  });
});
