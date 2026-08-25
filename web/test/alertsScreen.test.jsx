// The alerts screen exists to make one distinction visible: a supplier who is
// probably fine versus one who probably is not. Everything asserted here is
// about that distinction surviving the render.
//
// The fixture gives the LOW-risk supplier the LARGEST amount on purpose. If the
// screen ever sorted or grouped by rupees, they would appear above the ghost
// supplier and the whole point of the ranking would be gone with nothing on
// screen looking wrong.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listAlerts: vi.fn() } };
});

import { api } from '../src/api.js';
import { AlertsScreen } from '../src/screens/Alerts.jsx';

const RUN = { id: 7, taxPeriod: '2026-07', asOfDate: '2026-08-05' };

const GHOST = {
  gstin: '27AAAAA0003A1Z3',
  tradeName: 'Krishna Traders',
  filingScheme: 'MONTHLY',
  filingSchemeConfidence: 'MEDIUM',
  filingSchemeReason: 'filings appear monthly',
  cutOffDate: '2026-08-11',
  daysToCutOff: 6,
  preCutOff: true,
  urgency: 'EARLY',
  urgencyRank: 1,
  risk: {
    band: 'HIGH',
    score: 0.66,
    reasons: ['reported nothing at all in 5 of the last 6 months'],
    features: {}
  },
  invoiceCount: 1,
  itcAtStake: 180000,
  statusCounts: { NOT_REPORTED: 1, SAVED_NOT_FILED: 0, SAVED_VALUE_MISMATCH: 0 },
  invoices: [
    {
      expectedInvoiceId: 11,
      status: 'NOT_REPORTED',
      invoiceNo: 'KT/26/7003',
      invoiceDate: '2026-07-18',
      taxableValue: 1000000,
      totalTax: 180000,
      itcAtStake: 180000,
      deltaTotalTax: null,
      note: 'Not in IMS at all — the supplier has not even saved it yet.'
    }
  ],
  headline: 'Krishna Traders — 1 document to chase, 6 days left.',
  consequence: 'Their return is still a draft until 11 Aug 2026 — 6 days away.',
  chaseMessage: 'To: Krishna Traders (27AAAAA0003A1Z3)\n\nKT/26/7003 is not on the portal.'
};

const RELIABLE = {
  ...GHOST,
  gstin: '27AAAAA0001A1Z5',
  tradeName: 'Dell Agencies',
  risk: {
    band: 'LOW',
    score: 0,
    reasons: ['filed on time in all of the last 6 months, by their 11th'],
    features: {}
  },
  // Twenty times the ghost's exposure, and still LOW.
  itcAtStake: 3600000,
  invoices: [{ ...GHOST.invoices[0], expectedInvoiceId: 12, invoiceNo: 'DEL/2026/7001' }],
  chaseMessage: 'To: Dell Agencies (27AAAAA0001A1Z5)'
};

const band = (name, suppliers) => ({
  band: name,
  supplierCount: suppliers.length,
  invoiceCount: suppliers.reduce((sum, entry) => sum + entry.invoiceCount, 0),
  itcAtStake: suppliers.reduce((sum, entry) => sum + entry.itcAtStake, 0),
  suppliers
});

const ALERTS = {
  taxPeriod: '2026-07',
  asOfDate: '2026-08-05',
  window: 'PREVENTIVE',
  orgCutOffDate: '2026-08-11',
  nextTaxPeriod: '2026-08',
  historyPeriods: [],
  totals: { supplierCount: 2, invoiceCount: 2, itcAtStake: 3780000, expectedInvoices: 2, imsRecords: 0 },
  bands: [band('HIGH', [GHOST]), band('MEDIUM', []), band('LOW', [RELIABLE])],
  suppliers: [GHOST, RELIABLE]
};

beforeEach(() => {
  api.listAlerts.mockResolvedValue(ALERTS);
});

const mount = (run = RUN) => render(<AlertsScreen run={run} taxPeriod="2026-07" />);

