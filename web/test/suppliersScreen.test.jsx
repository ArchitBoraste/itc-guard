// Suppliers on 14 Sep: contacts, filing schemes, this period's issue and risk.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import aug14 from './fixtures/aug-14sep.json';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listSuppliers: vi.fn(), setContact: vi.fn(), setFilingScheme: vi.fn() } };
});

import { api } from '../src/api.js';
import { SuppliersScreen } from '../src/screens/Suppliers.jsx';

const GSTIN = {
  reliable: '27AAJFR9162G1ZT',
  krishna: '27BBRPK2295N1ZT'
};

async function renderSuppliers(suppliers = aug14.suppliers) {
  api.listSuppliers.mockResolvedValue(suppliers);
  const reloadPeriod = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<SuppliersScreen period="2026-08" results={aug14.results} dataVersion={0} reloadPeriod={reloadPeriod} refresh={refresh} />);
  await screen.findByTestId('suppliers-table');
  return { reloadPeriod, refresh };
}

const rowFor = (name) => within(screen.getByTestId('suppliers-table')).getByText(name).closest('tr');

beforeEach(() => {
  api.setContact.mockResolvedValue({});
  api.setFilingScheme.mockResolvedValue({});
});

describe('the list', () => {
  it("lists this period's suppliers with what happened to each", async () => {
    await renderSuppliers();
    expect(screen.getByText('12 suppliers this period, riskiest first.')).toBeInTheDocument();
    expect(rowFor('Reliable Traders')).toHaveTextContent('Not in your purchase register');
    expect(rowFor('Reliable Traders')).toHaveTextContent('1 invoice not in your books');
    expect(rowFor('National Supply Co')).toHaveTextContent('Amount higher than your bill');
    expect(rowFor('Anand Electricals')).toHaveTextContent('Saved, not filed');
    expect(rowFor('Krishna Enterprises')).toHaveTextContent('Quarterly · set by you');
    expect(rowFor('Patel Systems')).toHaveTextContent('Monthly (assumed)');
    expect(within(rowFor('Patel Systems')).getByText('Not filed')).toHaveClass('bad-text');
    expect(rowFor('Unity Distributors')).toHaveTextContent('₹0.60 rounding, accepted');
    expect(rowFor('Crystal Enterprises')).toHaveTextContent('−₹900');
  });

  it('says when a supplier filed, once GSTR-2B gives the date', async () => {
    const dated = {
      ...aug14.suppliers,
      suppliers: aug14.suppliers.suppliers.map((supplier) =>
        supplier.tradeName === 'Orbit Distributors' ? { ...supplier, lastFiledOn: '2026-09-04' } : supplier
      )
    };
    await renderSuppliers(dated);
    expect(rowFor('Orbit Distributors')).toHaveTextContent('Filed 4 Sep 2026');
  });

  it('never mentions the GSTIN checksum', async () => {
    const failing = {
      ...aug14.suppliers,
      suppliers: aug14.suppliers.suppliers.map((supplier) => ({ ...supplier, gstinChecksumValid: false }))
    };
    await renderSuppliers(failing);
    expect(document.body.textContent).not.toMatch(/checksum|check digit|invalid gstin/i);
  });

  it('searches by name or GSTIN, and narrows to suppliers with issues', async () => {
    await renderSuppliers();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search suppliers' }), GSTIN.krishna.slice(0, 8));
    expect(within(screen.getByTestId('suppliers-table')).getAllByRole('row')).toHaveLength(2);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search suppliers' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only with issues' }));
    const table = screen.getByTestId('suppliers-table');
    expect(within(table).queryByText('Orbit Distributors')).toBeNull();
    expect(within(table).getByText('Patel Systems')).toBeInTheDocument();
  });

  it('opens a row to the reasons for its risk', async () => {
    await renderSuppliers();
    await userEvent.click(screen.getByRole('button', { name: 'Show risk details for Patel Systems' }));
    expect(screen.getByTestId('risk-reasons')).toHaveTextContent('Reported nothing at all in 1 of the last 1 month');
  });
});

