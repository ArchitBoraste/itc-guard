// Where the supplier detail panel opens.
//
// It used to render after the entire table, as a sibling of the whole panel. On
// the demo's 64 suppliers that meant clicking a row appeared to do nothing: the
// panel was a full page-scroll below the fold, with no indication it had opened
// or which supplier it was about.
//
// So placement is the assertion, not presence. `getByTestId('supplier-detail')`
// passed the whole time it was broken — it found the panel at the bottom of the
// page perfectly well. These tests pin it to the DOM position instead: inside
// the table, in the row immediately after the one that was clicked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listSuppliers: vi.fn(), getSupplier: vi.fn() } };
});

import { api } from '../src/api.js';
import { SuppliersScreen } from '../src/screens/Suppliers.jsx';

const RUN = { id: 3, taxPeriod: '2026-07' };

const supplier = (gstin, tradeName, overrides = {}) => ({
  gstin,
  tradeName,
  legalName: `${tradeName} Pvt Ltd`,
  stateCode: '27',
  filingScheme: 'MONTHLY',
  filingSchemeConfidence: 'MEDIUM',
  filingSchemeReason: 'filings appear monthly',
  stats: {
    periodsObserved: 6, lateCount: 0, missedCount: 0, invoiceCount: 12,
    mismatchCount: 0, avgDaysLate: -3, observedTotalTax: 100000,
    expectedTotalTax: 100000, trend: []
  },
  risk: {
    asOfPeriod: '2026-07', band: 'LOW', periodsObserved: 6, source: 'MODEL',
    guard: null, reasons: ['filed on time in all of the last 6 months, by their 11th'],
    topFactors: [],
    features: {
      periodsObserved: 6, lateCount: 0, missedCount: 0, mismatches: 0,
      documents: 12, meanDaysLate: -3, maxDaysLate: -2, cutOffDay: 11
    }
  },
  ...overrides
});

// Three rows, so "beneath the clicked row" and "at the end of the table" are
// genuinely different positions. With one row they would coincide and the test
// would pass against the bug it exists to catch.
const FIRST = supplier('27AAAAA0001A1Z5', 'Alpha Traders');
const MIDDLE = supplier('27BBBBB0002B1Z4', 'Deepak Sales Corp');
const LAST = supplier('27CCCCC0003C1Z3', 'Zenith Components');

const history = (gstin, tradeName) => ({
  gstin,
  tradeName,
  filingScheme: 'MONTHLY',
  filingSchemeConfidence: 'MEDIUM',
  filingSchemeReason: 'filings appear monthly',
  periods: [
    {
      taxPeriod: '2026-06', expectedCount: 4, invoiceCount: 4, appearedIn2b: true,
      appearedInIms: true, gstr1FiledOn: '2026-07-09', cutOffDate: '2026-07-11',
      daysLate: -2, expectedTotalTax: 50000, observedTotalTax: 50000,
      mismatchCount: 0, missed: false
    }
  ]
});

beforeEach(() => {
  api.listSuppliers.mockResolvedValue({
    suppliers: [FIRST, MIDDLE, LAST],
    model: { source: 'HEURISTIC' }
  });
  api.getSupplier.mockImplementation(async (gstin) =>
    history(gstin, gstin === MIDDLE.gstin ? MIDDLE.tradeName : 'Other')
  );
});

const rowFor = (entry) => screen.getByTestId(`supplier-${entry.gstin}`);

describe('the supplier detail panel', () => {
  it('opens in the row immediately below the supplier that was clicked', async () => {
    render(<SuppliersScreen run={RUN} />);
    const clicked = await screen.findByTestId(`supplier-${MIDDLE.gstin}`);

    await userEvent.click(clicked);
    const panel = await screen.findByTestId('supplier-detail');

    // The panel's own row is the clicked row's next sibling. This is the whole
    // point: a panel appended to the end of the table also "appears after" the
    // clicked row, and only adjacency distinguishes the two.
    const detailRow = panel.closest('tr');
    expect(detailRow).not.toBeNull();
    expect(clicked.nextElementSibling).toBe(detailRow);

    // And it is genuinely inside the table body, not a sibling of the table.
    expect(detailRow.parentElement).toBe(clicked.parentElement);
    expect(detailRow.closest('table')).toBe(screen.getByTestId('suppliers-table'));

    // The regression stated directly: a middle supplier's panel must not be last.
    const body = clicked.parentElement;
    expect(body.lastElementChild).not.toBe(detailRow);
    expect(body.lastElementChild).toBe(rowFor(LAST));
  });

  it('spans the full width of the table so it reads as one panel', async () => {
    render(<SuppliersScreen run={RUN} />);
    await userEvent.click(await screen.findByTestId(`supplier-${MIDDLE.gstin}`));
    const panel = await screen.findByTestId('supplier-detail');

    // `:scope >` matters: the panel contains its own per-period table, so a bare
    // 'thead th' counts that one's headers too and the comparison is meaningless.
    const headerCells = screen
      .getByTestId('suppliers-table')
      .querySelectorAll(':scope > thead > tr > th').length;
    expect(headerCells).toBeGreaterThan(1);
    expect(panel.closest('td').getAttribute('colspan')).toBe(String(headerCells));
  });

  it('marks the open row as selected, so the panel is attributable', async () => {
    render(<SuppliersScreen run={RUN} />);
    const clicked = await screen.findByTestId(`supplier-${MIDDLE.gstin}`);

    expect(clicked.className).not.toMatch(/is-selected/);

    await userEvent.click(clicked);
    await screen.findByTestId('supplier-detail');

    expect(clicked.className).toMatch(/is-selected/);
    expect(clicked).toHaveAttribute('aria-expanded', 'true');
    expect(rowFor(FIRST).className).not.toMatch(/is-selected/);
    expect(rowFor(LAST).className).not.toMatch(/is-selected/);
  });

  it('keeps only one open at a time, and moves it to the newly clicked row', async () => {
    render(<SuppliersScreen run={RUN} />);
    await userEvent.click(await screen.findByTestId(`supplier-${MIDDLE.gstin}`));
    await screen.findByTestId('supplier-detail');

    await userEvent.click(rowFor(LAST));
    await waitFor(() => {
      expect(screen.getAllByTestId('supplier-detail')).toHaveLength(1);
    });

    expect(rowFor(LAST).nextElementSibling).toBe(
      screen.getByTestId('supplier-detail').closest('tr')
    );
    expect(rowFor(MIDDLE).className).not.toMatch(/is-selected/);
  });

  it('still closes from the existing close control', async () => {
    render(<SuppliersScreen run={RUN} />);
    const clicked = await screen.findByTestId(`supplier-${MIDDLE.gstin}`);
    await userEvent.click(clicked);
    await screen.findByTestId('supplier-detail');

    await userEvent.click(screen.getByRole('button', { name: 'close' }));

    await waitFor(() => {
      expect(screen.queryByTestId('supplier-detail')).not.toBeInTheDocument();
    });
    expect(clicked.className).not.toMatch(/is-selected/);
  });
});
