// One definition of "needs a decision", shared by every screen and the export.
//
// The audit found four different counts on one screen (72 / 32 / 4 / 384) and a
// banner that turned green while 22 records still went to the portal as N. These
// pin the rule: in IMS, actionable, and carrying N right now.
import { describe, expect, it } from 'vitest';
import {
  awaitsSupplier,
  currentImsAction,
  decisionCategory,
  isImsActionable,
  needsDecision,
  summarizeOpenDecisions
} from '../../src/services/decisions.js';

const imsRow = (over = {}) => ({
  bucket: 'VALUE_MISMATCH',
  recommendedAction: 'REJECT',
  confirmedAction: null,
  signedItc: 1000,
  withdrawn: false,
  portal: { source: 'IMS', imsAction: 'N' },
  ...over
});

describe('currentImsAction', () => {
  it('is the trader decision when there is one', () => {
    expect(currentImsAction(imsRow({ confirmedAction: 'REJECT' }))).toBe('REJECT');
    expect(currentImsAction(imsRow({ confirmedAction: 'PENDING' }))).toBe('PENDING');
  });

  it('applies ACCEPT to a clean match without a human, and nothing else', () => {
    expect(currentImsAction(imsRow({ bucket: 'MATCHED', recommendedAction: 'ACCEPT' }))).toBe('ACCEPT');
    // An Accept recommendation on a mismatch waits for the trader.
    expect(currentImsAction(imsRow({ recommendedAction: 'ACCEPT' }))).toBe('NO_ACTION');
    // A Reject recommendation is never applied on its own.
    expect(currentImsAction(imsRow())).toBe('NO_ACTION');
  });

  it('keeps an action already recorded on the portal', () => {
    expect(currentImsAction(imsRow({ portal: { source: 'IMS', imsAction: 'R' } }))).toBe('REJECT');
    expect(currentImsAction(imsRow({ bucket: 'MATCHED', recommendedAction: 'ACCEPT', portal: { source: 'IMS', imsAction: 'P' } }))).toBe('PENDING');
  });

  it('treats a confirmed N as no decision at all', () => {
    expect(currentImsAction(imsRow({ confirmedAction: 'NO_ACTION' }))).toBe('NO_ACTION');
    expect(currentImsAction(imsRow({ bucket: 'MATCHED', recommendedAction: 'ACCEPT', confirmedAction: 'NO_ACTION' }))).toBe('ACCEPT');
  });
});

