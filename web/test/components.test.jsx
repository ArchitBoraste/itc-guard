// The shared components every screen is built from.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chip } from '../src/components/Chip.jsx';
import { StatTile } from '../src/components/StatTile.jsx';
import { PageHeader } from '../src/components/PageHeader.jsx';
import { DataTable } from '../src/components/DataTable.jsx';
import { SegmentedDecision } from '../src/components/SegmentedDecision.jsx';
import { MessagePanel, mailtoHref } from '../src/components/MessagePanel.jsx';
import { EmptyState } from '../src/components/EmptyState.jsx';
import { ConfirmDialog } from '../src/components/ConfirmDialog.jsx';
import { Sidebar } from '../src/components/Sidebar.jsx';
import { TopBar } from '../src/components/TopBar.jsx';
import { deadlineChip, formatDate, formatUploadTime } from '../src/lib/calendar.js';

const MESSAGE = {
  kind: 'PORTAL_HIGHER',
  subject: 'Invoice NS-612 dated 13 Aug 2026',
  text: 'Hello Rakesh ji, invoice NS-612 (13 Aug 2026) shows ₹28,000 taxable. Thank you, Sharma Electronics',
  whatsappUrl: 'https://wa.me/919822041587?text=Hello'
};

describe('Chip', () => {
  it('says its status in words as well as colour', () => {
    render(<Chip tone="bad">Not in your books</Chip>);
    const chip = screen.getByText('Not in your books');
    expect(chip).toHaveClass('chip', 'chip-bad');
    expect(chip).toHaveAttribute('data-tone', 'bad');
  });
});

describe('StatTile', () => {
  it('puts the label above the value and the context under it', () => {
    render(<StatTile label="Ready to claim" value="₹18,900" sub="5 match exactly" tone="ok" testId="ready" />);
    const tile = screen.getByTestId('ready');
    expect(tile.textContent).toBe('Ready to claim₹18,9005 match exactly');
    expect(screen.getByTestId('ready-value')).toHaveClass('tone-ok');
  });
});

