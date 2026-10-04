// The purchase register's optional "Supplier filing frequency" column: Monthly or
// Quarterly, case-insensitive, read as the canonical filing scheme. Like the
// contact columns it is the app's own extension, never required.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAPPABLE_FIELDS, describeColumns, parse } from '../../src/adapters/purchaseRegister.js';
import { supplierOf } from '../../../tools/demo-timeline.js';
import { demoRegister } from '../helpers/demoFiles.js';
import { readBuffer } from '../helpers/fixtures.js';

const csv = (lines) => Buffer.from(lines.join('\n'), 'utf8');
const header = 'GSTIN of Supplier,Invoice Number,Invoice date,Taxable Value,Rate,Supplier filing frequency';

describe('the demo register', () => {
  it('says Krishna files quarterly and leaves everyone else blank', () => {
    const invoices = parse(readFileSync(demoRegister('aug')));
    const krishna = invoices.find((invoice) => invoice.supplierGstin === supplierOf('krishna').gstin);
    expect(krishna.supplierFilingScheme).toBe('QRMP');
    const others = invoices.filter((invoice) => invoice !== krishna);
    expect(others.every((invoice) => invoice.supplierFilingScheme === null)).toBe(true);
  });
});

describe('the column', () => {
  it('reads Monthly and Quarterly in any case, and blank as nothing said', () => {
    const invoices = parse(csv([
      header,
      '27AAFFO2231R1ZX,A/1,3-Aug-26,1000,18,MONTHLY',
      '27AKLPG6614M1ZS,B/1,4-Aug-26,1000,18,quarterly',
      '29AACCL3907B1ZT,C/1,5-Aug-26,1000,18,'
    ]));
    expect(invoices.map((invoice) => invoice.supplierFilingScheme)).toEqual(['MONTHLY', 'QRMP', null]);
  });

  it('refuses anything else, naming what it expects', () => {
    expect(() => parse(csv([header, '27AAFFO2231R1ZX,A/1,3-Aug-26,1000,18,Yearly']))).toThrow(/Monthly or Quarterly/);
  });

  it('is absent from a register that does not carry it', () => {
    const invoices = parse(readBuffer('2026-03', 'purchase_register.xlsx'));
    expect(invoices.every((invoice) => invoice.supplierFilingScheme === null)).toBe(true);
  });

  it('can be pointed at by a column map, and is offered as a guess for one', () => {
    expect(MAPPABLE_FIELDS).toContain('filingFrequency');
    const described = describeColumns(csv(['GSTIN of Supplier,Invoice Number,Invoice date,Taxable Value,Filing Frequency']));
    expect(described.mapped.filingFrequency).toBe(4);
  });
});
