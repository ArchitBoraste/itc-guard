// Only the supplier's new words survive: quoted history and signatures go.
import { describe, expect, it } from 'vitest';
import { newReplyText } from '../../src/services/replyText.js';

describe('newReplyText', () => {
  it('cuts Gmail quoted history, including a wrapped attribution line', () => {
    const text = [
      'Will correct NS-612 through GSTR-1A by 9 Oct',
      '',
      'On Mon, 5 Oct 2026 at 00:42, Sharma Electronics <',
      'sharma.demo@gmail.com> wrote:',
      '',
      '> Hello, invoice NS-612 shows ₹28,000 taxable.',
      '> Thank you, Sharma Electronics'
    ].join('\r\n');
    expect(newReplyText(text)).toBe('Will correct NS-612 through GSTR-1A by 9 Oct');
  });

  it('cuts a one-line attribution, a signature and a phone footer', () => {
    expect(newReplyText('Done, filed today.\n\nOn Tue, Oct 6, 2026 Sharma <a@b.c> wrote:\n> old')).toBe('Done, filed today.');
    expect(newReplyText('Filed.\n-- \nRakesh Shah\nAccounts')).toBe('Filed.');
    expect(newReplyText('Ok will do\n\nSent from my iPhone')).toBe('Ok will do');
  });

  it('cuts an Outlook header block and drops stray quoted lines', () => {
    const text = 'Please send the PO copy.\n> earlier line\n\nFrom: Sharma Electronics <a@b.c>\nSent: Monday\nTo: x\nSubject: y\n\nold';
    expect(newReplyText(text)).toBe('Please send the PO copy.');
  });

  it('keeps the whole text when nothing marks a quote, and is never longer than 4000 characters', () => {
    expect(newReplyText('Line one\n\n\n\nLine two')).toBe('Line one\n\nLine two');
    expect(newReplyText('x'.repeat(5000))).toHaveLength(4000);
    expect(newReplyText(null)).toBe('');
  });
});
