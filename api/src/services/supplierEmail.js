// Supplier email sent from the app: the email channel of services/messageThreads.js.
//
// Off unless SMTP_HOST, SMTP_USER and SMTP_PASS are set: the Email button then
// stays a mailto link. When on:
//   * the To is the supplier's contact AT SEND TIME (supplier_contacts, latest
//     register or PUT wins), and the thread keeps the address it went to;
//   * only addresses in EMAIL_ALLOWLIST receive anything (403 otherwise), and a
//     workspace sends at most MESSAGE_DAILY_LIMIT (30) a day, email and WhatsApp
//     together (429);
//   * every subject carries a tag, "[ITC Guard #K7Q2XM]", and every message our
//     own Message-ID, the two ways services/mailInbox.js finds a reply's thread.
//
// Every send is a thread of its own, with one message.
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { contactsByGstin, knownSupplierGstin } from './supplierContacts.js';
import { traderNameOf } from './supplierMessages.js';
import {
  CHANNELS,
  cleanContext,
  cleanDocumentRefs,
  cleanTaxPeriod,
  createThread,
  getThread,
  newRef,
  orgRow,
  sentToday,
  supplierName
} from './messageThreads.js';
import { ServiceError } from './ingest.js';

export const SUBJECT_TAG = /\[ITC Guard #([A-Z2-9]{6})\]/;

const MAX_SUBJECT = 300;
const MAX_BODY = 20000;

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

const oneLine = (text) => String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

// The subject the trader typed, with any tag of ours removed: the server adds it.
export function taggedSubject(ref, subject) {
  return `[ITC Guard #${ref}] ${oneLine(subject).replace(SUBJECT_TAG, '').trim()}`.slice(0, 500);
}

const domainOf = (address) => String(address).split('@')[1] || 'itc-guard.local';

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

// --- sending ---------------------------------------------------------------------

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
      `This workspace has sent ${mail.dailyLimit} messages in the last 24 hours, the most it may. Use Copy or your own mail app.`,
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

  const threadId = await createThread(
    {
      orgId,
      ref,
      channel: CHANNELS.EMAIL,
      supplierGstin: gstin,
      supplierName: name,
      documentRefs,
      taxPeriod: cleanTaxPeriod(input.taxPeriod),
      context: cleanContext(input.context),
      to,
      subject,
      body
    },
    { format: 'email', body, externalId: messageId }
  );
  return getThread(threadId);
}
