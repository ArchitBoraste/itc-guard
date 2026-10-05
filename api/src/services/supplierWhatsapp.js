// Supplier WhatsApp sent from the app through Meta's WhatsApp Cloud API: the
// whatsapp channel of services/messageThreads.js.
//
// Off unless WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE_NAME
// are set: the WhatsApp button then stays a wa.me link. When on:
//   * the number is the supplier's contact phone AT SEND TIME (an Indian mobile,
//     E.164), and the thread keeps the number it went to;
//   * only numbers in WHATSAPP_ALLOWLIST receive anything (403), and the daily
//     limit is the one email counts against too (429);
//   * a send continues the latest thread to the same number about the same
//     documents, else starts one. WhatsApp lets a business write first only with
//     an approved template, so a thread opens with WHATSAPP_TEMPLATE_NAME and five
//     values: whom, from whom, the invoice number, its date and the ask (one
//     sentence from services/supplierMessages.js). Once the supplier has written
//     on that thread in the last 24 hours the full message goes as plain text;
//   * the wamid Meta returns is stored on the message. A swipe-reply carries it as
//     context.id, and the delivery statuses name it (services/whatsappWebhook.js).
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { contactsByGstin, knownSupplierGstin, whatsappNumber } from './supplierContacts.js';
import { addressName, formatDate, traderNameOf, whatsappParam } from './supplierMessages.js';
import {
  CHANNELS,
  addSend,
  cleanContext,
  cleanDocumentRefs,
  cleanTaxPeriod,
  createThread,
  docKey,
  documentRefsOf,
  getThread,
  isoUtc,
  newRef,
  orgRow,
  sentToday,
  supplierName
} from './messageThreads.js';
import {
  GraphError,
  fetchTemplate,
  graphFailure,
  renderTemplate,
  sendTemplate,
  sendText
} from './whatsappApi.js';
import { ServiceError } from './ingest.js';

// WhatsApp's own limit on a text message.
const MAX_TEXT = 4096;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ASK = 'Please check how it appears on the GST portal and reply here.';

// '+919876543210' -> '+91 98765 43210'
export const displayNumber = (e164) => {
  const digits = String(e164 ?? '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : String(e164 ?? '');
};

// The template's five values, in its order: whom, from whom, the invoice number,
// its date, the ask. Each one line, as Meta requires.
export function templateValues({ person, traderName, documentRefs, invoiceDate, ask }) {
  return [
    whatsappParam(addressName(person) ?? 'there', 60),
    whatsappParam(traderName || 'ITC Guard', 100),
    whatsappParam(documentRefs.join(', '), 100),
    whatsappParam(formatDate(invoiceDate), 40),
    whatsappParam(ask, 200) || DEFAULT_ASK
  ];
}

export async function whatsappStatus(orgId) {
  const wa = config.whatsapp;
  return {
    enabled: wa.enabled,
    dailyLimit: wa.dailyLimit,
    sentToday: wa.enabled ? await sentToday(orgId) : 0
  };
}

// The latest thread to this number about exactly these documents, or null.
async function continuingThread(orgId, gstin, to, documentRefs) {
  const [rows] = await pool.query(
    `SELECT * FROM message_threads
      WHERE org_id = ? AND channel = ? AND supplier_gstin = ? AND to_address = ?
      ORDER BY id DESC LIMIT 50`,
    [orgId, CHANNELS.WHATSAPP, gstin, to]
  );
  const key = (refs) => refs.map(docKey).sort().join('|');
  const wanted = key(documentRefs);
  return rows.find((row) => key(documentRefsOf(row)) === wanted) ?? null;
}

async function lastReplyAt(threadId) {
  const [rows] = await pool.query('SELECT MAX(received_at) AS at FROM message_replies WHERE thread_id = ?', [threadId]);
  return rows[0].at ? new Date(isoUtc(rows[0].at)) : null;
}

// The document's date from the books, else the portal (a phantom is only there,
// possibly under a mistyped GSTIN of this supplier).
async function invoiceDateOf(orgId, gstin, invoiceNo) {
  const [rows] = await pool.query(
    `SELECT invoice_date FROM (
       SELECT invoice_date, tax_period FROM expected_invoices
        WHERE org_id = ? AND supplier_gstin = ? AND invoice_no = ?
       UNION ALL
       SELECT invoice_date, tax_period FROM portal_records
        WHERE org_id = ? AND invoice_no = ?
          AND (supplier_gstin = ? OR supplier_gstin IN
                (SELECT alias_gstin FROM supplier_gstin_aliases WHERE org_id = ? AND gstin = ?))
     ) found ORDER BY tax_period DESC LIMIT 1`,
    [orgId, gstin, invoiceNo, orgId, invoiceNo, gstin, orgId, gstin]
  );
  return rows[0]?.invoice_date ?? null;
}

// Everything a send needs, checked: who, which thread, template or text.
async function planSend(orgId, input) {
  const wa = config.whatsapp;
  if (!wa.enabled) {
    throw new ServiceError('WhatsApp is not set up on this server. Use Open in WhatsApp instead.', 503, 'whatsapp_not_configured');
  }
  const documentRefs = cleanDocumentRefs(input.documentRefs);
  const body = String(input.body ?? '').trim();
  if (!body) throw new ServiceError('body must not be empty');
  if (body.length > MAX_TEXT) throw new ServiceError(`body is longer than ${MAX_TEXT} characters, the most WhatsApp takes`);

  const gstin = await knownSupplierGstin(orgId, String(input.supplierGstin ?? '').toUpperCase());
  const name = await supplierName(orgId, gstin);
  const contact = (await contactsByGstin(orgId)).get(gstin) ?? null;
  const digits = whatsappNumber(contact?.phone);
  if (!digits) {
    throw new ServiceError(
      contact?.phone
        ? `${contact.phone} on file for ${name ?? gstin} is not an Indian mobile number. Correct it on the Suppliers screen.`
        : `No mobile number on file for ${name ?? gstin}. Add one on the Suppliers screen.`,
      409,
      'no_whatsapp'
    );
  }
  const to = `+${digits}`;
  if (!wa.allowlist.includes(digits)) {
    throw new ServiceError(
      `${displayNumber(to)} is not on this server's list of numbers it may message on WhatsApp. Use Open in WhatsApp instead.`,
      403,
      'number_not_allowed'
    );
  }
  if ((await sentToday(orgId)) >= wa.dailyLimit) {
    throw new ServiceError(
      `This workspace has sent ${wa.dailyLimit} messages in the last 24 hours, the most it may. Use Open in WhatsApp instead.`,
      429,
      'daily_limit'
    );
  }

  const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.invoiceDate ?? ''))
    ? input.invoiceDate
    : await invoiceDateOf(orgId, gstin, documentRefs[0]);
  if (!invoiceDate) throw new ServiceError('invoiceDate (yyyy-mm-dd) is required: the document is not in the books or on the portal');

  const traderName = traderNameOf(await orgRow(orgId)) || 'ITC Guard';
  const thread = await continuingThread(orgId, gstin, to, documentRefs);
  const replied = thread ? await lastReplyAt(thread.id) : null;
  return {
    gstin,
    name,
    to,
    digits,
    documentRefs,
    body,
    traderName,
    thread,
    // Plain text only while the supplier's own last message is under 24 hours old.
    format: replied && Date.now() - replied.getTime() < WINDOW_MS ? 'text' : 'template',
    values: templateValues({ person: contact.person, traderName, documentRefs, invoiceDate, ask: input.ask })
  };
}

