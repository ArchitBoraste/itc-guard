// A Tally-style purchase-register CSV built from a fixture period's v2.4 register:
// the shape a trader's own export has, and the one the audit uploaded (P30-P33).
//
//   Party GSTIN, Party Name, Voucher Type, Bill No, Bill Date (dd/mm/yyyy),
//   Taxable Amount, IGST, CGST, SGST, Cess, Bill Amount ("3,63,097.00")
//
// One row per document, so the GSTR-2 CSV path groups each into one invoice.
import { parse as parseRegister } from '../../src/adapters/purchaseRegister.js';
import { formatPaise } from '../../src/matching/recommend.js';
import { readBuffer } from './fixtures.js';

export const TALLY_HEADERS = Object.freeze([
  'Party GSTIN', 'Party Name', 'Voucher Type', 'Bill No', 'Bill Date',
  'Taxable Amount', 'IGST', 'CGST', 'SGST', 'Cess', 'Bill Amount'
]);

// What the column mapper proposes for these headers, as a columnMap.
export const TALLY_COLUMN_MAP = Object.freeze({
  supplierGstin: 'Party GSTIN',
  supplierName: 'Party Name',
  docType: 'Voucher Type',
  invoiceNo: 'Bill No',
  invoiceDate: 'Bill Date',
  taxableValue: 'Taxable Amount',
  igst: 'IGST',
  cgst: 'CGST',
  sgst: 'SGST',
  cess: 'Cess',
  invoiceValue: 'Bill Amount'
});

const VOUCHER_TYPE = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note' };

// What Tally actually writes: every purchase invoice is a "Purchase" voucher.
export const tallyVoucherType = (invoice) =>
  invoice.docType === 'INVOICE' ? 'Purchase' : VOUCHER_TYPE[invoice.docType];

const quote = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// tallyCsv(period, { voucherType }) -> Buffer
//   voucherType(invoice) -> the Voucher Type cell; defaults to the document type.
export function tallyCsv(period, { voucherType = (invoice) => VOUCHER_TYPE[invoice.docType] } = {}) {
  const invoices = parseRegister(readBuffer(period, 'purchase_register.xlsx'));
  const lines = [TALLY_HEADERS.join(',')];
  for (const invoice of invoices) {
    lines.push(
      [
        invoice.supplierGstin,
        invoice.supplierName ?? '',
        voucherType(invoice),
        invoice.invoiceNo,
        ddmmyyyy(invoice.invoiceDate),
        formatPaise(invoice.taxableValue),
        formatPaise(invoice.igst),
        formatPaise(invoice.cgst),
        formatPaise(invoice.sgst),
        formatPaise(invoice.cess),
        formatPaise(invoice.taxableValue + invoice.totalTax)
      ].map((cell) => quote(String(cell))).join(',')
    );
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export const columnMapWithout = (...fields) =>
  Object.fromEntries(Object.entries(TALLY_COLUMN_MAP).filter(([field]) => !fields.includes(field)));
