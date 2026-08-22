// Money formatting. Values arrive from the API as INTEGER PAISE and stay integers
// the whole way through this module — no value is ever divided into a float.
//
// The rounding is done by integer arithmetic on paise, and the digit grouping is
// done on the decimal STRING. A float never touches a rupee figure on screen.

// Rounds paise to whole rupees, half away from zero, and returns the sign
// separately so the caller can render "-" wherever it wants.
function toWholeRupees(paise) {
  const value = Math.trunc(Number(paise) || 0);
  const negative = value < 0;
  const abs = Math.abs(value);
  // abs + 50 then snap down to a multiple of 100: half-up, integer-only.
  const rounded = abs + 50 - ((abs + 50) % 100);
  // rounded is a multiple of 100, so this division is exact in IEEE-754.
  const whole = rounded / 100;
  // A few paise below zero rounds to nothing; "−₹0" is noise, not information.
  return { negative: negative && whole !== 0, rupees: whole };
}

// Indian digit grouping: last three digits, then pairs. 12345678 -> 1,23,45,678
export function groupIndian(digits) {
  const text = String(digits);
  if (text.length <= 3) return text;
  const tail = text.slice(-3);
  let head = text.slice(0, -3);
  const groups = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  return `${groups.join(',')},${tail}`;
}

// ₹1,18,000 — no paise, ever.
export function rupees(paise, { signed = false } = {}) {
  const { negative, rupees: whole } = toWholeRupees(paise);
  const body = `₹${groupIndian(whole)}`;
  if (negative) return `−${body}`;
  return signed && whole !== 0 ? `+${body}` : body;
}

// Compact form for headline cards: ₹1.45 Cr / ₹12.4 L / ₹8,200.
// Uses integer paise for the threshold tests, and only ever divides a value it is
// about to render to one or two decimals — never a figure anything is added to.
export function rupeesCompact(paise) {
  const { negative, rupees: whole } = toWholeRupees(paise);
  const sign = negative ? '−' : '';
  if (whole >= 10000000) return `${sign}₹${(whole / 10000000).toFixed(2)} Cr`;
  if (whole >= 100000) return `${sign}₹${(whole / 100000).toFixed(2)} L`;
  return `${sign}₹${groupIndian(whole)}`;
}

// Percentage of a part against a whole, both in paise. Guarded so a zero or
// negative denominator never produces Infinity or NaN on screen.
export function shareOf(partPaise, wholePaise) {
  const whole = Math.abs(Math.trunc(Number(wholePaise) || 0));
  if (!whole) return null;
  const part = Math.abs(Math.trunc(Number(partPaise) || 0));
  return Math.round((part / whole) * 1000) / 10;
}
