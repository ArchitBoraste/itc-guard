// Supplier email sent from the app, and the threads the replies land on.
//
// Off unless SMTP_HOST, SMTP_USER and SMTP_PASS are set: the Email button then
// stays a mailto link. When on:
//   * the To is the supplier's contact AT SEND TIME (supplier_contacts, latest
//     register or PUT wins), and the thread keeps the address it went to;
//   * only addresses in EMAIL_ALLOWLIST receive anything (403 otherwise), and a
//     workspace sends at most EMAIL_DAILY_LIMIT (30) a day (429);
//   * every subject carries a tag, "[ITC Guard #K7Q2XM]", and every message our
//     own Message-ID, the two ways services/mailInbox.js finds a reply's thread.
//
// Reply text is the supplier's, untrusted: stored as text, shown escaped.
import { randomBytes, randomInt } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { contactsByGstin, knownSupplierGstin } from './supplierContacts.js';
import { traderNameOf } from './supplierMessages.js';
import { ServiceError } from './ingest.js';

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_LENGTH = 6;
export const SUBJECT_TAG = /\[ITC Guard #([A-Z2-9]{6})\]/;

const MAX_SUBJECT = 300;
const MAX_BODY = 20000;
const MAX_DOCUMENTS = 20;
const CONTEXTS = new Set(['decisions', 'notfiled', 'corrections', 'suppliers']);

// --- transport -------------------------------------------------------------------

let transport = null;
let transportKey = null;
let transportOverride = null;

// Tests send through a fake ({ sendMail }); null goes back to SMTP.
export function setMailTransport(fake) {
  transportOverride = fake;
}

function mailTransport(smtp) {
  if (transportOverride) return transportOverride;
  const key = `${smtp.host}:${smtp.port}:${smtp.user}`;
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    });
    transportKey = key;
  }
  return transport;
}

// --- small helpers ---------------------------------------------------------------

function newRef() {
  let ref = '';
  for (let i = 0; i < REF_LENGTH; i += 1) ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return ref;
}

const oneLine = (text) => String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

// The subject the trader typed, with any tag of ours removed: the server adds it.
export function taggedSubject(ref, subject) {
  return `[ITC Guard #${ref}] ${oneLine(subject).replace(SUBJECT_TAG, '').trim()}`.slice(0, 500);
}

const domainOf = (address) => String(address).split('@')[1] || 'itc-guard.local';

// MySQL DATETIME (UTC, read as a string) -> ISO 8601.
export const isoUtc = (value) => (value ? `${String(value).replace(' ', 'T')}Z` : null);

function cleanDocumentRefs(value) {
  if (!Array.isArray(value) || !value.length) throw new ServiceError('documentRefs must list at least one invoice number');
  if (value.length > MAX_DOCUMENTS) throw new ServiceError(`documentRefs lists more than ${MAX_DOCUMENTS} documents`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 64) {
      throw new ServiceError('each documentRefs entry must be an invoice number of up to 64 characters');
    }
    return entry.trim();
  });
}

// --- reads -----------------------------------------------------------------------

async function orgRow(orgId) {
  const [rows] = await pool.query(
    'SELECT trade_name, legal_name, trader_phone FROM organizations WHERE id = ?',
    [orgId]
  );
  if (!rows.length) throw new ServiceError('workspace not found', 404, 'not_found');
  return rows[0];
}

async function sentToday(orgId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM message_threads WHERE org_id = ? AND sent_at > UTC_TIMESTAMP() - INTERVAL 1 DAY',
    [orgId]
  );
  return Number(rows[0].n);
}

// What the compose dialog needs to know before it opens.
export async function mailStatus(orgId) {
  const mail = config.mail;
  const org = await orgRow(orgId);
  return {
    enabled: mail.enabled,
    fromName: traderNameOf(org) || null,
    traderPhone: org.trader_phone ?? null,
    dailyLimit: mail.dailyLimit,
    sentToday: mail.enabled ? await sentToday(orgId) : 0
  };
}

// "Doesn't seem to be about NS-612", or null.
export function replyFlag(reply, documentRefs) {
  if (reply.mentionsOurInvoice === false || reply.intent === 'unrelated') {
    return `Doesn't seem to be about ${documentRefs.join(', ')}`;
  }
  return null;
}

