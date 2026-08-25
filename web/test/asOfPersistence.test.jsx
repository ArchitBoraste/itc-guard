// The as-of date is the clock the whole session is being read at, not a setting
// belonging to one screen.
//
// It used to live in AlertsScreen's own state, so setting 5 May, stepping over to
// Actions and coming back silently snapped it to the run's 16 May — the demo
// cannot walk through the filing month if changing screens resets the month.
// It now rides in the hash query, which also survives a reload and makes one
// point in the month a link someone can send.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
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
  mode: 'PREVENTIVE',
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

const EMPTY_ALERTS = {
  taxPeriod: '2026-04',
  asOfDate: '2026-05-16',
  window: 'PREVENTIVE',
  orgCutOffDate: '2026-05-11',
  nextTaxPeriod: '2026-05',
  historyPeriods: [],
  totals: { supplierCount: 0, invoiceCount: 0, itcAtStake: 0, expectedInvoices: 0, imsRecords: 0 },
  bands: [],
  suppliers: []
};

beforeEach(() => {
  window.location.hash = '';
  api.org.mockResolvedValue({ org: { id: 1, gstin: '27AABCS1429F1Z8', tradeName: 'Sharma' }, demoPeriods: [] });
  api.listRuns.mockResolvedValue([{ id: 7, taxPeriod: '2026-04' }]);
  api.getRunByPeriod.mockResolvedValue(RUN);
  api.listAllResults.mockResolvedValue([]);
  api.listAlerts.mockResolvedValue(EMPTY_ALERTS);
  api.imsActionsSummary.mockResolvedValue({ stats: { records: 0, byAction: {} }, warnings: [] });
  api.listChanges.mockResolvedValue({ changes: [], counts: {} });
});

const gotoAlerts = async () => {
  await userEvent.click(await screen.findByTestId('nav-alerts'));
  return screen.findByTestId('as-of-date');
};

describe('the as-of date across the session', () => {
  it('opens on the run as-of date and puts nothing in the URL', async () => {
    render(<App />);
    expect(await gotoAlerts()).toHaveValue('2026-05-16');
    expect(window.location.hash).toBe('#/alerts');
  });

  it('survives navigating away and back', async () => {
    render(<App />);
    const input = await gotoAlerts();

    fireEvent.change(input, { target: { value: '2026-05-05' } });
    await waitFor(() => expect(api.listAlerts).toHaveBeenLastCalledWith('2026-04', '2026-05-05'));

    await userEvent.click(screen.getByTestId('nav-summary'));
    await userEvent.click(screen.getByTestId('nav-actions'));
    await userEvent.click(screen.getByTestId('nav-alerts'));

    expect(await screen.findByTestId('as-of-date')).toHaveValue('2026-05-05');
    expect(api.listAlerts).toHaveBeenLastCalledWith('2026-04', '2026-05-05');
  });

  it('carries the date through the URL so a point in the month can be linked', async () => {
    render(<App />);
    fireEvent.change(await gotoAlerts(), { target: { value: '2026-05-05' } });

    await waitFor(() => expect(window.location.hash).toContain('asOf=2026-05-05'));

    // And it stays on the hash while the trader moves around, which is what makes
    // the link reproducible rather than just the screen remembering.
    await userEvent.click(screen.getByTestId('nav-summary'));
    expect(window.location.hash).toBe('#/summary?asOf=2026-05-05');
  });

  it('starts from a date already in the URL, as a shared link would', async () => {
    window.location.hash = '#/alerts?asOf=2026-05-05';
    render(<App />);

    expect(await screen.findByTestId('as-of-date')).toHaveValue('2026-05-05');
    await waitFor(() => expect(api.listAlerts).toHaveBeenCalledWith('2026-04', '2026-05-05'));
  });

  // A hand-edited URL must not reach an API that will reject it.
  it('ignores a mangled date rather than sending it to the API', async () => {
    window.location.hash = '#/alerts?asOf=last-tuesday';
    render(<App />);

    expect(await screen.findByTestId('as-of-date')).toHaveValue('2026-05-16');
    await waitFor(() => expect(api.listAlerts).toHaveBeenCalledWith('2026-04', '2026-05-16'));
    expect(api.listAlerts).not.toHaveBeenCalledWith('2026-04', 'last-tuesday');
  });

  it('drops the parameter when the trader goes back to the run date', async () => {
    window.location.hash = '#/alerts?asOf=2026-05-05';
    render(<App />);
    await screen.findByTestId('as-of-date');

    await userEvent.click(screen.getByTestId('reset-as-of'));

    await waitFor(() => expect(window.location.hash).toBe('#/alerts'));
    expect(await screen.findByTestId('as-of-date')).toHaveValue('2026-05-16');
  });
});
