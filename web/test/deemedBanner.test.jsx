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

    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      '0 decisions recorded'
    );
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent(
      '1 was reset when the supplier changed the record'
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
    expect(banner).toHaveTextContent('0 decisions recorded');
    // The bridging clause: without it these two are a contradiction.
    expect(banner).toHaveTextContent('1 was reset');
    expect(panel).toHaveTextContent('1 decision you made was dropped');
  });

  it('counts decisions that still stand alongside the ones that were reset', () => {
    mount([RESET_ROW, CONFIRMED_ROW, UNTOUCHED_ROW]);

    // A reset row is neither recorded nor never-made, so it must not be folded
    // into the recorded count — that would overstate what is actually decided.
    expect(screen.getByTestId('deemed-confirmed-count')).toHaveTextContent(
      '1 decision recorded'
    );
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent('1 was reset');
  });

  it('pluralises when several were reset', () => {
    mount([RESET_ROW, { ...RESET_ROW, id: 9 }]);
    expect(screen.getByTestId('deemed-reset-count')).toHaveTextContent(
      '2 were reset when suppliers changed those records'
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
