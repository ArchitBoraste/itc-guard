// Supplier message threads on every channel: what was sent, what came back, and
// the unread count the bells show.
//
// A thread is one conversation with a supplier about one or more documents, on
// one channel: email (services/supplierEmail.js) or WhatsApp
// (services/supplierWhatsapp.js). message_threads says who and what it is about
// and holds its first message; message_sends every message sent on it (an email
// thread has one); message_replies what the supplier wrote back. A reply from
// either channel is stored and checked the same way (storeReply), so the bell,
// the intent chip and "Promised by" read both alike.
//
// Reply text is the supplier's, untrusted: stored as text, shown escaped.
import { randomInt } from 'node:crypto';
import { pool } from '../db/pool.js';
import { checkReply } from './replyCheck.js';
import { ServiceError } from './ingest.js';

export const CHANNELS = Object.freeze({ EMAIL: 'email', WHATSAPP: 'whatsapp' });

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_LENGTH = 6;
const MAX_DOCUMENTS = 20;
export const CONTEXTS = new Set(['decisions', 'notfiled', 'corrections', 'suppliers']);

// --- small helpers ---------------------------------------------------------------

export function newRef() {
  let ref = '';
  for (let i = 0; i < REF_LENGTH; i += 1) ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return ref;
}

// MySQL DATETIME (UTC, read as a string) -> ISO 8601.
export const isoUtc = (value) => (value ? `${String(value).replace(' ', 'T')}Z` : null);

const parseRefs = (value) => (Array.isArray(value) ? value : JSON.parse(value ?? '[]'));

export const documentRefsOf = (thread) => parseRefs(thread.document_refs);

// 'INV/2024/0891' and 'inv-2024-0891' are the same document to a reader.
export const docKey = (invoiceNo) => String(invoiceNo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function cleanDocumentRefs(value) {
  if (!Array.isArray(value) || !value.length) throw new ServiceError('documentRefs must list at least one invoice number');
  if (value.length > MAX_DOCUMENTS) throw new ServiceError(`documentRefs lists more than ${MAX_DOCUMENTS} documents`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 64) {
      throw new ServiceError('each documentRefs entry must be an invoice number of up to 64 characters');
    }
    return entry.trim();
  });
}

export const cleanTaxPeriod = (value) => (/^\d{4}-\d{2}$/.test(String(value ?? '')) ? value : null);
export const cleanContext = (value) => (CONTEXTS.has(value) ? value : null);

// --- reads -----------------------------------------------------------------------

export async function orgRow(orgId) {
  const [rows] = await pool.query(
    'SELECT trade_name, legal_name, trader_phone FROM organizations WHERE id = ?',
    [orgId]
  );
  if (!rows.length) throw new ServiceError('workspace not found', 404, 'not_found');
  return rows[0];
}

export async function supplierName(orgId, gstin) {
  const [rows] = await pool.query(
    `SELECT COALESCE(
       (SELECT trade_name FROM suppliers WHERE org_id = ? AND gstin = ? LIMIT 1),
       (SELECT supplier_name FROM expected_invoices WHERE org_id = ? AND supplier_gstin = ? LIMIT 1),
       (SELECT supplier_name FROM portal_records WHERE org_id = ? AND supplier_gstin = ? LIMIT 1)
     ) AS name`,
    [orgId, gstin, orgId, gstin, orgId, gstin]
  );
  return rows[0].name ?? null;
}

// Messages sent in the last 24 hours, email and WhatsApp together: one daily limit.
export async function sentToday(orgId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM message_sends WHERE org_id = ? AND sent_at > UTC_TIMESTAMP() - INTERVAL 1 DAY',
    [orgId]
  );
  return Number(rows[0].n);
}

// "Doesn't seem to be about NS-612", or null.
export function replyFlag(reply, documentRefs) {
  if (reply.mentionsOurInvoice === false || reply.intent === 'unrelated') {
    return `Doesn't seem to be about ${documentRefs.join(', ')}`;
  }
  return null;
}

