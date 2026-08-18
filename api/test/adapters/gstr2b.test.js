import { describe, expect, it } from 'vitest';
import { NON_IMS_SECTIONS, TWOB_SECTIONS, identityKey, parse } from '../../src/adapters/gstr2b.js';
import { parse as parseIms } from '../../src/adapters/ims.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import {
  FIXTURES_PRESENT,
  PERIODS,
  groundTruth,
  readJson,
  sumRateLineTotals,
  summarize
} from '../helpers/fixtures.js';

const describeFixtures = FIXTURES_PRESENT ? describe : describe.skip;

describeFixtures('GSTR-2B adapter — fixtures', () => {
  it.each(PERIODS)('%s: document count matches the fixture summary', (period) => {
    const records = parse(readJson(period, 'gstr2b.json'));
    expect(records).toHaveLength(summarize(period).in2b);
  });

  it.each(PERIODS)('%s: per-section counts match the fixture summary', (period) => {
    const records = parse(readJson(period, 'gstr2b.json'));
    const bySection = {};
    for (const record of records) {
      bySection[record.section] = (bySection[record.section] ?? 0) + 1;
    }
    expect(bySection).toEqual(summarize(period).twoBSections);
  });

  it.each(PERIODS)('%s: flattens supplier -> document -> items', (period) => {
    const raw = readJson(period, 'gstr2b.json');
    const records = parse(raw);

    // A 2B b2b entry is one supplier holding many invoices; the adapter must emit
    // one record per invoice, not per supplier.
    const supplierGroups = (raw.docdata.b2b ?? []).length;
    const b2bRecords = records.filter((r) => r.section === 'b2b');
    expect(b2bRecords.length).toBeGreaterThan(supplierGroups);
    expect(b2bRecords).toHaveLength(
      (raw.docdata.b2b ?? []).reduce((n, g) => n + g.inv.length, 0)
    );
  });

  it.each(PERIODS)('%s: rate lines sum to the document totals', (period) => {
    const records = parse(readJson(period, 'gstr2b.json'));
    const withLines = records.filter((r) => r.rateLines.length > 0);
    expect(withLines.length).toBeGreaterThan(0);

    for (const record of withLines) {
      const summed = sumRateLineTotals(record.rateLines);
      expect(summed.taxableValue).toBe(record.taxableValue);
      expect(summed.igst).toBe(record.igst);
      expect(summed.cgst).toBe(record.cgst);
      expect(summed.sgst).toBe(record.sgst);
      expect(summed.cess).toBe(record.cess);
      expect(record.totalTax).toBe(summed.igst + summed.cgst + summed.sgst + summed.cess);
    }
  });

  it.each(PERIODS)('%s: multi-rate invoices really are present', (period) => {
    const records = parse(readJson(period, 'gstr2b.json'));
    // Otherwise the summing test above would pass on single-line documents.
    expect(records.filter((r) => r.rateLines.length > 1).length).toBeGreaterThan(0);
  });

  it.each(PERIODS)('%s: carries supfildt, cfs, itcavl and rsn', (period) => {
    const raw = readJson(period, 'gstr2b.json');
    const records = parse(raw);

    const b2b = records.filter((r) => r.section === 'b2b');
    for (const record of b2b) {
      expect(record.supplierFiledOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['Y', 'N']).toContain(record.counterpartyFilingStatus);
      expect(typeof record.itcAvailable).toBe('boolean');
      expect(record.supplierReturnPeriod).toMatch(/^\d{4}-\d{2}$/);
    }

    // itcavl = N carries the reason in rsn; the fixture includes POS-rule cases.
    const rawIneligible = (raw.docdata.b2b ?? []).flatMap((g) =>
      g.inv.filter((i) => i.itcavl === 'N')
    );
    expect(records.filter((r) => r.itcAvailable === false)).toHaveLength(rawIneligible.length);
    const reasons = rawIneligible.filter((i) => i.rsn);
    if (reasons.length) {
      expect(
        records.filter((r) => r.itcAvailable === false && r.itcIneligibleReason).length
      ).toBe(reasons.length);
    }
  });

  it.each(PERIODS)('%s: reverse-charge records come through flagged', (period) => {
    const raw = readJson(period, 'gstr2b.json');
    const records = parse(raw);
    const rawRcm = (raw.docdata.b2b ?? []).flatMap((g) => g.inv.filter((i) => i.rev === 'Y'));
    expect(records.filter((r) => r.section === 'b2b' && r.reverseCharge)).toHaveLength(
      rawRcm.length
    );
    expect(rawRcm.length).toBeGreaterThan(0);
  });

  it.each(PERIODS)('%s: isd uses doclist and itcelg, with no taxable value', (period) => {
    const raw = readJson(period, 'gstr2b.json');
    const records = parse(raw).filter((r) => r.section === 'isd');
    expect(records).toHaveLength(
      (raw.docdata.isd ?? []).reduce((n, g) => n + g.doclist.length, 0)
    );

    for (const record of records) {
      expect(['ISD_INVOICE', 'ISD_CREDIT']).toContain(record.docType);
      // The isd section carries no txval at all — the credit is the whole record.
      expect(record.taxableValue).toBe(0);
      expect(record.totalTax).toBeGreaterThan(0);
      expect(typeof record.itcAvailable).toBe('boolean');
      expect(record.supplyType).toBe(null);
    }
  });

  it.each(PERIODS)('%s: impg has no supplier GSTIN and is keyed on portcode+boenum', (period) => {
    const raw = readJson(period, 'gstr2b.json');
    const records = parse(raw).filter((r) => r.section === 'impg');
    expect(records).toHaveLength((raw.docdata.impg ?? []).length);

    for (const record of records) {
      expect(record.supplierGstin).toBe(null);
      expect(record.portCode).toBeTruthy();
      expect(record.docType).toBe('BOE');
      // Imports are IGST + cess only.
      expect(record.cgst).toBe(0);
      expect(record.sgst).toBe(0);
      expect(identityKey(record)).toContain(record.portCode);
      expect(identityKey(record)).toContain(record.invoiceNo);
    }
  });

  it.each(PERIODS)('%s: contentHash reproduces the ground-truth hash', (period) => {
    const records = parse(readJson(period, 'gstr2b.json'));
    const expected = new Set(
      groundTruth(period)
        .documents.filter((d) => d.portal?.contentHash)
        .map((d) => d.portal.contentHash)
    );
    // isd/impg have no books counterpart and so no hash in the ground truth.
    for (const record of records.filter((r) => !NON_IMS_SECTIONS.has(r.section))) {
      expect(expected.has(record.contentHash), `unknown hash for ${record.invoiceNo}`).toBe(true);
      expect(record.contentHash).toBe(
        computeContentHash({
          supplierGstin: record.supplierGstin,
          invoiceNoNorm: record.invoiceNoNorm,
          invoiceDate: record.invoiceDate,
          taxableValue: record.taxableValue,
          totalTax: record.totalTax,
          docType: record.docType
        })
      );
    }
  });

  it.each(PERIODS)('%s: 2B chksum is the head of our contentHash', (period) => {
    const raw = readJson(period, 'gstr2b.json');
    const records = parse(raw);
    // Zip positionally: the same supplier can carry the same invoice number and
    // date twice, so no key built from the record fields is unique. This also
    // pins the supplier -> document flattening order.
    const flattened = (raw.docdata.b2b ?? []).flatMap((group) =>
      group.inv.map((inv) => ({ group, inv }))
    );
    const b2bRecords = records.filter((r) => r.section === 'b2b');
    expect(b2bRecords).toHaveLength(flattened.length);

    let checked = 0;
    flattened.forEach(({ group, inv }, index) => {
      const record = b2bRecords[index];
      expect(record.supplierGstin).toBe(group.ctin);
      expect(record.invoiceNo).toBe(inv.inum);
      if (!inv.chksum) return;
      expect(record.contentHash.startsWith(inv.chksum)).toBe(true);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(0);
  });

  it.each(PERIODS)('%s: isd and impg appear only from 2B, never from IMS', (period) => {
    const twoB = parse(readJson(period, 'gstr2b.json'));
    const ims = parseIms(readJson(period, 'ims.json'));

    const twoBNonIms = twoB.filter((r) => NON_IMS_SECTIONS.has(r.section));
    expect(twoBNonIms.length).toBeGreaterThan(0);
    expect(ims.filter((r) => NON_IMS_SECTIONS.has(r.section))).toHaveLength(0);

    // IMS has 8 sections, 2B has 10 — the two extras are exactly these.
    const twoBSections = new Set(twoB.map((r) => r.section));
    const imsSections = new Set(ims.map((r) => r.section));
    for (const section of imsSections) expect(NON_IMS_SECTIONS.has(section)).toBe(false);
    expect([...twoBSections].some((s) => NON_IMS_SECTIONS.has(s))).toBe(true);
  });

  it.each(PERIODS)('%s: every record is a filed snapshot in the envelope period', (period) => {
    const records = parse(readJson(period, 'gstr2b.json'));
    for (const record of records) {
      expect(record.source).toBe('GSTR2B');
      // Only filed records reach 2B.
      expect(record.filingStatus).toBe('FILED');
      expect(record.imsAction).toBe(null);
      expect(record.taxPeriod).toBe(period);
    }
  });
});

describe('GSTR-2B adapter — shapes and failure modes', () => {
  const envelope = (docdata, rtnprd = '032026') => ({ chksum: 'x', rtnprd, docdata });

  const invoice = {
    inum: 'INV/DEL/2026/4471',
    dt: '08-02-2026',
    val: 118000,
    typ: 'R',
    pos: '27',
    rev: 'N',
    itcavl: 'Y',
    rsn: '',
    diffprcnt: 100,
    cfs: 'Y',
    items: [
      { hsn: '8471', rt: 18, txval: 100000, igst: 18000, cgst: 0, sgst: 0, cess: 0 }
    ]
  };

  it('reads the tax period from the envelope rtnprd', () => {
    const [record] = parse(
      envelope({ b2b: [{ ctin: '27AABCU9603R1ZM', trdnm: 'Dell', supfildt: '11-03-2026', supprd: '022026', inv: [invoice] }] })
    );
    expect(record.taxPeriod).toBe('2026-03');
    expect(record.supplierReturnPeriod).toBe('2026-02');
    expect(record.supplierFiledOn).toBe('2026-03-11');
  });

  it('reads a credit note from ntnum/ntdt, with typ as the note type', () => {
    const records = parse(
      envelope({
        cdnr: [
          {
            ctin: '27AABCU9603R1ZM',
            trdnm: 'Krishna',
            supfildt: '11-03-2026',
            supprd: '032026',
            nt: [
              { ntnum: 'CN/1', ntdt: '14-03-2026', typ: 'C', val: 1000, pos: '27', rev: 'N', itcavl: 'Y', items: [{ rt: 18, txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }] },
              { ntnum: 'DN/1', ntdt: '15-03-2026', typ: 'D', val: 1000, pos: '27', rev: 'N', itcavl: 'Y', items: [{ rt: 18, txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }] }
            ]
          }
        ]
      })
    );
    expect(records.map((r) => r.docType)).toEqual(['CREDIT_NOTE', 'DEBIT_NOTE']);
    expect(records.map((r) => r.section)).toEqual(['cdnr', 'cdnr']);
    // typ on a note is C/D, so there is no supply type to read.
    expect(records.map((r) => r.supplyType)).toEqual([null, null]);
    expect(records[0].invoiceNo).toBe('CN/1');
  });

  it('accepts the nt_num spelling as well', () => {
    const [record] = parse(
      envelope({
        cdnr: [
          {
            ctin: '27AABCU9603R1ZM',
            supprd: '032026',
            nt: [{ nt_num: 'CN/2', nt_dt: '14-03-2026', typ: 'C', txval: 1000, igst: 180 }]
          }
        ]
      })
    );
    expect(record.invoiceNo).toBe('CN/2');
    expect(record.taxableValue).toBe(100000);
  });

  it('falls back to document-level amounts when items is absent', () => {
    const [record] = parse(
      envelope({
        b2b: [
          {
            ctin: '27AABCU9603R1ZM',
            supprd: '032026',
            inv: [{ inum: 'X/1', dt: '08-03-2026', typ: 'R', pos: '27', txval: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 }]
          }
        ]
      })
    );
    expect(record.taxableValue).toBe(500000);
    expect(record.totalTax).toBe(90000);
    expect(record.rateLines).toEqual([]);
  });

  it('treats an absent diffprcnt as 100', () => {
    const { diffprcnt, ...noDiff } = invoice;
    const [record] = parse(
      envelope({ b2b: [{ ctin: '27AABCU9603R1ZM', supprd: '032026', inv: [noDiff] }] })
    );
    expect(record.differentialPercent).toBe(100);
  });

  it('carries the ineligibility reason when itcavl is N', () => {
    const [record] = parse(
      envelope({
        b2b: [
          {
            ctin: '27AABCU9603R1ZM',
            supprd: '032026',
            inv: [{ ...invoice, itcavl: 'N', rsn: 'POS' }]
          }
        ]
      })
    );
    expect(record.itcAvailable).toBe(false);
    expect(record.itcIneligibleReason).toBe('POS');
  });

  it('accepts etin for the e-commerce sections', () => {
    const [record] = parse(
      envelope({ ecom: [{ etin: '27AABCU9603R1ZM', supprd: '032026', inv: [invoice] }] })
    );
    expect(record.section).toBe('ecom');
    expect(record.supplierGstin).toBe('27AABCU9603R1ZM');
  });

  it('refuses an unknown section rather than dropping it', () => {
    expect(() => parse(envelope({ b2b: [], b2bcn: [] }))).toThrow(/unknown section\(s\): b2bcn/);
  });

  it('refuses an unknown coded value', () => {
    expect(() =>
      parse(envelope({ b2b: [{ ctin: '27AABCU9603R1ZM', supprd: '032026', inv: [{ ...invoice, typ: 'ZZ' }] }] }))
    ).toThrow(/typ has unknown value/);
    expect(() =>
      parse(envelope({ isd: [{ ctin: '27AABCU9603R1ZM', supprd: '032026', doclist: [{ docnum: 'I/1', docdt: '01-03-2026', doctyp: 'ZZ', igst: 10 }] }] }))
    ).toThrow(/doctyp has unknown value/);
  });

  it('reports the path to a bad record', () => {
    expect(() =>
      parse(envelope({ b2b: [{ ctin: '27AABCU9603R1ZM', supprd: '032026', inv: [{ dt: '08-03-2026', typ: 'R' }] }] }))
    ).toThrow(/docdata\.b2b\[0\]\.inv\[0\]: inum is missing/);
  });

  it('refuses a file with no rtnprd unless a period is supplied', () => {
    const docdata = { b2b: [{ ctin: '27AABCU9603R1ZM', supprd: '032026', inv: [invoice] }] };
    expect(() => parse({ docdata })).toThrow(/no rtnprd and no taxPeriod/);
    expect(parse({ docdata }, { taxPeriod: '2026-03' })[0].taxPeriod).toBe('2026-03');
  });

  it('knows which sections never enter IMS', () => {
    expect([...NON_IMS_SECTIONS].sort()).toEqual(['impg', 'impgsez', 'isd', 'isda']);
    expect(TWOB_SECTIONS).toHaveLength(10);
  });
});
