// The filing calendar read against one date: the deadlines every screen shows and
// whether GSTR-2B exists yet.
import { describe, expect, it } from 'vitest';
import { filingCalendar, isTwoBGenerated } from '../../src/matching/cutoff.js';

describe('filingCalendar', () => {
  it("lists August's deadlines and the days left to each on 5 Sep", () => {
    expect(filingCalendar('2026-09-05', '2026-08')).toEqual({
      taxPeriod: '2026-08',
      asOfDate: '2026-09-05',
      window: 'PREVENTIVE',
      deadlines: [
        { key: 'CUTOFF_MONTHLY', date: '2026-09-11', daysLeft: 6 },
        { key: 'CUTOFF_QRMP', date: '2026-09-13', daysLeft: 8 },
        { key: 'GSTR2B_GENERATED', date: '2026-09-14', daysLeft: 9 },
        { key: 'GSTR3B_DUE', date: '2026-09-20', daysLeft: 15 }
      ]
    });
  });

  it('counts a deadline as 0 on the day and negative once passed', () => {
    const calendar = filingCalendar('2026-09-14', '2026-08');
    const days = Object.fromEntries(calendar.deadlines.map((entry) => [entry.key, entry.daysLeft]));
    expect(days).toEqual({ CUTOFF_MONTHLY: -3, CUTOFF_QRMP: -1, GSTR2B_GENERATED: 0, GSTR3B_DUE: 6 });
    expect(calendar.window).toBe('REACTIVE');
  });

  it("reads the trader's own window from their filer type", () => {
    expect(filingCalendar('2026-09-12', '2026-08', 'MONTHLY').window).toBe('CUTOFF_PASSED');
    expect(filingCalendar('2026-09-12', '2026-08', 'QRMP').window).toBe('PREVENTIVE');
  });

  it('crosses the year end', () => {
    expect(filingCalendar('2027-01-05', '2026-12').deadlines[0]).toEqual({
      key: 'CUTOFF_MONTHLY', date: '2027-01-11', daysLeft: 6
    });
  });

  it('answers null without a usable date or period', () => {
    expect(filingCalendar(null, '2026-08')).toBeNull();
    expect(filingCalendar('2026-09-05', 'August')).toBeNull();
  });
});

describe('isTwoBGenerated', () => {
  it('is false until the 14th of the following month', () => {
    expect(isTwoBGenerated('2026-09-13', '2026-08')).toBe(false);
    expect(isTwoBGenerated('2026-09-14', '2026-08')).toBe(true);
    expect(isTwoBGenerated('2026-10-01', '2026-08')).toBe(true);
  });
});
