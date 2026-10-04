import { formatDate, formatSentTime } from '../lib/calendar.js';
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
        <span className="caption">Replied {formatSentTime(reply.receivedAt)}</span>
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

// The emails sent about a document (or to a supplier), each with its replies.
export function EmailThreads({ supplierGstin, invoiceNo = null }) {
  const { threads } = useMail();
  const mine = supplierGstin ? threadsFor(threads, supplierGstin, invoiceNo) : [];
  if (!mine.length) return null;
  return (
    <div className="email-threads" data-testid="email-threads">
      {mine.map((thread) => (
        <div className="email-thread" key={thread.id}>
          <div className="email-sent" data-testid="email-sent">
            Emailed {formatSentTime(thread.sentAt)} <span className="muted">to {thread.to} · #{thread.ref}</span>
          </div>
          {thread.replies.length ? (
            thread.replies.map((reply) => <ReplyCard key={reply.id} reply={reply} />)
          ) : (
            <div className="caption">No reply yet</div>
          )}
        </div>
      ))}
    </div>
  );
}
