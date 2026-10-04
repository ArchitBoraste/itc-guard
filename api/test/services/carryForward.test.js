// What a rebuilt run keeps from the one it replaces: the trader's decisions while
// they still apply, and the warning that one was dropped until it is answered.
//
// Pure — carryForward() reads a map of previous rows; nothing here touches the db.
import { describe, expect, it } from 'vitest';
import { CONFIRMATION_RESET, carryForward } from '../../src/services/reconcile.js';

const HASH = 'a'.repeat(64);
const AMENDED = 'b'.repeat(64);

const result = (overrides = {}) => ({
  expected: { id: 10 },
  portal: { id: 20, contentHash: HASH },
  bucket: 'VALUE_MISMATCH',
  ...overrides
});

// A previous match_results row for the same pair, as loadCarriedState() reads it.
const previous = (overrides = {}) => ({
  expected_invoice_id: 10,
  portal_record_id: 20,
  confirmed_action: null,
  confirmed_content_hash: null,
  confirmed_bucket: null,
  flags: JSON.stringify([]),
  ...overrides
});

const carried = (row) => new Map([['10:20', row]]);

const decided = (action, overrides = {}) =>
  previous({
    confirmed_action: action,
    confirmed_content_hash: HASH,
    confirmed_bucket: 'VALUE_MISMATCH',
    ...overrides
  });

describe('carryForward', () => {
  it('leaves a pair with no history alone', () => {
    const fresh = result();
    expect(carryForward(new Map(), fresh)).toBe(fresh);
  });

  it('keeps a decision about the same content and bucket', () => {
    const out = carryForward(carried(decided('REJECT')), result());
    expect(out.confirmedAction).toBe('REJECT');
    expect(out.confirmationReset).toBeUndefined();
  });

  it('drops a decision once the supplier amends the record, and says so', () => {
    const out = carryForward(carried(decided('ACCEPT')), result({
      portal: { id: 20, contentHash: AMENDED }
    }));
    expect(out.confirmedAction).toBeUndefined();
    expect(out.confirmationReset).toBe(true);
  });

  it('drops a decision once the bucket moves, and says so', () => {
    const out = carryForward(carried(decided('REJECT')), result({ bucket: 'MATCHED' }));
    expect(out.confirmationReset).toBe(true);
  });

  // Audit P14: re-running cleared the warning although nothing was decided again.
  it('keeps the dropped-decision warning across a rebuild until the row is decided again', () => {
    const warned = previous({ flags: JSON.stringify([CONFIRMATION_RESET]) });
    const out = carryForward(carried(warned), result());
    expect(out.confirmationReset).toBe(true);
    expect(out.confirmedAction).toBeUndefined();
  });

  it('reads flags whether the driver hands back JSON text or a parsed array', () => {
    const warned = previous({ flags: [CONFIRMATION_RESET] });
    expect(carryForward(carried(warned), result()).confirmationReset).toBe(true);
  });

  it('does not count N as deciding again: the warning stays beside it', () => {
    const out = carryForward(
      carried(decided('NO_ACTION', { flags: JSON.stringify([CONFIRMATION_RESET]) })),
      result()
    );
    expect(out.confirmedAction).toBe('NO_ACTION');
    expect(out.confirmationReset).toBe(true);
  });

  it('lets a decision made since the reset stand without the warning', () => {
    // A row decided before deciding cleared the flag still carries both.
    const out = carryForward(
      carried(decided('ACCEPT', { flags: JSON.stringify([CONFIRMATION_RESET]) })),
      result()
    );
    expect(out.confirmedAction).toBe('ACCEPT');
    expect(out.confirmationReset).toBeUndefined();
  });

  it('matches on the pair, never on one side of it', () => {
    const otherBooksRow = result({ expected: { id: 11 } });
    expect(carryForward(carried(decided('REJECT')), otherBooksRow)).toBe(otherBooksRow);
  });
});
