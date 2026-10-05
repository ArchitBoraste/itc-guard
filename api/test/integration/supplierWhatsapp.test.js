// Supplier WhatsApp sent from the app (services/supplierWhatsapp.js), end to end
// over HTTP with a fake Graph API: nothing leaves the machine.
//
//   * A thread opens with the approved template and its five values; the wamid
//     Meta returns is stored. A later send to the same number about the same
//     document continues the thread, as text once the supplier wrote in the last
//     24 hours (and falls back to the template if Meta says the window closed).
//   * Only allowlisted numbers (403), the daily limit shared with email (429), a
//     mobile number on file (409). Meta's refusals come back in plain words and
//     nothing is stored.
//   * Not configured: 503, and GET /api/messages says enabled: false.
//
// Owns org 38.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { setGraphFetch } from '../../src/services/whatsappApi.js';
import { storeReply } from '../../src/services/messageThreads.js';
import { supplierAsk, MESSAGE_KINDS } from '../../src/services/supplierMessages.js';
import { SUPPLIERS } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoRegister } from '../helpers/demoFiles.js';
import { registerWithContacts } from '../helpers/registerCopy.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.whatsappSend;
const NATIONAL = SUPPLIERS.find((supplier) => supplier.key === 'national');
const MAHAVIR = SUPPLIERS.find((supplier) => supplier.key === 'mahavir');
const NATIONAL_PHONE = '919800000001';
const ENV = {
  WHATSAPP_TOKEN: 'test-token-never-logged',
  WHATSAPP_PHONE_NUMBER_ID: '1110001',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '2220002',
  WHATSAPP_TEMPLATE_NAME: 'itc_guard_chase',
  WHATSAPP_ALLOWLIST: `+91 98000 00001, ${'919800000009'}`,
  MESSAGE_DAILY_LIMIT: '30'
};
const TEMPLATE_BODY = 'Hello {{1}}, this is {{2}}. About invoice {{3}} dated {{4}}: {{5}} Please reply here.';
const ASK = supplierAsk(MESSAGE_KINDS.PORTAL_HIGHER, {
  portal: { totalTax: 504000 }, books: { totalTax: 450000 }, decided: null
});

let api;
let sends;
let refuse;
let invoiceDate;
let wamids = 0;

const quiet = async () => ({ intent: 'unchecked', summary: null, promisedDate: null, mentionsOurInvoice: null });

