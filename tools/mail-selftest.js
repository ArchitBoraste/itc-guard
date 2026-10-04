// mail-selftest.js — checks supplier email end to end, without the database.
//
//   npm run mail:selftest [-- someone@example.com]
//   (in the prod container: node /app/tools/mail-selftest.js someone@example.com)
//
// 1. SMTP: logs in and sends one tagged mail to the address given, else to
//    MAIL_SELFTEST_TO (set in the gitignored .env, so no real address lives in
//    the repo). It must be on EMAIL_ALLOWLIST. Prints the thread ref it carries.
// 2. IMAP: logs in and counts unread mail in INBOX.
// 3. Gemini: checks a sample reply, when GEMINI_API_KEY is set.
//
// Reads the same env as the API. Never prints a password, key or account name.
// Exits 1 if SMTP or IMAP fails.
import { createRequire } from 'node:module';
import { randomBytes, randomInt } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../api/src/config.js';
import { checkReply } from '../api/src/services/replyCheck.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// nodemailer and imapflow live in api/node_modules; load them from there.
const apiRequire = createRequire(join(REPO_ROOT, 'api', 'package.json'));
const nodemailer = apiRequire('nodemailer');
const { ImapFlow } = apiRequire('imapflow');

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ok = (text) => console.log(`  ok    ${text}`);
const bad = (text) => console.log(`  FAIL  ${text}`);
const errCode = (err) => err?.responseCode ?? err?.code ?? err?.name ?? 'error';

async function smtp(mail, to) {
  const transport = nodemailer.createTransport({
    host: mail.smtp.host,
    port: mail.smtp.port,
    secure: mail.smtp.secure,
    auth: { user: mail.smtp.user, pass: mail.smtp.pass },
    connectionTimeout: 15000
  });
  await transport.verify();
  ok(`SMTP login to ${mail.smtp.host}:${mail.smtp.port}`);
  let ref = '';
  for (let i = 0; i < 6; i += 1) ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  const domain = mail.smtp.user.split('@')[1] ?? 'itc-guard.local';
  await transport.sendMail({
    from: { name: 'ITC Guard self-test', address: mail.smtp.user },
    to,
    subject: `[ITC Guard #${ref}] Self-test`,
    text:
      'This is the ITC Guard mail self-test. Nothing to do: it is not tied to any workspace,\n' +
      'so a reply to it is left in the mailbox untouched.',
    messageId: `<itcg.${ref}.${randomBytes(6).toString('hex')}@${domain}>`,
    headers: { 'X-ITC-Guard-Ref': ref }
  });
  ok(`sent to ${to}, thread ref #${ref}`);
  transport.close();
  return ref;
}

async function imap(mail) {
  const client = new ImapFlow({
    host: mail.imap.host,
    port: mail.imap.port,
    secure: true,
    auth: { user: mail.imap.user, pass: mail.imap.pass },
    logger: false
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = (await client.search({ seen: false }, { uid: true })) || [];
      ok(`IMAP login to ${mail.imap.host}, INBOX has ${unseen.length} unread`);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function gemini(mail) {
  if (!mail.gemini.apiKey) {
    console.log('  skip  Gemini: no GEMINI_API_KEY, replies will show as "Not checked"');
    return;
  }
  const started = Date.now();
  const result = await checkReply(
    {
      ourMessage: 'Hello, invoice NS-612 shows Rs 28,000 taxable on the GST portal but our books show Rs 25,000. Please correct it through GSTR-1A.',
      reply: 'Will correct NS-612 through GSTR-1A by 9 Oct',
      documentRefs: ['NS-612'],
      receivedAt: new Date()
    },
    { log: { error: () => {} } }
  );
  if (result.intent === 'unchecked') bad(`Gemini (${mail.gemini.model}): no usable answer, replies will show as "Not checked"`);
  else ok(`Gemini (${mail.gemini.model}) in ${Date.now() - started} ms: ${result.intent}, promised ${result.promisedDate ?? 'no date'}`);
}

async function main() {
  const mail = config.mail;
  const to = (process.argv[2] ?? process.env.MAIL_SELFTEST_TO ?? '').trim().toLowerCase();
  console.log('ITC Guard mail self-test');
  if (!to) {
    bad('no address: npm run mail:selftest -- someone@example.com, or set MAIL_SELFTEST_TO');
    process.exitCode = 1;
    return;
  }
  if (!mail.enabled) {
    bad('SMTP_HOST, SMTP_USER and SMTP_PASS must all be set');
    process.exit(1);
  }
  if (!mail.allowlist.includes(to)) {
    bad(`${to} is not on EMAIL_ALLOWLIST (${mail.allowlist.length} address(es) listed)`);
    process.exit(1);
  }
  let failed = false;
  try {
    await smtp(mail, to);
  } catch (err) {
    failed = true;
    bad(`SMTP: ${errCode(err)} (for Gmail: an app password, port 465)`);
  }
  if (!mail.imap.host) {
    failed = true;
    bad('IMAP_HOST is not set: replies will not be read');
  } else {
    try {
      await imap(mail);
    } catch (err) {
      failed = true;
      bad(`IMAP: ${errCode(err)} (for Gmail: IMAP must be on in Gmail settings)`);
    }
  }
  await gemini(mail);
  // exitCode rather than exit(): let the sockets close on their own.
  process.exitCode = failed ? 1 : 0;
}

main();
