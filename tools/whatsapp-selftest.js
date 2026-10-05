// whatsapp-selftest.js — sends one real WhatsApp through Meta's Cloud API, without
// the database.
//
//   npm run whatsapp:selftest [-- 919356742616]
//   (in the prod container: node /app/tools/whatsapp-selftest.js)
//
// The message is the one the app writes about the demo's MS-878 from Mahavir Sales
// (the portal shows less tax than the books), to the number given, else the first
// number on WHATSAPP_ALLOWLIST; like the app, it sends to allowlisted numbers only.
// WHATSAPP_FIRST_MESSAGE decides how it goes, as in the app:
//   text      the full message as free text. WhatsApp delivers it only within 24
//             hours of the recipient's last message to the business number.
//   template  WHATSAPP_TEMPLATE_NAME (WHATSAPP_TEMPLATE_LANG) with its five values,
//             after reading the template's status from WhatsApp Manager.
//
// Prints the wamid, or Meta's error in plain words. Delivery is reported later by
// the webhook, which cannot reach a laptop: look at the phone. Never prints the
// token, the app secret, the verify token or the whole number. Exits 1 on failure.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../api/src/config.js';
import { MESSAGE_KINDS, supplierMessage } from '../api/src/services/supplierMessages.js';
import { templateValues } from '../api/src/services/supplierWhatsapp.js';
import {
  GraphError,
  explainGraphError,
  fetchTemplate,
  renderTemplate,
  sendTemplate,
  sendText
} from '../api/src/services/whatsappApi.js';
import { PORTAL, REGISTER } from './demo-timeline.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTACTS = join(REPO_ROOT, 'fixtures', 'demo', 'contacts.local.json');
const TRADER_NAME = 'Sharma Electronics';
const INVOICE_NO = 'MS-878';

const ok = (text) => console.log(`  ok    ${text}`);
const bad = (text) => console.log(`  FAIL  ${text}`);
const note = (text) => console.log(`  note  ${text}`);

// '919356742616' -> '+91 ••••• •2616'
const masked = (digits) => `+${digits.slice(0, 2)} ••••• •${digits.slice(-4)}`;

function settings(wa) {
  const required = [
    ['WHATSAPP_TOKEN', wa.token],
    ['WHATSAPP_PHONE_NUMBER_ID', wa.phoneNumberId],
    ['WHATSAPP_ALLOWLIST', wa.allowlist.length ? 'x' : '']
  ];
  if (wa.firstMessage === 'template') required.push(['WHATSAPP_TEMPLATE_NAME', wa.templateName]);
  let missing = 0;
  for (const [name, value] of required) {
    if (value) {
      ok(`${name} is set`);
    } else {
      bad(`${name} is not set`);
      missing += 1;
    }
  }
  for (const [name, value] of [['WHATSAPP_APP_SECRET', wa.appSecret], ['WHATSAPP_VERIFY_TOKEN', wa.verifyToken]]) {
    if (value) ok(`${name} is set`);
    else note(`${name} is not set: replies and delivery ticks need it once deployed`);
  }
  return missing === 0;
}

// The message the app shows for MS-878 in August, from the demo timeline.
function ms878Message(person) {
  const books = Object.values(REGISTER).flat().find((entry) => entry.invoiceNo === INVOICE_NO);
  const portal = PORTAL.find((entry) => entry.period === 'aug' && entry.invoiceNo === INVOICE_NO).events.at(-1).amounts;
  const facts = {
    traderName: TRADER_NAME,
    contact: { person },
    docType: books.docType,
    invoiceNo: INVOICE_NO,
    invoiceDate: books.invoiceDate,
    taxPeriod: '2026-08',
    scheme: 'MONTHLY',
    cutOffDate: '2026-09-11',
    books: { taxableValue: books.amounts.taxable, totalTax: books.amounts.totalTax },
    portal: { invoiceNo: INVOICE_NO, taxableValue: portal.taxable, totalTax: portal.totalTax },
    decided: null
  };
  return { supplier: books.supplier.name, message: supplierMessage(MESSAGE_KINDS.PORTAL_LOWER, facts) };
}

// The contact person the demo-local register carries for Mahavir, if any.
function contactPerson(supplierName) {
  if (!existsSync(CONTACTS)) return null;
  try {
    return JSON.parse(readFileSync(CONTACTS, 'utf8')).suppliers?.[supplierName]?.contactPerson || null;
  } catch {
    return null;
  }
}

function explain(err) {
  if (!(err instanceof GraphError)) throw err;
  const plain = explainGraphError(err.metaCode, err);
  bad(`Meta error ${err.metaCode ?? (err.httpStatus ? `HTTP ${err.httpStatus}` : err.title)}: ${plain.message}`);
}

async function main() {
  const wa = config.whatsapp;
  console.log(`WhatsApp self-test (Graph API ${wa.graphVersion}, first message: ${wa.firstMessage})`);
  if (!settings(wa)) return 1;

  const argument = (process.argv[2] ?? '').replace(/\D/g, '');
  const to = argument || wa.allowlist[0];
  if (!wa.allowlist.includes(to)) {
    bad(`${masked(to)} is not on WHATSAPP_ALLOWLIST; the app would refuse it too`);
    return 1;
  }
  ok(`to ${masked(to)}${argument ? '' : ' (first on WHATSAPP_ALLOWLIST)'}`);

  const { supplier } = ms878Message(null);
  const person = contactPerson(supplier);
  const { message } = ms878Message(person);
  ok(`about ${INVOICE_NO} from ${supplier}: ${message.ask}`);

  try {
    if (wa.firstMessage === 'text') {
      const wamid = await sendText(to, message.text);
      ok(`sent the full message as free text, wamid ${wamid}`);
      note('WhatsApp delivers free text only within 24 hours of your last message to the business number.');
      note('If nothing arrives, that window is closed: message the business number, then run this again.');
    } else {
      let template = null;
      try {
        template = await fetchTemplate();
        if (!template) note('WHATSAPP_BUSINESS_ACCOUNT_ID is not set: the template status cannot be read');
        else if (template.status === 'APPROVED') ok(`template ${wa.templateName} (${wa.templateLanguage}) is APPROVED`);
        else note(`template ${wa.templateName} (${wa.templateLanguage}) is ${template.status}: Meta will refuse it until approved`);
      } catch (err) {
        if (!(err instanceof GraphError)) throw err;
        note(`could not read the template (Meta error ${err.metaCode ?? err.httpStatus ?? err.title}); sending anyway`);
      }
      const values = templateValues({
        person,
        traderName: TRADER_NAME,
        documentRefs: [INVOICE_NO],
        invoiceDate: message.invoiceDate,
        ask: message.ask
      });
      const wamid = await sendTemplate(to, values, template);
      ok(`sent the template, wamid ${wamid}`);
      const text = renderTemplate(template, values);
      if (text) note(`it reads: ${text}`);
    }
  } catch (err) {
    explain(err);
    return 1;
  }
  console.log('Check the phone: the message should arrive within a minute.');
  return 0;
}

// exitCode, not exit(): on Windows, process.exit() while fetch's sockets are still
// closing trips a libuv assertion and the exit status is lost.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`self-test crashed: ${err.name ?? 'error'}`);
    process.exitCode = 1;
  });