describe('the alerts screen', () => {
  it('opens on the run as-of date rather than today', async () => {
    mount();
    await waitFor(() => expect(api.listAlerts).toHaveBeenCalled());
    expect(api.listAlerts).toHaveBeenCalledWith('2026-07', '2026-08-05');
    expect(screen.getByTestId('as-of-date')).toHaveValue('2026-08-05');
  });

  // A date input is picked, not typed: the browser emits one change carrying the
  // whole date. Typing it a character at a time would exercise a sequence of
  // half-formed values no user ever produces.
  it('re-asks the server when the trader moves through the month', async () => {
    mount();
    await waitFor(() => expect(api.listAlerts).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('as-of-date'), { target: { value: '2026-08-12' } });

    await waitFor(() => expect(api.listAlerts).toHaveBeenLastCalledWith('2026-07', '2026-08-12'));
  });

  // --- the date is owned by App, so it can live in the URL ------------------

  it('takes the as-of date from its prop when App is driving it', async () => {
    render(
      <AlertsScreen run={RUN} taxPeriod="2026-07" asOf="2026-08-12" onAsOfChange={vi.fn()} />
    );
    await waitFor(() => expect(api.listAlerts).toHaveBeenCalledWith('2026-07', '2026-08-12'));
    expect(screen.getByTestId('as-of-date')).toHaveValue('2026-08-12');
  });

  it('reports a change upward instead of keeping it to itself', async () => {
    const onAsOfChange = vi.fn();
    render(
      <AlertsScreen run={RUN} taxPeriod="2026-07" asOf="2026-08-12" onAsOfChange={onAsOfChange} />
    );
    await screen.findByTestId('alert-summary');

    fireEvent.change(screen.getByTestId('as-of-date'), { target: { value: '2026-08-05' } });
    expect(onAsOfChange).toHaveBeenCalledWith('2026-08-05');
  });

  it('clears the override rather than pinning the default as a value', async () => {
    const onAsOfChange = vi.fn();
    render(
      <AlertsScreen run={RUN} taxPeriod="2026-07" asOf="2026-08-12" onAsOfChange={onAsOfChange} />
    );
    await userEvent.click(await screen.findByTestId('reset-as-of'));
    // null, not '2026-08-05' — the URL goes back to carrying no date at all.
    expect(onAsOfChange).toHaveBeenCalledWith(null);
  });

  it('groups by risk band and totals the credit in each', async () => {
    mount();
    const high = await screen.findByTestId('band-HIGH');
    const low = await screen.findByTestId('band-LOW');

    expect(within(high).getByTestId(`alert-${GHOST.gstin}`)).toBeInTheDocument();
    expect(within(low).getByTestId(`alert-${RELIABLE.gstin}`)).toBeInTheDocument();

    expect(screen.getByTestId('band-itc-HIGH')).toHaveTextContent('₹1,800');
    expect(screen.getByTestId('band-itc-LOW')).toHaveTextContent('₹36,000');

    // An empty band renders nothing at all rather than an empty heading.
    expect(screen.queryByTestId('band-MEDIUM')).not.toBeInTheDocument();
  });

  it('does not let the larger amount outrank the riskier supplier', async () => {
    mount();
    await screen.findByTestId('band-HIGH');
    const panels = screen.getAllByTestId(/^band-(HIGH|MEDIUM|LOW)$/);
    expect(panels[0]).toHaveAttribute('data-testid', 'band-HIGH');
    expect(panels.at(-1)).toHaveAttribute('data-testid', 'band-LOW');
  });

  // The card used to carry `urgency-PAST_CUTOFF`, the same class as the chip, so
  // the chip's line-through inherited down and struck through the supplier name,
  // the reasons, the invoice table and the amounts. A passed cut-off makes these
  // WORSE, not resolved — nothing on the card is ever crossed out.
  it('does not cross out a card whose cut-off has passed', async () => {
    const stranded = {
      ...GHOST,
      preCutOff: false,
      daysToCutOff: -5,
      urgency: 'PAST_CUTOFF',
      consequence: 'Their cut-off (11 Aug 2026) has passed. A correction now needs GSTR-1A.'
    };
    api.listAlerts.mockResolvedValue({
      ...ALERTS,
      bands: [band('HIGH', [stranded]), band('MEDIUM', []), band('LOW', [])],
      suppliers: [stranded]
    });

    mount();
    const card = await screen.findByTestId(`alert-${GHOST.gstin}`);

    // The card is marked, but never in the chip's own class namespace.
    expect(card).toHaveClass('is-past-cutoff');
    expect(card.className).not.toContain('urgency-');

    // The state is still said, on the chip, where the styling belongs.
    expect(screen.getByTestId(`urgency-${GHOST.gstin}`)).toHaveTextContent('Cut-off passed');
    // And the supplier name is still plain text a trader can read and act on.
    expect(within(card).getByText('Krishna Traders')).toBeInTheDocument();
  });

  it('says why a supplier is flagged in words, not as a score', async () => {
    mount();
    const reasons = await screen.findByTestId(`reasons-${GHOST.gstin}`);
    expect(reasons).toHaveTextContent('reported nothing at all in 5 of the last 6 months');
    // The number behind the band is never printed.
    expect(screen.queryByText('0.66')).not.toBeInTheDocument();
  });

  it('offers the chase message per supplier and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    mount();
    const button = await screen.findByTestId(`copy-${GHOST.gstin}`);
    await userEvent.click(button);

    expect(writeText).toHaveBeenCalledWith(GHOST.chaseMessage);
    await waitFor(() => expect(button).toHaveTextContent('Copied'));
  });

  it('falls back to showing the text when the clipboard is blocked', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });

    mount();
    await userEvent.click(await screen.findByTestId(`copy-${GHOST.gstin}`));

    expect(await screen.findByTestId(`copy-${GHOST.gstin}-text`)).toHaveTextContent(
      'KT/26/7003 is not on the portal'
    );
  });

  it('says so plainly when there is nothing to chase', async () => {
    api.listAlerts.mockResolvedValue({
      ...ALERTS,
      totals: { ...ALERTS.totals, supplierCount: 0, invoiceCount: 0, itcAtStake: 0 },
      bands: [band('HIGH', []), band('MEDIUM', []), band('LOW', [])],
      suppliers: []
    });
    mount();
    expect(await screen.findByTestId('empty-alerts')).toHaveTextContent('Nothing to chase');
  });
});
