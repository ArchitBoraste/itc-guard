// Meta's WhatsApp webhook end to end over HTTP (routes/webhooks.js,
// services/whatsappWebhook.js), with signed fixtures in Meta's shapes
// (test/fixtures/whatsapp-webhooks.json).
//
//   * GET answers Meta's check with the challenge, for the verify token only.
//   * POST must carry a valid X-Hub-Signature-256 over the raw body; it is
//     answered 200 at once, processed after, and idempotent on the message id.
//   * A reply finds its thread by context.id first, else by the sender's most
//     recent thread; an unknown sender, another business number, a reaction are
//     ignored. Replies are stored and checked like email replies.
//   * Statuses only move forward; a failure keeps its reason in plain words.
//   * The webhook never passes through the session middleware.
//
// Owns org 39.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';
import { ensureOrg } from '../../src/services/demo.js';
import { CHANNELS, addSend, createThread } from '../../src/services/messageThreads.js';
import { handleWhatsappWebhook, webhooksIdle } from '../../src/services/whatsappWebhook.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.whatsappWebhook;
const FIXTURES = JSON.parse(readFileSync(new URL('../fixtures/whatsapp-webhooks.json', import.meta.url), 'utf8'));
const ENV = {
  WHATSAPP_APP_SECRET: 'test-app-secret',
  WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_PHONE_NUMBER_ID: '1110001'
};
const SUPPLIER = '+919800000011';
const GSTIN = '27AABCN7782E1ZT';

let server;
let base;
const authCalls = [];
let threads = {};

const sign = (raw, secret = ENV.WHATSAPP_APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

async function post(payload, { signature, raw = JSON.stringify(payload) } = {}) {
  const res = await fetch(`${base}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'X-Hub-Signature-256': signature ?? sign(raw) }) },
    body: raw
  });
  await webhooksIdle();
  return { status: res.status, text: await res.text() };
}

async function replies() {
  const [rows] = await pool.query('SELECT * FROM message_replies WHERE org_id = ? ORDER BY id', [ORG_ID]);
  return rows;
}

async function sendRow(wamid) {
  const [[row]] = await pool.query('SELECT * FROM message_sends WHERE external_id = ?', [wamid]);
  return row;
}

const thread = (ref, documentRefs, to = SUPPLIER) => ({
  orgId: ORG_ID, ref, channel: CHANNELS.WHATSAPP, supplierGstin: GSTIN, supplierName: 'National Supply Co',
  documentRefs, taxPeriod: '2026-08', context: 'decisions', to, subject: `${documentRefs[0]} · Sharma Electronics`,
  body: `Hello Rakesh ji, please correct ${documentRefs[0]}.`
});

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  Object.assign(process.env, ENV);

  // NS-612's thread was messaged first; NS-700's is the latest to the same number.
  threads.first = await createThread(thread('WHKAAA', ['NS-612']), { format: 'template', body: 'Template', externalId: 'wamid.ITCG-TEST-T1' });
  threads.latest = await createThread(thread('WHKBBB', ['NS-700']), { format: 'template', body: 'Template', externalId: 'wamid.ITCG-TEST-T2' });
  await pool.query('UPDATE message_sends SET sent_at = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE external_id = ?', ['wamid.ITCG-TEST-T1']);

  const app = createApp({
    pingDb: async () => true,
    auth: (req, res, next) => {
      authCalls.push(req.originalUrl);
      req.orgId = ORG_ID;
      next();
    }
  });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  await new Promise((resolve) => server?.close(resolve));
  await resetOrg(ORG_ID);
  await closePool();
});

describe("Meta's subscription check", () => {
  it('echoes hub.challenge as plain text for the verify token, and refuses anything else', async () => {
    const ok = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await ok.text()).toBe('1158201444');

    const wrong = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1`);
    expect(wrong.status).toBe(403);
  });
});

describe('the signature', () => {
  it('refuses a body with a bad signature or none, storing nothing', async () => {
    expect((await post(FIXTURES.contextReply, { signature: sign('{}') })).status).toBe(401);
    expect((await post(FIXTURES.contextReply, { signature: sign(JSON.stringify(FIXTURES.contextReply), 'another-secret') })).status).toBe(401);
    expect((await post(FIXTURES.contextReply, { signature: null })).status).toBe(401);
    expect(await replies()).toHaveLength(0);
  });

  it('checks the raw bytes as sent, not a re-serialised copy', async () => {
    const raw = JSON.stringify(FIXTURES.stranger, null, 2);
    expect((await post(FIXTURES.stranger, { raw })).status).toBe(200);
    expect((await post(FIXTURES.stranger, { raw, signature: sign(JSON.stringify(FIXTURES.stranger)) })).status).toBe(401);
  });

  it('refuses a signed body that is not JSON', async () => {
    expect((await post(null, { raw: 'not json' })).status).toBe(400);
  });
});

