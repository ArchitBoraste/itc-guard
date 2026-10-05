// One thread model for every channel (services/messageThreads.js).
//
//   * An email thread is one thread with one message, exactly as before.
//   * The daily limit counts messages on both channels together.
//   * A reply on any channel is stored and checked the same way, so the bell, the
//     intent and the promised date read alike; a delivery status moves the
//     bell's version so the UI re-reads.
//   * Mail never lands on a WhatsApp thread.
//
// Owns org 37.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { setMailTransport } from '../../src/services/supplierEmail.js';
import { handleIncoming } from '../../src/services/mailInbox.js';
import { CHANNELS, addSend, createThread, storeReply, unreadSummary } from '../../src/services/messageThreads.js';
import { SUPPLIERS } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoRegister } from '../helpers/demoFiles.js';
import { registerWithContacts } from '../helpers/registerCopy.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.messageThreads;
const NATIONAL = SUPPLIERS.find((supplier) => supplier.key === 'national');
const ADDRESS = 'national-threads@test.example';
const MAIL_ENV = {
  SMTP_HOST: 'smtp.test.example',
  SMTP_USER: 'trader@test.example',
  SMTP_PASS: 'not-a-password',
  EMAIL_ALLOWLIST: ADDRESS,
  EMAIL_DAILY_LIMIT: '4'
};

let api;
let whatsappThread;

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  Object.assign(process.env, MAIL_ENV);
  setMailTransport({ sendMail: async (mail) => ({ messageId: mail.messageId }) });
  api = await startApi(ORG_ID);
  const register = registerWithContacts(demoRegister('aug'), { [NATIONAL.gstin]: { email: ADDRESS } }, 'threads-suite');
  expect((await api.ingest('PURCHASE_REGISTER', register)).status).toBe(200);
});

afterAll(async () => {
  setMailTransport(null);
  for (const name of Object.keys(MAIL_ENV)) delete process.env[name];
  await api?.close();
  await resetOrg(ORG_ID);
  await closePool();
});

const email = () => api.call('POST', '/api/messages', {
  supplierGstin: NATIONAL.gstin,
  documentRefs: ['NS-612'],
  subject: 'NS-612',
  body: 'Hello, please correct NS-612.',
  taxPeriod: '2026-08',
  context: 'decisions'
});

describe('one model for both channels', () => {
  it('stores an email as a thread with its one message', async () => {
    const { status, body } = await email();
    expect(status).toBe(201);
    expect(body.thread).toMatchObject({ channel: 'email', to: ADDRESS, replies: [] });
    expect(body.thread.messages).toEqual([
      expect.objectContaining({ format: 'email', to: ADDRESS, body: 'Hello, please correct NS-612.', status: null })
    ]);
  });

  it('counts WhatsApp messages against the same daily limit', async () => {
    const id = await createThread(
      {
        orgId: ORG_ID, ref: 'WATHRZ', channel: CHANNELS.WHATSAPP, supplierGstin: NATIONAL.gstin,
        supplierName: 'National Supply Co', documentRefs: ['NS-612'], taxPeriod: '2026-08', context: 'decisions',
        to: '+919800000001', subject: 'NS-612 · Sharma Electronics', body: 'Hello, please correct NS-612.'
      },
      { format: 'template', body: 'Template text', externalId: `wamid.threads-${process.pid}-1` }
    );
    [[whatsappThread]] = await pool.query('SELECT * FROM message_threads WHERE id = ?', [id]);
    await addSend(whatsappThread, { format: 'text', body: 'Hello again', externalId: `wamid.threads-${process.pid}-2` });

    const { body } = await api.call('GET', '/api/messages');
    expect(body.mail.sentToday).toBe(3);
    const thread = body.threads.find((entry) => entry.id === id);
    expect(thread).toMatchObject({ channel: 'whatsapp', to: '+919800000001' });
    expect(thread.messages.map((message) => message.format)).toEqual(['template', 'text']);

    expect((await email()).status).toBe(201);
    const refused = await email();
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('daily_limit');
  });

  it('stores a WhatsApp reply like an email reply, and the bell reads it alike', async () => {
    const check = async () => ({ intent: 'will_fix', summary: 'Will fix it by 9 Oct.', promisedDate: '2026-10-09', mentionsOurInvoice: true });
    const before = await unreadSummary(ORG_ID);
    const reply = { externalId: `wamid.reply-${process.pid}`, from: '+919800000001', receivedAt: new Date(), text: 'Will fix by 9 Oct' };
    expect(await storeReply(whatsappThread, reply, { check })).toBe('stored');
    expect(await storeReply(whatsappThread, reply, { check })).toBe('duplicate');

    const after = await unreadSummary(ORG_ID);
    expect(after.count).toBe(1);
    expect(after.version).not.toBe(before.version);
    expect(after.latest[0]).toMatchObject({
      channel: 'whatsapp', from: '+919800000001', intent: 'will_fix', promisedDate: '2026-10-09', flag: null,
      documentRefs: ['NS-612'], supplierGstin: NATIONAL.gstin
    });
  });

  it("moves the bell's version when a delivery status changes", async () => {
    const before = (await unreadSummary(ORG_ID)).version;
    await pool.query("UPDATE message_sends SET status = 'delivered' WHERE thread_id = ?", [whatsappThread.id]);
    expect((await unreadSummary(ORG_ID)).version).not.toBe(before);
  });

  it('never takes a mail for a reply on a WhatsApp thread', async () => {
    const mail = {
      messageId: `<threads-${process.pid}@supplier.example>`,
      subject: 'Re: [ITC Guard #WATHRZ] NS-612',
      inReplyTo: `<wamid.threads-${process.pid}-1>`,
      from: { value: [{ address: ADDRESS }] },
      date: new Date(),
      text: 'Done'
    };
    expect(await handleIncoming(mail, { check: async () => ({}) })).toBe('unmatched');
  });
});
