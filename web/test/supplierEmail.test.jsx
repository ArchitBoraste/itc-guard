// Supplier email in the app: the compose dialog, the thread under the message, and
// replies shown as text. The API is mocked; nothing is sent.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: { listMessages: vi.fn(), unreadMessages: vi.fn(), sendMessage: vi.fn(), markSupplierRead: vi.fn() }
  };
});

import { api } from '../src/api.js';
import { MailProvider } from '../src/components/MailProvider.jsx';
import { MessagePanel } from '../src/components/MessagePanel.jsx';
import { PromisedLine, SupplierBell, TopBarBell } from '../src/components/SupplierBell.jsx';

const GSTIN = '27AABCN7782E1ZT';
const MESSAGE = {
  kind: 'PORTAL_HIGHER',
  subject: 'Invoice NS-612 dated 13 Aug 2026',
  text: 'Hello, invoice NS-612 shows ₹28,000 taxable. Thank you, Sharma Electronics',
  whatsappUrl: null
};
const CONTACT = { person: null, phone: null, email: 'national@test.example' };
const MAIL = { enabled: true, fromName: 'Sharma Electronics', traderPhone: '+91 90000 22222', dailyLimit: 30, sentToday: 0 };
const THREAD = {
  id: 7, ref: 'K7Q2XM', supplierGstin: GSTIN, supplierName: 'National Supply Co', documentRefs: ['NS-612'],
  taxPeriod: '2026-08', context: 'decisions', to: CONTACT.email, subject: '[ITC Guard #K7Q2XM] NS-612 · Sharma Electronics',
  body: 'x', sentAt: '2026-10-04T19:12:00Z', replies: []
};

function panel() {
  return render(
    <MailProvider>
      <MessagePanel
        contact={CONTACT}
        message={MESSAGE}
        supplierGstin={GSTIN}
        documentRefs={['NS-612']}
        taxPeriod="2026-08"
        context="decisions"
      />
    </MailProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  api.unreadMessages.mockResolvedValue({ count: 0, version: '0:0:0', latest: [] });
});

describe('Email from the app', () => {
  it('composes to the contact on file, with the trader phone in the body, and shows the sent thread', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, threads: [] });
    api.sendMessage.mockResolvedValue(THREAD);
    const user = userEvent.setup();
    panel();

    await user.click(await screen.findByTestId('email-button'));
    const dialog = screen.getByTestId('compose-dialog');
    expect(within(dialog).getByTestId('compose-to')).toHaveTextContent('national@test.example');
    expect(within(dialog).getByTestId('compose-subject')).toHaveValue('NS-612 · Sharma Electronics');
    expect(within(dialog).getByTestId('compose-body').value).toBe(
      `${MESSAGE.text}\n\nReply here or on WhatsApp +91 90000 22222`
    );

    await user.click(within(dialog).getByTestId('compose-send'));
    expect(api.sendMessage).toHaveBeenCalledWith({
      supplierGstin: GSTIN,
      documentRefs: ['NS-612'],
      subject: 'NS-612 · Sharma Electronics',
      body: `${MESSAGE.text}\n\nReply here or on WhatsApp +91 90000 22222`,
      taxPeriod: '2026-08',
      context: 'decisions'
    });
    expect((await screen.findAllByText('Emailed 5 Oct 2026, 00:42')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('email-sent')).toHaveTextContent('Emailed 5 Oct 2026, 00:42 to national@test.example · #K7Q2XM');
    expect(screen.queryByTestId('compose-dialog')).toBeNull();
  });

  it('keeps the dialog open with the server\'s reason when a send is refused', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, threads: [] });
    api.sendMessage.mockRejectedValue(new Error('national@test.example is not on this server\'s list of addresses it may email.'));
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByTestId('email-button'));
    await user.click(screen.getByTestId('compose-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('not on this server');
    expect(screen.getByTestId('compose-dialog')).toBeInTheDocument();
  });

  it('stays a mailto link when the server cannot send', async () => {
    api.listMessages.mockResolvedValue({ mail: { ...MAIL, enabled: false }, threads: [] });
    panel();
    const link = await screen.findByRole('link', { name: 'Email' });
    expect(link.getAttribute('href')).toMatch(/^mailto:national@test\.example\?/);
    expect(screen.queryByTestId('email-button')).toBeNull();
  });

  it('shows a reply as text, never as markup', async () => {
    const reply = {
      id: 1, threadId: 7, from: CONTACT.email, receivedAt: '2026-10-04T19:20:00Z',
      text: '<img src=x onerror=alert(1)> Will correct NS-612 by 9 Oct', intent: 'will_fix',
      summary: 'Will correct it through GSTR-1A.', promisedDate: '2026-10-09', mentionsOurInvoice: true, read: false, flag: null
    };
    api.listMessages.mockResolvedValue({ mail: MAIL, threads: [{ ...THREAD, replies: [reply] }] });
    const { container } = panel();
    expect(await screen.findByTestId('reply-text')).toHaveTextContent('<img src=x onerror=alert(1)> Will correct NS-612 by 9 Oct');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('intent-chip')).toHaveTextContent('Will fix');
    expect(screen.getByTestId('reply-promised')).toHaveTextContent('Promised by 9 Oct 2026');
  });
});