// The template as Meta holds it, or null when it cannot be read: the send goes
// ahead positionally and Meta's answer decides.
async function templateOrNull() {
  try {
    return await fetchTemplate();
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;
    console.error(`[whatsapp] template read failed: Meta error ${err.metaCode ?? '-'} (HTTP ${err.httpStatus ?? '-'})`);
    return null;
  }
}

// When the template's text is unknown, what was sent is recorded by its values.
const templateRecord = (template, values) =>
  renderTemplate(template, values) ?? `Template "${config.whatsapp.templateName}": ${values.join(' · ')}`;

// What the confirm dialog shows before the trader sends:
//   { to, format: 'template' | 'text', text, templateName, templateStatus, threadRef }
// text is null when the template's body could not be read; values are then shown.
export async function previewSupplierWhatsapp(orgId, input = {}) {
  const plan = await planSend(orgId, input);
  const template = plan.format === 'template' ? await templateOrNull() : null;
  return {
    to: plan.to,
    toDisplay: displayNumber(plan.to),
    format: plan.format,
    text: plan.format === 'text' ? plan.body : renderTemplate(template, plan.values),
    values: plan.format === 'template' ? plan.values : null,
    templateName: config.whatsapp.templateName,
    templateStatus: template?.status ?? null,
    threadRef: plan.thread?.ref ?? null
  };
}

// sendSupplierWhatsapp(orgId, { supplierGstin, documentRefs[], body, ask?, invoiceDate?,
//                               taxPeriod?, context? }) -> the stored thread
export async function sendSupplierWhatsapp(orgId, input = {}) {
  const plan = await planSend(orgId, input);
  let format = plan.format;
  let wamid = null;
  let sent = null;

  if (format === 'text') {
    try {
      wamid = await sendText(plan.digits, plan.body);
      sent = plan.body;
    } catch (err) {
      // Meta's clock said the 24 hours were up: the template is still allowed.
      if (!(err instanceof GraphError) || err.metaCode !== 131047) throw graphFailure(err);
      format = 'template';
    }
  }
  if (format === 'template') {
    const template = await templateOrNull();
    try {
      wamid = await sendTemplate(plan.digits, plan.values, template);
    } catch (err) {
      throw graphFailure(err);
    }
    sent = templateRecord(template, plan.values);
  }

  if (plan.thread) {
    await addSend(plan.thread, { format, body: sent, externalId: wamid });
    return getThread(plan.thread.id);
  }
  const threadId = await createThread(
    {
      orgId,
      ref: newRef(),
      channel: CHANNELS.WHATSAPP,
      supplierGstin: plan.gstin,
      supplierName: plan.name,
      documentRefs: plan.documentRefs,
      taxPeriod: cleanTaxPeriod(input.taxPeriod),
      context: cleanContext(input.context),
      to: plan.to,
      subject: `${plan.documentRefs[0]} · ${plan.traderName}`,
      body: plan.body
    },
    { format, body: sent, externalId: wamid }
  );
  return getThread(threadId);
}
