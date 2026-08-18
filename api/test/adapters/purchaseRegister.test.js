import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  FORMAT_GSTR2_CSV,
  FORMAT_TEMPLATE_V24,
  FORMAT_UNKNOWN,
  detectFormat,
  parse,
  parseWithMetadata
} from '../../src/adapters/purchaseRegister.js';
import { FIXTURES_PRESENT, PERIODS, readBuffer, summarize } from '../helpers/fixtures.js';

const describeFixtures = FIXTURES_PRESENT ? describe : describe.skip;

describeFixtures('purchase register — v2.4 template fixtures', () => {
  it('detects the template format', () => {
    expect(detectFormat(readBuffer(PERIODS[0], 'purchase_register.xlsx'))).toBe(
      FORMAT_TEMPLATE_V24
    );
  });

  it.each(PERIODS)('%s: document count matches the fixture summary', (period) => {
    const invoices = parse(readBuffer(period, 'purchase_register.xlsx'));
    expect(invoices).toHaveLength(summarize(period).inBooks);
  });

  it.each(PERIODS)('%s: reads the header metadata and resolves the tax period', (period) => {
    const { metadata, taxPeriod, invoices } = parseWithMetadata(
      readBuffer(period, 'purchase_register.xlsx')
    );
    expect(metadata.recipientGstin).toMatch(/^[0-9A-Z]{15}$/);
    expect(metadata.recipientName).toBeTruthy();
    // 'Financial year* : 2025-26' + 'Tax period* : March' -> '2026-03'
    expect(taxPeriod).toBe(period);
    expect(new Set(invoices.map((i) => i.taxPeriod))).toEqual(new Set([period]));
  });

  it.each(PERIODS)('%s: every invoice matches a books row in the ground truth', (period) => {
    const invoices = parse(readBuffer(period, 'purchase_register.xlsx'));
    const gt = summarize(period);
    expect(invoices).toHaveLength(gt.inBooks);

    for (const invoice of invoices) {
      expect(invoice.supplierGstin).toMatch(/^[0-9A-Z]{15}$/);
      expect(invoice.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(invoice.taxableValue)).toBe(true);
      expect(invoice.totalTax).toBe(invoice.igst + invoice.cgst + invoice.sgst + invoice.cess);
      expect(['INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE']).toContain(invoice.docType);
      expect(['B2B', 'DE', 'SEZWP', 'SEZWOP']).toContain(invoice.supplyType);
    }
  });

  it.each(PERIODS)('%s: books totals agree with the ground truth per document', (period) => {
    const invoices = parse(readBuffer(period, 'purchase_register.xlsx'));
    const gt = JSON.parse(
      readBuffer(period, 'ground_truth.json').toString('utf8')
    ).documents.filter((d) => d.presence.inBooks);

    // Key on the full identity: the fixtures deliberately repeat an invoice
    // number for the same supplier and date (the DUPLICATE_INV_NO defect).
    const keyOf = (gstin, no, date, taxable) => [gstin, no, date, taxable].join('|');
    const expected = new Map();
    for (const doc of gt) {
      const key = keyOf(
        doc.books.supplierGstin,
        doc.books.invoiceNo,
        doc.books.invoiceDate,
        doc.books.taxablePaise
      );
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }

    for (const invoice of invoices) {
      const key = keyOf(
        invoice.supplierGstin,
        invoice.invoiceNo,
        invoice.invoiceDate,
        invoice.taxableValue
      );
      expect(expected.get(key), `no ground-truth books row for ${key}`).toBeGreaterThan(0);
      expected.set(key, expected.get(key) - 1);
    }
  });

  it.each(PERIODS)('%s: never collapses two register rows into one document', (period) => {
    // The v2.4 template is one row per document, so a repeated
    // (supplier, invoice number) — the DUPLICATE_INV_NO defect — must survive as
    // two documents. Comparing per-key counts against the ground truth proves no
    // grouping pass ran on this path.
    const invoices = parse(readBuffer(period, 'purchase_register.xlsx'));
    const gt = JSON.parse(readBuffer(period, 'ground_truth.json').toString('utf8'));

    const tally = (entries) => {
      const counts = new Map();
      for (const [gstin, norm] of entries) {
        const key = `${gstin}|${norm}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };

    const parsed = tally(invoices.map((i) => [i.supplierGstin, i.invoiceNoNorm]));
    const expected = tally(
      gt.documents
        .filter((d) => d.presence.inBooks)
        .map((d) => [d.books.supplierGstin, d.books.invoiceNoNorm])
    );

    expect(parsed).toEqual(expected);
    // And the fixture really does contain a repeat, or this proves nothing.
    expect([...expected.values()].some((n) => n > 1)).toBe(true);
  });

  it.each(PERIODS)('%s: comma-formatted amount cells parse to the same paise', (period) => {
    // The generator writes a slice of cells as Indian-grouped strings. Prove the
    // string path and the number path agree by re-reading the raw sheet.
    const buffer = readBuffer(period, 'purchase_register.xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Purchase Register'], {
      header: 1,
      raw: true,
      blankrows: true,
      defval: null
    });
    const invoices = parse(buffer);

    const stringCells = [];
    for (let i = 5; i < rows.length; i += 1) {
      for (let c = 6; c <= 10; c += 1) {
        if (typeof rows[i]?.[c] === 'string') stringCells.push({ row: i + 1, col: c, raw: rows[i][c] });
      }
    }
    expect(stringCells.length).toBeGreaterThan(0);

    const fields = { 6: 'taxableValue', 7: 'igst', 8: 'cgst', 9: 'sgst', 10: 'cess' };
    for (const { row, col, raw } of stringCells) {
      const invoice = invoices.find((i) => i.sourceRowNo === row);
      expect(invoice, `no invoice parsed from row ${row}`).toBeTruthy();
      const digitsOnly = raw.replace(/,/g, '');
      const expectedPaise = Math.round(Number(digitsOnly) * 100);
      expect(invoice[fields[col]]).toBe(expectedPaise);
      // and the comma actually mattered
      if (raw.includes(',')) expect(Number(raw)).toBeNaN();
    }
  });

  it.each(PERIODS)('%s: the v2.4 template carries no rate detail', (period) => {
    const invoices = parse(readBuffer(period, 'purchase_register.xlsx'));
    // One row per document and no Rate column: there is nothing to split out.
    for (const invoice of invoices) expect(invoice.rateLines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GSTR-2 CSV: one row per invoice x rate. No fixture ships in this format, so
// the cases below are built from the column list and sample values in
// docs/purchase-register-schema.md.
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'GSTIN of Supplier,Invoice Number,Invoice date,Invoice Value,Place Of Supply,' +
  'Reverse Charge,Invoice Type,Rate,Taxable Value,Integrated Tax Paid,' +
  'Central Tax Paid,State/UT Tax Paid,Cess Paid,Eligibility For ITC';

function csv(...lines) {
  return Buffer.from([CSV_HEADER, ...lines].join('\n'), 'utf8');
}

describe('purchase register — GSTR-2 CSV', () => {
  const twoRateInvoice = csv(
    '27AABCU9603R1ZM,A/1003,14-Jul-17,"1,10,000",29-Karnataka,N,Regular,12,"10,000","1,200",0,0,0,Inputs',
    '27AABCU9603R1ZM,A/1003,14-Jul-17,"1,10,000",29-Karnataka,N,Regular,5,"35,000","1,750",0,0,0,Inputs'
  );

  it('detects the CSV format', () => {
    expect(detectFormat(twoRateInvoice)).toBe(FORMAT_GSTR2_CSV);
  });

  it('groups rate rows into one document and sums the heads', () => {
    const invoices = parse(twoRateInvoice);
    expect(invoices).toHaveLength(1);

    const [invoice] = invoices;
    expect(invoice.invoiceNo).toBe('A/1003');
    expect(invoice.invoiceNoNorm).toBe('A1003');
    expect(invoice.invoiceDate).toBe('2017-07-14');
    expect(invoice.taxableValue).toBe(4500000); // 10,000 + 35,000
    expect(invoice.igst).toBe(295000); // 1,200 + 1,750
    expect(invoice.totalTax).toBe(295000);
    expect(invoice.placeOfSupply).toBe('29');
    expect(invoice.supplyType).toBe('B2B');
    expect(invoice.reverseCharge).toBe(false);
    expect(invoice.itcEligibility).toBe('Inputs');
  });

  it('keeps the rate lines, and they sum to the document totals', () => {
    const [invoice] = parse(twoRateInvoice);
    expect(invoice.rateLines).toHaveLength(2);
    expect(invoice.rateLines.map((l) => l.rate)).toEqual([12, 5]);

    const summed = invoice.rateLines.reduce(
      (acc, l) => ({
        taxableValue: acc.taxableValue + l.taxableValue,
        igst: acc.igst + l.igst
      }),
      { taxableValue: 0, igst: 0 }
    );
    expect(summed.taxableValue).toBe(invoice.taxableValue);
    expect(summed.igst).toBe(invoice.igst);
  });

  it('separates documents that differ only by date', () => {
    const invoices = parse(
      csv(
        '27AABCU9603R1ZM,A/1003,14-Jul-17,50000,29-Karnataka,N,Regular,12,10000,1200,0,0,0,Inputs',
        '27AABCU9603R1ZM,A/1003,15-Jul-17,50000,29-Karnataka,N,Regular,12,10000,1200,0,0,0,Inputs'
      )
    );
    expect(invoices).toHaveLength(2);
  });

  it('maps the documented invoice-type vocabulary and the reverse-charge flag', () => {
    const invoices = parse(
      csv(
        '27AABCU9603R1ZM,S/1,1-Jul-17,1000,29-Karnataka,Y,SEZ supplies without payment,0,1000,0,0,0,0,Ineligible',
        '27AABCU9603R1ZM,D/1,1-Jul-17,1000,29-Karnataka,N,Deemed Exp,0,1000,0,0,0,0,Inputs'
      )
    );
    expect(invoices.map((i) => i.supplyType)).toEqual(['SEZWOP', 'DE']);
    expect(invoices.map((i) => i.reverseCharge)).toEqual([true, false]);
  });

  it('derives the tax period from the document date when none is supplied', () => {
    const [invoice] = parse(twoRateInvoice);
    expect(invoice.taxPeriod).toBe('2017-07');
  });

  it('lets an explicit tax period override the derived one', () => {
    const [invoice] = parse(twoRateInvoice, null, { taxPeriod: '2017-08' });
    expect(invoice.taxPeriod).toBe('2017-08');
  });

  it('reads a credit note from the cdnr column vocabulary', () => {
    const buffer = Buffer.from(
      [
        'GSTIN of Supplier,Note/Refund Voucher Number,Note/Refund Voucher date,' +
          'Invoice/Advance Payment Voucher Number,Invoice/Advance Payment Voucher date,' +
          'Document Type,Supply Type,Rate,Taxable Value,Integrated Tax Paid,' +
          'Central Tax Paid,State/UT Tax Paid,Cess Paid',
        '27AABCU9603R1ZM,CN/7,20-Jul-17,A/1003,14-Jul-17,C,Regular,12,"5,000",600,0,0,0'
      ].join('\n'),
      'utf8'
    );
    const [note] = parse(buffer);
    expect(note.docType).toBe('CREDIT_NOTE');
    expect(note.invoiceNo).toBe('CN/7');
    expect(note.originalInvoiceNo).toBe('A/1003');
    expect(note.originalInvoiceDate).toBe('2017-07-14');
    expect(note.taxableValue).toBe(500000);
  });
});

describe('purchase register — column mapping and failure modes', () => {
  it('accepts a columnMap for a file with the trader’s own headers', () => {
    const buffer = Buffer.from(
      [
        'Party GST,Bill No,Bill Dt,Base Amount,IGST Amt',
        '27AABCU9603R1ZM,B-99,3-Mar-26,"1,00,000","18,000"'
      ].join('\n'),
      'utf8'
    );
    // Unmapped, the file is not recognisable as either template.
    expect(detectFormat(buffer)).toBe(FORMAT_UNKNOWN);

    const invoices = parse(
      buffer,
      {
        supplierGstin: 'Party GST',
        invoiceNo: 'Bill No',
        invoiceDate: 'Bill Dt',
        taxableValue: 'Base Amount',
        igst: 'IGST Amt'
      },
      { format: FORMAT_GSTR2_CSV }
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0].taxableValue).toBe(10000000);
    expect(invoices[0].igst).toBe(1800000);
    expect(invoices[0].invoiceDate).toBe('2026-03-03');
  });

  it('maps by column index too', () => {
    const buffer = Buffer.from(['a,b,c,d', '27AABCU9603R1ZM,B-99,3-Mar-26,1000'].join('\n'), 'utf8');
    const invoices = parse(
      buffer,
      { supplierGstin: 0, invoiceNo: 1, invoiceDate: 2, taxableValue: 3 },
      { format: FORMAT_GSTR2_CSV }
    );
    expect(invoices[0].taxableValue).toBe(100000);
  });

  it('refuses an unrecognised file rather than returning an empty list', () => {
    expect(() => parse(Buffer.from('not a register at all', 'utf8'))).toThrow(
      /unrecognised purchase-register format/
    );
  });

  it('names the row and column when a required cell is unusable', () => {
    const buffer = Buffer.from(
      [
        'GSTIN of Supplier,Invoice Number,Invoice date,Taxable Value',
        '27AABCU9603R1ZM,B-99,not-a-date,1000'
      ].join('\n'),
      'utf8'
    );
    expect(() => parse(buffer)).toThrow(/row 2: document date is not d-MMM-yy/);
  });

  it('refuses a columnMap that points at a header the file does not have', () => {
    const buffer = Buffer.from(
      ['GSTIN of Supplier,Invoice Number,Invoice date,Taxable Value', '27AABCU9603R1ZM,B-99,3-Mar-26,1'].join('\n'),
      'utf8'
    );
    expect(() => parse(buffer, { taxableValue: 'Nope' })).toThrow(/not in the file/);
  });
});