function replyView(row, documentRefs) {
  const reply = {
    id: Number(row.id),
    threadId: Number(row.thread_id),
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

const parseRefs = (value) => (Array.isArray(value) ? value : JSON.parse(value ?? '[]'));

function threadView(row) {
  return {
    id: Number(row.id),
    ref: row.ref,
    supplierGstin: row.supplier_gstin,
    supplierName: row.supplier_name,
    documentRefs: parseRefs(row.document_refs),
    taxPeriod: row.tax_period,
    context: row.context,
    to: row.to_address,
    subject: row.subject,
    body: row.body,
    sentAt: isoUtc(row.sent_at),
    replies: []
  };
}

// Every thread in the workspace, newest first, each with its replies (oldest first).
export async function listThreads(orgId) {
  const [threads] = await pool.query(
    'SELECT * FROM message_threads WHERE org_id = ? ORDER BY sent_at DESC, id DESC',
    [orgId]
  );
  const [replies] = await pool.query(
    'SELECT * FROM message_replies WHERE org_id = ? ORDER BY received_at, id',
    [orgId]
  );
  const byId = new Map(threads.map((row) => [Number(row.id), threadView(row)]));
  for (const row of replies) {
    const thread = byId.get(Number(row.thread_id));
    if (thread) thread.replies.push(replyView(row, thread.documentRefs));
  }
  return [...byId.values()];
}

// The top bar's bell: the unread count and the latest unread replies. version
// changes whenever a thread or reply is added or read, so the UI re-reads the
// threads only then.
export async function unreadSummary(orgId, { limit = 8 } = {}) {
  const [rows] = await pool.query(
    `SELECT r.*, t.ref, t.supplier_gstin, t.supplier_name, t.document_refs, t.context, t.tax_period
       FROM message_replies r JOIN message_threads t ON t.id = r.thread_id
      WHERE r.org_id = ? AND r.read_at IS NULL
      ORDER BY r.received_at DESC, r.id DESC`,
    [orgId]
  );
  const [[marks]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM message_threads WHERE org_id = ?) AS threads,
            (SELECT COALESCE(MAX(id), 0) FROM message_replies WHERE org_id = ?) AS last_reply`,
    [orgId, orgId]
  );
  return {
    count: rows.length,
    version: `${marks.threads}:${marks.last_reply}:${rows.length}`,
    latest: rows.slice(0, limit).map((row) => {
      const documentRefs = parseRefs(row.document_refs);
      return {
        ...replyView(row, documentRefs),
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

// --- sending ---------------------------------------------------------------------

async function supplierName(orgId, gstin) {
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

// sendSupplierEmail(orgId, { supplierGstin, documentRefs[], subject, body, taxPeriod?, context? })
//   -> the stored thread
export async function sendSupplierEmail(orgId, input = {}) {
  const mail = config.mail;
  if (!mail.enabled) {
    throw new ServiceError('Email is not set up on this server. Use Copy or your own mail app.', 503, 'mail_not_configured');
  }
  const documentRefs = cleanDocumentRefs(input.documentRefs);
  const body = String(input.body ?? '').trim();
  if (!body) throw new ServiceError('body must not be empty');
  if (body.length > MAX_BODY) throw new ServiceError(`body is longer than ${MAX_BODY} characters`);
  if (oneLine(input.subject).length > MAX_SUBJECT) throw new ServiceError(`subject is longer than ${MAX_SUBJECT} characters`);
  const taxPeriod = /^\d{4}-\d{2}$/.test(String(input.taxPeriod ?? '')) ? input.taxPeriod : null;
  const context = CONTEXTS.has(input.context) ? input.context : null;

  const gstin = await knownSupplierGstin(orgId, String(input.supplierGstin ?? '').toUpperCase());
  const name = await supplierName(orgId, gstin);
  const to = (await contactsByGstin(orgId)).get(gstin)?.email ?? null;
  if (!to) {
    throw new ServiceError(
      `No email address on file for ${name ?? gstin}. Add one on the Suppliers screen.`,
      409,
      'no_email'
    );
  }
  if (!mail.allowlist.includes(to.toLowerCase())) {
    throw new ServiceError(
      `${to} is not on this server's list of addresses it may email. Use Copy or your own mail app instead.`,
      403,
      'address_not_allowed'
    );
  }
  if ((await sentToday(orgId)) >= mail.dailyLimit) {
    throw new ServiceError(
      `This workspace has sent ${mail.dailyLimit} emails in the last 24 hours, the most it may. Use Copy or your own mail app.`,
      429,
      'daily_limit'
    );
  }

  const org = await orgRow(orgId);
  const traderName = traderNameOf(org) || 'ITC Guard';
  const ref = newRef();
  const defaultSubject = `${documentRefs[0]} · ${traderName}`;
  const subject = taggedSubject(ref, oneLine(input.subject) || defaultSubject);
  const messageId = `<itcg.${ref}.${randomBytes(6).toString('hex')}@${domainOf(mail.smtp.user)}>`;

  try {
    await mailTransport(mail.smtp).sendMail({
      from: { name: traderName, address: mail.smtp.user },
      to,
      subject,
      text: body,
      messageId,
      headers: { 'X-ITC-Guard-Ref': ref }
    });
  } catch (err) {
    // The SMTP server's own words can carry the account name; log the code only.
    console.error(`[mail] send failed for thread ${ref}: ${err.code ?? err.name ?? 'error'}`);
    throw new ServiceError('The email could not be sent. Try again in a minute, or use Copy.', 502, 'send_failed');
  }

  const [inserted] = await pool.query(
    `INSERT INTO message_threads
       (org_id, ref, supplier_gstin, supplier_name, document_refs, tax_period, context,
        to_address, subject, body, message_id, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [orgId, ref, gstin, name, JSON.stringify(documentRefs), taxPeriod, context, to, subject, body, messageId]
  );
  const [rows] = await pool.query('SELECT * FROM message_threads WHERE id = ?', [inserted.insertId]);
  return threadView(rows[0]);
}
