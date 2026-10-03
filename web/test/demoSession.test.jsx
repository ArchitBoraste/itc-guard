// The visitor-facing half of per-visitor workspaces.
//
// "Clear all data" appears only where it means something, and asks before it
// fires. On a single-org deployment the same button would wipe the developer's
// own data, so the API says whether it applies and the UI believes it rather than
// guessing. Once cleared, the visitor is back on an empty Upload screen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      session: vi.fn(),
      clearWorkspace: vi.fn(),
      listUploads: vi.fn(),
      listPeriods: vi.fn(),
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
  api.listUploads.mockResolvedValue([]);
  api.listPeriods.mockResolvedValue([]);
});

describe('Clear all data', () => {
  it('is offered on a per-visitor deployment, asks before it fires, and lands on Upload', async () => {
    api.session.mockResolvedValue(ready());
    api.clearWorkspace.mockResolvedValue({ cleared: { orgId: 1042 } });

    render(<App />);

    const button = await screen.findByTestId('clear-all-data');
    // One click arms it, a second confirms: nothing is wiped by a stray click.
    await userEvent.click(button);
    expect(api.clearWorkspace).not.toHaveBeenCalled();

    api.listRuns.mockResolvedValue([]);
    await userEvent.click(screen.getByTestId('clear-confirm'));
    expect(api.clearWorkspace).toHaveBeenCalledTimes(1);

    // The workspace is empty now: Upload, with nothing loaded.
    expect(await screen.findByTestId('first-run')).toBeInTheDocument();
  });

  it('is hidden when the deployment serves a single shared org', async () => {
    api.session.mockResolvedValue(ready({ orgId: 1, perVisitor: false }));

    render(<App />);

    await screen.findByTestId('nav-summary');
    expect(screen.queryByTestId('clear-all-data')).not.toBeInTheDocument();
  });
});
