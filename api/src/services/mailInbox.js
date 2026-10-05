// Replies to supplier email, read from the trader's mailbox.
//
// One IMAP poller per API process (started in index.js, never by importing the
// app), every IMAP_POLL_SECONDS (30): UNSEEN mail in INBOX from the last few days.
// A mail finds its thread by In-Reply-To / References against our Message-IDs,
// else by the "[ITC Guard #<ref>]" tag in its subject, and goes to that thread's
// workspace. A matched mail is stored once (by its own Message-ID), checked
// (services/replyCheck.js) and marked seen; anything else is left exactly as it
// was. Errors back off and are logged by code only; the API never goes down for
// the mailbox. Off when SMTP or IMAP is not configured.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { newReplyText } from './replyText.js';
import { SUBJECT_TAG } from './supplierEmail.js';
import { checkReply } from './replyCheck.js';
import { CHANNELS, storeReply } from './messageThreads.js';

const LOOKBACK_DAYS = 3;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const OWN_MESSAGE_ID = /^<itcg\.[A-Z2-9]{6}\./;

// --- matching a mail to its thread (exported for tests) ------------------------------

function referencedIds(parsed) {
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : String(parsed.references ?? '').split(/\s+/);
  return [parsed.inReplyTo, ...refs]
    .flatMap((value) => String(value ?? '').match(/<[^<>\s]+>/g) ?? [])
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 50);
}

export async function findThread(parsed) {
  const ids = referencedIds(parsed);
  if (ids.length) {
    const [rows] = await pool.query(
      'SELECT * FROM message_threads WHERE channel = ? AND message_id IN (?) ORDER BY id DESC LIMIT 1',
      [CHANNELS.EMAIL, ids]
    );
    if (rows.length) return rows[0];
  }
  const tag = SUBJECT_TAG.exec(String(parsed.subject ?? ''));
  if (!tag) return null;
  const [rows] = await pool.query('SELECT * FROM message_threads WHERE channel = ? AND ref = ?', [CHANNELS.EMAIL, tag[1]]);
  return rows[0] ?? null;
}

// handleIncoming(parsed mail) -> 'stored' | 'duplicate' | 'own' | 'unmatched'.
// 'stored' and 'duplicate' are ours to mark seen; the rest are left alone.
export async function handleIncoming(parsed, { check = checkReply } = {}) {
  if (OWN_MESSAGE_ID.test(String(parsed.messageId ?? ''))) return 'own';
  const thread = await findThread(parsed);
  if (!thread) return 'unmatched';

  const receivedAt = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date();
  return storeReply(
    thread,
    {
      externalId: parsed.messageId ?? null,
      from: parsed.from?.value?.[0]?.address ?? null,
      receivedAt,
      text: newReplyText(parsed.text ?? '') || '(no text)'
    },
    { check }
  );
}

// --- the poller ------------------------------------------------------------------------

// startMailPoller() -> stop(). A no-op stop when mail is not configured.
export function startMailPoller({ log = console } = {}) {
  const mail = config.mail;
  if (!mail.enabled || !mail.imap.host) {
    log.log('[mail] inbox polling off (SMTP or IMAP not configured)');
    return () => {};
  }

  let client = null;
  let timer = null;
  let stopped = false;
  let failures = 0;
  // UIDs looked at and left alone, so an unrelated unread mail is fetched once.
  const passed = new Set();
  let uidValidity = null;

  const closeClient = async () => {
    const current = client;
    client = null;
    if (!current) return;
    try {
      await current.logout();
    } catch {
      current.close();
    }
  };

  async function connected() {
    if (client?.usable) return client;
    await closeClient();
    const next = new ImapFlow({
      host: mail.imap.host,
      port: mail.imap.port,
      secure: true,
      auth: { user: mail.imap.user, pass: mail.imap.pass },
      logger: false,
      socketTimeout: 60000
    });
    // Without a listener an 'error' event would throw and take the API down.
    next.on('error', (err) => log.error(`[mail] imap error: ${err.code ?? err.name ?? 'error'}`));
    next.on('close', () => {
      if (client === next) client = null;
    });
    await next.connect();
    client = next;
    return next;
  }

  async function pollOnce() {
    const imap = await connected();
    const lock = await imap.getMailboxLock('INBOX');
    let stored = 0;
    try {
      if (uidValidity !== String(imap.mailbox.uidValidity)) {
        uidValidity = String(imap.mailbox.uidValidity);
        passed.clear();
      }
      const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const uids = (await imap.search({ seen: false, since }, { uid: true })) || [];
      for (const uid of uids) {
        if (passed.has(uid)) continue;
        // source is fetched with BODY.PEEK, so looking does not mark it seen.
        const message = await imap.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message?.source) continue;
        const parsed = await simpleParser(message.source);
        const outcome = await handleIncoming(parsed);
        if (outcome === 'stored' || outcome === 'duplicate') {
          await imap.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          if (outcome === 'stored') stored += 1;
        } else {
          passed.add(uid);
        }
      }
    } finally {
      lock.release();
    }
    if (stored) log.log(`[mail] stored ${stored} supplier repl${stored === 1 ? 'y' : 'ies'}`);
  }

  async function tick() {
    if (stopped) return;
    let delay = mail.pollSeconds * 1000;
    try {
      await pollOnce();
      failures = 0;
    } catch (err) {
      failures += 1;
      delay = Math.min(MAX_BACKOFF_MS, mail.pollSeconds * 1000 * 2 ** Math.min(failures, 5));
      // The code only: an IMAP server's message can carry the account name.
      log.error(`[mail] poll failed (${err.code ?? err.name ?? 'error'}); next try in ${Math.round(delay / 1000)} s`);
      await closeClient();
    }
    if (!stopped) timer = setTimeout(tick, delay);
  }

  log.log(`[mail] polling the inbox every ${mail.pollSeconds} s`);
  timer = setTimeout(tick, 2000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    closeClient();
  };
}