describe('risk', () => {
  const riskCell = (name) => within(rowFor(name)).getAllByRole('cell').at(-2);

  it('shows New instead of a band while a supplier has under three months of history', async () => {
    await renderSuppliers();
    expect(riskCell('Patel Systems')).toHaveTextContent('New · not enough history');
    expect(riskCell('Orbit Distributors')).toHaveTextContent('New · not enough history');
    expect(within(screen.getByTestId('suppliers-table')).queryByText(/^(Medium|Low)$/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show risk details for Patel Systems' }));
    const panel = screen.getByTestId('risk-reasons');
    expect(panel).toHaveTextContent('New · not enough history');
    expect(panel).toHaveTextContent('A risk band needs 3 months of filing history; 1 month so far.');
    // The facts are still listed.
    expect(panel).toHaveTextContent('Reported nothing at all in 1 of the last 1 month');
    expect(panel).not.toHaveTextContent('provisional');
  });

  it('shows a supplier with an invoice not in the books as High, first', async () => {
    await renderSuppliers();
    expect(riskCell('Reliable Traders')).toHaveTextContent('High');
    expect(riskCell('Reliable Traders')).toHaveTextContent('Invoice not in your books');
    const firstRow = within(screen.getByTestId('suppliers-table')).getAllByRole('row')[1];
    expect(firstRow).toHaveTextContent('Reliable Traders');

    await userEvent.click(screen.getByRole('button', { name: 'Show risk details for Reliable Traders' }));
    const panel = screen.getByTestId('risk-reasons');
    expect(panel).toHaveTextContent('Why high risk');
    expect(panel).toHaveTextContent('Invoice RT-760 of 27 Aug 2026 (₹5,400 tax) is on the portal but not in your books');
  });

  it('reads the band from a payload without a standing', async () => {
    const banded = {
      ...aug14.suppliers,
      suppliers: aug14.suppliers.suppliers.map((supplier) => {
        const { standing, ...risk } = supplier.risk;
        return { ...supplier, risk: { ...risk, band: 'MEDIUM', phantoms: [] } };
      })
    };
    await renderSuppliers(banded);
    expect(riskCell('Patel Systems')).toHaveTextContent('Medium');
  });
});

describe('contacts', () => {
  it('adds one for a supplier who is only on the portal', async () => {
    const { reloadPeriod } = await renderSuppliers();
    await userEvent.click(within(rowFor('Reliable Traders')).getByRole('button', { name: 'Add contact' }));
    const form = screen.getByTestId('contact-form');
    await userEvent.type(within(form).getByLabelText('Name'), 'Rohit Shah');
    await userEvent.type(within(form).getByLabelText('Phone'), '+91 98765 43210');
    await userEvent.click(within(form).getByRole('button', { name: 'Save contact' }));
    await waitFor(() =>
      expect(api.setContact).toHaveBeenCalledWith(GSTIN.reliable, { contactPerson: 'Rohit Shah', phone: '+91 98765 43210', email: '' })
    );
    await waitFor(() => expect(reloadPeriod).toHaveBeenCalled());
  });
});

describe('filing scheme', () => {
  it('is set by the trader, and every month is re-read', async () => {
    const { refresh } = await renderSuppliers();
    await userEvent.click(screen.getByRole('button', { name: 'Change filing frequency for Patel Systems' }));
    const form = screen.getByTestId('scheme-form');
    await userEvent.selectOptions(within(form).getByRole('combobox'), 'QRMP');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setFilingScheme).toHaveBeenCalledWith('24AAECP8836L1ZY', 'QRMP'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('can be handed back to inference', async () => {
    await renderSuppliers();
    await userEvent.click(screen.getByRole('button', { name: 'Change filing frequency for Krishna Enterprises' }));
    const form = screen.getByTestId('scheme-form');
    expect(within(form).getByRole('combobox')).toHaveValue('QRMP');
    await userEvent.selectOptions(within(form).getByRole('combobox'), '');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setFilingScheme).toHaveBeenCalledWith(GSTIN.krishna, null));
  });
});
