// Corrections in September: what August asked its suppliers for, and what came.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import sep05 from './fixtures/sep-05oct.json';
import sep10 from './fixtures/sep-10oct.json';
import { CorrectionsScreen } from '../src/screens/Corrections.jsx';

const rowFor = (invoiceNo) => within(screen.getByTestId('corrections-table')).getByText(invoiceNo).closest('tr');

describe('5 Oct', () => {
  it('counts what was asked for, what arrived and what still waits', () => {
    render(<CorrectionsScreen period="2026-09" corrections={sep05.corrections} />);
    expect(screen.getByText("Fixes you asked suppliers for in August, checked against September's files.")).toBeInTheDocument();
    expect(screen.getByTestId('asked')).toHaveTextContent('Asked for5from the August review');
    // August accepted ₹6,300 of MS-878, so its amendment brings ₹900; PS-3401 ₹3,240.
    expect(screen.getByTestId('arrived')).toHaveTextContent('Arrived2 · ₹4,140claimable in September');
    expect(screen.getByTestId('waiting')).toHaveTextContent('Still waiting3 · ₹10,620next chance 11 Oct 2026');
  });

  it('says what each supplier was asked for, and where an arrival was found', () => {
    render(<CorrectionsScreen period="2026-09" corrections={sep05.corrections} />);
    expect(rowFor('MS-878')).toHaveTextContent('Report the ₹900 tax difference');
    expect(rowFor('MS-878')).toHaveTextContent('Arrived');
    expect(rowFor('MS-878')).toHaveTextContent('GSTR-1A amendment · IMS 5 Oct 2026');
    expect(rowFor('MS-878')).toHaveTextContent('+₹900');
    expect(rowFor('PS-3401')).toHaveTextContent('Added through GSTR-1A');
    expect(rowFor('NS-612')).toHaveTextContent('Correct tax to ₹4,500');
    expect(rowFor('NS-612')).toHaveTextContent('Waiting · 1 month');
    expect(rowFor('NS-612')).toHaveTextContent('Not in September files');
    expect(rowFor('AE/177')).toHaveTextContent('File the saved invoice');
    expect(rowFor('AE/177')).toHaveTextContent('Saved, not filed yet');
    expect(within(rowFor('MS-878')).queryByRole('button', { name: /Remind/ })).toBeNull();
  });

  it('opens the reminder for a waiting correction', async () => {
    render(<CorrectionsScreen period="2026-09" corrections={sep05.corrections} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remind National Supply Co about NS-612' }));
    const panel = screen.getByRole('region', { name: 'Reminder to National Supply Co' });
    expect(within(panel).getByTestId('message-text')).toHaveTextContent(
      'Please correct it through GSTR-1A by 11 Oct 2026 so it reaches our September 2026 GSTR-2B.'
    );
  });
});

describe('10 Oct', () => {
  it("counts Anand's filing as arrived", () => {
    render(<CorrectionsScreen period="2026-09" corrections={sep10.corrections} />);
    expect(screen.getByTestId('arrived')).toHaveTextContent('3 ·');
    expect(screen.getByTestId('waiting')).toHaveTextContent('2 ·');
    expect(rowFor('AE/177')).toHaveTextContent('Arrived');
  });
});

describe('the first month', () => {
  it('explains when corrections appear', () => {
    render(<CorrectionsScreen period="2026-08" corrections={{ counts: { arrived: 0, waiting: 0 }, items: [] }} />);
    expect(screen.getByTestId('no-corrections')).toHaveTextContent('Corrections appear once you load a second month.');
  });
});
