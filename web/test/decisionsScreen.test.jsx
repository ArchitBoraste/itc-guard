// IMS decisions on 11 Sep, from the API's own answer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import aug11 from './fixtures/aug-11sep.json';
import { whyLine } from '../src/lib/issues.js';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      confirmResult: vi.fn(),
      confirmRecommendations: vi.fn(),
      dismissReset: vi.fn(),
      downloadImsActions: vi.fn(),
      createRun: vi.fn()
    }
  };
});

import { ApiError, api } from '../src/api.js';
import { DecisionsScreen } from '../src/screens/Decisions.jsx';

const byInvoice = (results, invoiceNo) =>
  results.find((row) => (row.books?.invoiceNo ?? row.portal?.invoiceNo) === invoiceNo && !row.linkedFrom);

function renderDecisions(results = aug11.results, run = aug11.run) {
  const reloadPeriod = vi.fn().mockResolvedValue(undefined);
  render(
    <DecisionsScreen
      period="2026-08"
      inventory={null}
      run={run}
      results={results}
      calendar={aug11.clock.calendar}
      navigate={vi.fn()}
      refresh={vi.fn()}
      reloadPeriod={reloadPeriod}
    />
  );
  return { reloadPeriod };
}

const rowFor = (invoiceNo) => screen.getByText(invoiceNo).closest('tr');

beforeEach(() => {
  api.confirmResult.mockResolvedValue({});
  api.confirmRecommendations.mockResolvedValue({ confirmed: [], skipped: [] });
  api.dismissReset.mockResolvedValue({});
});