function replyView(row, documentRefs, channel) {
  const reply = {
    id: Number(row.id),
    threadId: Number(row.thread_id),
    channel,
    from: row.from_address,
    receivedAt: isoUtc(row.received_at),
    text: row.body,
    intent: row.intent,
    summary: row.summary,
    promisedDate: row.promised_date ?? null,
    mentionsOurInvoice: row.mentions_our_invoice === null ? null : Boolean(row.mentions_our_invoice),
    read: row.read_at !== null
  };
  return { ...reply, flag: replyFlag(reply, documentRefs) };
}

function sendView(row) {
  return {
    id: Number(row.id),
    format: row.format,
    to: row.to_address,
    body: row.body,
    sentAt: isoUtc(row.sent_at),
    status: row.status ?? null,
    statusDetail: row.status_detail ?? null,
    statusAt: isoUtc(row.status_at)
  };
}

export function threadView(row) {
  return {
    id: Number(row.id),
    ref: row.ref,
    channel: row.channel ?? CHANNELS.EMAIL,
    supplierGstin: row.supplier_gstin,
    supplierName: row.supplier_name,
    documentRefs: parseRefs(row.document_refs),
    taxPeriod: row.tax_period,
    context: row.context,
    to: row.to_address,
    subject: row.subject,
    body: row.body,
    sentAt: isoUtc(row.sent_at),
    messages: [],
    replies: []
  };
}

function assemble(threadRows, sendRows, replyRows) {
  const byId = new Map(threadRows.map((row) => [Number(row.id), threadView(row)]));
  for (const row of sendRows) byId.get(Number(row.thread_id))?.messages.push(sendView(row));
  for (const row of replyRows) {
    const thread = byId.get(Number(row.thread_id));
    if (thread) thread.replies.push(replyView(row, thread.documentRefs, thread.channel));
  }
  return [...byId.values()];
}

// Every thread in the workspace, newest first, each with its messages and replies
// (oldest first).
export async function listThreads(orgId) {
  const [threads] = await pool.query(
    'SELECT * FROM message_threads WHERE org_id = ? ORDER BY sent_at DESC, id DESC',
    [orgId]
  );
  const [sends] = await pool.query('SELECT * FROM message_sends WHERE org_id = ? ORDER BY sent_at, id', [orgId]);
  const [replies] = await pool.query('SELECT * FROM message_replies WHERE org_id = ? ORDER BY received_at, id', [orgId]);
  return assemble(threads, sends, replies);
}

// One thread as the API returns it, or null.
export async function getThread(threadId) {
  const [threads] = await pool.query('SELECT * FROM message_threads WHERE id = ?', [threadId]);
  if (!threads.length) return null;
  const [sends] = await pool.query('SELECT * FROM message_sends WHERE thread_id = ? ORDER BY sent_at, id', [threadId]);
  const [replies] = await pool.query('SELECT * FROM message_replies WHERE thread_id = ? ORDER BY received_at, id', [threadId]);
  return assemble(threads, sends, replies)[0];
}

