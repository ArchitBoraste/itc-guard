// Every rupee figure on screen is formatted from integer paise (web/src/lib/money.js).
import { describe, expect, it } from 'vitest';
import { rupees, rupeesExact } from '../src/lib/money.js';

describe('rupeesExact', () => {
  it.each([
    [0, '₹0.00'],
    [5, '₹0.05'],
    [1008, '₹10.08'],
    [12345678, '₹1,23,456.78'],
    [-500000, '−₹5,000.00'],
    // Past where paise / 100 stops being exact in a double; the digits still are.
    [900719925474099, '₹90,07,19,92,54,740.99']
  ])('formats %d paise as %s', (paise, text) => {
    expect(rupeesExact(paise)).toBe(text);
  });

  it('agrees with the whole-rupee formatter on round figures', () => {
    expect(rupeesExact(12019000)).toBe(`${rupees(12019000)}.00`);
  });
});
