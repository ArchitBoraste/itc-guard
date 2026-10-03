// The purchase register's optional supplier-contact columns.
//
// No GSTN template has them: they are the app's own extension, read when present
// under any of a few common titles, never required, and never evidence that a
// file is a template.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  FORMAT_TEMPLATE_V24,
  MAPPABLE_FIELDS,
  describeColumns,
  parse,
  parseWithMetadata,
  suggestColumns
} from '../../src/adapters/purchaseRegister.js';
import { SUPPLIERS, placeholderContact } from '../../../tools/demo-timeline.js';
import { demoRegister } from '../helpers/demoFiles.js';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '../../../samples/2026-04/purchase_register.xlsx');
const ORBIT = SUPPLIERS.find((supplier) => supplier.key === 'orbit');

const csv = (lines) => Buffer.from(lines.join('\n'), 'utf8');

describe('the demo register', () => {
  it('is still the v2.4 template, and every document carries its supplier’s contact', () => {
    const { format, invoices } = parseWithMetadata(readFileSync(demoRegister('aug')));
    expect(format).toBe(FORMAT_TEMPLATE_V24);
    const orbit = invoices.find((invoice) => invoice.supplierGstin === ORBIT.gstin);
    expect(orbit.supplierContact).toEqual(placeholderContact(ORBIT));
    expect(invoices.every((invoice) => invoice.supplierContact)).toBe(true);
  });
});

describe('a register without contact columns', () => {
  it('reads as before, with no contact on any document', () => {
    const invoices = parse(readFileSync(SAMPLE));
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices.every((invoice) => invoice.supplierContact === null)).toBe(true);
  });
});

describe('contact columns under other titles', () => {
  const header = 'GSTIN of Supplier,Invoice Number,Invoice date,Taxable Value,Rate,Contact Person,Mobile,E-mail';

  it('are matched without regard to case or punctuation', () => {
    const [invoice] = parse(csv([
      header,
      '27AAFFO2231R1ZX,A/1,3-Aug-26,1000,18,Ravi Kumar,919820012345,ravi@example.org'
    ]));
    expect(invoice.supplierContact).toEqual({ person: 'Ravi Kumar', phone: '919820012345', email: 'ravi@example.org' });
  });

  it('give a document the contact from whichever of its rate rows carries one', () => {
    const [invoice] = parse(csv([
      header,
      '27AAFFO2231R1ZX,A/1,3-Aug-26,1000,18,,,',
      '27AAFFO2231R1ZX,A/1,3-Aug-26,500,12,,98200 12345,'
    ]));
    expect(invoice.rateLines).toHaveLength(2);
    expect(invoice.supplierContact).toEqual({ person: null, phone: '98200 12345', email: null });
  });

  it('read a phone Excel stored as a number as text', () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['GSTIN of recipient* :', '27AABCS1080F1ZN', null, 'Financial year* :', '2026-27'],
      ['Trade/Legal name:', 'Sharma', null, 'Tax period* :', 'August'],
      [],
      [],
      ['GSTIN of Supplier/ECO*', 'Document type*', 'Document number*', 'Document date*', 'Taxable value (₹)*', 'Supplier phone'],
      ['27AAFFO2231R1ZX', 'Invoice', 'A/1', '3-Aug-26', 1000, 919820012345]
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Purchase Register');
    const [invoice] = parse(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    expect(invoice.supplierContact).toEqual({ person: null, phone: '919820012345', email: null });
  });
});

describe('the column mapper', () => {
  it('offers the three as optional fields, never required ones', () => {
    expect(MAPPABLE_FIELDS).toEqual(expect.arrayContaining(['contactPerson', 'contactPhone', 'contactEmail']));
    const described = describeColumns(readFileSync(demoRegister('aug')));
    expect(described.mapped).toMatchObject({ contactPerson: 11, contactPhone: 12, contactEmail: 13 });
    expect(described.requiredFields).not.toContain('contactPhone');
  });

  it('guesses them from a trader’s own titles', () => {
    const guessed = suggestColumns(['Party GSTIN', 'Bill No', 'Party Phone', 'Party Email']);
    expect(guessed.contactPhone).toMatchObject({ index: 2 });
    expect(guessed.contactEmail).toMatchObject({ index: 3 });
  });

  it('honours a column map that points at a column of any name', () => {
    const [invoice] = parse(
      csv(['Party GSTIN,Bill No,Bill Date,Amount,Kind,Accounts WhatsApp', '27AAFFO2231R1ZX,A/1,3-Aug-26,1000,Invoice,9820012345']),
      {
        supplierGstin: 'Party GSTIN', invoiceNo: 'Bill No', invoiceDate: 'Bill Date',
        taxableValue: 'Amount', docType: 'Kind', contactPhone: 'Accounts WhatsApp'
      }
    );
    expect(invoice.supplierContact).toEqual({ person: null, phone: '9820012345', email: null });
  });
});
