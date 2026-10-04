// Not filed yet: the cut-off card in both states, by each supplier's own
// cut-off, and the message for the selected row.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import aug11 from './fixtures/aug-11sep.json';
import aug14 from './fixtures/aug-14sep.json';
import sep05 from './fixtures/sep-05oct.json';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listAlerts: vi.fn() } };
});

import { api } from '../src/api.js';
import { NotFiledScreen, cutoffState } from '../src/screens/NotFiled.jsx';

const rowsOf = (alerts) => alerts.suppliers.flatMap((supplier) => supplier.invoices.map((invoice) => ({ supplier, invoice })));

async function renderNotFiled(alerts, period = '2026-08') {
  api.listAlerts.mockResolvedValue(alerts);
  render(<NotFiledScreen period={period} dataVersion={0} />);
  return screen.findByTestId('cutoff-card');
}

beforeEach(() => api.listAlerts.mockReset());

describe('before the cut-off, 11 Sep', () => {
  it('says suppliers can still fix it for free, with both cut-offs', async () => {
    const card = await renderNotFiled(aug11.alerts);
    expect(card).toHaveAttribute('data-tone', 'info');
    expect(card).toHaveTextContent('Suppliers can still fix this for free');
    expect(card).toHaveTextContent('Last day');
    expect(card).toHaveTextContent('Monthly filers: 11 Sep 2026 · Quarterly filers: 13 Sep 2026');
    expect(card).toHaveTextContent("Ask the supplier to include the invoice in August's GSTR-1 or IFF. You claim the credit in August.");
    expect(screen.getByTestId('stat-invoices')).toHaveTextContent('Invoices3');
    expect(screen.getByTestId('stat-tax-waiting')).toHaveTextContent('Tax waiting₹9,360');
    expect(screen.getByTestId('stat-suppliers')).toHaveTextContent('Suppliers3');
  });

  it("lists each document with its supplier's own cut-off and status on the portal", async () => {
    await renderNotFiled(aug11.alerts);
    const table = screen.getByTestId('notfiled-table');
    const krishna = within(table).getByText('KE-112').closest('tr');
    expect(krishna).toHaveTextContent('Quarterly · set by you');
    expect(krishna).toHaveTextContent('13 Sep 20262 days left');
    expect(krishna).toHaveTextContent('Not on portal');
    const anand = within(table).getByText('AE/177').closest('tr');
    expect(anand).toHaveTextContent('Monthly (assumed)');
    expect(anand).toHaveTextContent('Saved, not filed');
    expect(anand).toHaveTextContent('11 Sep 2026Today');
  });

  it('shows the message for the row chosen', async () => {
    await renderNotFiled(aug11.alerts);
    expect(screen.getByRole('region', { name: /^Message to / })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Message Krishna Enterprises about KE-112' }));
    const panel = screen.getByRole('region', { name: 'Message to Krishna Enterprises' });
    expect(within(panel).getByTestId('message-text')).toHaveTextContent('in your GSTR-1 or IFF by 13 Sep 2026');
    expect(screen.getByRole('button', { name: 'Message Krishna Enterprises about KE-112' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('after the cut-off, 14 Sep', () => {
  it('says the cut-off has passed and asks for GSTR-1A', async () => {
    const card = await renderNotFiled(aug14.alerts);
    expect(card).toHaveAttribute('data-tone', 'bad');
    expect(card).toHaveTextContent('Supplier cut-off has passed');
    expect(card).toHaveTextContent('Passed');
    expect(card).toHaveTextContent('Ask the supplier to add the invoice through GSTR-1A. The credit will reach you in September.');
    const patel = within(screen.getByTestId('notfiled-table')).getByText('PS-3401').closest('tr');
    expect(patel).toHaveTextContent('11 Sep 2026Passed');
  });
});

describe('when only some cut-offs have passed', () => {
  it("names both, since a quarterly supplier's is later", () => {
    const rows = rowsOf(aug11.alerts).map(({ supplier, invoice }) => ({
      invoice,
      supplier: supplier.filingScheme === 'QRMP' ? { ...supplier, daysToCutOff: 1 } : { ...supplier, preCutOff: false, daysToCutOff: -1 }
    }));
    const state = cutoffState(rows, '2026-08');
    expect(state.title).toBe('Some suppliers can still fix this for free');
    expect(state.chip).toBe('1 day left');
    expect(state.dates).toBe('Monthly filers: 11 Sep 2026 · Quarterly filers: 13 Sep 2026');
  });
});

describe('September', () => {
  it('calls a saved record with a different amount what it is', async () => {
    await renderNotFiled(sep05.alerts, '2026-09');
    const national = within(screen.getByTestId('notfiled-table')).getByText('NS-701').closest('tr');
    expect(national).toHaveTextContent('Saved with a different amount');
  });
});

describe('nothing waiting', () => {
  it('says every invoice is filed', async () => {
    api.listAlerts.mockResolvedValue({ ...aug11.alerts, suppliers: [] });
    render(<NotFiledScreen period="2026-08" dataVersion={0} />);
    expect(await screen.findByTestId('all-filed')).toHaveTextContent('Every invoice in your books is filed');
  });
});
