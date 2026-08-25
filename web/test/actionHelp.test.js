// The Chase supplier group header used to be a fixed sentence promising that
// "the cut-off has not passed, so their fix still lands in this period for free"
// — printed directly above rows whose own explanation said the opposite: "the
// record was never filed, so a correction now reaches a later period, not this
// one." The row was right. Both were on screen at once, at as-of 16 May against
// an 11 May cut-off.
//
// Every other action means one thing whatever day it is, which is why the rest of
// the table stays a constant.
import { describe, expect, it } from 'vitest';
import { ACTION_HELP, actionHelp, rowFlags } from '../src/lib/vocab.js';

const row = (flags = []) => ({ flags });

describe('actionHelp', () => {
  it('leaves calendar-independent actions exactly as they were', () => {
    for (const action of ['ACCEPT', 'REJECT', 'PENDING', 'VERIFY', 'DEFERRED', 'NO_ACTION']) {
      expect(actionHelp(action, [row(), row(['CUTOFF_PASSED'])])).toBe(ACTION_HELP[action]);
    }
  });

  it('promises the free fix only while every supplier is inside their window', () => {
    const help = actionHelp('CHASE_SUPPLIER', [row(), row()]);
    expect(help).toContain('has not passed');
    expect(help).toContain('for free');
  });

  it('stops promising it once every cut-off has passed', () => {
    const help = actionHelp('CHASE_SUPPLIER', [row(['CUTOFF_PASSED']), row(['CUTOFF_PASSED'])]);
    expect(help).not.toContain('has not passed');
    expect(help).not.toContain('for free');
    expect(help).toContain('cut-off has passed');
    // Still worth doing, and for the reason that is actually true now.
    expect(help).toContain('reaches a later period');
  });

  it('counts them when the group straddles two different cut-offs', () => {
    // Exactly what a mixed monthly/QRMP group looks like on the 12th.
    const help = actionHelp('CHASE_SUPPLIER', [
      row(['CUTOFF_PASSED']),
      row(['CUTOFF_PASSED']),
      row()
    ]);
    expect(help).toContain('2 of 3');
    expect(help).toContain('later period');
    expect(help).toContain('free-fix window');
  });

  it('falls back to the neutral sentence with no rows to judge from', () => {
    expect(actionHelp('CHASE_SUPPLIER', [])).toBe(ACTION_HELP.CHASE_SUPPLIER);
    expect(ACTION_HELP.CHASE_SUPPLIER).not.toContain('has not passed');
  });
});

// CUTOFF_PASSED is true of every result in a run read after the cut-off — 424 of
// 424 in the April demo period. A chip on all of them would bury the few flags
// that mark an actual problem with the invoice.
describe('rowFlags', () => {
  it('keeps the flags that describe the record', () => {
    expect(rowFlags(['GSTIN_MISMATCH', 'DATE_DRIFT'])).toEqual(['GSTIN_MISMATCH', 'DATE_DRIFT']);
  });

  it('drops the calendar flag that belongs to the group header', () => {
    expect(rowFlags(['SUPPLIER_UNFILED', 'CUTOFF_PASSED'])).toEqual(['SUPPLIER_UNFILED']);
    expect(rowFlags(['CUTOFF_PASSED'])).toEqual([]);
  });
});
