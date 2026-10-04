// The shell: where an empty workspace lands, that the sidebar's counts agree with
// the screens, the As of date, Re-run, and Help.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import aug14 from './fixtures/aug-14sep.json';
import sep05 from './fixtures/sep-05oct.json';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      session: vi.fn(),
      org: vi.fn(),
      listPeriods: vi.fn(),
      clock: vi.fn(),
      setClock: vi.fn(),
      getRunByPeriod: vi.fn(),
      listAllResults: vi.fn(),
      listCorrections: vi.fn(),
      createRun: vi.fn(),
      listUploads: vi.fn(),
      listDemoFiles: vi.fn(),
      listAlerts: vi.fn(),
      listSuppliers: vi.fn(),
      downloadImsActions: vi.fn()
    }
  };
});

import { api } from '../src/api.js';
import App from '../src/App.jsx';
import { HelpScreen } from '../src/screens/Help.jsx';

const ORG = { org: { gstin: '27AABCS1080F1ZN', gstinAdopted: true, legalName: 'Sharma Electronics Private Limited', tradeName: 'Sharma Electronics' } };
const EMPTY_CLOCK = { clock: { asOfDate: '2026-10-04', today: '2026-10-04', followsToday: true }, calendar: null };

function workspace({ periods, run, results, corrections, clock, org = ORG }) {
  api.session.mockResolvedValue({ state: 'READY', perVisitor: true });
  api.org.mockResolvedValue(org);
  api.listPeriods.mockResolvedValue(periods);
  api.clock.mockResolvedValue(clock);
  api.getRunByPeriod.mockResolvedValue(run);
  api.listAllResults.mockResolvedValue(results);
  api.listCorrections.mockResolvedValue(corrections);
  api.listUploads.mockResolvedValue([]);
  api.listDemoFiles.mockResolvedValue([]);
}

const august = () =>
  workspace({
    periods: aug14.periods,
    run: aug14.run,
    results: aug14.results,
    corrections: aug14.corrections,
    clock: aug14.clock
  });

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
});

describe('an empty workspace', () => {
  it('lands on Upload, with nothing counted', async () => {
    workspace({
      periods: [], run: null, results: null, corrections: null, clock: EMPTY_CLOCK,
      org: { org: { ...ORG.org, gstin: '27AABCS2522F1ZQ', gstinAdopted: false } }
    });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Upload files' })).toBeInTheDocument();
    expect(screen.getByTestId('period-select')).toBeDisabled();
    expect(screen.queryByTestId('badge-decisions')).toBeNull();
    expect(screen.queryByTestId('deadline')).toBeNull();
    // The trader is named once their files say who they are.
    expect(screen.queryByTestId('trader')).toBeNull();
  });
});

describe('August on 14 Sep', () => {
  it('counts the same decisions and documents in the sidebar as on the screens', async () => {
    august();
    window.location.hash = '#/overview';
    render(<App />);
    await screen.findByTestId('tile-decision');
    expect(screen.getByTestId('badge-decisions')).toHaveTextContent('4');
    expect(screen.getByTestId('tile-decision')).toHaveTextContent('4 records');
    expect(screen.getByTestId('badge-notfiled')).toHaveTextContent('3');
    expect(screen.getByTestId('tile-notfiled')).toHaveTextContent('3 invoices');
    expect(screen.getByTestId('deadline')).toHaveTextContent('GSTR-3B due 20 Sep 2026 · 6 days left');
    expect(screen.getByTestId('trader')).toHaveTextContent('Sharma Electronics Pvt Ltd27AABCS1080F1ZN');

    await userEvent.click(screen.getByTestId('nav-decisions'));
    expect(await screen.findByTestId('tab-needs')).toHaveTextContent('4');
  });

  it('moves the workspace date from the top bar, and reads every screen again', async () => {
    august();
    api.setClock.mockResolvedValue({});
    window.location.hash = '#/overview';
    render(<App />);
    await screen.findByTestId('tile-decision');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.change(screen.getByTestId('as-of'), { target: { value: '2026-09-15' } });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(api.setClock).toHaveBeenCalledWith('2026-09-15', '2026-08'));
    await waitFor(() => expect(api.listPeriods.mock.calls.length).toBeGreaterThan(1));
  });

  it('offers Re-run in the top bar when the results are out of date', async () => {
    workspace({
      periods: aug14.periods,
      run: { ...aug14.run, staleness: { ...aug14.run.staleness, isStale: true } },
      results: aug14.results,
      corrections: aug14.corrections,
      clock: aug14.clock
    });
    api.createRun.mockResolvedValue(aug14.run);
    window.location.hash = '#/overview';
    render(<App />);
    const notice = await screen.findByTestId('stale-notice');
    await userEvent.click(within(notice).getByRole('button', { name: 'Re-run' }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledWith('2026-08'));
  });
});

describe('September', () => {
  it('counts the corrections still waiting', async () => {
    workspace({
      periods: sep05.periods,
      run: sep05.run,
      results: sep05.results,
      corrections: sep05.corrections,
      clock: sep05.clock
    });
    window.location.hash = '#/corrections?period=2026-09';
    render(<App />);
    await screen.findByTestId('corrections-table');
    expect(screen.getByTestId('badge-corrections')).toHaveTextContent('3');
    expect(screen.queryByTestId('badge-decisions')).toBeNull();
  });
});

describe('Help', () => {
  it('has one line per screen, the month, and says the workspace is private', () => {
    render(<HelpScreen />);
    expect(within(screen.getByTestId('help-screens')).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByTestId('help-calendar')).toHaveTextContent('11th');
    expect(screen.getByTestId('help-calendar')).toHaveTextContent('13th');
    expect(screen.getByTestId('help-calendar')).toHaveTextContent('14th');
    expect(screen.getByTestId('help-calendar')).toHaveTextContent('20th');
    expect(screen.getByTestId('help-privacy')).toHaveTextContent('Each visitor gets a private workspace; nothing is shared.');
  });
});
