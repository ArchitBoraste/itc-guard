import { useEffect, useRef, useState } from 'react';
import { formatSentTime } from '../lib/calendar.js';
import { ComposeDialog } from './ComposeDialog.jsx';
import { MessageThreads } from './MessageThreads.jsx';
import { WhatsAppDialog } from './WhatsAppDialog.jsx';
import { useMail } from './MailProvider.jsx';

// The message to a supplier, built by the server (services/supplierMessages.js),
// with the ways to send it. Copy puts the text on the clipboard. Email and
// WhatsApp send from the app when the server is set up for them
// (services/supplierEmail.js, services/supplierWhatsapp.js) and the panel knows
// which supplier and documents the message is about; otherwise they open the
// trader's own mail app (mailto) and WhatsApp (wa.me).
export function contactLine(contact) {
  if (!contact) return null;
  return [contact.person, contact.phone, contact.email].filter(Boolean).join(' · ') || null;
}

export function mailtoHref(contact, message) {
  if (!contact?.email || !message) return null;
  const params = new URLSearchParams({ subject: message.subject ?? '', body: message.text });
  // URLSearchParams writes spaces as "+", which mail apps show literally.
  return `mailto:${contact.email}?${params.toString().replace(/\+/g, '%20')}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'absolute';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  document.body.removeChild(area);
}

// The email body: the message, then how to reach the trader back.
export function emailBody(message, traderPhone) {
  return traderPhone ? `${message.text}

Reply here or on WhatsApp ${traderPhone}` : message.text;
}

// A control that cannot be used here, still focusable so its reason is reachable.
function Unavailable({ children, reason }) {
  return (
    <button type="button" className="btn" aria-disabled="true" title={reason} aria-label={`${children} (${reason})`}>
      {children}
    </button>
  );
}

export function MessagePanel({
  title = 'Message to supplier',
  contact = null,
  message,
  card = false,
  noContactText = 'No contact on file',
  headingLevel = 3,
  testId = 'message-panel',
  // For sending from the app: who and what the message is about.
  supplierGstin = null,
  documentRefs = null,
  taxPeriod = null,
  context = null
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(null);
  const [composing, setComposing] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [sent, setSent] = useState(null);
  const timer = useRef(null);
  const { mail, whatsapp, send, preview } = useMail();

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!message) return null;
  const Heading = `h${headingLevel}`;
  const line = contactLine(contact);
  const mailto = mailtoHref(contact, message);
  const refs = (documentRefs ?? []).filter(Boolean);
  const inApp = Boolean(mail?.enabled && contact?.email && supplierGstin && refs.length);
  const whatsappInApp = Boolean(whatsapp?.enabled && contact?.whatsapp && supplierGstin && refs.length);
  const whatsappRequest = {
    channel: 'whatsapp',
    supplierGstin,
    documentRefs: refs,
    body: message.text,
    ask: message.ask ?? null,
    invoiceDate: message.invoiceDate ?? null,
    taxPeriod,
    context
  };

  const sendEmail = async ({ subject, body }) => {
    const thread = await send({ supplierGstin, documentRefs: refs, subject, body, taxPeriod, context });
    setSent(`Emailed ${formatSentTime(thread.sentAt)}`);
    setComposing(false);
  };

  const sendWhatsapp = async () => {
    const thread = await send(whatsappRequest);
    setSent(`Sent on WhatsApp ${formatSentTime(thread.messages?.at(-1)?.sentAt ?? thread.sentAt)}`);
    setWhatsappOpen(false);
  };

  const copy = async () => {
    setCopyError(null);
    try {
      await copyText(message.text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Could not copy. Select the text and copy it yourself.');
    }
  };

  return (
    <section
      className={`message-panel${card ? ' card is-card' : ''}`}
      aria-label={title}
      data-testid={testId}
      data-kind={message.kind}
    >
      <div className="message-head">
        <Heading className="message-title">{title}</Heading>
        {line ? (
          <div className="message-contact">{line}</div>
        ) : (
          <div className="message-contact bad-text">{noContactText}</div>
        )}
      </div>
      <div className="message-text" data-testid="message-text">
        {message.text}
      </div>
      <div className="button-row">
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {whatsappInApp ? (
          <button type="button" className="btn" onClick={() => setWhatsappOpen(true)} data-testid="whatsapp-button">
            WhatsApp
          </button>
        ) : message.whatsappUrl ? (
          <a className="btn" href={message.whatsappUrl} target="_blank" rel="noopener noreferrer">
            WhatsApp
          </a>
        ) : (
          <Unavailable reason={contact?.phone ? 'WhatsApp needs an Indian mobile number' : 'No mobile number on file'}>
            WhatsApp
          </Unavailable>
        )}
        {inApp ? (
          <button type="button" className="btn" onClick={() => setComposing(true)} data-testid="email-button">
            Email
          </button>
        ) : mailto ? (
          <a className="btn" href={mailto}>
            Email
          </a>
        ) : (
          <Unavailable reason="No email address on file">Email</Unavailable>
        )}
        <span className="caption" aria-live="polite">
          {copied ? 'Message copied' : copyError ?? sent ?? ''}
        </span>
      </div>
      <MessageThreads supplierGstin={supplierGstin} invoiceNo={refs[0] ?? null} />
      {inApp ? (
        <ComposeDialog
          open={composing}
          to={contact.email}
          fromName={mail.fromName}
          initialSubject={`${refs[0]} · ${mail.fromName ?? ''}`.replace(/ · $/, '')}
          initialBody={emailBody(message, mail.traderPhone)}
          onSend={sendEmail}
          onCancel={() => setComposing(false)}
        />
      ) : null}
      {whatsappInApp ? (
        <WhatsAppDialog
          open={whatsappOpen}
          request={whatsappRequest}
          contactName={contact.person}
          fallbackUrl={message.whatsappUrl}
          preview={preview}
          onSend={sendWhatsapp}
          onCancel={() => setWhatsappOpen(false)}
        />
      ) : null}
    </section>
  );
}
