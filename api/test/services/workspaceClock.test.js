// What "today" is, and what counts as a date. No database.
import { describe, expect, it } from 'vitest';
import { parseAsOfDate, todayInIndia } from '../../src/services/workspaceClock.js';

describe('todayInIndia', () => {
  it("is India's date, not UTC's: 00:30 on the 12th in Pune is the 12th", () => {
    expect(todayInIndia(new Date('2026-09-11T19:00:00Z'))).toBe('2026-09-12');
    expect(todayInIndia(new Date('2026-09-11T18:00:00Z'))).toBe('2026-09-11');
  });
});

describe('parseAsOfDate', () => {
  it('accepts a real yyyy-mm-dd date', () => {
    expect(parseAsOfDate('2026-09-05')).toBe('2026-09-05');
  });

  it.each(['2026-02-30', '05-09-2026', '2026-9-5', 'tomorrow', '', 20260905])(
    'refuses %j',
    (value) => {
      expect(() => parseAsOfDate(value)).toThrow(/asOfDate must be a real date/);
    }
  );
});
