// Overview on the demo's dates, from the API's own answers: the four figures add
// up to the books, the to-do list hides what is done, and every non-matching item
// is listed, earlier months' late arrivals included.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import aug14 from './fixtures/aug-14sep.json';
import aug14accepted from './fixtures/aug-14sep-accepted.json';
import sep05 from './fixtures/sep-05oct.json';
import { OverviewScreen } from '../src/screens/Overview.jsx';
import { overviewFigures } from '../src/lib/overview.js';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { createRun: vi.fn(), downloadImsActions: vi.fn() } };
});

function renderOverview(fixture, period, extra = {}) {
  render(
    <OverviewScreen
      period={period}
      inventory={null}
      run={fixture.run}
      results={fixture.results}
      corrections={fixture.corrections ?? null}
      calendar={fixture.clock?.calendar ?? fixture.run?.calendar ?? null}
      navigate={vi.fn()}
      href={(route) => `#/${route}`}
      refresh={vi.fn()}
      rerun={vi.fn()}
      rerunning={false}
      {...extra}
    />
  );
}

const tile = (id) => screen.getByTestId(id);

describe('14 Sep, GSTR-2B in', () => {
  it('shows the demo brief’s four figures, which add up to the books', () => {
    renderOverview(aug14, '2026-08');
    expect(tile('tile-books')).toHaveTextContent('Credit in your books₹42,66011 documents');
    expect(tile('tile-ready')).toHaveTextContent('Ready to claim₹18,9005 match exactly');
    expect(tile('tile-decision')).toHaveTextContent('Needs your decision₹14,4004 records');
    expect(tile('tile-notfiled')).toHaveTextContent('Not filed by suppliers₹9,3603 invoices');
    expect(screen.getByTestId('segbar')).toHaveAttribute(
      'aria-label',
      'Ready to claim ₹18,900, Needs your decision ₹14,400, Not filed by suppliers ₹9,360'
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('August 2026');
    expect(screen.getByText('11 documents in your books · 10 records on the portal')).toBeInTheDocument();
  });

  it('counts decisions as the API does', () => {
    renderOverview(aug14, '2026-08');
    expect(tile('tile-decision')).toHaveTextContent(`${aug14.run.openDecisions.count} records`);
  });

  it('lists the steps before GSTR-3B, each with one button', () => {
    renderOverview(aug14, '2026-08');
    expect(screen.getByRole('heading', { name: 'Before 20 Sep 2026' })).toBeInTheDocument();
    const steps = within(screen.getByTestId('todo')).getAllByRole('listitem');
    expect(steps.map((step) => step.querySelector('.todo-title').textContent)).toEqual([
      'Decide 4 IMS records',
      'Chase 3 suppliers',
      'Upload the IMS file on the portal'
    ]);
    expect(within(steps[0]).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '#/decisions');
    expect(within(steps[0]).getByText('₹14,400 is waiting on you')).toBeInTheDocument();
  });

  it('lists every item that does not match exactly, in plain words', () => {
    renderOverview(aug14, '2026-08');
    const table = screen.getByTestId('found');
    const issues = within(table).getAllByRole('row').slice(1).map((row) => row.cells[0].textContent);
    expect(issues).toEqual([
      'Lower on portal',
      'Higher on portal',
      'Invoice no. differs',
      'Not in your books',
      'Not on portal',
      'Not on portal',
      'Saved, not filed',
      '₹0.60 rounding · accepted'
    ]);
    expect(within(table).getByText('BA/291', { exact: false }).closest('td')).toHaveTextContent('BA/219 vs BA/291');
    expect(within(table).getByText('−₹900')).toBeInTheDocument();
    expect(within(table).getByText('+₹540')).toBeInTheDocument();
    expect(screen.getByTestId('exact-count')).toHaveTextContent('4 other documents match exactly');
    // Never an engine code on screen.
    expect(document.body.textContent).not.toMatch(/VALUE_MISMATCH|MISSING_IN|NON_IMS|SUGGESTED/);
  });
});

describe('after accepting Mahavir', () => {
  it('claims the portal figure and leaves the ₹900 waiting on the supplier', () => {
    renderOverview(aug14accepted, '2026-08');
    expect(tile('tile-ready')).toHaveTextContent('₹25,200');
    expect(tile('tile-decision')).toHaveTextContent('₹7,2003 records');
    expect(screen.getByTestId('rest-line')).toHaveTextContent("₹900 waiting on a supplier's correction");
    const figures = overviewFigures(aug14accepted.run, aug14accepted.results);
    expect(figures.ready.itc + figures.decision.itc + figures.notFiled.itc + figures.rest.itc).toBe(figures.books.itc);
  });
});

describe('5 Oct, September with August arriving late', () => {
  it("says what arrived from August, and marks August's documents", () => {
    renderOverview(sep05, '2026-09');
    // August accepted ₹6,300 of MS-878, so its amendment brings ₹900; PS-3401 ₹3,240.
    expect(screen.getByTestId('carried-in')).toHaveTextContent('₹4,140 arrived from August · see Corrections');
    expect(screen.getByRole('link', { name: 'see Corrections' })).toHaveAttribute('href', '#/corrections');
    const table = screen.getByTestId('found');
    const fromAugust = within(table).getAllByText('From August');
    expect(fromAugust).toHaveLength(3);
    expect(fromAugust[0].closest('tr')).toBeTruthy();
  });

  it('has nothing to decide while National can still fix its saved record for free', () => {
    renderOverview(sep05, '2026-09');
    expect(tile('tile-decision')).toHaveTextContent('₹00 records');
    const titles = within(screen.getByTestId('todo')).getAllByRole('listitem').map((step) => step.querySelector('.todo-title').textContent);
    expect(titles).not.toContain('Decide 0 IMS records');
    expect(titles[0]).toMatch(/^Chase \d+ suppliers$/);
    expect(titles).toContain('Remind suppliers about 3 corrections');
  });

  it('keeps the books total to September’s own documents', () => {
    renderOverview(sep05, '2026-09');
    expect(tile('tile-books')).toHaveTextContent('₹37,08010 documents');
  });
});

describe('no run yet', () => {
  it('offers to reconcile when the books and the portal are in', () => {
    renderOverview({ run: null, results: null }, '2026-08', { inventory: { hasBooks: true, hasPortal: true } });
    expect(screen.getByRole('button', { name: 'Reconcile August 2026' })).toBeInTheDocument();
  });
});
