// The About screen carries the app's own disclaimer: what its file formats were
// recovered from, and that every figure in it is synthetic.
//
// Two things about it are load-bearing rather than cosmetic, and both are here:
// it is reachable with no data loaded at all, and it is reachable when the API is
// down. A caveat that only renders on a healthy, seeded machine is not a caveat.
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
      listChanges: vi.fn(),
      listSuppliers: vi.fn(),
      listUploads: vi.fn(),
      listPeriods: vi.fn(),
      seedDemo: vi.fn(),
      createRun: vi.fn()
    }
  };
});

import { api } from '../src/api.js';
import App from '../src/App.jsx';
import { AboutScreen, TEST_COUNTS } from '../src/screens/About.jsx';

beforeEach(() => {
  window.location.hash = '';
  // Single-org deployment: the session resolves immediately and the app carries
  // on exactly as it did before per-visitor demo data existed.
  api.session.mockResolvedValue({ orgId: 1, state: 'READY', isNew: false, error: null, perVisitor: false });
  api.org.mockResolvedValue({ org: { id: 1, gstin: '27AABCS1429F1Z8', tradeName: 'Sharma' }, demoPeriods: [] });
  api.listRuns.mockResolvedValue([]);
  api.listUploads.mockResolvedValue([]);
  api.listPeriods.mockResolvedValue([]);
});

describe('the about screen', () => {
  it('names the tools each schema was recovered from', () => {
    render(<AboutScreen />);
    const sources = screen.getByTestId('about-sources');
    expect(sources).toHaveTextContent('IMS_Offline_Utility_V1_1.xlsm');
    expect(sources).toHaveTextContent('GSTR2B_Offline_Matching_Tool_v2.9.exe');
    expect(sources).toHaveTextContent('Returns Offline Tool V3.2.4');
  });

  it('states the synthetic-data caveat where it cannot be missed', () => {
    render(<AboutScreen />);
    const caveat = screen.getByTestId('about-synthetic');
    expect(caveat).toHaveTextContent(/synthetic/i);
    expect(caveat).toHaveTextContent(/generate-fixtures/);
    // The specific claim, not just the word: the model learned the generator.
    expect(caveat).toHaveTextContent(/learned is the generator/i);
  });

  it('reports the test counts', () => {
    render(<AboutScreen />);
    expect(screen.getByTestId('about-tests')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${TEST_COUNTS.api} API tests`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${TEST_COUNTS.web} front-end tests`))).toBeInTheDocument();
  });
});

describe('reaching About', () => {
  it('is clickable with nothing loaded, when every other screen is disabled', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('nav-about')).toBeEnabled());

    // The cold-start state: no runs, so the app has forced itself onto Upload and
    // greyed the rest of the nav out.
    expect(screen.getByTestId('nav-summary')).toBeDisabled();
    expect(screen.getByTestId('nav-actions')).toBeDisabled();

    await userEvent.click(screen.getByTestId('nav-about'));
    expect(await screen.findByTestId('about-synthetic')).toBeInTheDocument();
  });

  it('stays on About instead of being bounced back to Upload', async () => {
    window.location.hash = '#/about';
    render(<App />);
    expect(await screen.findByTestId('about-synthetic')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('nav-about')).toHaveClass('is-active'));
  });

  it('renders when the API is unreachable', async () => {
    api.org.mockRejectedValue(new Error('Failed to fetch'));
    api.listRuns.mockRejectedValue(new Error('Failed to fetch'));

    window.location.hash = '#/about';
    render(<App />);

    expect(await screen.findByTestId('about-synthetic')).toBeInTheDocument();
    expect(screen.queryByTestId('error')).not.toBeInTheDocument();
  });
});
