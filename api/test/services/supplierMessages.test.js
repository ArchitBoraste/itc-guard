// The short message to a supplier about one document: which one a row needs, and
// what it says. Pure: no database.
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_KINDS as K,
  greeting,
  messageForAlertInvoice,
  messageForCorrection,
  messageForResult,
  messageRupees,
  resultMessageKind,
  supplierMessage
} from '../../src/services/supplierMessages.js';

const base = {
  traderName: 'Sharma Electronics',
  contact: { person: 'Rakesh Jain', phone: '+91 98220 41587', email: 'rakesh@example.in' },
  docType: 'INVOICE',
  invoiceNo: 'NS-612',
  invoiceDate: '2026-08-13',
  taxPeriod: '2026-08',
  scheme: 'MONTHLY',
  cutOffDate: '2026-09-11',
  books: { taxableValue: 2500000, totalTax: 450000 },
  portal: { invoiceNo: 'NS-612', taxableValue: 2800000, totalTax: 504000 },
  decided: null
};

const result = (over = {}) => ({
  bucket: 'VALUE_MISMATCH',
  flags: [],
  confirmedAction: null,
  supplierContact: base.contact,
  books: { invoiceNo: 'NS-612', invoiceDate: '2026-08-13', docType: 'INVOICE', supplierGstin: '27AABCN7782E1Z9', taxableValue: 2500000, totalTax: 450000 },
  portal: { invoiceNo: 'NS-612', invoiceDate: '2026-08-13', docType: 'INVOICE', supplierGstin: '27AABCN7782E1Z9', taxableValue: 2800000, totalTax: 504000, filingStatus: 'FILED' },
  ...over
});

describe('formatting', () => {
  it('quotes whole rupees, and paise only when there are some', () => {
    expect(messageRupees(2800000)).toBe('₹28,000');
    expect(messageRupees(180060)).toBe('₹1,800.60');
    expect(messageRupees(1234567800)).toBe('₹1,23,45,678');
  });

  it('greets a person by first name, and nobody when the name is a placeholder', () => {
    expect(greeting('Rakesh Jain')).toBe('Hello Rakesh ji,');
    expect(greeting('K. Balaji')).toBe('Hello K. Balaji ji,');
    expect(greeting('Sample contact 05')).toBe('Hello,');
    expect(greeting(null)).toBe('Hello,');
  });
});

describe('the message', () => {
  it('asks for a GSTR-1A when the portal is higher, saying it was rejected only once it was', () => {
    const undecided = supplierMessage(K.PORTAL_HIGHER, base);
    expect(undecided.text).toBe(
      'Hello Rakesh ji, invoice NS-612 (13 Aug 2026) shows ₹28,000 taxable and ₹5,040 tax on the GST portal, ' +
        'but our books show ₹25,000 and ₹4,500. Please correct it through GSTR-1A so we can accept it. ' +
        'Thank you, Sharma Electronics'
    );
    expect(supplierMessage(K.PORTAL_HIGHER, { ...base, decided: 'REJECT' }).text).toContain('We have rejected it in IMS.');
  });

  it('asks for the difference when the portal is lower', () => {
    const lower = {
      ...base,
      invoiceNo: 'MS-878',
      books: { taxableValue: 4000000, totalTax: 720000 },
      portal: { invoiceNo: 'MS-878', taxableValue: 3500000, totalTax: 630000 },
      decided: 'ACCEPT'
    };
    const { text } = supplierMessage(K.PORTAL_LOWER, lower);
    expect(text).toContain('We have accepted ₹6,300 for now.');
    expect(text).toContain('Please report the remaining ₹5,000 taxable (₹900 tax) through GSTR-1A.');
  });

  it('names the cut-off before it, and GSTR-1A after it', () => {
    const before = supplierMessage(K.NOT_FILED_BEFORE_CUTOFF, { ...base, portal: null });
    expect(before.text).toContain('is not on the GST portal yet. Please include it in your GSTR-1 by 11 Sep 2026');
    expect(before.text).toContain('so we can claim the credit in August 2026');
    const after = supplierMessage(K.NOT_FILED_AFTER_CUTOFF, { ...base, portal: null });
    expect(after.text).toContain('Please add it through GSTR-1A so we can claim the credit.');
  });

  it("tells a quarterly filer about the IFF, and after its cut-off the quarterly return", () => {
    const quarterly = { ...base, scheme: 'QRMP', cutOffDate: '2026-09-13', portal: null };
    expect(supplierMessage(K.NOT_FILED_BEFORE_CUTOFF, quarterly).text).toContain('in your GSTR-1 or IFF by 13 Sep 2026');
    expect(supplierMessage(K.NOT_FILED_AFTER_CUTOFF, quarterly).text).toContain('include it in your quarterly GSTR-1');
  });

  it('never tells a credit note it brings credit', () => {
    const note = { ...base, docType: 'CREDIT_NOTE', invoiceNo: 'CE-CN-08', portal: null };
    const { text } = supplierMessage(K.NOT_FILED_BEFORE_CUTOFF, note);
    expect(text).toContain('our credit note CE-CN-08');
    expect(text).toContain('so that our returns agree');
    expect(text).not.toContain('claim the credit');
  });

  it('asks a phantom to be removed', () => {
    const { text } = supplierMessage(K.NOT_IN_BOOKS, {
      ...base, contact: null, invoiceNo: 'RT-760', books: null,
      portal: { invoiceNo: 'RT-760', taxableValue: 3000000, totalTax: 540000 }, decided: 'REJECT'
    });
    expect(text).toBe(
      'Hello, invoice RT-760 (13 Aug 2026, ₹5,400 tax) is on the GST portal under our GSTIN, but we have no ' +
        'purchase against it. We have rejected it in IMS. Please check and remove it. Thank you, Sharma Electronics'
    );
  });

  it('opens WhatsApp only for an Indian mobile number', () => {
    expect(supplierMessage(K.PORTAL_HIGHER, base).whatsappUrl).toMatch(/^https:\/\/wa\.me\/919822041587\?text=/);
    const placeholder = { ...base, contact: { person: 'Sample contact 05', phone: '+91 00000 00005' } };
    expect(supplierMessage(K.PORTAL_HIGHER, placeholder).whatsappUrl).toBeNull();
  });

  it('carries a subject for email', () => {
    expect(supplierMessage(K.PORTAL_HIGHER, base).subject).toBe('Invoice NS-612 dated 13 Aug 2026');
  });
});

