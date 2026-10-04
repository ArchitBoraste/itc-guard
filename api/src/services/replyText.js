// The new text of an email reply: the quoted history and the signature cut off.
//
// Pure. Works on the plain-text part, line by line, and stops at the first line
// that starts the quoted original or a signature, in the shapes Gmail, Outlook and
// phone mail apps write them. What is left is the supplier's own words, and it is
// still untrusted text: the caller stores it as text and the UI shows it escaped.

const MAX_LENGTH = 4000;

// A line that starts the quoted original, or a signature.
const CUT_LINES = [
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^_{5,}\s*$/,
  /^-- ?$/,
  /^Sent from my \S+/i,
  /^Sent from (Mail|Outlook|Yahoo Mail|Gmail)\b/i,
  /^Get Outlook for /i
];

// Outlook's header block: "From: …" then Sent/To/Subject within a few lines.
function startsOutlookHeader(lines, i) {
  if (!/^\*?From:\*?\s/i.test(lines[i])) return false;
  return lines.slice(i + 1, i + 5).some((line) => /^\*?(Sent|Date|To|Subject):\*?\s/i.test(line));
}

// Gmail's "On Mon, 5 Oct 2026 at 00:42, Sharma Electronics <a@b.c> wrote:", which
// a mail client may wrap over two or three lines.
function startsAttribution(lines, i) {
  const line = lines[i];
  if (/^On\s.+\swrote:\s*$/i.test(line)) return true;
  if (/^On\s/i.test(line) && !/wrote:/i.test(line)) {
    const joined = `${line} ${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`;
    return /^On\s.+\swrote:/i.test(joined) && joined.indexOf('wrote:') < 400;
  }
  return /^(Le|Am|El)\s.+(a écrit|schrieb|escribió)\s*:\s*$/i.test(line);
}

export function newReplyText(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // Zero-width and non-breaking spaces that mail clients sprinkle in.
    .replace(/[​‌‍﻿]/g, '')
    .replace(/ /g, ' ')
    .split('\n');

  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    const bare = line.trim();
    if (CUT_LINES.some((pattern) => pattern.test(bare))) break;
    if (startsAttribution(lines.map((entry) => entry.trim()), i)) break;
    if (startsOutlookHeader(lines.map((entry) => entry.trim()), i)) break;
    if (bare.startsWith('>')) continue;
    kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_LENGTH);
}
