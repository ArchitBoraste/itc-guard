// Supplier email sent from the app (services/supplierEmail.js), end to end over
// HTTP with a fake SMTP transport: nothing leaves the machine.
//
//   * The To is the supplier's contact at send time; the thread keeps the address
//     it went to, so a later register with a new email changes the next send only.
//   * Only allowlisted addresses (403), at most EMAIL_DAILY_LIMIT a day (429).
//   * The subject carries "[ITC Guard #<ref>]" and the mail our own Message-ID.
//   * Not configured: 503, and GET /api/messages says enabled: false.
//
// Owns org 35.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { setMailTransport } from '../../src/services/supplierEmail.js';
import { SUPPLIERS } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { registerWithContacts } from '../helpers/registerCopy.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.supplierEmail;
const NATIONAL = SUPPLIERS.find((supplier) => supplier.key === 'national');
const MAHAVIR = SUPPLIERS.find((supplier) => supplier.key === 'mahavir');
const FIRST = 'national@test.example';
const SECOND = 'mahavir@test.example';
const MAIL_ENV = {
  SMTP_HOST: 'smtp.test.example',
  SMTP_PORT: '465',
  SMTP_USER: 'trader@test.example',
  SMTP_PASS: 'not-a-password',
  EMAIL_ALLOWLIST: `${FIRST},${SECOND},changed@test.example`,
  EMAIL_DAILY_LIMIT: '3'
};

let api;
const sent = [];

const send = (overrides = {}) => api.call('POST', '/api/messages', {
  supplierGstin: NATIONAL.gstin,
  documentRefs: ['NS-612'],
  subject: 'NS-612 · Sharma Electronics',
  body: 'Hello, please correct NS-612.',
  taxPeriod: '2026-08',
  context: 'decisions',
  ...overrides
});

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  Object.assign(process.env, MAIL_ENV);
  setMailTransport({ sendMail: async (mail) => { sent.push(mail); return { messageId: mail.messageId }; } });
  api = await startApi(ORG_ID);
  await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' });
  const register = registerWithContacts(demoRegister('aug'), {
    [NATIONAL.gstin]: { email: FIRST },
    [MAHAVIR.gstin]: { email: SECOND }
  }, 'email-suite', { traderPhone: '+91 90000 11111' });
  expect((await api.ingest('PURCHASE_REGISTER', register)).status).toBe(200);
  expect((await api.ingest('IMS', demoIms('aug', '2026-09-11'))).status).toBe(200);
});

afterEach(() => {
  process.env.EMAIL_DAILY_LIMIT = MAIL_ENV.EMAIL_DAILY_LIMIT;
});

afterAll(async () => {
  setMailTransport(null);
  for (const name of [...Object.keys(MAIL_ENV)]) delete process.env[name];
  await api?.close();
  await pool.query('DELETE FROM message_replies WHERE org_id = ?', [ORG_ID]);
  await pool.query('DELETE FROM message_threads WHERE org_id = ?', [ORG_ID]);
  await closePool();
});