describe('replies', () => {
  it('stores a swipe-reply on the thread it quotes, though another thread is more recent', async () => {
    const res = await post(FIXTURES.contextReply);
    expect(res).toEqual({ status: 200, text: 'OK' });
    const [row] = await replies();
    expect(row).toMatchObject({
      org_id: ORG_ID,
      thread_id: threads.first,
      message_id: 'wamid.ITCG-TEST-IN-CONTEXT',
      from_address: SUPPLIER,
      received_at: '2026-10-05 13:50:00',
      body: 'Will correct NS-612 through GSTR-1A by 9 Oct',
      intent: 'unchecked',
      read_at: null
    });
  });

  it('stores a message delivered twice once', async () => {
    expect((await post(FIXTURES.contextReply)).status).toBe(200);
    expect(await replies()).toHaveLength(1);
  });

  it("stores a plain message on the sender's most recent thread, as untrusted text", async () => {
    await post(FIXTURES.phoneFallback);
    const row = (await replies()).at(-1);
    expect(row).toMatchObject({ thread_id: threads.latest, message_id: 'wamid.ITCG-TEST-IN-PLAIN' });
    // Kept as text (the UI escapes it); control characters are dropped.
    expect(row.body).toBe('Done, <b>filed</b> today');
  });

  it('notes a photo with its caption, and ignores a reaction, an unknown sender and another number', async () => {
    await post(FIXTURES.photo);
    await post(FIXTURES.stranger);
    await post(FIXTURES.otherNumber);
    const rows = await replies();
    expect(rows.map((row) => row.message_id)).toEqual([
      'wamid.ITCG-TEST-IN-CONTEXT', 'wamid.ITCG-TEST-IN-PLAIN', 'wamid.ITCG-TEST-IN-PHOTO'
    ]);
    expect(rows.at(-1).body).toBe('(Sent a photo on WhatsApp: GSTR-1A filed)');
  });

  it('lights the bell like an email reply', async () => {
    const { body } = await fetch(`${base}/api/messages/unread`).then(async (res) => ({ body: await res.json() }));
    expect(body.count).toBe(3);
    expect(body.latest.every((reply) => reply.channel === 'whatsapp' && reply.supplierGstin === GSTIN)).toBe(true);
  });

  it('runs the same reply check as email and stores what it says', async () => {
    let asked = null;
    const check = async (input) => {
      asked = input;
      return { intent: 'will_fix', summary: 'Will correct it by 9 Oct.', promisedDate: '2026-10-09', mentionsOurInvoice: true };
    };
    const payload = structuredClone(FIXTURES.contextReply);
    payload.entry[0].changes[0].value.messages[0].id = 'wamid.ITCG-TEST-IN-CHECKED';
    const counts = await handleWhatsappWebhook(payload, { check, log: { log: () => {} } });
    expect(counts).toMatchObject({ stored: 1 });
    expect(asked).toMatchObject({
      ourMessage: 'Hello Rakesh ji, please correct NS-612.',
      reply: 'Will correct NS-612 through GSTR-1A by 9 Oct',
      documentRefs: ['NS-612']
    });
    expect((await replies()).at(-1)).toMatchObject({ intent: 'will_fix', promised_date: '2026-10-09', mentions_our_invoice: 1 });
  });
});

describe('delivery statuses', () => {
  it('move a message forward and never back', async () => {
    await post(FIXTURES.delivered);
    expect(await sendRow('wamid.ITCG-TEST-T1')).toMatchObject({ status: 'delivered', status_at: '2026-10-05 13:45:00' });
    await post(FIXTURES.lateSent);
    expect((await sendRow('wamid.ITCG-TEST-T1')).status).toBe('delivered');
    await post(FIXTURES.read);
    expect((await sendRow('wamid.ITCG-TEST-T1')).status).toBe('read');
  });

  it('keep the reason a message failed, in plain words, and the thread shows it', async () => {
    await post(FIXTURES.failed);
    expect(await sendRow('wamid.ITCG-TEST-T2')).toMatchObject({
      status: 'failed', status_detail: 'more than 24 hours since they last wrote'
    });
    const body = await fetch(`${base}/api/messages`).then((res) => res.json());
    const latest = body.threads.find((entry) => entry.id === threads.latest);
    expect(latest.messages[0]).toMatchObject({ status: 'failed', statusDetail: 'more than 24 hours since they last wrote' });
  });

  it('a later send on the thread gets its own status', async () => {
    const [[row]] = await pool.query('SELECT * FROM message_threads WHERE id = ?', [threads.first]);
    await addSend(row, { format: 'text', body: 'Full message', externalId: 'wamid.ITCG-TEST-T3' });
    const payload = structuredClone(FIXTURES.delivered);
    payload.entry[0].changes[0].value.statuses[0].id = 'wamid.ITCG-TEST-T3';
    await post(payload);
    expect((await sendRow('wamid.ITCG-TEST-T3')).status).toBe('delivered');
    expect((await sendRow('wamid.ITCG-TEST-T1')).status).toBe('read');
  });
});

describe('outside the session', () => {
  it('never reaches the session middleware, and 404s anything else under /api/webhooks', async () => {
    const before = authCalls.filter((url) => url.startsWith('/api/webhooks')).length;
    const other = await fetch(`${base}/api/webhooks/somewhere-else`, { method: 'POST' });
    expect(other.status).toBe(404);
    expect(authCalls.filter((url) => url.startsWith('/api/webhooks')).length).toBe(before);
    expect(before).toBe(0);
  });

  it('is refused while no app secret is set', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    try {
      expect((await post(FIXTURES.contextReply)).status).toBe(503);
    } finally {
      process.env.WHATSAPP_APP_SECRET = ENV.WHATSAPP_APP_SECRET;
    }
  });
});
