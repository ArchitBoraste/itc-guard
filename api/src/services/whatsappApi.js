// Meta's WhatsApp Cloud API: the three calls the app makes, and Meta's errors in
// plain words. No database here.
//
//   sendTemplate(to, values, template)  the approved template, its body filled in
//   sendText(to, text)                  free text; WhatsApp allows it only within
//                                       24 h of the supplier's last message
//   fetchTemplate()                     the template's status and body text, for
//                                       the preview (cached for a few minutes)
//
// The token travels in the Authorization header and nowhere else. A failure is
// reduced to Meta's numeric error code and a sentence for the trader
// (explainGraphError); the raw response is never logged or shown.
import { config } from '../config.js';
import { ServiceError } from './ingest.js';

const GRAPH = 'https://graph.facebook.com';
const TIMEOUT_MS = 15000;
const TEMPLATE_CACHE_MS = 5 * 60 * 1000;

let fetchOverride = null;
let templateCache = null;

// Tests talk to a fake Graph API (fetch-shaped); null goes back to the real one.
export function setGraphFetch(fake) {
  fetchOverride = fake;
  templateCache = null;
}

export class GraphError extends Error {
  constructor(metaCode, { httpStatus = null, title = null } = {}) {
    super(`WhatsApp Cloud API error ${metaCode ?? httpStatus ?? title ?? 'unknown'}`);
    this.name = 'GraphError';
    this.metaCode = metaCode;
    this.httpStatus = httpStatus;
    this.title = title;
  }
}

async function graph(path, { method = 'GET', body = null } = {}) {
  const wa = config.whatsapp;
  let response;
  try {
    response = await (fetchOverride ?? fetch)(`${GRAPH}/${wa.graphVersion}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${wa.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw new GraphError(null, { title: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.error) {
    const error = payload?.error ?? {};
    throw new GraphError(Number.isInteger(error.code) ? error.code : null, { httpStatus: response.status });
  }
  return payload;
}

function wamidOf(payload) {
  const id = payload?.messages?.[0]?.id;
  if (typeof id !== 'string' || !id) throw new GraphError(null, { httpStatus: 200, title: 'no message id' });
  return id;
}

// --- sending -----------------------------------------------------------------------

// The template's body parameters: positional ({{1}}…) unless the template was made
// with named ones, which then take its names in the order the body uses them.
export function templateParameters(values, template = null) {
  const names = template?.parameterFormat === 'NAMED' ? template.parameterNames : null;
  return values.map((text, index) =>
    names && names[index] ? { type: 'text', parameter_name: names[index], text } : { type: 'text', text }
  );
}

// -> the wamid Meta returned.
export async function sendTemplate(to, values, template = null) {
  const wa = config.whatsapp;
  const payload = await graph(`${wa.phoneNumberId}/messages`, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: wa.templateName,
        language: { code: wa.templateLanguage },
        components: [{ type: 'body', parameters: templateParameters(values, template) }]
      }
    }
  });
  return wamidOf(payload);
}

// -> the wamid Meta returned.
export async function sendText(to, text) {
  const payload = await graph(`${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }
  });
  return wamidOf(payload);
}

// --- the template ------------------------------------------------------------------

function templateInfo(entry) {
  const text = (entry.components ?? []).find((component) => String(component.type).toUpperCase() === 'BODY')?.text ?? null;
  const parameterFormat = String(entry.parameter_format ?? 'POSITIONAL').toUpperCase();
  const parameterNames =
    parameterFormat === 'NAMED' && text
      ? [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]))]
      : [];
  return { name: entry.name, language: entry.language, status: entry.status ?? null, text, parameterFormat, parameterNames };
}

// The configured template as WhatsApp Manager holds it, null when the account id
// is not set, or { status: 'MISSING' } when there is no such name and language.
// Throws a GraphError when Meta cannot be asked.
export async function fetchTemplate() {
  const wa = config.whatsapp;
  if (!wa.businessAccountId) return null;
  const key = `${wa.businessAccountId}:${wa.templateName}:${wa.templateLanguage}`;
  if (templateCache?.key === key && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) return templateCache.value;
  const query = new URLSearchParams({ name: wa.templateName, fields: 'name,status,language,components,parameter_format', limit: '100' });
  const payload = await graph(`${encodeURIComponent(wa.businessAccountId)}/message_templates?${query}`);
  const entry = (payload?.data ?? []).find((item) => item.name === wa.templateName && item.language === wa.templateLanguage);
  const value = entry
    ? templateInfo(entry)
    : { name: wa.templateName, language: wa.templateLanguage, status: 'MISSING', text: null, parameterFormat: 'POSITIONAL', parameterNames: [] };
  templateCache = { key, at: Date.now(), value };
  return value;
}

// The template's body with the values in, as the supplier will read it; null
// when the body text is not known.
export function renderTemplate(template, values) {
  if (!template?.text) return null;
  if (template.parameterFormat === 'NAMED') {
    return template.text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name) => {
      const index = template.parameterNames.indexOf(name);
      return index >= 0 && values[index] !== undefined ? values[index] : whole;
    });
  }
  return template.text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, number) => values[Number(number) - 1] ?? whole);
}

