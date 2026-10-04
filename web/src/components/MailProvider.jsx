import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

// The workspace's supplier email: whether the server can send, every thread with
// its replies, and the unread count the bells show. Polls GET /api/messages/unread
// every 20 s and re-reads the threads only when its version changes.
//
// Without a provider (a screen rendered on its own) everything reads as "email
// off, no threads", so the Email button stays a mailto link.
const POLL_MS = 20000;

const EMPTY = Object.freeze({
  mail: null,
  threads: [],
  unread: { count: 0, latest: [] },
  send: async () => {
    throw new Error('email is not available here');
  },
  markRead: async () => {},
  reload: async () => {}
});

const MailContext = createContext(EMPTY);

export const useMail = () => useContext(MailContext);

// 'INV/2024/0891' and 'inv-2024-0891' are the same document to a reader.
export const docKey = (invoiceNo) => String(invoiceNo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function threadsFor(threads, gstin, invoiceNo = null) {
  return threads.filter(
    (thread) =>
      thread.supplierGstin === gstin &&
      (invoiceNo === null || thread.documentRefs.some((ref) => docKey(ref) === docKey(invoiceNo)))
  );
}

// Every reply on a supplier's threads (or one document's), newest first.
export function repliesFor(threads, gstin, invoiceNo = null) {
  return threadsFor(threads, gstin, invoiceNo)
    .flatMap((thread) => thread.replies.map((reply) => ({ ...reply, thread })))
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)) || b.id - a.id);
}

// The latest date a supplier promised for a document, or null.
export function promisedDateFor(threads, gstin, invoiceNo) {
  const reply = repliesFor(threads, gstin, invoiceNo).find((entry) => entry.promisedDate);
  return reply?.promisedDate ?? null;
}

export function MailProvider({ children, refreshKey = 0 }) {
  const [mail, setMail] = useState(null);
  const [threads, setThreads] = useState([]);
  const [unread, setUnread] = useState({ count: 0, latest: [] });
  const version = useRef(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const body = await api.listMessages();
      if (!alive.current || !body) return;
      setMail(body.mail ?? null);
      setThreads(body.threads ?? []);
    } catch {
      // Email is an extra: a failed read leaves the app as it was.
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const body = await api.unreadMessages();
      if (!alive.current || !body) return;
      setUnread({ count: body.count ?? 0, latest: body.latest ?? [] });
      if (body.version !== version.current) {
        version.current = body.version;
        await reload();
      }
    } catch {
      // Tried again on the next tick.
    }
  }, [reload]);

  useEffect(() => {
    alive.current = true;
    version.current = null;
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [poll, refreshKey]);

  const send = useCallback(
    async (message) => {
      const thread = await api.sendMessage(message);
      setThreads((current) => [thread, ...current.filter((entry) => entry.id !== thread.id)]);
      setMail((current) => (current ? { ...current, sentToday: (current.sentToday ?? 0) + 1 } : current));
      return thread;
    },
    []
  );

  const markRead = useCallback(
    async (gstin) => {
      const hasUnread = threadsFor(threads, gstin).some((thread) => thread.replies.some((reply) => !reply.read));
      if (!hasUnread) return;
      setThreads((current) =>
        current.map((thread) =>
          thread.supplierGstin === gstin
            ? { ...thread, replies: thread.replies.map((reply) => ({ ...reply, read: true })) }
            : thread
        )
      );
      try {
        await api.markSupplierRead(gstin);
      } finally {
        await poll();
      }
    },
    [threads, poll]
  );

  const value = useMemo(() => ({ mail, threads, unread, send, markRead, reload: poll }), [
    mail,
    threads,
    unread,
    send,
    markRead,
    poll
  ]);

  return <MailContext.Provider value={value}>{children}</MailContext.Provider>;
}
