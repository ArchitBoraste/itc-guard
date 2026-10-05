// What goes into a WhatsApp template: the one-sentence ask for every kind of
// message, and the five values with Meta's rules on them (one line, no tab, no run
// of spaces, short). Pure: no database, no network.
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_KINDS as K,
  addressName,
  supplierAsk,
  supplierMessage,
  whatsappParam
} from '../../src/services/supplierMessages.js';
import { templateValues } from '../../src/services/supplierWhatsapp.js';

const base = {
  traderName: 'Sharma Electronics',
  contact: { person: 'Rakesh Jain', phone: '+91 98220 41587', email: null },
  docType: 'INVOICE',
  invoiceNo: 'NS-612',
  invoiceDate: '2026-08-13',
  taxPeriod: '2026-08',
  scheme: 'MONTHLY',
  cutOffDate: '2026-09-11',
  books: { taxableValue: 2500000, totalTax: 450000 },
  portal: { invoiceNo: 'NS/612', taxableValue: 2800000, totalTax: 504000 },
  decided: null,
  needed: 'VALUE_MISMATCH',
  nextChance: { date: '2026-10-11', reachesPeriod: '2026-10' }
};

// Meta refuses a template value with a newline, a tab or more than four spaces in a row.
const metaAccepts = (value) => !/[\n\r\t]/.test(value) && !/ {5,}/.test(value) && value.trim() === value && value.length > 0;

describe('the ask', () => {
  it('is one line of at most 200 characters for every kind of message', () => {
    for (const kind of Object.values(K)) {
      for (const scheme of ['MONTHLY', 'QRMP']) {
        const ask = supplierAsk(kind, { ...base, scheme });
        expect(metaAccepts(ask), `${kind} ${scheme}: ${ask}`).toBe(true);
        expect(ask.length, kind).toBeLessThanOrEqual(200);
        expect(ask, kind).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  it('says what is wrong and what to do, with the amounts and the cut-off', () => {
    expect(supplierAsk(K.PORTAL_HIGHER, base)).toBe(
      'The GST portal shows ₹5,040 tax against ₹4,500 in our books, so please correct it through GSTR-1A.'
    );
    expect(supplierAsk(K.PORTAL_HIGHER, { ...base, decided: 'REJECT' })).toContain('and we have rejected it in IMS, so');
    expect(supplierAsk(K.PORTAL_LOWER, { ...base, portal: { ...base.portal, totalTax: 400000 } })).toBe(
      'The GST portal shows ₹4,000 tax against ₹4,500 in our books, so please report the remaining ₹500 tax through GSTR-1A.'
    );
    expect(supplierAsk(K.NOT_FILED_BEFORE_CUTOFF, base)).toBe(
      'It is not on the GST portal yet, so please include it in your GSTR-1 by 11 Sep 2026.'
    );
    expect(supplierAsk(K.NOT_FILED_BEFORE_CUTOFF, { ...base, scheme: 'QRMP', cutOffDate: '2026-09-13' })).toContain(
      'your GSTR-1 or IFF by 13 Sep 2026'
    );
    expect(supplierAsk(K.INVOICE_NO_DIFFERS, base)).toContain('appears on the GST portal as NS/612');
    expect(supplierAsk(K.CORRECTION_REMINDER, base)).toBe(
      'The GST portal still shows ₹5,040 tax, so please correct it through GSTR-1A by 11 Oct 2026 so it reaches our October 2026 GSTR-2B.'
    );
  });

  it('travels with the message, beside the invoice date', () => {
    const message = supplierMessage(K.PORTAL_HIGHER, base);
    expect(message.ask).toBe(supplierAsk(K.PORTAL_HIGHER, base));
    expect(message.invoiceDate).toBe('2026-08-13');
  });
});

describe('template values', () => {
  it('makes any text one acceptable line, cut at a word', () => {
    expect(whatsappParam('Line one\nline\ttwo      spaced  ')).toBe('Line one line two spaced');
    const cut = whatsappParam('word '.repeat(80), 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith('word…')).toBe(true);
  });

  it('addresses the contact by first name, else "there"', () => {
    expect(addressName('Rakesh Jain')).toBe('Rakesh');
    expect(addressName('Sample contact 05')).toBeNull();
    const values = templateValues({
      person: 'Sample contact 05',
      traderName: 'Sharma\nElectronics',
      documentRefs: ['NS-612'],
      invoiceDate: '2026-08-13',
      ask: null
    });
    expect(values).toEqual([
      'there',
      'Sharma Electronics',
      'NS-612',
      '13 Aug 2026',
      'Please check how it appears on the GST portal and reply here.'
    ]);
    expect(values.every(metaAccepts)).toBe(true);
  });

  it('keeps the five values in the template order', () => {
    const values = templateValues({
      person: 'Rakesh Jain',
      traderName: 'Sharma Electronics',
      documentRefs: ['NS-612', 'NS-613'],
      invoiceDate: '2026-08-13',
      ask: supplierAsk(K.PORTAL_HIGHER, base)
    });
    expect(values.slice(0, 4)).toEqual(['Rakesh', 'Sharma Electronics', 'NS-612, NS-613', '13 Aug 2026']);
    expect(values[4]).toMatch(/^The GST portal shows/);
  });
});
