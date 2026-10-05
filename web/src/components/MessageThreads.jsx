import { formatDate, formatSentTime } from '../lib/calendar.js';
import { formatWhatsappNumber } from '../lib/phone.js';
import { Chip } from './Chip.jsx';
import { useMail, threadsFor } from './MailProvider.jsx';

// What a supplier's reply says, as the check read it. "Not checked" when there was
// no Gemini key or the check failed: the raw reply is shown either way.
export const INTENTS = Object.freeze({
  will_fix: { label: 'Will fix', tone: 'info' },
  already_fixed: { label: 'Says fixed', tone: 'ok' },
  disputes: { label: 'Disputes', tone: 'bad' },
  needs_info: { label: 'Needs info', tone: 'warn' },
  unrelated: { label: 'Unrelated', tone: 'muted' },
  unchecked: { label: 'Not checked', tone: 'neutral' }
});

const isWhatsapp = (entry) => entry?.channel === 'whatsapp';

// "Emailed" / "Sent on WhatsApp", or lower case for the middle of a line.
export function sentPhrase(thread, { lower = false } = {}) {
  if (isWhatsapp(thread)) return lower ? 'sent on WhatsApp' : 'Sent on WhatsApp';
  return lower ? 'emailed' : 'Emailed';
}

export function IntentChip({ intent }) {
  const entry = INTENTS[intent] ?? INTENTS.unchecked;
  return (
    <Chip tone={entry.tone} testId="intent-chip">
      {entry.label}
    </Chip>
  );
}

// One reply. Its text is the supplier's, untrusted: rendered as text, never HTML.
export function ReplyCard({ reply, showSupplier = false }) {
  return (
    <div className={`reply-card${reply.read ? '' : ' is-unread'}`} data-testid="reply-card">
      <div className="reply-head">
        <IntentChip intent={reply.intent} />
        {showSupplier && reply.supplierName ? <span className="strong-line">{reply.supplierName}</span> : null}
        <span className="caption">
          Replied{isWhatsapp(reply) ? ' on WhatsApp' : ''} {formatSentTime(reply.receivedAt)}
        </span>
      </div>
      {reply.flag ? (
        <div className="reply-flag" data-testid="reply-flag">
          {reply.flag}
        </div>
      ) : null}
      {reply.summary ? <div className="reply-summary">{reply.summary}</div> : null}
      {reply.promisedDate ? (
        <div className="reply-promised" data-testid="reply-promised">
          Promised by {formatDate(reply.promisedDate)}
        </div>
      ) : null}
      <div className="reply-text" data-testid="reply-text">
        {reply.text}
      </div>
    </div>
  );
}

function EmailThread({ thread }) {
  return (
    <div className="email-thread">
      <div className="email-sent" data-testid="email-sent">
        Emailed {formatSentTime(thread.sentAt)} <span className="muted">to {thread.to} · #{thread.ref}</span>
      </div>
      {thread.replies.length ? (
        thread.replies.map((reply) => <ReplyCard key={reply.id} reply={reply} />)
      ) : (
        <div className="caption">No reply yet</div>
      )}
    </div>
  );
}

// A WhatsApp thread is a conversation: every message sent on it and every reply,
// in the order they happened.
function WhatsappThread({ thread }) {
  const messages = thread.messages?.length ? thread.messages : [{ id: 0, sentAt: thread.sentAt, to: thread.to }];
  const entries = [
    ...messages.map((message) => ({ key: `m${message.id}`, at: message.sentAt, order: 0, message })),
    ...thread.replies.map((reply) => ({ key: `r${reply.id}`, at: reply.receivedAt, order: 1, reply }))
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.order - b.order);
  return (
    <div className="email-thread" data-testid="whatsapp-thread">
      {entries.map((entry) =>
        entry.message ? (
          <div className="email-sent" key={entry.key} data-testid="whatsapp-sent">
            Sent on WhatsApp {formatSentTime(entry.message.sentAt)}{' '}
            <span className="muted">
              to {formatWhatsappNumber(entry.message.to ?? thread.to)} · #{thread.ref}
            </span>
          </div>
        ) : (
          <ReplyCard key={entry.key} reply={entry.reply} />
        )
      )}
      {thread.replies.length ? null : <div className="caption">No reply yet</div>}
    </div>
  );
}

// The messages sent about a document (or to a supplier), each with its replies.
export function MessageThreads({ supplierGstin, invoiceNo = null }) {
  const { threads } = useMail();
  const mine = supplierGstin ? threadsFor(threads, supplierGstin, invoiceNo) : [];
  if (!mine.length) return null;
  return (
    <div className="email-threads" data-testid="email-threads">
      {mine.map((thread) =>
        isWhatsapp(thread) ? <WhatsappThread key={thread.id} thread={thread} /> : <EmailThread key={thread.id} thread={thread} />
      )}
    </div>
  );
}
