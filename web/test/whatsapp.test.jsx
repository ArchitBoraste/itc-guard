// Supplier WhatsApp in the app: the thread as a conversation, and the bells that
// read it like email. The API is mocked; nothing is sent.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      listMessages: vi.fn(),
      unreadMessages: vi.fn(),
      sendMessage: vi.fn(),
      previewMessage: vi.fn(),
      markSupplierRead: vi.fn()
    }
  };
});

import { api } from '../src/api.js';
import { MailProvider } from '../src/components/MailProvider.jsx';
import { MessagePanel } from '../src/components/MessagePanel.jsx';
import { SupplierBell } from '../src/components/SupplierBell.jsx';

const GSTIN = '27AABCN7782E1ZT';
const MAIL = { enabled: false, fromName: 'Sharma Electronics', traderPhone: null, dailyLimit: 30, sentToday: 0 };
const CONTACT = { person: 'Rakesh Jain', phone: '+91 98000 00001', email: null, whatsapp: '919800000001' };
const MESSAGE = {
  kind: 'PORTAL_HIGHER',
  subject: 'Invoice NS-612 dated 13 Aug 2026',
  text: 'Hello Rakesh ji, invoice NS-612 shows ₹28,000 taxable. Thank you, Sharma Electronics',
  whatsappUrl: 'https://wa.me/919800000001?text=Hello',
  ask: 'The GST portal shows ₹5,400 tax against ₹5,040 in our books, so please correct it through GSTR-1A.',
  invoiceDate: '2026-08-13'
};
const REPLY = {
  id: 11, threadId: 9, channel: 'whatsapp', from: '+919800000001', receivedAt: '2026-10-05T13:50:00Z',
  text: 'Will correct by 9 Oct', intent: 'will_fix', summary: 'Will correct it by 9 Oct.',
  promisedDate: '2026-10-09', mentionsOurInvoice: true, read: false, flag: null
};
const THREAD = {
  id: 9, ref: 'W4TSAP', channel: 'whatsapp', supplierGstin: GSTIN, supplierName: 'National Supply Co',
  documentRefs: ['NS-612'], taxPeriod: '2026-08', context: 'decisions', to: '+919800000001',
  subject: 'NS-612 · Sharma Electronics', body: MESSAGE.text, sentAt: '2026-10-05T13:40:00Z',
  messages: [
    { id: 1, format: 'template', to: '+919800000001', body: 'Hello Rakesh', sentAt: '2026-10-05T13:40:00Z', status: null, statusDetail: null },
    { id: 2, format: 'text', to: '+919800000001', body: MESSAGE.text, sentAt: '2026-10-05T14:00:00Z', status: null, statusDetail: null }
  ],
  replies: [REPLY]
};

function panel(props = {}) {
  return render(
    <MailProvider>
      <MessagePanel
        contact={CONTACT}
        message={MESSAGE}
        supplierGstin={GSTIN}
        documentRefs={['NS-612']}
        taxPeriod="2026-08"
        context="decisions"
        {...props}
      />
    </MailProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  api.unreadMessages.mockResolvedValue({ count: 0, version: '0:0:0:0:0', latest: [] });
});

describe('a WhatsApp thread', () => {
  it('reads as a conversation: what was sent and what came back, in order', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: { enabled: false }, threads: [THREAD] });
    panel();
    const thread = await screen.findByTestId('whatsapp-thread');
    const sent = within(thread).getAllByTestId('whatsapp-sent');
    expect(sent.map((line) => line.textContent)).toEqual([
      expect.stringContaining('Sent on WhatsApp 5 Oct 2026, 19:10'),
      expect.stringContaining('Sent on WhatsApp 5 Oct 2026, 19:30')
    ]);
    expect(sent[0]).toHaveTextContent('to +91 98000 00001 · #W4TSAP');
    const reply = within(thread).getByTestId('reply-card');
    expect(reply).toHaveTextContent('Replied on WhatsApp 5 Oct 2026, 19:20');
    // The reply sits between the two messages.
    const order = [...thread.children].map((node) => node.dataset.testid);
    expect(order).toEqual(['whatsapp-sent', 'reply-card', 'whatsapp-sent']);
  });

  it('lights the supplier bell and says it was sent on WhatsApp', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: { enabled: false }, threads: [THREAD] });
    api.markSupplierRead.mockResolvedValue({ marked: 1 });
    const user = userEvent.setup();
    render(
      <MailProvider>
        <SupplierBell gstin={GSTIN} name="National Supply Co" />
      </MailProvider>
    );
    await user.click(await screen.findByTestId('supplier-bell'));
    const popover = screen.getByTestId('bell-popover');
    expect(popover).toHaveTextContent('About NS-612 · sent on WhatsApp 5 Oct 2026, 19:10');
    expect(within(popover).getByTestId('reply-promised')).toHaveTextContent('Promised by 9 Oct 2026');
  });
});