describe('which message a result needs', () => {
  it('reads the bucket, the filing status and the cut-off', () => {
    expect(resultMessageKind(result())).toBe(K.PORTAL_HIGHER);
    expect(resultMessageKind(result({ portal: { ...result().portal, totalTax: 400000 } }))).toBe(K.PORTAL_LOWER);
    expect(resultMessageKind(result({ portal: { ...result().portal, filingStatus: 'SAVED' } }))).toBe(K.SAVED_DIFFERENT_BEFORE_CUTOFF);
    expect(
      resultMessageKind(result({ flags: ['CUTOFF_PASSED'], portal: { ...result().portal, filingStatus: 'SAVED' } }))
    ).toBe(K.SAVED_DIFFERENT_AFTER_CUTOFF);
    expect(resultMessageKind(result({ bucket: 'SUGGESTED' }))).toBe(K.INVOICE_NO_DIFFERS);
    expect(resultMessageKind(result({ bucket: 'MISSING_IN_BOOKS', books: null }))).toBe(K.NOT_IN_BOOKS);
    expect(resultMessageKind(result({ bucket: 'MISSING_IN_PORTAL', portal: null }))).toBe(K.NOT_FILED_BEFORE_CUTOFF);
    expect(resultMessageKind(result({ bucket: 'MISSING_IN_PORTAL', portal: null, flags: ['CUTOFF_PASSED'] }))).toBe(
      K.NOT_FILED_AFTER_CUTOFF
    );
    expect(
      resultMessageKind(result({ bucket: 'MATCHED', portal: { ...result().portal, filingStatus: 'SAVED' } }))
    ).toBe(K.SAVED_NOT_FILED_BEFORE_CUTOFF);
  });

  it('has nothing to say about a clean match, a rounding difference, or a record outside IMS', () => {
    expect(resultMessageKind(result({ bucket: 'MATCHED' }))).toBeNull();
    expect(resultMessageKind(result({ portal: { ...result().portal, totalTax: 450060 } }))).toBeNull();
    expect(resultMessageKind(result({ bucket: 'NON_IMS' }))).toBeNull();
    expect(resultMessageKind(result({ bucket: 'INELIGIBLE' }))).toBeNull();
  });

  it('builds the message for the supplier against their own cut-off', () => {
    const message = messageForResult(result({ bucket: 'MISSING_IN_PORTAL', portal: null }), {
      traderName: 'Sharma Electronics', taxPeriod: '2026-08', scheme: 'QRMP'
    });
    expect(message.text).toContain('by 13 Sep 2026');
  });
});

describe('alerts and corrections', () => {
  it('writes a saved-with-a-different-amount message for a Not filed yet row', () => {
    const message = messageForAlertInvoice({
      traderName: 'Sharma Electronics',
      taxPeriod: '2026-09',
      supplier: { contact: null, filingScheme: 'MONTHLY', cutOffDate: '2026-10-11', preCutOff: true },
      invoice: {
        status: 'SAVED_VALUE_MISMATCH', docType: 'INVOICE', invoiceNo: 'NS-701', invoiceDate: '2026-09-10',
        taxableValue: 1800000, totalTax: 324000, portalTaxableValue: 2000000, portalTotalTax: 360000
      }
    });
    expect(message.kind).toBe(K.SAVED_DIFFERENT_BEFORE_CUTOFF);
    expect(message.text).toContain('is saved on the GST portal at ₹20,000 taxable and ₹3,600 tax');
    expect(message.text).toContain('before you file your GSTR-1 by 11 Oct 2026');
  });

  it('reminds a supplier of a waiting correction, and says nothing once it arrived', () => {
    const item = {
      status: 'WAITING',
      taxPeriod: '2026-08',
      supplier: { contact: null, filingScheme: 'MONTHLY' },
      document: { docType: 'INVOICE', invoiceNo: 'NS-612', invoiceDate: '2026-08-13', taxableValue: 2500000, totalTax: 450000 },
      needed: { kind: 'VALUE_MISMATCH', portal: { taxableValue: 2800000, totalTax: 504000 } },
      waiting: { nextChance: { date: '2026-10-11', reachesPeriod: '2026-09' } }
    };
    const message = messageForCorrection({ traderName: 'Sharma Electronics', item });
    expect(message.text).toContain('a reminder about our invoice NS-612 dated 13 Aug 2026 (₹25,000 + ₹4,500 GST).');
    expect(message.text).toContain('Please correct it through GSTR-1A by 11 Oct 2026 so it reaches our September 2026 GSTR-2B.');
    expect(messageForCorrection({ traderName: 'x', item: { ...item, status: 'ARRIVED' } })).toBeNull();
  });
});