describe('PageHeader', () => {
  it('has one heading and at most one sentence', () => {
    render(<PageHeader title="Corrections" subtitle="Fixes you asked suppliers for." />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Corrections');
    expect(screen.getByText('Fixes you asked suppliers for.')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  const columns = [
    { key: 'name', header: 'Supplier', render: (row) => row.name },
    { key: 'tax', header: 'Tax', align: 'right', render: (row) => row.tax },
    { key: 'go', header: 'Action', hideHeader: true, render: () => <button type="button">Open</button> }
  ];
  const rows = [
    { id: 1, name: 'Orbit Distributors', tax: '₹9,000' },
    { id: 2, name: 'Patel Systems', tax: '₹3,240' }
  ];

  it('scrolls inside its card, never the page', () => {
    const { container } = render(<DataTable label="Suppliers" columns={columns} rows={rows} rowKey={(row) => row.id} minWidth={900} />);
    expect(container.firstChild).toHaveClass('table-scroll');
    expect(screen.getByRole('table', { name: 'Suppliers' })).toHaveStyle({ minWidth: '900px' });
  });

  it('labels an action column for screen readers only, and right-aligns figures', () => {
    render(<DataTable label="Suppliers" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers[2].querySelector('.visually-hidden')).toHaveTextContent('Action');
    expect(screen.getByText('₹3,240').closest('td')).toHaveClass('align-right');
  });

  it('draws an open row’s detail under it, across every column', () => {
    render(
      <DataTable
        label="Suppliers"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        isExpanded={(row) => row.id === 2}
        renderDetail={(row) => <p>Reasons for {row.name}</p>}
      />
    );
    const detail = screen.getByText('Reasons for Patel Systems').closest('td');
    expect(detail).toHaveAttribute('colspan', '3');
    expect(screen.queryByText('Reasons for Orbit Distributors')).toBeNull();
  });
});

describe('SegmentedDecision', () => {
  it('shows the chosen action as pressed, and choosing it again clears it', async () => {
    const onChange = vi.fn();
    render(<SegmentedDecision value="REJECT" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Decision' });
    expect(within(group).getByRole('button', { name: 'Reject' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(within(group).getByRole('button', { name: 'Reject' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await userEvent.click(within(group).getByRole('button', { name: 'Accept' }));
    expect(onChange).toHaveBeenLastCalledWith('ACCEPT');
  });

  it('never offers Pending where the portal blocks it', () => {
    render(<SegmentedDecision onChange={vi.fn()} pendingBlocked />);
    expect(screen.getByRole('button', { name: 'Pending' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
  });
});

describe('MessagePanel', () => {
  const contact = { person: 'Rakesh Jain', phone: '+91 98220 41587', email: 'rakesh@example.in' };

  it('shows the contact and the text, and opens WhatsApp in a new tab', () => {
    render(<MessagePanel contact={contact} message={MESSAGE} />);
    expect(screen.getByText('Rakesh Jain · +91 98220 41587 · rakesh@example.in')).toBeInTheDocument();
    expect(screen.getByTestId('message-text')).toHaveTextContent(MESSAGE.text);
    const whatsapp = screen.getByRole('link', { name: 'WhatsApp' });
    expect(whatsapp).toHaveAttribute('href', MESSAGE.whatsappUrl);
    expect(whatsapp).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Email' }).getAttribute('href')).toBe(mailtoHref(contact, MESSAGE));
  });

  it('builds a mailto with the subject and body, spaces not plus signs', () => {
    const href = mailtoHref(contact, MESSAGE);
    expect(href.startsWith('mailto:rakesh@example.in?subject=Invoice%20NS-612')).toBe(true);
    expect(href).not.toContain('+');
  });

  it('disables WhatsApp with the reason when there is no mobile number', () => {
    render(<MessagePanel contact={{ person: 'Sample', phone: '+91 00000 00005' }} message={{ ...MESSAGE, whatsappUrl: null }} />);
    const button = screen.getByRole('button', { name: /WhatsApp/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', 'WhatsApp needs an Indian mobile number');
    expect(screen.getByRole('button', { name: /Email/ })).toHaveAttribute('title', 'No email address on file');
  });

  it('says so when nobody is on file', () => {
    render(<MessagePanel contact={null} message={MESSAGE} noContactText="Not in your purchase register" />);
    expect(screen.getByText('Not in your purchase register')).toHaveClass('bad-text');
  });

  it('copies the text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MessagePanel contact={contact} message={MESSAGE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(MESSAGE.text);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('says what is missing and offers the next step', () => {
    render(<EmptyState title="Nothing here yet" action={<a href="#/upload">Upload files</a>} />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('Nothing here yet');
    expect(screen.getByRole('link', { name: 'Upload files' })).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('is a labelled modal that starts on Cancel and closes on Escape', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="Clear all data?" confirmLabel="Clear all data" danger onConfirm={onConfirm} onCancel={onCancel}>
        <p>Every upload goes.</p>
      </ConfirmDialog>
    );
    const dialog = screen.getByRole('dialog', { name: 'Clear all data?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear all data' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe('Sidebar', () => {
  it('marks the current screen and shows the counts that need attention', () => {
    render(
      <Sidebar
        route="decisions"
        href={(route) => `#/${route}`}
        badges={{ decisions: 4, notFiled: 3, corrections: 0 }}
        trader={{ name: 'Sharma Electronics Pvt Ltd', gstin: '27AABCS1080F1ZN' }}
      />
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /IMS decisions/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('badge-decisions')).toHaveTextContent('4 need a decision');
    expect(screen.getByTestId('badge-notfiled')).toHaveTextContent('3 not filed');
    expect(screen.queryByTestId('badge-corrections')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Help' })).toHaveAttribute('href', '#/help');
    expect(screen.getByTestId('trader')).toHaveTextContent('27AABCS1080F1ZN');
  });
});

describe('dates', () => {
  it('are shown one way everywhere: day, short month, year', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026');
    expect(formatDate(null)).toBe('—');
    // An upload stamp is UTC from MySQL, read in India.
    const now = new Date('2026-10-05T06:00:00Z');
    expect(formatUploadTime('2026-10-04 07:32:49', now)).toBe('4 Oct 2026, 1:02 pm');
    expect(formatUploadTime('2026-10-05 05:00:00', now)).toBe('Today, 10:30 am');
  });
});

describe('the deadline chip', () => {
  const calendar = (cut, due) => ({
    deadlines: [
      { key: 'CUTOFF_MONTHLY', date: '2026-09-11', daysLeft: cut },
      { key: 'GSTR3B_DUE', date: '2026-09-20', daysLeft: due }
    ]
  });

  it('names the supplier cut-off until it passes, then GSTR-3B, then says it is overdue', () => {
    expect(deadlineChip(calendar(4, 13))).toEqual({ tone: 'info', text: 'Supplier cut-off 11 Sep 2026 · 4 days left' });
    expect(deadlineChip(calendar(0, 9))).toEqual({ tone: 'info', text: 'Supplier cut-off 11 Sep 2026 · today' });
    expect(deadlineChip(calendar(-3, 6))).toEqual({ tone: 'warn', text: 'GSTR-3B due 20 Sep 2026 · 6 days left' });
    expect(deadlineChip(calendar(-20, -1))).toEqual({ tone: 'bad', text: 'GSTR-3B was due 20 Sep 2026' });
  });
});

describe('TopBar', () => {
  it('moves the workspace date once the typed date settles', () => {
    vi.useFakeTimers();
    try {
      const onAsOfChange = vi.fn();
      render(
        <TopBar periods={['2026-08']} period="2026-08" onPeriodChange={vi.fn()} asOfDate="2026-09-11" onAsOfChange={onAsOfChange} />
      );
      fireEvent.change(screen.getByTestId('as-of'), { target: { value: '2026-09-14' } });
      expect(onAsOfChange).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(600));
      expect(onAsOfChange).toHaveBeenCalledWith('2026-09-14');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the as-of date in the app format, on a button that opens the native picker', async () => {
    render(<TopBar periods={['2026-08']} period="2026-08" onPeriodChange={vi.fn()} asOfDate="2026-10-05" onAsOfChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'As of 5 Oct 2026' });
    expect(button.querySelector('svg')).not.toBeNull();
    // The native input is there to be opened, never to be seen or tabbed to.
    const input = screen.getByTestId('as-of');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveClass('date-picker-input');

    input.showPicker = vi.fn();
    await userEvent.click(button);
    expect(input.showPicker).toHaveBeenCalled();
  });

  it('falls back to focusing the input where showPicker is refused', async () => {
    render(<TopBar periods={['2026-08']} period="2026-08" onPeriodChange={vi.fn()} asOfDate="2026-10-05" onAsOfChange={vi.fn()} />);
    const input = screen.getByTestId('as-of');
    input.showPicker = vi.fn(() => {
      throw new DOMException('not allowed', 'NotAllowedError');
    });
    const clicked = vi.fn();
    input.addEventListener('click', clicked);
    await userEvent.click(screen.getByRole('button', { name: 'As of 5 Oct 2026' }));
    expect(clicked).toHaveBeenCalled();
  });

  it('shows the picked date while it settles', () => {
    render(<TopBar periods={['2026-08']} period="2026-08" onPeriodChange={vi.fn()} asOfDate="2026-09-11" onAsOfChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId('as-of'), { target: { value: '2026-09-14' } });
    expect(screen.getByRole('button', { name: 'As of 14 Sep 2026' })).toBeInTheDocument();
  });

  it('offers Re-run when the results are out of date', async () => {
    const onRerun = vi.fn();
    render(<TopBar periods={['2026-08']} period="2026-08" onPeriodChange={vi.fn()} onAsOfChange={vi.fn()} stale onRerun={onRerun} />);
    await userEvent.click(within(screen.getByTestId('stale-notice')).getByRole('button', { name: 'Re-run' }));
    expect(onRerun).toHaveBeenCalled();
  });
});
