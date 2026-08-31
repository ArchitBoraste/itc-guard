// The visitor-facing half of per-visitor demo data.
//
// Two things have to hold on a public deployment, and neither is visible from the
// API tests:
//
//   1. An org that is still being seeded shows "preparing your demo data" and
//      then loads by itself. It must NOT fall through to the Upload screen, which
//      is where an app with no runs otherwise sends people — a judge whose first
//      screen says "upload a purchase register" has been told the demo is empty.
//
//   2. "Reset my data" appears only where it means something. On a single-org
//      deployment the same button would wipe the developer's own data, so the API
//      says whether it applies and the UI believes it rather than guessing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      session: vi.fn(),
      resetSession: vi.fn(),
      org: vi.fn(),
      listRuns: vi.fn(),
      getRunByPeriod: vi.fn(),
      getRun: vi.fn(),
      listAllResults: vi.fn(),
      listAlerts: vi.fn(),
      imsActionsSummary: vi.fn(),
      imsActionsUrl: (id) => `/api/runs/${id}/ims-actions.json`,
      listChanges: vi.fn()
    }
  };
});

import { api } from '../src/api.js';
import App from '../src/App.jsx';

const RUN = {
  id: 7,
  taxPeriod: '2026-04',
  mode: 'REACTIVE',
  asOfDate: '2026-05-16',
  filingScheme: 'MONTHLY',
  cutOffDate: '2026-05-11',
  engineVersion: '1.0.0',
  bucketCounts: {},
  bucketItc: {},
  totalsBreakdown: {},
  totals: {
    expectedTotalItc: 0, claimableItc: 0, atRiskItc: 0, deferredItc: 0,
    ineligibleItc: 0, nonImsItc: 0, grandTotalItc: 0
  },
  staleness: { staleResults: 0, withdrawnResults: 0, unseenRecords: 0, isStale: false }
};

const ready = (overrides = {}) => ({
  orgId: 1042,
  state: 'READY',
  isNew: false,
  error: null,
  perVisitor: true,
  ...overrides
});

beforeEach(() => {
  window.location.hash = '';
  api.org.mockResolvedValue({
    org: { id: 1042, gstin: '27AABCS1042F1Z3', tradeName: 'Sharma' },
    demoPeriods: []
  });
  api.listRuns.mockResolvedValue([{ id: 7, taxPeriod: '2026-04' }]);
  api.getRunByPeriod.mockResolvedValue(RUN);
  api.listAllResults.mockResolvedValue([]);
  api.imsActionsSummary.mockResolvedValue({ stats: { records: 0, byAction: {} }, warnings: [] });
  api.listChanges.mockResolvedValue({ changes: [], counts: {} });
});

describe('while this visitor\'s copy is being seeded', () => {
  it('shows the preparing state, then loads on its own once it is ready', async () => {
    api.session
      .mockResolvedValueOnce(ready({ state: 'PROVISIONING', isNew: true }))
      .mockResolvedValue(ready());

    render(<App />);

    expect(await screen.findByTestId('preparing')).toBeInTheDocument();
    // Not the empty-state redirect: an org mid-seed has no runs yet, and Upload
    // is the wrong thing to show someone whose data is on its way.
    expect(screen.queryByTestId('upload-screen')).not.toBeInTheDocument();

    // The poll takes over without anyone clicking anything.
    //
    // The budget is wall clock, not the thing under test: App polls every 1500ms
    // and the assertion is that NOBODY had to click. Five seconds was three
    // intervals, and with the suite running files in parallel inside the
    // container a slow render turned this red roughly one run in three. Raising
    // it does not weaken the assertion — a poll that never fires still fails.
    await waitFor(() => expect(screen.queryByTestId('preparing')).not.toBeInTheDocument(), {
      timeout: 20000
    });
    expect(api.listRuns).toHaveBeenCalled();
  });
});

describe('Reset my data', () => {
  it('is offered on a per-visitor deployment and asks before it fires', async () => {
    api.session.mockResolvedValue(ready());
    api.resetSession.mockResolvedValue({ orgId: 1042, state: 'PROVISIONING', error: null });

    render(<App />);

    const button = await screen.findByTestId('reset-my-data');
    // One click arms it, a second confirms — nothing is wiped by a stray click.
    await userEvent.click(button);
    expect(api.resetSession).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('reset-confirm'));
    expect(api.resetSession).toHaveBeenCalledTimes(1);

    // And the same preparing screen the cold path uses.
    expect(await screen.findByTestId('preparing')).toBeInTheDocument();
  });

  it('is hidden when the deployment serves a single shared org', async () => {
    api.session.mockResolvedValue(ready({ orgId: 1, perVisitor: false }));

    render(<App />);

    await screen.findByTestId('nav-summary');
    expect(screen.queryByTestId('reset-my-data')).not.toBeInTheDocument();
  });
});
