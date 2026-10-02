// The banner sits directly above the reset panel on every screen, so the two are
// read as one sentence. "0 decisions recorded" over "1 decision you made was
// dropped" is two true statements that contradict each other on the page: the
// count is of decisions that still STAND, but nothing on screen said so, and the
// obvious reading is that one of the two numbers is broken.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  ConfirmationResetBanner,
  DeemedAcceptanceBanner
} from '../src/components/DeemedAcceptanceBanner.jsx';

const RUN = {
  id: 543,
  taxPeriod: '2026-04',
  asOfDate: '2026-05-16',
  filingScheme: 'MONTHLY',
  mode: 'REACTIVE'
};

// An IMS row the trader has not acted on. imsAction 'N' is what deemed
// acceptance acts on.
const row = (overrides = {}) => ({
  id: 1,
  bucket: 'VALUE_MISMATCH',
  flags: [],
  recommendedAction: 'REJECT',
  confirmedAction: null,
  signedItc: 12103345,
  books: { invoiceNo: '06-17/AMD/3538' },
  portal: {
    invoiceNo: '06-17/AMD/3538',
    source: 'IMS',
    section: 'b2b',
    imsAction: 'N',
    pendingBlocked: false,
    itcAvailable: true
  },
  ...overrides
});

// What demo:reset builds: one decision made, then reset when the supplier
// revised the record. confirmedAction is null because the reset dropped it.
const RESET_ROW = row({ flags: ['CONFIRMATION_RESET'] });
const CONFIRMED_ROW = row({ id: 2, confirmedAction: 'ACCEPT' });
const UNTOUCHED_ROW = row({ id: 3 });

const mount = (results) =>
  render(<DeemedAcceptanceBanner run={RUN} results={results} loading={false} />);

describe('the deemed-acceptance banner and the reset panel agree', () => {
  it('says a decision was reset rather than leaving the count at a bare zero', () => {
    mount([RESET_ROW]);

    // Not "0 decisions recorded". A bare zero beside "1 was reset" read as a
    // contradiction of the panel below; this states what is left in the same
    // breath as what happened to the rest.
    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      'no decisions still stand'
    );
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent(
      'the one you made was dropped when the supplier changed that record'
    );
  });

  it('reads as one statement with the panel it sits above', () => {
    // The two rendered together are what the trader actually sees.
    render(
      <>
        <DeemedAcceptanceBanner run={RUN} results={[RESET_ROW]} loading={false} />
        <ConfirmationResetBanner results={[RESET_ROW]} />
      </>
    );

    const banner = screen.getByTestId('deemed-banner');
    const panel = screen.getByTestId('confirmation-reset-banner');

    // Read top to bottom: "no decisions still stand — the one you made was
    // dropped when the supplier changed that record", then "1 decision you made
    // was dropped". One statement, told twice, agreeing.
    expect(banner).toHaveTextContent('no decisions still stand');
    expect(banner).toHaveTextContent('the one you made was dropped');
    expect(panel).toHaveTextContent('1 decision you made was dropped');

    // The old phrasing put a bare zero next to a non-zero and left the reader to
    // reconcile them.
    expect(banner).not.toHaveTextContent('0 decisions recorded');
  });

  it('counts decisions that still stand alongside the ones that were reset', () => {
    mount([RESET_ROW, CONFIRMED_ROW, UNTOUCHED_ROW]);

    // A reset row is neither recorded nor never-made, so it must not be folded
    // into the recorded count — that would overstate what is actually decided.
    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      '1 decision still stands'
    );
    // "another", not "the one you made" — there is a surviving decision too.
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent(
      'another was dropped when the supplier changed that record'
    );
  });

  it('pluralises when several were reset', () => {
    mount([RESET_ROW, { ...RESET_ROW, id: 9 }]);
    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      'no decisions still stand'
    );
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent(
      'all 2 you made were dropped when suppliers changed those records'
    );
  });

  it('says "others" when some survived and several did not', () => {
    mount([RESET_ROW, { ...RESET_ROW, id: 9 }, CONFIRMED_ROW]);
    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      '1 decision still stands'
    );
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent(
      '2 others were dropped when suppliers changed those records'
    );
  });

  it('does not count a confirmed N as a decision', () => {
    mount([row({ id: 4, confirmedAction: 'NO_ACTION' }), CONFIRMED_ROW]);
    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      '1 decision recorded'
    );
  });

  it('stays quiet when nothing was reset', () => {
    // The clause is an explanation for an apparent contradiction. With no reset
    // rows there is nothing to explain, and a permanent "0 were reset" is noise.
    mount([CONFIRMED_ROW, UNTOUCHED_ROW]);

    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      '1 decision recorded'
    );
    expect(screen.queryByTestId('deemed-reset-count')).toBeNull();
  });
});