const REPLY = {
  id: 1, threadId: 7, from: CONTACT.email, receivedAt: '2026-10-04T19:20:00Z',
  text: 'Will correct NS-612 through GSTR-1A by 9 Oct', intent: 'will_fix',
  summary: 'Will correct it through GSTR-1A by 9 Oct.', promisedDate: '2026-10-09', mentionsOurInvoice: true,
  read: false, flag: null
};
const SPAM = {
  ...REPLY, id: 2, receivedAt: '2026-10-04T19:25:00Z', text: 'Cheap watches', intent: 'unrelated',
  summary: 'An advert.', promisedDate: null, mentionsOurInvoice: false, flag: "Doesn't seem to be about NS-612"
};

describe('follow-ups', () => {
  it('puts an unread dot on the supplier bell, and opening it shows the reply and marks it read', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, threads: [{ ...THREAD, replies: [REPLY, SPAM] }] });
    api.markSupplierRead.mockResolvedValue({ marked: 2 });
    const user = userEvent.setup();
    render(
      <MailProvider>
        <SupplierBell gstin={GSTIN} name="National Supply Co" />
        <PromisedLine gstin={GSTIN} invoiceNo="ns/612" />
      </MailProvider>
    );
    const bell = await screen.findByTestId('supplier-bell');
    expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
    expect(screen.getByTestId('promised-line')).toHaveTextContent('Promised by 9 Oct 2026');

    await user.click(bell);
    const popover = screen.getByTestId('bell-popover');
    expect(within(popover).getAllByTestId('intent-chip').map((chip) => chip.textContent)).toEqual(['Unrelated', 'Will fix']);
    expect(within(popover).getByText('Will correct it through GSTR-1A by 9 Oct.')).toBeInTheDocument();
    expect(within(popover).getByTestId('reply-flag')).toHaveTextContent("Doesn't seem to be about NS-612");
    expect(api.markSupplierRead).toHaveBeenCalledWith(GSTIN);
    expect(screen.queryByTestId('bell-dot')).toBeNull();
  });

  it('shows no bell for a supplier never emailed from the app', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, threads: [THREAD] });
    render(
      <MailProvider>
        <SupplierBell gstin="27AAAAA0000A1Z5" name="Someone" />
        <span>ready</span>
      </MailProvider>
    );
    await screen.findByText('ready');
    expect(screen.queryByTestId('supplier-bell')).toBeNull();
  });

  it('counts unread replies in the top bar and opens the row of the one clicked', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, threads: [{ ...THREAD, replies: [REPLY] }] });
    const latest = [{ ...REPLY, ref: 'K7Q2XM', supplierGstin: GSTIN, supplierName: 'National Supply Co', documentRefs: ['NS-612'], context: 'decisions', taxPeriod: '2026-08' }];
    api.unreadMessages.mockResolvedValue({ count: 1, version: '1:1:1', latest });
    const onOpenReply = vi.fn();
    const user = userEvent.setup();
    render(
      <MailProvider>
        <TopBarBell onOpenReply={onOpenReply} />
      </MailProvider>
    );
    expect(await screen.findByTestId('topbar-bell-count')).toHaveTextContent('1');
    await user.click(screen.getByTestId('topbar-bell'));
    await user.click(screen.getByTestId('topbar-bell-item'));
    expect(onOpenReply).toHaveBeenCalledWith(latest[0]);
  });
});