// The fake Graph API: records every send, answers with a wamid unless told to refuse.
function fakeGraph() {
  setGraphFetch(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (url.includes('/message_templates')) {
      return reply(200, { data: [{ name: 'itc_guard_chase', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: TEMPLATE_BODY }] }] });
    }
    sends.push({ url, headers: options.headers, body });
    const refusal = refuse?.(body);
    if (refusal) return reply(400, { error: { message: `(#${refusal}) refused`, code: refusal } });
    wamids += 1;
    return reply(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.send-${process.pid}-${wamids}` }] });
  });
}

const send = (overrides = {}) => api.call('POST', '/api/messages', {
  channel: 'whatsapp',
  supplierGstin: NATIONAL.gstin,
  documentRefs: ['NS-612'],
  body: 'Hello Rakesh ji, invoice NS-612 shows ₹28,000 taxable on the GST portal. Thank you, Sharma Electronics',
  ask: ASK,
  invoiceDate,
  taxPeriod: '2026-08',
  context: 'decisions',
  ...overrides
});

async function threadRows() {
  const [rows] = await pool.query('SELECT * FROM message_threads WHERE org_id = ? ORDER BY id', [ORG_ID]);
  return rows;
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  Object.assign(process.env, ENV);
  api = await startApi(ORG_ID);
  const register = registerWithContacts(demoRegister('aug'), {
    [NATIONAL.gstin]: { person: 'Rakesh Jain', phone: '+91 98000 00001' },
    [MAHAVIR.gstin]: { person: 'Mahavir Shah', phone: '98000 00002' }
  }, 'whatsapp-suite');
  expect((await api.ingest('PURCHASE_REGISTER', register)).status).toBe(200);
  const [[row]] = await pool.query(
    "SELECT invoice_date FROM expected_invoices WHERE org_id = ? AND invoice_no = 'NS-612'",
    [ORG_ID]
  );
  invoiceDate = row.invoice_date;
});

beforeEach(() => {
  sends = [];
  refuse = null;
  fakeGraph();
});

afterEach(() => {
  setGraphFetch(null);
  process.env.MESSAGE_DAILY_LIMIT = ENV.MESSAGE_DAILY_LIMIT;
});

afterAll(async () => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  await api?.close();
  await resetOrg(ORG_ID);
  await closePool();
});

describe('the first message on a thread', () => {
  it('says WhatsApp is on', async () => {
    const { body } = await api.call('GET', '/api/messages');
    expect(body.whatsapp).toEqual({ enabled: true, dailyLimit: 30, sentToday: 0 });
  });

  it('previews the template as the supplier will read it, sending nothing', async () => {
    const { status, body } = await api.call('POST', '/api/messages/preview', {
      channel: 'whatsapp', supplierGstin: NATIONAL.gstin, documentRefs: ['NS-612'], body: 'Hello', ask: ASK, invoiceDate
    });
    expect(status).toBe(200);
    const [year, month, day] = invoiceDate.split('-').map(Number);
    const dated = `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;
    expect(body.preview).toEqual({
      to: `+${NATIONAL_PHONE}`,
      toDisplay: '+91 98000 00001',
      format: 'template',
      text: `Hello Rakesh, this is Sharma Electronics. About invoice NS-612 dated ${dated}: ${ASK} Please reply here.`,
      values: ['Rakesh', 'Sharma Electronics', 'NS-612', dated, ASK],
      templateName: 'itc_guard_chase',
      templateStatus: 'APPROVED',
      threadRef: null
    });
    expect(sends).toHaveLength(0);
  });

  it('sends the template with its five values and stores the wamid on a new thread', async () => {
    const { status, body } = await send({ invoiceDate: undefined });
    expect(status).toBe(201);
    expect(sends).toHaveLength(1);
    const [{ url, headers, body: posted }] = sends;
    expect(url).toMatch(/\/v\d+\.\d+\/1110001\/messages$/);
    expect(headers.Authorization).toBe('Bearer test-token-never-logged');
    expect(posted).toMatchObject({ to: NATIONAL_PHONE, type: 'template', template: { name: 'itc_guard_chase', language: { code: 'en' } } });
    // The date was looked up from the books when the request did not carry one.
    const values = posted.template.components[0].parameters.map((parameter) => parameter.text);
    expect(values.slice(0, 3)).toEqual(['Rakesh', 'Sharma Electronics', 'NS-612']);
    expect(values[3]).toMatch(/^\d{1,2} [A-Z][a-z]{2} 2026$/);
    expect(values[4]).toBe(ASK);

    const { thread } = body;
    expect(thread).toMatchObject({
      channel: 'whatsapp', to: `+${NATIONAL_PHONE}`, supplierGstin: NATIONAL.gstin, documentRefs: ['NS-612'],
      taxPeriod: '2026-08', context: 'decisions', replies: []
    });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ format: 'template', status: null });
    expect(thread.messages[0].body).toContain('Hello Rakesh, this is Sharma Electronics.');
    const [row] = await threadRows();
    expect(row.message_id).toBe(`wamid.send-${process.pid}-${wamids}`);
    const [[sent]] = await pool.query('SELECT external_id FROM message_sends WHERE thread_id = ?', [row.id]);
    expect(sent.external_id).toBe(row.message_id);
  });
});

