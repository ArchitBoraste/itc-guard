// One count of "needs a decision", read from the API by every screen.
//
// The audit found the same screen saying "72 need a decision", "Review 32" and,
// once everything had been confirmed, "Every IMS record has a decision" while 22
// records still went to the portal as N. The banner, Summary and Actions now all
// read run.openDecisions (and the per-row needsDecision behind it) instead of
// counting for themselves.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      listChanges: vi.fn(),
      imsActionsSummary: vi.fn(),
      imsActionsUrl: (id) => `/api/runs/${id}/ims-actions.json`
    }
  };
});

import { api } from '../src/api.js';
import { DeemedAcceptanceBanner } from '../src/components/DeemedAcceptanceBanner.jsx';
import { SummaryScreen } from '../src/screens/Summary.jsx';
import { ActionsScreen } from '../src/screens/Actions.jsx';

const open = (count, itc = count * 1000) => ({
  count,
  itc,
  byCategory: { phantom: { count: 0, itc: 0 }, verify: { count: 0, itc: 0 }, other: { count, itc } }
});

const RUN = {
  id: 77,
  taxPeriod: '2026-04',
  mode: 'REACTIVE',
  asOfDate: '2026-05-16',
  filingScheme: 'MONTHLY',
  cutOffDate: '2026-05-11',
  // 72 non-matched documents, of which only 32 are IMS records waiting on N.
  bucketCounts: { MATCHED: 352, VALUE_MISMATCH: 11, SUGGESTED: 14, MISSING_IN_BOOKS: 7, NON_IMS: 30, INELIGIBLE: 6, MISSING_IN_PORTAL: 4 },
  bucketItc: {},
  totalsBreakdown: {},
  totals: {
    expectedTotalItc: 0, claimableItc: 0, atRiskItc: 0, deferredItc: 0,
    ineligibleItc: 0, nonImsItc: 0, grandTotalItc: 0
  },
  staleness: { staleResults: 0, withdrawnResults: 0, unseenRecords: 0, isStale: false },
  openDecisions: open(32)
};

const row = (id, over = {}) => ({
  id,
  bucket: 'VALUE_MISMATCH',
  flags: [],
  score: 1,
  scoreBreakdown: null,
  recommendedAction: 'REJECT',
  recommendationReason: 'Portal tax is higher than books.',
  confirmedAction: null,
  needsDecision: true,
  stale: false,
  withdrawn: false,
  signedItc: 1000,
  books: { invoiceNo: `INV/${id}`, supplierName: 'Mahavir Sales Corp', supplierGstin: '27HAELJ6674T5Z9', docType: 'INVOICE', taxableValue: 100, totalTax: 18 },
  portal: {
    invoiceNo: `INV/${id}`,
    supplierName: 'Mahavir Sales Corp',
    supplierGstin: '27HAELJ6674T5Z9',
    docType: 'INVOICE',
    source: 'IMS',
    section: 'b2b',
    imsAction: 'N',
    pendingBlocked: false,
    remarksBlocked: false,
    itcAvailable: true,
    taxableValue: 100,
    totalTax: 20
  },
  ...over
});

beforeEach(() => {
  api.listChanges.mockResolvedValue({ total: 0, changes: [], counts: {}, invalidatedCount: 0 });
  api.imsActionsSummary.mockResolvedValue({ stats: { records: 0, byAction: {} }, warnings: [] });
});

describe('the banner', () => {
  it('stays open while records carry N, even when every row was "confirmed"', () => {
    // The audit's E24: Confirm all on every group, banner turns green, 22 still N.
    const confirmedN = Array.from({ length: 22 }, (_, i) => row(i + 1, { confirmedAction: 'NO_ACTION' }));
    render(
      <DeemedAcceptanceBanner run={{ ...RUN, openDecisions: open(22) }} results={confirmedN} loading={false} onGoToActions={vi.fn()} />
    );

    const banner = screen.getByTestId('deemed-banner');
    expect(banner).not.toHaveTextContent('Every IMS record has a decision');
    expect(screen.getByTestId('deemed-open-count')).toHaveTextContent('22');
    expect(within(banner).getByRole('button', { name: 'Review 22' })).toBeInTheDocument();
  });

  it('turns clear only when the API says nothing is open', () => {
    render(<DeemedAcceptanceBanner run={{ ...RUN, openDecisions: open(0) }} results={[]} loading={false} />);
    const banner = screen.getByTestId('deemed-banner');
    expect(banner).toHaveAttribute('data-tone', 'clear');
    expect(banner).toHaveTextContent('Every IMS record has a decision');
  });
});

describe('Summary', () => {
  it('counts what the API counts, not every non-matched bucket', () => {
    render(<SummaryScreen run={RUN} results={[]} onGoToActions={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByTestId('summary-open-decisions')).toHaveTextContent('32 need a decision');
  });

  it('offers nothing to decide when nothing is open', () => {
    render(<SummaryScreen run={{ ...RUN, openDecisions: open(0) }} results={[]} onGoToActions={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.queryByTestId('summary-open-decisions')).toBeNull();
  });
});

describe('Actions', () => {
  it('lists exactly the rows the API marks as needing a decision', () => {
    const results = [
      row(1),
      row(2, { bucket: 'SUGGESTED', recommendedAction: 'VERIFY' }),
      // Decided, a clean match, and books-only: none of them open.
      row(3, { confirmedAction: 'REJECT', needsDecision: false }),
      row(4, { bucket: 'MATCHED', recommendedAction: 'ACCEPT', needsDecision: false }),
      row(5, { bucket: 'MISSING_IN_PORTAL', recommendedAction: 'DEFERRED', needsDecision: false, portal: null })
    ];
    render(<ActionsScreen run={{ ...RUN, openDecisions: open(2) }} results={results} onConfirmed={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.getByTestId('scope-ATTENTION')).toHaveTextContent('Needs a decision (2)');
    const shown = screen.getAllByTestId('result-row').map((el) => el.getAttribute('data-result-id'));
    expect(shown).toEqual(['1', '2']);
    // Books-only rows are never "open": there is no IMS record to decide on.
    expect(screen.getByTestId('strip-DEFERRED')).not.toHaveTextContent('open');
  });
});