// --- Meta's errors, in plain words ------------------------------------------------

// Meta's error code -> { status, code, message, short }. message is for the trader
// when a send is refused; short finishes "Failed: …" on a message whose delivery
// failed later (the webhook's status update).
export function explainGraphError(metaCode, { httpStatus = null, title = null } = {}) {
  const { templateName: name, templateLanguage: language } = config.whatsapp;
  const plain = (status, code, message, short) => ({ status, code, message, short });
  switch (metaCode) {
    case 0:
    case 190:
      return plain(502, 'whatsapp_token',
        "WhatsApp did not accept this server's access token: it has expired or is wrong. Renew WHATSAPP_TOKEN on the server; until then use Open in WhatsApp.",
        'the access token was refused');
    case 3:
    case 10:
    case 200:
      return plain(502, 'whatsapp_permission',
        "This server's access token may not send from this WhatsApp number (it needs the whatsapp_business_messaging permission).",
        'the token may not send from this number');
    case 131030:
      return plain(403, 'whatsapp_recipient_not_allowed',
        "This number is not on the Meta test number's list of allowed recipients. Add it in the Meta app under WhatsApp > API Setup, or use Open in WhatsApp.",
        "the number is not on the test number's allowed list");
    case 131047:
      return plain(409, 'whatsapp_window_closed',
        'More than 24 hours have passed since the supplier last wrote, so WhatsApp only allows the approved template.',
        'more than 24 hours since they last wrote');
    case 132001:
      return plain(502, 'whatsapp_template_not_approved',
        `WhatsApp has no approved template "${name}" in language "${language}". It may still be in review, or the name or language differs in WhatsApp Manager.`,
        'the template is not approved');
    case 132000:
    case 132012:
    case 132018:
      return plain(502, 'whatsapp_template_parameters',
        `The template "${name}" does not take the five values ITC Guard fills in (supplier, trader, invoice number, date, request). Check its variables in WhatsApp Manager.`,
        "the template's variables do not match");
    case 132015:
    case 132016:
      return plain(502, 'whatsapp_template_paused',
        `Meta has ${metaCode === 132016 ? 'disabled' : 'paused'} the template "${name}" for low quality. Check it in WhatsApp Manager.`,
        `the template is ${metaCode === 132016 ? 'disabled' : 'paused'}`);
    case 131026:
      return plain(502, 'whatsapp_undeliverable',
        'WhatsApp could not deliver to this number: it may not use WhatsApp. Call the supplier, or use Copy.',
        'WhatsApp could not deliver it (the number may not use WhatsApp)');
    case 131049:
    case 131050:
      return plain(502, 'whatsapp_not_delivered',
        'WhatsApp chose not to deliver this message. Try again later, or use Open in WhatsApp.',
        'WhatsApp chose not to deliver it');
    case 4:
    case 80007:
    case 130429:
    case 131048:
    case 131056:
      return plain(429, 'whatsapp_rate_limited',
        'WhatsApp is limiting how fast this number can send. Try again in a few minutes.',
        'WhatsApp limited how fast this number can send');
    case 133010:
      return plain(502, 'whatsapp_number_not_registered',
        "The business phone number is not registered on WhatsApp's platform yet. Register it in the Meta app.",
        'the business number is not registered');
    case 131031:
    case 131042:
      return plain(502, 'whatsapp_account_restricted',
        `Meta has restricted this WhatsApp account (Meta error ${metaCode}). Check WhatsApp Manager.`,
        'the WhatsApp account is restricted');
    default:
      break;
  }
  if (metaCode === null && httpStatus === 401) return explainGraphError(190);
  if (metaCode === null && title === 'no message id') {
    return plain(502, 'whatsapp_unconfirmed', 'WhatsApp did not confirm the message. Check with the supplier before sending it again.', 'not confirmed by WhatsApp');
  }
  if (metaCode === null && !httpStatus) {
    return plain(502, 'whatsapp_unreachable', 'Could not reach WhatsApp. Try again in a minute, or use Open in WhatsApp.', 'WhatsApp could not be reached');
  }
  const which = metaCode ?? `HTTP ${httpStatus}`;
  return plain(502, 'whatsapp_send_failed',
    `WhatsApp refused the message (Meta error ${which}). Try again, or use Open in WhatsApp.`,
    title ? `${String(title).slice(0, 120)} (Meta error ${which})` : `Meta error ${which}`);
}

// A GraphError -> the ServiceError the route answers with. Logs the code only.
export function graphFailure(err, what = 'send') {
  if (!(err instanceof GraphError)) throw err;
  console.error(`[whatsapp] ${what} failed: Meta error ${err.metaCode ?? '-'} (HTTP ${err.httpStatus ?? '-'}${err.title ? `, ${err.title}` : ''})`);
  const plain = explainGraphError(err.metaCode, err);
  return new ServiceError(plain.message, plain.status, plain.code);
}
