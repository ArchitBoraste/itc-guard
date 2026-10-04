import { useEffect, useRef, useState } from 'react';

// The message to a supplier, built by the server (services/supplierMessages.js),
// with the ways to send it. Nothing is sent from here: Copy puts the text on the
// clipboard, WhatsApp and Email open the trader's own app with it filled in.
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
  testId = 'message-panel'
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!message) return null;
  const Heading = `h${headingLevel}`;
  const line = contactLine(contact);
  const mailto = mailtoHref(contact, message);

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
        {message.whatsappUrl ? (
          <a className="btn" href={message.whatsappUrl} target="_blank" rel="noopener noreferrer">
            WhatsApp
          </a>
        ) : (
          <Unavailable reason={contact?.phone ? 'WhatsApp needs an Indian mobile number' : 'No mobile number on file'}>
            WhatsApp
          </Unavailable>
        )}
        {mailto ? (
          <a className="btn" href={mailto}>
            Email
          </a>
        ) : (
          <Unavailable reason="No email address on file">Email</Unavailable>
        )}
        <span className="caption" aria-live="polite">
          {copied ? 'Message copied' : copyError ?? ''}
        </span>
      </div>
    </section>
  );
}
