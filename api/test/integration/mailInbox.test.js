// A reply reaches its thread (services/mailInbox.js handleIncoming), from parsed
// mail objects shaped as mailparser returns them. No IMAP server is involved.
//
//   * In-Reply-To / References find the thread by our Message-ID; the subject tag
//     is the fallback; anything else is left alone.
//   * Only the new text is stored, once per Message-ID, in the thread's workspace.
//   * Our own outgoing mail is never taken for a reply.
//
// Owns org 36.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { handleIncoming } from '../../src/services/mailInbox.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';

const ORG_ID = TEST_ORGS.mailInbox;
const GSTIN = '27AABCN7782E1ZT';
const MESSAGE_ID = '<itcg.TSTREF.0123456789ab@test.example>';
const unchecked = async () => ({ intent: 'unchecked', summary: null, promisedDate: null, mentionsOurInvoice: null });

let sequence = 0;
const mailOf = (overrides) => ({
  messageId: `<reply-${process.pid}-${(sequence += 1)}@supplier.example>`,
  subject: 'Re: [ITC Guard #TSTREF] NS-612 · Sharma Electronics',
  from: { value: [{ address: 'national@test.example' }] },
  date: new Date('2026-10-04T19:30:00Z'),
  text: 'Will correct NS-612 through GSTR-1A by 9 Oct\n\nOn Mon, 5 Oct 2026 at 00:42, Sharma <t@test.example> wrote:\n> Hello',
  ...overrides
});

async function replies() {
  const [rows] = await pool.query('SELECT * FROM message_replies WHERE org_id = ? ORDER BY id', [ORG_ID]);
  return rows;
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  await pool.query(
    `INSERT INTO message_threads (org_id, ref, supplier_gstin, supplier_name, document_refs, tax_period, context,
       to_address, subject, body, message_id, sent_at)
     VALUES (?, 'TSTREF', ?, 'National Supply Co', '["NS-612"]', '2026-08', 'decisions', 'national@test.example',
       '[ITC Guard #TSTREF] NS-612 · Sharma Electronics', 'Hello, please correct NS-612.', ?, UTC_TIMESTAMP())`,
    [ORG_ID, GSTIN, MESSAGE_ID]
  );
});

afterAll(async () => {
  await resetOrg(ORG_ID);
  await closePool();
});

describe('a reply finds its thread', () => {
  it("by In-Reply-To, storing only the new text in the thread's workspace", async () => {
    const mail = mailOf({ inReplyTo: MESSAGE_ID, subject: 'Re: something else' });
    expect(await handleIncoming(mail, { check: unchecked })).toBe('stored');
    const [row] = await replies();
    expect(row).toMatchObject({
      org_id: ORG_ID,
      body: 'Will correct NS-612 through GSTR-1A by 9 Oct',
      from_address: 'national@test.example',
      intent: 'unchecked',
      message_id: mail.messageId,
      read_at: null
    });
    expect(await handleIncoming(mail, { check: unchecked })).toBe('duplicate');
    expect(await replies()).toHaveLength(1);
  });

  it('by References, then by the subject tag when the headers are gone', async () => {
    expect(await handleIncoming(mailOf({ references: ['<other@x>', MESSAGE_ID] }), { check: unchecked })).toBe('stored');
    expect(await handleIncoming(mailOf({}), { check: unchecked })).toBe('stored');
    expect(await replies()).toHaveLength(3);
  });

  it('leaves unrelated mail and our own outgoing mail alone', async () => {
    expect(await handleIncoming(mailOf({ subject: 'Lunch?', inReplyTo: '<nope@x>' }), { check: unchecked })).toBe('unmatched');
    expect(await handleIncoming(mailOf({ subject: 'Re: [ITC Guard #ZZZZZZ] x' }), { check: unchecked })).toBe('unmatched');
    expect(await handleIncoming(mailOf({ messageId: MESSAGE_ID }), { check: unchecked })).toBe('own');
    expect(await replies()).toHaveLength(3);
  });

  it('stores what the check says', async () => {
    const check = async (input) => {
      expect(input).toMatchObject({ ourMessage: 'Hello, please correct NS-612.', documentRefs: ['NS-612'] });
      expect(input.reply).toBe('Will correct NS-612 through GSTR-1A by 9 Oct');
      return { intent: 'will_fix', summary: 'Will correct it through GSTR-1A.', promisedDate: '2026-10-09', mentionsOurInvoice: true };
    };
    expect(await handleIncoming(mailOf({ inReplyTo: MESSAGE_ID }), { check })).toBe('stored');
    const row = (await replies()).at(-1);
    expect(row).toMatchObject({ intent: 'will_fix', promised_date: '2026-10-09', mentions_our_invoice: 1 });
  });
});