describe('later messages on the thread', () => {
  it('sends the template again while the supplier has not written, on the same thread', async () => {
    const { body } = await send();
    expect(sends[0].body.type).toBe('template');
    expect(await threadRows()).toHaveLength(1);
    expect(body.thread.messages.map((message) => message.format)).toEqual(['template', 'template']);
  });

  it('sends the full message as text once the supplier replied in the last 24 hours', async () => {
    const [thread] = await threadRows();
    await storeReply(thread, { externalId: `wamid.in-${process.pid}-1`, from: `+${NATIONAL_PHONE}`, receivedAt: new Date(), text: 'Which invoice?' }, { check: quiet });

    const preview = await api.call('POST', '/api/messages/preview', {
      channel: 'whatsapp', supplierGstin: NATIONAL.gstin, documentRefs: ['ns/612'], body: 'The full message', invoiceDate
    });
    expect(preview.body.preview).toMatchObject({ format: 'text', text: 'The full message', values: null, threadRef: thread.ref });

    const { body } = await send();
    expect(sends[0].body).toMatchObject({ type: 'text', text: { body: expect.stringContaining('invoice NS-612 shows ₹28,000') } });
    expect(body.thread.messages.map((message) => message.format)).toEqual(['template', 'template', 'text']);
  });

  it('falls back to the template when Meta says the 24 hours are up', async () => {
    refuse = (posted) => (posted.type === 'text' ? 131047 : null);
    const { status, body } = await send();
    expect(status).toBe(201);
    expect(sends.map((entry) => entry.body.type)).toEqual(['text', 'template']);
    expect(body.thread.messages.at(-1).format).toBe('template');
  });

  it('goes back to the template once the reply is more than 24 hours old', async () => {
    await pool.query('UPDATE message_replies SET received_at = UTC_TIMESTAMP() - INTERVAL 25 HOUR WHERE org_id = ?', [ORG_ID]);
    await send();
    expect(sends.map((entry) => entry.body.type)).toEqual(['template']);
  });

  it('starts a new thread for another document', async () => {
    const { body } = await send({ documentRefs: ['NS-999'] });
    expect(body.thread.messages).toHaveLength(1);
    expect(await threadRows()).toHaveLength(2);
  });
});

describe('refusals', () => {
  it('refuses a number that is not on the allowlist, sending nothing', async () => {
    const { status, body } = await send({ supplierGstin: MAHAVIR.gstin, documentRefs: ['MS-878'] });
    expect(status).toBe(403);
    expect(body.error).toBe('number_not_allowed');
    expect(body.message).toContain('+91 98000 00002');
    expect(sends).toHaveLength(0);
  });

  it('refuses a supplier with no mobile number', async () => {
    await api.call('PUT', `/api/suppliers/${MAHAVIR.gstin}/contact`, { email: 'm@test.example' });
    const { status, body } = await send({ supplierGstin: MAHAVIR.gstin, documentRefs: ['MS-878'] });
    expect(status).toBe(409);
    expect(body.error).toBe('no_whatsapp');
  });

  it("answers Meta's refusals in plain words and stores nothing", async () => {
    const before = (await api.call('GET', '/api/messages')).body.whatsapp.sentToday;
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    try {
      for (const [code, status, error, words] of [
        [131030, 403, 'whatsapp_recipient_not_allowed', 'allowed recipients'],
        [132001, 502, 'whatsapp_template_not_approved', 'no approved template "itc_guard_chase"'],
        [190, 502, 'whatsapp_token', 'access token'],
        [132000, 502, 'whatsapp_template_parameters', 'five values']
      ]) {
        refuse = () => code;
        const res = await send({ documentRefs: ['NS-777'] });
        expect(res.status, String(code)).toBe(status);
        expect(res.body.error).toBe(error);
        expect(res.body.message).toContain(words);
      }
    } finally {
      console.error = original;
    }
    expect((await api.call('GET', '/api/messages')).body.whatsapp.sentToday).toBe(before);
    expect(lines.join('\n')).not.toContain(ENV.WHATSAPP_TOKEN);
    expect(lines.join('\n')).not.toContain(NATIONAL_PHONE);
  });

  it('stops at the daily limit it shares with email', async () => {
    const { sentToday } = (await api.call('GET', '/api/messages')).body.whatsapp;
    process.env.MESSAGE_DAILY_LIMIT = String(sentToday);
    const { status, body } = await send();
    expect(status).toBe(429);
    expect(body.error).toBe('daily_limit');
    expect(sends).toHaveLength(0);
  });

  it('refuses a request without documents or body, and an unknown channel', async () => {
    expect((await send({ documentRefs: [] })).status).toBe(400);
    expect((await send({ body: '  ' })).status).toBe(400);
    expect((await send({ channel: 'sms' })).status).toBe(400);
  });

  it('is off without the settings, and says so', async () => {
    const token = process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_TOKEN;
    try {
      expect((await api.call('GET', '/api/messages')).body.whatsapp.enabled).toBe(false);
      const { status, body } = await send();
      expect(status).toBe(503);
      expect(body.error).toBe('whatsapp_not_configured');
    } finally {
      process.env.WHATSAPP_TOKEN = token;
    }
  });
});
