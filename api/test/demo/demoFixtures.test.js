// The live demo's sample files: the story they tell, and that the committed files
// still tell it.
//
// tools/demo-timeline.js is the story as data; the generator writes fixtures/demo/
// from it. These check the story's own invariants (a snapshot is cumulative, 2B
// carries filed records only, the books add up to what the script says) and that
// the files in the repo read back through the adapters as the timeline says —
// an edit to the timeline without `npm run gen:demo` fails here.
import { describe, expect, it } from 'vitest';

import { isValidGstin } from '../../src/matching/normalize.js';
import {
  PERIODS,
  PERIOD_KEYS,
  PORTAL,
  REGISTER,
  SUPPLIERS,
  TRADER,
  imsFileName,
  imsSnapshot,
  placeholderContact,
  stateOn,
  twoBDocuments
} from '../../../tools/demo-timeline.js';
import { checkSet } from '../../../tools/generate-demo-fixtures.js';

const signedTax = (doc) => (doc.docType === 'CREDIT_NOTE' ? -1 : 1) * doc.amounts.totalTax;
const netItc = (periodKey) => REGISTER[periodKey].reduce((sum, doc) => sum + signedTax(doc), 0);
const ids = (entries) => entries.map(({ doc }) => doc.id);
const byNumber = (periodKey, supplierKey, invoiceNo) =>
  PORTAL.find((doc) => doc.period === periodKey && doc.supplier.key === supplierKey && doc.invoiceNo === invoiceNo);

describe('the demo trader and suppliers', () => {
  it('uses GSTINs that pass the real check digit', () => {
    expect(TRADER.gstin).toBe('27AABCS1080F1ZN');
    for (const gstin of [TRADER.gstin, ...SUPPLIERS.map((supplier) => supplier.gstin)]) {
      expect(isValidGstin(gstin), gstin).toBe(true);
    }
    expect(new Set(SUPPLIERS.map((supplier) => supplier.gstin)).size).toBe(SUPPLIERS.length);
  });

  it('commits placeholder contacts only', () => {
    const orbit = placeholderContact(SUPPLIERS[0]);
    expect(orbit).toEqual({ person: 'Sample contact 01', phone: '+91 00000 00001', email: 'supplier1@example.com' });
  });

  it('keeps Reliable Traders out of every register', () => {
    for (const periodKey of PERIOD_KEYS) {
      expect(REGISTER[periodKey].some((doc) => doc.supplier.key === 'reliable')).toBe(false);
    }
  });
});

describe('the registers', () => {
  it('add up to the script: Rs 42,660 for August, Rs 37,080 for September', () => {
    expect(REGISTER.aug).toHaveLength(11);
    expect(REGISTER.sep).toHaveLength(10);
    expect(netItc('aug')).toBe(4266000);
    expect(netItc('sep')).toBe(3708000);
  });

  it('splits CGST/SGST within Maharashtra and charges IGST across states', () => {
    const orbit = REGISTER.aug.find((doc) => doc.invoiceNo === 'INV-0801');
    expect(orbit.amounts).toMatchObject({ igst: 0, cgst: 450000, sgst: 450000 });
    const laxmi = REGISTER.aug.find((doc) => doc.invoiceNo === 'LC-821');
    expect(laxmi.amounts).toMatchObject({ igst: 540000, cgst: 0, sgst: 0 });
  });
});

describe('the IMS snapshots', () => {
  it('are cumulative, and a filed record never goes back to saved', () => {
    for (const periodKey of PERIOD_KEYS) {
      let previous = [];
      for (const date of PERIODS[periodKey].snapshots) {
        const current = imsSnapshot(periodKey, date);
        expect(ids(current)).toEqual(expect.arrayContaining(ids(previous)));
        for (const { doc, state } of previous) {
          if (state.status === 'FILED') expect(stateOn(doc, date).status).toBe('FILED');
        }
        previous = current;
      }
    }
  });

  it('follow the August timeline', () => {
    const at = (date) => Object.fromEntries(imsSnapshot('aug', date).map(({ doc, state }) => [doc.invoiceNo, state.status]));
    expect(at('2026-09-05')).toEqual({ 'INV-0801': 'FILED', 'MS-878': 'FILED' });
    expect(at('2026-09-07')).toMatchObject({ 'GT/0145': 'SAVED', 'NS-612': 'SAVED', 'UD-1905': 'FILED' });
    expect(at('2026-09-10')).toMatchObject({ 'GT/0145': 'FILED', 'BA/291': 'FILED', 'AE/177': 'SAVED' });
    expect(at('2026-09-11')).toMatchObject({ 'NS-612': 'FILED', 'RT-760': 'FILED', 'AE/177': 'SAVED' });
    expect(at('2026-09-11')).not.toHaveProperty('PS-3401');
    expect(at('2026-09-11')).not.toHaveProperty('KE-112');
  });

  it('show National saved high on 5 Oct and corrected by 10 Oct', () => {
    const national = byNumber('sep', 'national', 'NS-701');
    expect(stateOn(national, '2026-10-05')).toMatchObject({ status: 'SAVED', amounts: { taxable: 2000000, totalTax: 360000 } });
    expect(stateOn(national, '2026-10-10')).toMatchObject({ status: 'FILED', amounts: { taxable: 1800000, totalTax: 324000 } });
  });

  it("carry August's late documents in every September snapshot except Krishna's", () => {
    for (const date of PERIODS.sep.snapshots) {
      const numbers = imsSnapshot('sep', date).map(({ doc }) => doc.invoiceNo);
      expect(numbers).toEqual(expect.arrayContaining(['MS-878', 'PS-3401', 'AE/177']));
      expect(numbers).not.toContain('KE-112');
      expect(numbers).not.toContain('KE-130');
    }
  });

  it('put the GSTR-1A amendment in the amendment section with its original', () => {
    const amendment = byNumber('sep', 'mahavir', 'MS-878');
    expect(amendment.amendment).toEqual({ originalInvoiceNo: 'MS-878', originalInvoiceDate: '2026-08-11' });
    expect(amendment.sourceForm).toBe('R1A');
    expect(byNumber('sep', 'patel', 'PS-3401').amendment).toBeNull();
  });

  it('name each file after its date', () => {
    expect(imsFileName('aug', '2026-09-05')).toBe('ims_aug26_as_of_05sep.json');
    expect(imsFileName('sep', '2026-10-11')).toBe('ims_sep26_as_of_11oct.json');
  });
});

describe('GSTR-2B', () => {
  it('carries filed records only', () => {
    const august = twoBDocuments('aug').map(({ doc }) => doc.invoiceNo).sort();
    expect(august).toEqual(['BA/291', 'CE-CN-08', 'GT/0145', 'INV-0801', 'LC-821', 'MS-878', 'NS-612', 'RT-760', 'UD-1905']);
    for (const { state } of [...twoBDocuments('aug'), ...twoBDocuments('sep')]) expect(state.status).toBe('FILED');
  });

  it("brings Krishna's quarterly filing and Balaji's absence into September", () => {
    const september = twoBDocuments('sep').map(({ doc }) => doc.invoiceNo);
    expect(september).toEqual(expect.arrayContaining(['KE-112', 'KE-130', 'MS-878', 'PS-3401', 'AE/177']));
    expect(september).not.toContain('BA/305');
  });
});

describe('the committed files', () => {
  it('read back through the adapters exactly as the timeline says', () => {
    expect(() => checkSet()).not.toThrow();
  });
});