describe('sending', () => {
  it('says email is on, from the trader, with none sent yet', async () => {
    const { status, body } = await api.call('GET', '/api/messages');
    expect(status).toBe(200);
    expect(body.mail).toMatchObject({
      enabled: true, fromName: 'Sharma Electronics', traderPhone: '+91 90000 11111', dailyLimit: 3, sentToday: 0
    });
    expect(body.threads).toEqual([]);
  });

  it('sends to the contact on file, tags the subject and stores the thread', async () => {
    const { status, body } = await send({ to: 'someone-else@test.example' });
    expect(status).toBe(201);
    const { thread } = body;
    expect(thread.ref).toMatch(/^[A-Z2-9]{6}$/);
    expect(thread).toMatchObject({
      supplierGstin: NATIONAL.gstin,
      documentRefs: ['NS-612'],
      to: FIRST,
      subject: `[ITC Guard #${thread.ref}] NS-612 · Sharma Electronics`,
      taxPeriod: '2026-08',
      context: 'decisions',
      replies: []
    });
    expect(new Date(thread.sentAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // A "to" in the request is ignored: the address is the contact's.
    const mail = sent.at(-1);
    expect(mail.to).toBe(FIRST);
    expect(mail.from).toEqual({ name: 'Sharma Electronics', address: MAIL_ENV.SMTP_USER });
    expect(mail.subject).toBe(thread.subject);
    expect(mail.messageId).toMatch(new RegExp(`^<itcg\\.${thread.ref}\\.[0-9a-f]{12}@test\\.example>$`));
    expect(mail.text).toBe('Hello, please correct NS-612.');

    const [rows] = await pool.query('SELECT message_id FROM message_threads WHERE ref = ?', [thread.ref]);
    expect(rows[0].message_id).toBe(mail.messageId);
  });

  it('does not let the trader type a tag of their own', async () => {
    const { body } = await send({ subject: '[ITC Guard #AAAAAA] About NS-612' });
    expect(body.thread.subject).toBe(`[ITC Guard #${body.thread.ref}] About NS-612`);
  });

  it('sends to the new address after a register changes it, and the old thread keeps its own', async () => {
    const before = (await api.call('GET', '/api/messages')).body.threads;
    const changed = registerWithContacts(demoRegister('aug'), {
      [NATIONAL.gstin]: { email: 'changed@test.example' },
      [MAHAVIR.gstin]: { email: SECOND }
    }, 'email-suite-changed');
    expect((await api.ingest('PURCHASE_REGISTER', changed)).status).toBe(200);

    const { status, body } = await send();
    expect(status).toBe(201);
    expect(body.thread.to).toBe('changed@test.example');
    expect(sent.at(-1).to).toBe('changed@test.example');

    const after = (await api.call('GET', '/api/messages')).body.threads;
    for (const thread of before) {
      expect(after.find((entry) => entry.id === thread.id).to).toBe(FIRST);
    }
  });
});

describe('refusals', () => {
  it('refuses an address that is not on the allowlist, sending nothing', async () => {
    process.env.EMAIL_DAILY_LIMIT = '30';
    await api.call('PUT', `/api/suppliers/${MAHAVIR.gstin}/contact`, { email: 'stranger@test.example' });
    const count = sent.length;
    const { status, body } = await send({ supplierGstin: MAHAVIR.gstin, documentRefs: ['MS-878'] });
    expect(status).toBe(403);
    expect(body.error).toBe('address_not_allowed');
    expect(body.message).toContain('stranger@test.example');
    expect(sent.length).toBe(count);
  });

  it('refuses a supplier with no email on file', async () => {
    process.env.EMAIL_DAILY_LIMIT = '30';
    await api.call('PUT', `/api/suppliers/${MAHAVIR.gstin}/contact`, { phone: '9820012345' });
    const { status, body } = await send({ supplierGstin: MAHAVIR.gstin, documentRefs: ['MS-878'] });
    expect(status).toBe(409);
    expect(body.error).toBe('no_email');
  });

  it('stops at the daily limit', async () => {
    // Three sent above, and the limit is three.
    const { status, body } = await send();
    expect(status).toBe(429);
    expect(body.error).toBe('daily_limit');
  });

  it('refuses a request without documents or body', async () => {
    process.env.EMAIL_DAILY_LIMIT = '30';
    expect((await send({ documentRefs: [] })).status).toBe(400);
    expect((await send({ body: '   ' })).status).toBe(400);
  });

  it('is off without SMTP settings, and says so', async () => {
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      expect((await api.call('GET', '/api/messages')).body.mail.enabled).toBe(false);
      const { status, body } = await send();
      expect(status).toBe(503);
      expect(body.error).toBe('mail_not_configured');
    } finally {
      process.env.SMTP_HOST = host;
    }
  });
});

describe('unread replies', () => {
  it('counts unread replies and marks a supplier read', async () => {
    const [[thread]] = await pool.query('SELECT id FROM message_threads WHERE org_id = ? ORDER BY id LIMIT 1', [ORG_ID]);
    await pool.query(
      `INSERT INTO message_replies (org_id, thread_id, message_id, from_address, received_at, body, intent, summary, promised_date, mentions_our_invoice)
       VALUES (?, ?, '<r1@test.example>', ?, UTC_TIMESTAMP(), 'Will correct NS-612 by 9 Oct', 'will_fix', 'Will fix it.', '2026-10-09', 1),
              (?, ?, '<r2@test.example>', ?, UTC_TIMESTAMP(), 'Buy cheap watches', 'unrelated', 'Spam.', NULL, 0)`,
      [ORG_ID, thread.id, FIRST, ORG_ID, thread.id, FIRST]
    );
    const unread = (await api.call('GET', '/api/messages/unread')).body;
    expect(unread.count).toBe(2);
    expect(unread.latest[0]).toMatchObject({ supplierGstin: NATIONAL.gstin, documentRefs: ['NS-612'] });
    const spam = unread.latest.find((reply) => reply.intent === 'unrelated');
    expect(spam.flag).toBe("Doesn't seem to be about NS-612");
    const fix = unread.latest.find((reply) => reply.intent === 'will_fix');
    expect(fix).toMatchObject({ promisedDate: '2026-10-09', flag: null, read: false });

    const marked = await api.call('POST', '/api/messages/read', { supplierGstin: NATIONAL.gstin });
    expect(marked.body.marked).toBe(2);
    const after = (await api.call('GET', '/api/messages/unread')).body;
    expect(after.count).toBe(0);
    expect(after.version).not.toBe(unread.version);
  });

  it('go with Clear all data, and the trader phone with them', async () => {
    expect((await api.call('POST', '/api/workspace/clear')).status).toBe(200);
    expect((await api.call('GET', '/api/messages')).body).toMatchObject({ threads: [], mail: { traderPhone: null } });
  });
});
