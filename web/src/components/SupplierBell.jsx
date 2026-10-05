import { useEffect, useId, useRef, useState } from 'react';
import { formatDate, formatSentTime } from '../lib/calendar.js';
import { Icon } from './Icon.jsx';
import { ReplyCard, sentPhrase } from './MessageThreads.jsx';
import { promisedDateFor, repliesFor, threadsFor, useMail } from './MailProvider.jsx';

// Supplier replies where the trader works: a bell on each supplier's row (once
// they have been emailed or sent a WhatsApp from the app), one in the top bar, and
// the date a supplier promised under a document's status.

// Closes on Escape or a click outside, and hands focus back to the bell.
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const button = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (wrap.current && !wrap.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, wrap, button };
}

// The bell on a supplier's row. Nothing until the supplier has been messaged; a dot
// while a reply is unread. Opening it marks the supplier's replies read.
export function SupplierBell({ gstin, name = null, align = 'left' }) {
  const { threads, markRead } = useMail();
  const { open, setOpen, wrap, button } = usePopover();
  const popoverId = useId();
  const mine = gstin ? threadsFor(threads, gstin) : [];
  if (!mine.length) return null;
  const replies = repliesFor(threads, gstin);
  const unread = replies.some((reply) => !reply.read);
  const who = name ?? 'this supplier';

  const toggle = (event) => {
    event.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next && unread) markRead(gstin);
  };

  return (
    <span className="bell-wrap" ref={wrap} onClick={(event) => event.stopPropagation()}>
      <button
        ref={button}
        type="button"
        className={`bell-button${unread ? ' has-unread' : ''}`}
        aria-label={`Replies from ${who}${unread ? ' (unread)' : ''}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggle}
        data-testid="supplier-bell"
        data-unread={unread ? 'true' : 'false'}
      >
        <Icon name="bell" size={15} />
        {unread ? <span className="bell-dot" aria-hidden="true" data-testid="bell-dot" /> : null}
      </button>
      {open ? (
        <div
          className={`bell-popover${align === 'right' ? ' align-right' : ''}`}
          id={popoverId}
          role="dialog"
          aria-label={`Replies from ${who}`}
          data-testid="bell-popover"
        >
          <div className="bell-popover-title">Replies from {who}</div>
          {replies.length ? (
            replies.map((reply) => (
              <div key={reply.id}>
                <div className="caption">
                  About {reply.thread.documentRefs.join(', ')} · {sentPhrase(reply.thread, { lower: true })}{' '}
                  {formatSentTime(reply.thread.sentAt)}
                </div>
                <ReplyCard reply={reply} />
              </div>
            ))
          ) : (
            mine.map((thread) => (
              <div key={thread.id} className="caption">
                {sentPhrase(thread)} {formatSentTime(thread.sentAt)} about {thread.documentRefs.join(', ')} · no reply yet
              </div>
            ))
          )}
        </div>
      ) : null}
    </span>
  );
}

// The top bar's bell: how many replies are unread, and the latest of them. A click
// on one goes to its row.
export function TopBarBell({ onOpenReply }) {
  const { unread } = useMail();
  const { open, setOpen, wrap, button } = usePopover();
  const popoverId = useId();
  const count = unread.count ?? 0;

  return (
    <span className="bell-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`bell-button${count ? ' has-unread' : ''}`}
        aria-label={count ? `${count} unread supplier repl${count === 1 ? 'y' : 'ies'}` : 'Supplier replies'}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen(!open)}
        data-testid="topbar-bell"
      >
        <Icon name="bell" size={16} />
        {count ? (
          <span className="bell-count" data-testid="topbar-bell-count">
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="bell-popover align-right" id={popoverId} role="dialog" aria-label="Supplier replies" data-testid="topbar-bell-popover">
          <div className="bell-popover-title">{count ? 'Unread replies' : 'No unread replies'}</div>
          {unread.latest.map((reply) => (
            <button
              key={reply.id}
              type="button"
              className="bell-item"
              onClick={() => {
                setOpen(false);
                onOpenReply?.(reply);
              }}
              data-testid="topbar-bell-item"
            >
              <div className="caption">About {reply.documentRefs.join(', ')}</div>
              <ReplyCard reply={reply} showSupplier />
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// "Promised by 9 Oct 2026" under a document's status, once the supplier said so.
export function PromisedLine({ gstin, invoiceNo }) {
  const { threads } = useMail();
  const date = gstin ? promisedDateFor(threads, gstin, invoiceNo) : null;
  if (!date) return null;
  return (
    <div className="promised-line" data-testid="promised-line">
      Promised by {formatDate(date)}
    </div>
  );
}

// Scrolls a row into view once the screen has drawn it.
export function scrollToSelector(selector) {
  setTimeout(() => {
    const node = document.querySelector(selector);
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 80);
}