describe('needsDecision', () => {
  it('is true for an IMS record carrying N', () => {
    expect(needsDecision(imsRow())).toBe(true);
    expect(needsDecision(imsRow({ bucket: 'SUGGESTED', recommendedAction: 'VERIFY' }))).toBe(true);
    expect(needsDecision(imsRow({ bucket: 'MISSING_IN_BOOKS', recommendedAction: 'REJECT' }))).toBe(true);
  });

  it('stays true after the trader confirms N', () => {
    expect(needsDecision(imsRow({ confirmedAction: 'NO_ACTION' }))).toBe(true);
  });

  it('is false once the trader accepts, rejects or parks it', () => {
    for (const action of ['ACCEPT', 'REJECT', 'PENDING']) {
      expect(needsDecision(imsRow({ confirmedAction: action }))).toBe(false);
    }
  });

  it('is false for a clean match', () => {
    expect(needsDecision(imsRow({ bucket: 'MATCHED', recommendedAction: 'ACCEPT' }))).toBe(false);
  });

  // A saved record waits on its supplier (the demo's National NS-612 on 10 Sep:
  // saved with a higher amount, the day before the cut-off).
  describe('a record the supplier has only saved', () => {
    const saved = (over = {}) =>
      imsRow({ portal: { source: 'IMS', imsAction: 'N', filingStatus: 'SAVED' }, ...over });

    it('is never a decision on or before the cut-off, whatever the engine made of it', () => {
      for (const bucket of ['VALUE_MISMATCH', 'SUGGESTED', 'MISSING_IN_BOOKS']) {
        const row = saved({ bucket, cutOffPassed: false });
        expect(awaitsSupplier(row), bucket).toBe(true);
        expect(needsDecision(row), bucket).toBe(false);
      }
    });

    it('is not a decision past the cut-off when it agrees but was never filed', () => {
      const notFiled = saved({ bucket: 'MISSING_IN_PORTAL', recommendedAction: 'DEFERRED', cutOffPassed: true });
      expect(needsDecision(notFiled)).toBe(false);
    });

    it('is a decision past the cut-off when its amount still differs', () => {
      const differs = saved({ bucket: 'VALUE_MISMATCH', cutOffPassed: true });
      expect(awaitsSupplier(differs)).toBe(false);
      expect(needsDecision(differs)).toBe(true);
    });

    it('leaves a filed record to the ordinary rule', () => {
      const filed = imsRow({ portal: { source: 'IMS', imsAction: 'N', filingStatus: 'FILED' }, cutOffPassed: false });
      expect(awaitsSupplier(filed)).toBe(false);
      expect(needsDecision(filed)).toBe(true);
    });
  });

  it('never counts records with no IMS row to act on', () => {
    const cases = {
      'reverse charge / ISD / imports': imsRow({ bucket: 'NON_IMS', recommendedAction: 'NO_ACTION', portal: { source: 'GSTR2B', imsAction: null } }),
      ineligible: imsRow({ bucket: 'INELIGIBLE', recommendedAction: 'NO_ACTION', portal: { source: 'GSTR2B', imsAction: null } }),
      'books only': imsRow({ bucket: 'MISSING_IN_PORTAL', recommendedAction: 'DEFERRED', portal: null }),
      '2B only': imsRow({ portal: { source: 'GSTR2B', imsAction: null } }),
      withdrawn: imsRow({ withdrawn: true })
    };
    for (const [name, row] of Object.entries(cases)) {
      expect(isImsActionable(row), name).toBe(false);
      expect(needsDecision(row), name).toBe(false);
    }
  });
});

describe('decisionCategory', () => {
  it('splits open records into phantom, verify and other', () => {
    expect(decisionCategory(imsRow({ bucket: 'MISSING_IN_BOOKS', recommendedAction: 'REJECT' }))).toBe('phantom');
    expect(decisionCategory(imsRow({ bucket: 'SUGGESTED', recommendedAction: 'VERIFY' }))).toBe('verify');
    expect(decisionCategory(imsRow())).toBe('other');
  });

  it('is null for anything already decided or not actionable', () => {
    expect(decisionCategory(imsRow({ confirmedAction: 'ACCEPT' }))).toBeNull();
    expect(decisionCategory(imsRow({ portal: null, bucket: 'MISSING_IN_PORTAL' }))).toBeNull();
  });
});

describe('summarizeOpenDecisions', () => {
  it('counts and totals the open records, overall and per category', () => {
    const summary = summarizeOpenDecisions([
      imsRow({ signedItc: 500 }),
      imsRow({ bucket: 'MISSING_IN_BOOKS', recommendedAction: 'REJECT', signedItc: 200 }),
      imsRow({ bucket: 'SUGGESTED', recommendedAction: 'VERIFY', signedItc: -70 }),
      imsRow({ confirmedAction: 'REJECT', signedItc: 9999 }),
      imsRow({ bucket: 'MATCHED', recommendedAction: 'ACCEPT', signedItc: 9999 })
    ]);
    expect(summary).toEqual({
      count: 3,
      itc: 630,
      byCategory: {
        phantom: { count: 1, itc: 200 },
        verify: { count: 1, itc: -70 },
        other: { count: 1, itc: 500 }
      }
    });
  });

  it('is zero, with every category present, when nothing is open', () => {
    expect(summarizeOpenDecisions([])).toEqual({
      count: 0,
      itc: 0,
      byCategory: { phantom: { count: 0, itc: 0 }, verify: { count: 0, itc: 0 }, other: { count: 0, itc: 0 } }
    });
  });
});
