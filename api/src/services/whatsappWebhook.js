// Meta's WhatsApp webhook: supplier replies and delivery statuses
// (routes/webhooks.js answers the HTTP side).
//
//   GET   Meta's subscription check: hub.mode=subscribe and hub.verify_token equal
//         to WHATSAPP_VERIFY_TOKEN -> hub.challenge, as plain text.
//   POST  a batch of events, signed: X-Hub-Signature-256 is "sha256=" and the
//         HMAC-SHA256 of the RAW body under WHATSAPP_APP_SECRET. Anything else is
//         refused and never read. A signed batch is answered 200 at once and
//         processed after, so Meta does not retry it for being slow; a retry is
//         harmless anyway: a reply is stored once per wamid, and a status only
//         moves forward (sent < delivered < read; failed last).
//
// A message finds its thread by context.id (a swipe-reply quotes our wamid), else
// by the sender's number: that number's thread with the latest message sent in the
// last OPEN_DAYS days, in whichever workspace sent it. Anything else is ignored.
// The text is the supplier's, untrusted: stored as text, checked like an email
// reply (services/replyCheck.js), shown escaped. Logs carry counts and codes,
// never a number or a message.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { checkReply } from './replyCheck.js';
import { CHANNELS, storeReply } from './messageThreads.js';
import { explainGraphError } from './whatsappApi.js';

const OPEN_DAYS = 30;
const MAX_TEXT = 4000;
const RANK = Object.freeze({ sent: 1, delivered: 2, read: 3, failed: 4 });
const MEDIA = Object.freeze({
  image: 'a photo',
  video: 'a video',
  audio: 'a voice note',
  document: 'a document',
  sticker: 'a sticker'
});

// --- the HTTP checks --------------------------------------------------------------

// The raw body against "sha256=<hex>". False for anything malformed.
export function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody ?? Buffer.alloc(0)).digest();
  return timingSafeEqual(expected, Buffer.from(match[1].toLowerCase(), 'hex'));
}

const sameText = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

// Meta's GET: -> the challenge to echo, or null to refuse.
export function subscriptionChallenge(query) {
  const { verifyToken } = config.whatsapp;
  if (!verifyToken) return null;
  if (query['hub.mode'] !== 'subscribe' || typeof query['hub.challenge'] !== 'string') return null;
  if (!sameText(query['hub.verify_token'] ?? '', verifyToken)) return null;
  return query['hub.challenge'].slice(0, 200);
}

// --- processing after the 200 ---------------------------------------------------------

const pending = new Set();

// Runs a batch after the response went out; errors are logged by code only.
export function processLater(work) {
  const running = Promise.resolve()
    .then(work)
    .catch((err) => console.error(`[whatsapp] webhook processing failed: ${err.code ?? err.name ?? 'error'}`))
    .finally(() => pending.delete(running));
  pending.add(running);
}

// Resolves once every batch received so far is processed. For tests.
export async function webhooksIdle() {
  while (pending.size) await Promise.all([...pending]);
}

// --- one batch ----------------------------------------------------------------------

const asArray = (value) => (Array.isArray(value) ? value : []);

// Meta's unix-seconds string -> Date, or null.
function timestampOf(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

// Untrusted text: control characters out, trimmed, bounded.
function cleanText(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_TEXT);
  return text || null;
}

// What the supplier wrote, or null for what is not a reply (a reaction, a system
// notice, an unsupported type). Media is noted, with its caption.
function messageText(message) {
  switch (message.type) {
    case 'text':
      return cleanText(message.text?.body);
    case 'button':
      return cleanText(message.button?.text);
    case 'interactive':
      return cleanText(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title);
    default: {
      if (!MEDIA[message.type]) return null;
      const caption = cleanText(message[message.type]?.caption);
      return `(Sent ${MEDIA[message.type]} on WhatsApp${caption ? `: ${caption}` : '. Open WhatsApp to see it.'})`;
    }
  }
}