describe('the tabs', () => {
  it('open on what needs a decision, with the same count as everywhere else', () => {
    renderDecisions();
    expect(screen.getByRole('tab', { name: /Needs a decision/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-needs')).toHaveTextContent('4');
    expect(screen.getByTestId('tab-ready')).toHaveTextContent('5');
    expect(screen.queryByTestId('accept-all')).toBeNull();
  });

  it('accept every clean match in one go from Ready to accept only', async () => {
    const { reloadPeriod } = renderDecisions();
    await userEvent.click(screen.getByRole('tab', { name: /Ready to accept/ }));
    await userEvent.click(screen.getByTestId('accept-all'));
    expect(api.confirmRecommendations).toHaveBeenCalledWith(aug11.run.id, expect.arrayContaining([byInvoice(aug11.results, 'INV-0801').id]));
    expect(api.confirmRecommendations.mock.calls[0][1]).toHaveLength(5);
    await waitFor(() => expect(reloadPeriod).toHaveBeenCalled());
  });

  it('move with the arrow keys', async () => {
    renderDecisions();
    screen.getByRole('tab', { name: /Needs a decision/ }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Decided/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Decided/ })).toHaveFocus();
  });

  it('show an override only when the decision differs from the recommendation', async () => {
    const results = aug11.results.map((row) => {
      if (row.books?.invoiceNo === 'BA/219') return { ...row, confirmedAction: 'ACCEPT', needsDecision: false };
      if (row.books?.invoiceNo === 'MS-878') return { ...row, confirmedAction: 'REJECT', needsDecision: false };
      return row;
    });
    renderDecisions(results);
    expect(screen.getByTestId('tab-overridden')).toHaveTextContent('1');
    await userEvent.click(screen.getByRole('tab', { name: /Overridden/ }));
    const table = screen.getByTestId('decision-table');
    expect(within(table).getByText('MS-878')).toBeInTheDocument();
    expect(within(table).queryByText('BA/219')).toBeNull();
    expect(within(table).getByText('You chose Reject')).toBeInTheDocument();
  });
});

describe('deciding a record', () => {
  it('records the choice', async () => {
    const { reloadPeriod } = renderDecisions();
    await userEvent.click(within(rowFor('NS-612')).getByRole('button', { name: 'Reject' }));
    expect(api.confirmResult).toHaveBeenCalledWith(byInvoice(aug11.results, 'NS-612').id, 'REJECT');
    await waitFor(() => expect(reloadPeriod).toHaveBeenCalled());
  });

  it('sends it back to Not decided when the same choice is pressed again', async () => {
    const national = byInvoice(aug11.results, 'NS-612');
    const rejected = aug11.results.map((row) =>
      row.id === national.id ? { ...row, confirmedAction: 'REJECT', needsDecision: false } : row
    );
    renderDecisions(rejected);
    await userEvent.click(screen.getByRole('tab', { name: /Decided/ }));
    const pressed = within(rowFor('NS-612')).getByRole('button', { name: 'Reject' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(pressed);
    expect(api.confirmResult).toHaveBeenLastCalledWith(national.id, 'NO_ACTION');
  });

  it('shows a refused decision on its row', async () => {
    api.confirmResult.mockRejectedValue(new ApiError('this record is out of date', { status: 409, code: 'stale_result' }));
    renderDecisions();
    await userEvent.click(within(rowFor('RT-760')).getByRole('button', { name: 'Reject' }));
    expect(await within(rowFor('RT-760')).findByRole('alert')).toHaveTextContent('this record is out of date');
  });
});

describe('a row opened', () => {
  it('shows books against portal, why, and the message to the supplier', async () => {
    renderDecisions();
    await userEvent.click(screen.getByRole('button', { name: 'Show details for NS-612' }));
    const details = screen.getByTestId('details');
    expect(details).toHaveTextContent('₹25,000');
    expect(details).toHaveTextContent('₹28,000');
    expect(details).toHaveTextContent('The portal shows more than your bill.');
    expect(within(details).getByTestId('message-text')).toHaveTextContent('Please correct it through GSTR-1A so we can accept it.');
    expect(within(details).getByRole('button', { name: /WhatsApp/ })).toHaveAttribute('aria-disabled', 'true');
    expect(within(details).getByRole('link', { name: 'Email' })).toHaveAttribute('href', expect.stringMatching(/^mailto:supplier5@example\.com/));
    // No remark until the rejection is confirmed: an undecided record goes out as N, without one.
    expect(screen.queryByTestId('remark')).toBeNull();
  });

  it('shows the remark sent with a confirmed rejection', async () => {
    const results = aug11.results.map((row) =>
      row.books?.invoiceNo === 'NS-612' ? { ...row, confirmedAction: 'REJECT', needsDecision: false } : row
    );
    renderDecisions(results);
    await userEvent.click(screen.getByRole('tab', { name: /Decided/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Show details for NS-612' }));
    expect(screen.getByTestId('remark')).toHaveTextContent('Remark sent with the rejection');
  });

  it('says a phantom supplier is not in the purchase register', async () => {
    renderDecisions();
    await userEvent.click(screen.getByRole('button', { name: 'Show details for RT-760' }));
    expect(screen.getByTestId('details')).toHaveTextContent('No contact on file: not in your purchase register');
  });
});

describe('a decision the supplier undid', () => {
  it('carries a "Changed by supplier" chip with Dismiss', async () => {
    const national = byInvoice(aug11.results, 'NS-612');
    const results = aug11.results.map((row) =>
      row.id === national.id ? { ...row, flags: [...row.flags, 'CONFIRMATION_RESET'] } : row
    );
    const { reloadPeriod } = renderDecisions(results);
    expect(within(rowFor('NS-612')).getByTestId('changed-chip')).toHaveTextContent('Changed by supplier');
    await userEvent.click(within(rowFor('NS-612')).getByRole('button', { name: 'Dismiss' }));
    expect(api.dismissReset).toHaveBeenCalledWith(national.id);
    await waitFor(() => expect(reloadPeriod).toHaveBeenCalled());
  });
});

describe('the IMS file', () => {
  it('asks before downloading while records are not decided', async () => {
    api.downloadImsActions.mockRejectedValueOnce(
      new ApiError('4 records would go to the portal as N', {
        status: 409,
        code: 'open_decisions',
        body: { openDecisions: aug11.run.openDecisions }
      })
    );
    api.downloadImsActions.mockResolvedValueOnce({ blob: new Blob(['{}']), filename: 'ims.json' });
    URL.createObjectURL = vi.fn(() => 'blob:ims');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderDecisions();
    expect(screen.getByTestId('decisions-footer')).toHaveTextContent('4 records not decided yet');
    expect(screen.getByTestId('decisions-footer')).toHaveTextContent('accepted automatically on 20 Sep 2026');

    await userEvent.click(screen.getByTestId('download-ims'));
    const dialog = await screen.findByRole('dialog', { name: '4 records not decided yet' });
    expect(within(dialog).getByTestId('open-decision-counts')).toHaveTextContent('1 not in your books');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Download anyway' }));
    expect(api.downloadImsActions).toHaveBeenLastCalledWith(aug11.run.id, { acknowledgeOpenDecisions: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(click).toHaveBeenCalled();
  });
});

describe('credit notes', () => {
  it('never promise credit arriving next period', () => {
    const note = {
      bucket: 'VALUE_MISMATCH',
      flags: [],
      books: { docType: 'CREDIT_NOTE', totalTax: 90000 },
      portal: { docType: 'CREDIT_NOTE', totalTax: 120000, filingStatus: 'FILED' }
    };
    expect(whyLine(note)).toMatch(/reverses more credit than your books/);
    expect(whyLine(note)).not.toMatch(/arrive/i);
  });
});