const ON = { enabled: true, firstMessage: 'template', dailyLimit: 30, sentToday: 0 };
const REQUEST = {
  channel: 'whatsapp',
  supplierGstin: GSTIN,
  documentRefs: ['NS-612'],
  body: MESSAGE.text,
  ask: MESSAGE.ask,
  invoiceDate: '2026-08-13',
  taxPeriod: '2026-08',
  context: 'decisions'
};
const PREVIEW = {
  to: '+919800000001',
  toDisplay: '+91 98000 00001',
  format: 'template',
  reason: 'first_message',
  text: `Hello Rakesh, this is Sharma Electronics. About invoice NS-612 dated 13 Aug 2026: ${MESSAGE.ask}`,
  values: ['Rakesh', 'Sharma Electronics', 'NS-612', '13 Aug 2026', MESSAGE.ask],
  templateName: 'itc_guard_chase',
  templateStatus: 'APPROVED',
  threadRef: null
};

describe('sending on WhatsApp from the app', () => {
  it('confirms the number and the template text, then sends and says when', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: ON, threads: [] });
    api.previewMessage.mockResolvedValue(PREVIEW);
    api.sendMessage.mockResolvedValue({ ...THREAD, replies: [], messages: [{ ...THREAD.messages[0], sentAt: '2026-10-05T13:40:00Z' }] });
    const user = userEvent.setup();
    panel();

    await user.click(await screen.findByTestId('whatsapp-button'));
    const dialog = screen.getByTestId('whatsapp-dialog');
    expect(api.previewMessage).toHaveBeenCalledWith(REQUEST);
    expect(await within(dialog).findByTestId('whatsapp-to')).toHaveTextContent('+91 98000 00001 (Rakesh Jain)');
    expect(within(dialog).getByTestId('whatsapp-format')).toHaveTextContent('Your approved template “itc_guard_chase”');
    expect(within(dialog).getByTestId('whatsapp-preview')).toHaveTextContent(PREVIEW.text);
    expect(within(dialog).queryByTestId('whatsapp-template-warning')).toBeNull();

    await user.click(within(dialog).getByTestId('whatsapp-send'));
    expect(api.sendMessage).toHaveBeenCalledWith(REQUEST);
    // The caption under the buttons, and the thread line under the message.
    expect((await screen.findAllByText('Sent on WhatsApp 5 Oct 2026, 19:10')).length).toBe(2);
    expect(screen.getByTestId('whatsapp-sent')).toHaveTextContent('Sent on WhatsApp 5 Oct 2026, 19:10 to +91 98000 00001');
    expect(screen.queryByTestId('whatsapp-dialog')).toBeNull();
  });

  it('says when the full message goes as text, and warns of a template not yet approved', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: ON, threads: [] });
    api.previewMessage.mockResolvedValueOnce({ ...PREVIEW, format: 'text', reason: 'window_open', text: MESSAGE.text, values: null, threadRef: 'W4TSAP' });
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByTestId('whatsapp-button'));
    expect(await screen.findByTestId('whatsapp-format')).toHaveTextContent('The full message: they wrote in the last 24 hours');
    expect(screen.getByTestId('whatsapp-preview')).toHaveTextContent('Hello Rakesh ji, invoice NS-612');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    api.previewMessage.mockResolvedValueOnce({ ...PREVIEW, templateStatus: 'PENDING', text: null });
    await user.click(screen.getByTestId('whatsapp-button'));
    expect(await screen.findByTestId('whatsapp-template-warning')).toHaveTextContent('shows this template as PENDING');
    expect(screen.getByTestId('whatsapp-preview')).toHaveTextContent('Template itc_guard_chase with: Rakesh · Sharma Electronics · NS-612');
  });

  it('says when the server sends free text only, and shows the 24-hour refusal in its sentence', async () => {
    const windowClosed =
      "WhatsApp only allows a free message within 24 hours of the supplier's last message. " +
      'Ask them to message our WhatsApp number first, or wait for the template to be approved.';
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: { ...ON, firstMessage: 'text' }, threads: [] });
    api.previewMessage.mockResolvedValue({ ...PREVIEW, format: 'text', reason: 'text_mode', text: MESSAGE.text, values: null });
    api.sendMessage.mockRejectedValue(new Error(windowClosed));
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByTestId('whatsapp-button'));
    expect(await screen.findByTestId('whatsapp-format')).toHaveTextContent(
      "The full message as free text. WhatsApp delivers it only within 24 hours of the supplier's last message."
    );
    expect(screen.getByTestId('whatsapp-preview')).toHaveTextContent('Hello Rakesh ji, invoice NS-612');
    await user.click(screen.getByTestId('whatsapp-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent(windowClosed);
    expect(screen.getByTestId('whatsapp-fallback')).toBeInTheDocument();
  });

  it("keeps the dialog open with the server's reason and offers the trader's own WhatsApp", async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: ON, threads: [] });
    api.previewMessage.mockRejectedValue(new Error("+91 98000 00001 is not on this server's list of numbers it may message on WhatsApp."));
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByTestId('whatsapp-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('not on this server');
    expect(screen.getByTestId('whatsapp-fallback').getAttribute('href')).toBe(MESSAGE.whatsappUrl);
    expect(screen.getByTestId('whatsapp-send')).toBeDisabled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('shows a refused send in the dialog', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: ON, threads: [] });
    api.previewMessage.mockResolvedValue(PREVIEW);
    api.sendMessage.mockRejectedValue(new Error('WhatsApp has no approved template "itc_guard_chase" in language "en".'));
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByTestId('whatsapp-button'));
    await user.click(await screen.findByTestId('whatsapp-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('no approved template');
    expect(screen.getByTestId('whatsapp-dialog')).toBeInTheDocument();
  });

  it("stays today's wa.me link when the server cannot send WhatsApp", async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: { enabled: false, dailyLimit: 30, sentToday: 0 }, threads: [] });
    panel();
    const link = await screen.findByRole('link', { name: 'WhatsApp' });
    expect(link.getAttribute('href')).toBe(MESSAGE.whatsappUrl);
    expect(screen.queryByTestId('whatsapp-button')).toBeNull();
  });
});

describe('delivery state', () => {
  it('ticks each message as WhatsApp reports it, with the reason a message failed', async () => {
    const messages = [
      { ...THREAD.messages[0], status: 'read' },
      { ...THREAD.messages[1], status: 'delivered' },
      { ...THREAD.messages[1], id: 3, sentAt: '2026-10-06T14:00:00Z', status: 'failed', statusDetail: 'the template is not approved' }
    ];
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: ON, threads: [{ ...THREAD, messages, replies: [] }] });
    panel();
    const states = await screen.findAllByTestId('whatsapp-status');
    expect(states.map((node) => node.textContent)).toEqual([
      '✓✓ Read',
      '✓✓ Delivered',
      'Failed: the template is not approved'
    ]);
  });

  it('reads a message Meta accepted but has not reported yet as sent', async () => {
    api.listMessages.mockResolvedValue({ mail: MAIL, whatsapp: ON, threads: [{ ...THREAD, messages: [THREAD.messages[0]], replies: [] }] });
    panel();
    expect(await screen.findByTestId('whatsapp-status')).toHaveTextContent('✓ Sent');
  });
});