// The thread a message from this number answers, or null.
async function findThread(contextId, from) {
  if (typeof contextId === 'string' && contextId) {
    const [rows] = await pool.query(
      `SELECT t.* FROM message_sends s JOIN message_threads t ON t.id = s.thread_id
        WHERE s.channel = ? AND s.external_id = ? LIMIT 1`,
      [CHANNELS.WHATSAPP, contextId]
    );
    // A quote of our message from another number is no reply to it.
    if (rows.length && rows[0].to_address === from) return rows[0];
  }
  const [rows] = await pool.query(
    `SELECT t.* FROM message_sends s JOIN message_threads t ON t.id = s.thread_id
      WHERE s.channel = ? AND s.to_address = ? AND s.sent_at > UTC_TIMESTAMP() - INTERVAL ? DAY
      ORDER BY s.sent_at DESC, s.id DESC LIMIT 1`,
    [CHANNELS.WHATSAPP, from, OPEN_DAYS]
  );
  return rows[0] ?? null;
}

// One message from the batch -> 'stored' | 'duplicate' | 'unmatched' | 'ignored'.
export async function handleInboundMessage(message, { check = checkReply } = {}) {
  const wamid = typeof message?.id === 'string' && message.id ? message.id.slice(0, 255) : null;
  const digits = String(message?.from ?? '').replace(/\D/g, '');
  if (!wamid || digits.length < 8 || digits.length > 15) return 'ignored';
  const text = messageText(message);
  if (text === null) return 'ignored';

  const [seen] = await pool.query('SELECT id FROM message_replies WHERE message_id = ?', [wamid]);
  if (seen.length) return 'duplicate';
  const from = `+${digits}`;
  const thread = await findThread(message.context?.id, from);
  if (!thread) return 'unmatched';
  return storeReply(thread, { externalId: wamid, from, receivedAt: timestampOf(message.timestamp) ?? new Date(), text }, { check });
}

// Why a message failed, in plain words, from the status's errors[].
function failureReason(errors) {
  const [first] = asArray(errors);
  if (!first) return 'no reason given';
  const code = Number.isInteger(first.code) ? first.code : null;
  if (code === null) return String(first.title ?? 'no reason given').slice(0, 255);
  return explainGraphError(code, { title: first.title ?? null }).short.slice(0, 255);
}

// One status from the batch -> true when it moved our message forward.
export async function applyStatus(status) {
  const wamid = typeof status?.id === 'string' ? status.id : null;
  const rank = RANK[status?.status];
  if (!wamid || !rank) return false;
  const [result] = await pool.query(
    `UPDATE message_sends SET status = ?, status_detail = ?, status_at = ?
      WHERE channel = ? AND external_id = ?
        AND FIELD(COALESCE(status, ''), 'sent', 'delivered', 'read', 'failed') < ?`,
    [
      status.status,
      status.status === 'failed' ? failureReason(status.errors) : null,
      timestampOf(status.timestamp) ?? new Date(),
      CHANNELS.WHATSAPP,
      wamid,
      rank
    ]
  );
  return result.affectedRows > 0;
}

// handleWhatsappWebhook(payload) -> counts of what happened to it.
export async function handleWhatsappWebhook(payload, { check = checkReply, log = console } = {}) {
  const counts = { stored: 0, duplicate: 0, unmatched: 0, ignored: 0, statuses: 0 };
  if (payload?.object !== 'whatsapp_business_account') return counts;
  const { phoneNumberId } = config.whatsapp;
  for (const entry of asArray(payload.entry)) {
    for (const change of asArray(entry?.changes)) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      // Another number on the same app is not ours to read.
      const number = value.metadata?.phone_number_id;
      if (phoneNumberId && number && String(number) !== phoneNumberId) {
        counts.ignored += 1;
        continue;
      }
      for (const status of asArray(value.statuses)) {
        if (await applyStatus(status)) counts.statuses += 1;
      }
      for (const message of asArray(value.messages)) {
        counts[await handleInboundMessage(message, { check })] += 1;
      }
    }
  }
  if (counts.stored) log.log(`[whatsapp] stored ${counts.stored} supplier repl${counts.stored === 1 ? 'y' : 'ies'}`);
  return counts;
}
