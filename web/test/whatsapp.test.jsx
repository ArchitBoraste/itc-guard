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