// The top bar's bell: the unread count and the latest unread replies. version
// changes whenever a message, a reply or a delivery status is added or a reply is
// read, so the UI re-reads the threads only then.
export async function unreadSummary(orgId, { limit = 8 } = {}) {
  const [rows] = await pool.query(
    `SELECT r.*, t.ref, t.channel, t.supplier_gstin, t.supplier_name, t.document_refs, t.context, t.tax_period
       FROM message_replies r JOIN message_threads t ON t.id = r.thread_id
      WHERE r.org_id = ? AND r.read_at IS NULL
      ORDER BY r.received_at DESC, r.id DESC`,
    [orgId]
  );
  // A status only ever moves forward (sent < delivered < read; failed last), so
  // the sum of their ranks grows with every update.
  const [[marks]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM message_threads WHERE org_id = ?) AS threads,
            (SELECT COUNT(*) FROM message_sends WHERE org_id = ?) AS sends,
            (SELECT COALESCE(SUM(FIELD(status, 'sent', 'delivered', 'read', 'failed')), 0)
               FROM message_sends WHERE org_id = ?) AS statuses,
            (SELECT COALESCE(MAX(id), 0) FROM message_replies WHERE org_id = ?) AS last_reply`,
    [orgId, orgId, orgId, orgId]
  );
  return {
    count: rows.length,
    version: `${marks.threads}:${marks.sends}:${marks.statuses}:${marks.last_reply}:${rows.length}`,
    latest: rows.slice(0, limit).map((row) => {
      const documentRefs = parseRefs(row.document_refs);
      return {
        ...replyView(row, documentRefs, row.channel),
        ref: row.ref,
        supplierGstin: row.supplier_gstin,
        supplierName: row.supplier_name,
        documentRefs,
        context: row.context,
        taxPeriod: row.tax_period
      };
    })
  };
}

// Marks every reply on one supplier's threads read -> { marked }.
export async function markSupplierRead(orgId, gstin) {
  if (!/^[0-9A-Z]{15}$/.test(String(gstin ?? ''))) throw new ServiceError('supplierGstin must be a GSTIN');
  const [result] = await pool.query(
    `UPDATE message_replies r JOIN message_threads t ON t.id = r.thread_id
        SET r.read_at = UTC_TIMESTAMP()
      WHERE r.org_id = ? AND t.supplier_gstin = ? AND r.read_at IS NULL`,
    [orgId, gstin]
  );
  return { marked: result.affectedRows };
}

// --- writes ------------------------------------------------------------------------

// A new thread and its first message, sent just now -> the thread id.
//
// thread: { orgId, ref, channel, supplierGstin, supplierName, documentRefs,
//           taxPeriod, context, to, subject, body }
// first:  { format, body, externalId }
export async function createThread(thread, first) {
  const [inserted] = await pool.query(
    `INSERT INTO message_threads
       (org_id, ref, channel, supplier_gstin, supplier_name, document_refs, tax_period, context,
        to_address, subject, body, message_id, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      thread.orgId, thread.ref, thread.channel, thread.supplierGstin, thread.supplierName,
      JSON.stringify(thread.documentRefs), thread.taxPeriod, thread.context, thread.to,
      thread.subject, thread.body, first.externalId
    ]
  );
  await addSend({ id: inserted.insertId, org_id: thread.orgId, channel: thread.channel, to_address: thread.to }, first);
  return inserted.insertId;
}

// One more message on a thread (a message_threads row), sent just now.
export async function addSend(thread, { format, body, externalId }) {
  await pool.query(
    `INSERT INTO message_sends (org_id, thread_id, channel, format, to_address, body, external_id, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [thread.org_id, thread.id, thread.channel, format, thread.to_address, body, externalId]
  );
}

// storeReply(thread row, { externalId, from, receivedAt, text }, { check })
//   -> 'stored' | 'duplicate'
//
// externalId is the reply's own id on its channel (an email's Message-ID, a
// WhatsApp wamid), so a reply delivered twice is stored once. The check reads it
// against our first message on the thread; its answer is data, stored as is.
export async function storeReply(thread, reply, { check = checkReply } = {}) {
  if (reply.externalId) {
    const [seen] = await pool.query('SELECT id FROM message_replies WHERE message_id = ?', [reply.externalId]);
    if (seen.length) return 'duplicate';
  }
  const result = await check({
    ourMessage: thread.body,
    reply: reply.text,
    documentRefs: documentRefsOf(thread),
    receivedAt: reply.receivedAt
  });
  const [inserted] = await pool.query(
    `INSERT IGNORE INTO message_replies
       (org_id, thread_id, message_id, from_address, received_at, body,
        intent, summary, promised_date, mentions_our_invoice)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      thread.org_id,
      thread.id,
      reply.externalId ? String(reply.externalId).slice(0, 255) : null,
      reply.from ? String(reply.from).slice(0, 255) : null,
      reply.receivedAt,
      reply.text,
      result.intent,
      result.summary,
      result.promisedDate,
      result.mentionsOurInvoice === null ? null : Number(result.mentionsOurInvoice)
    ]
  );
  return inserted.affectedRows ? 'stored' : 'duplicate';
}
