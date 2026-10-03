// The rebuild has to be reachable when nothing looks wrong.
//
// The stale banner on Actions only appears once a run NOTICES it is out of date,
// which covers new portal data and nothing else. Change the engine, the weights
// or the recommendation wording and every verdict on screen is from the old code
// with no signal at all — and the only way to rebuild was to upload a file, which
// is a strange thing to have to do to see your own change.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      createRun: vi.fn(),
      imsActionsSummary: vi.fn(),
      imsActionsUrl: (id) => `/api/runs/${id}/ims-actions.json`
    }
  };
});

import { api } from '../src/api.js';
import { SummaryScreen } from '../src/screens/Summary.jsx';

const RUN = {
  id: 522,
  taxPeriod: '2026-04',
  mode: 'REACTIVE',
  asOfDate: '2026-05-16',
  filingScheme: 'MONTHLY',
  cutOffDate: '2026-05-11',
  finishedAt: '2026-08-23 14:10:22',
  bucketCounts: { MATCHED: 400, VALUE_MISMATCH: 11 },
  openDecisions: { count: 11, itc: 5381623, byCategory: {} },
  bucketItc: {},
  totalsBreakdown: {},
  totals: {
    expectedTotalItc: 145381623,
    claimableItc: 140000000,
    atRiskItc: 5381623,
    deferredItc: 0,
    ineligibleItc: 0,
    nonImsItc: 0,
    grandTotalItc: 145381623
  },
  staleness: { staleResults: 0, withdrawnResults: 0, unseenRecords: 0, isStale: false }
};

beforeEach(() => {
  api.imsActionsSummary.mockResolvedValue({
    stats: { records: 411, confirmed: 0, recommended: 411, byAction: {} },
    warnings: []
  });
});

const mount = (run = RUN, onRefresh = vi.fn()) =>
  render(
    <SummaryScreen run={run} results={[]} onGoToActions={vi.fn()} onRefresh={onRefresh} />
  );

describe('re-running a period from Summary', () => {
  it('offers the rebuild on a run that is perfectly current', async () => {
    mount();
    // Not conditioned on staleness — that is the whole point.
    expect(screen.getByTestId('rerun-reconciliation')).toBeEnabled();
    expect(screen.getByTestId('run-computed-at')).toHaveTextContent('last built 23 Aug 2026');
  });

  it('rebuilds with the run\'s mode and scheme, and sends no date of its own', async () => {
    const onRefresh = vi.fn();
    api.createRun.mockResolvedValue({ id: RUN.id });
    mount(RUN, onRefresh);

    await userEvent.click(screen.getByTestId('rerun-reconciliation'));

    // The date is the workspace's, applied by the server to every run: a date
    // sent from here would be a second clock.
    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith({
        taxPeriod: '2026-04',
        mode: 'REACTIVE',
        filingScheme: 'MONTHLY'
      })
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('shows a failed rebuild instead of leaving the button looking done', async () => {
    api.createRun.mockRejectedValue(new Error('nothing to reconcile for 2026-04'));
    mount();

    await userEvent.click(screen.getByTestId('rerun-reconciliation'));

    await waitFor(() =>
      expect(screen.getByText(/nothing to reconcile/)).toBeInTheDocument()
    );
    // Still usable afterwards: a failed rebuild is not a dead end.
    expect(screen.getByTestId('rerun-reconciliation')).toBeEnabled();
  });

  it('sits beside the call to action rather than replacing it', async () => {
    mount();
    const actions = screen.getByTestId('rerun-reconciliation').closest('.head-actions');
    expect(within(actions).getByText(/need a decision/)).toBeInTheDocument();
  });

  it('renders nothing at all when the period has no run', () => {
    render(<SummaryScreen run={null} results={[]} onGoToActions={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.queryByTestId('rerun-reconciliation')).toBeNull();
    expect(screen.getByTestId('empty-run')).toBeInTheDocument();
  });
});
