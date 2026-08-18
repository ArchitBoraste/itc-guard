import { describe, expect, it } from 'vitest';
import { IMS_SECTIONS, parse } from '../../src/adapters/ims.js';
import { computeContentHash } from '../../src/adapters/contentHash.js';
import { FIXTURES_PRESENT, PERIODS, groundTruth, readJson, summarize } from '../helpers/fixtures.js';

const describeFixtures = FIXTURES_PRESENT ? describe : describe.skip;

describeFixtures('IMS adapter — fixtures', () => {
  it.each(PERIODS)('%s: record count matches the fixture summary', (period) => {
    const records = parse(readJson(period, 'ims.json'));
    expect(records).toHaveLength(summarize(period).inIms);
  });

  it.each(PERIODS)('%s: every record is canonical and IMS-sourced', (period) => {
    const records = parse(readJson(period, 'ims.json'));
    for (const record of records) {
      expect(record.source).toBe('IMS');
      expect(record.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(record.taxPeriod).toBe(period);
      expect(Number.isInteger(record.taxableValue)).toBe(true);
      expect(record.totalTax).toBe(record.igst + record.cgst + record.sgst + record.cess);
      expect(['SAVED', 'FILED']).toContain(record.filingStatus);
      expect(['A', 'R', 'P', 'N']).toContain(record.imsAction);
      expect(record.placeOfSupply).toMatch(/^\d{2}$/);
      expect(typeof record.pendingBlocked).toBe('boolean');
      expect(typeof record.remarksBlocked).toBe('boolean');
      expect(typeof record.itcReductionBlocked).toBe('boolean');
    }
  });

  it.each(PERIODS)('%s: carries all four flags the later phases depend on', (period) => {
    const records = parse(readJson(period, 'ims.json'));
    const raw = readJson(period, 'ims.json').imsDetails;

    // srcfilstatus, ispendactblocked, isRemarksBlocked, itcRedReqBlocked must all
    // survive the adapter — and the fixture must actually exercise both values.
    const rawRecords = IMS_SECTIONS.flatMap((s) => raw[s] ?? []);
    const seen = {
      filed: rawRecords.filter((r) => r.srcfilstatus === 'FILED').length,
      saved: rawRecords.filter((r) => r.srcfilstatus === 'SAVED').length,
      pendingBlocked: rawRecords.filter((r) => r.ispendactblocked === 'Y').length,
      remarksBlocked: rawRecords.filter((r) => r.isRemarksBlocked === 'Y').length,
      itcBlocked: rawRecords.filter((r) => r.itcRedReqBlocked === 'Y').length
    };

    expect(records.filter((r) => r.filingStatus === 'FILED')).toHaveLength(seen.filed);
    expect(records.filter((r) => r.filingStatus === 'SAVED')).toHaveLength(seen.saved);
    expect(records.filter((r) => r.pendingBlocked)).toHaveLength(seen.pendingBlocked);
    expect(records.filter((r) => r.remarksBlocked)).toHaveLength(seen.remarksBlocked);
    expect(records.filter((r) => r.itcReductionBlocked)).toHaveLength(seen.itcBlocked);

    expect(seen.saved).toBeGreaterThan(0);
    expect(seen.pendingBlocked).toBeGreaterThan(0);
  });

  it.each(PERIODS)('%s: note sections come through as notes, not invoices', (period) => {
    const raw = readJson(period, 'ims.json').imsDetails;
    const records = parse(readJson(period, 'ims.json'));

    // b2bdn/b2bcn number themselves nt_num/nt_dt; b2b uses inum/idt.
    expect(records.filter((r) => r.docType === 'DEBIT_NOTE')).toHaveLength(
      (raw.b2bdn ?? []).length
    );
    expect(records.filter((r) => r.docType === 'CREDIT_NOTE')).toHaveLength(
      (raw.b2bcn ?? []).length
    );
    for (const note of records.filter((r) => r.docType !== 'INVOICE')) {
      // Canonical section vocabulary is 2B's: IMS b2bdn/b2bcn both land on cdnr.
      expect(note.section).toBe('cdnr');
      expect(note.invoiceNo).toBeTruthy();
      expect(note.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it.each(PERIODS)('%s: contentHash reproduces the ground-truth hash', (period) => {
    const records = parse(readJson(period, 'ims.json'));
    const expected = new Set(
      groundTruth(period)
        .documents.filter((d) => d.portal?.contentHash)
        .map((d) => d.portal.contentHash)
    );
    for (const record of records) {
      expect(expected.has(record.contentHash), `unknown hash for ${record.invoiceNo}`).toBe(true);
      // and it is exactly the documented serialisation
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

  it.each(PERIODS)('%s: never yields an isd or impg record', (period) => {
    const records = parse(readJson(period, 'ims.json'));
    // ISD and imports are 2B-only sections; IMS has eight sections, not ten.
    for (const record of records) {
      expect(['isd', 'isda', 'impg', 'impgsez']).not.toContain(record.section);
      expect(record.portCode).toBe(null);
      // RCM never enters IMS either.
      expect(record.reverseCharge).toBe(false);
    }
  });

  it.each(PERIODS)('%s: leaves the 2B-only fields null rather than guessing', (period) => {
    const records = parse(readJson(period, 'ims.json'));
    for (const record of records) {
      expect(record.itcAvailable).toBe(null);
      expect(record.itcIneligibleReason).toBe(null);
      expect(record.supplierFiledOn).toBe(null);
      expect(record.rateLines).toEqual([]);
    }
  });
});

describe('IMS adapter — shapes and failure modes', () => {
  const base = {
    stin: '27AABCU9603R1ZM',
    tradenm: 'Dell India Pvt Ltd',
    inv_typ: 'R',
    val: 118000,
    action: 'N',
    pos: '27',
    txval: 100000,
    iamt: 18000,
    camt: 0,
    samt: 0,
    cess: 0,
    srcform: 'R1',
    rtnprd: '02',
    srcfilstatus: 'SAVED',
    ispendactblocked: 'N',
    isRemarksBlocked: 'N',
    itcRedReqBlocked: 'N'
  };

  const wrap = (sections) => ({ imsDetails: sections });

  it('reads inum/idt on invoices and nt_num/nt_dt on notes', () => {
    const records = parse(
      wrap({
        b2b: [{ ...base, inum: 'INV/2026/1', idt: '08-02-2026' }],
        b2bcn: [{ ...base, nt_num: 'CN/9', nt_dt: '10-02-2026' }]
      })
    );
    expect(records.map((r) => [r.invoiceNo, r.invoiceDate, r.docType])).toEqual([
      ['INV/2026/1', '2026-02-08', 'INVOICE'],
      ['CN/9', '2026-02-10', 'CREDIT_NOTE']
    ]);
  });

  it('reads the amended original as oinum/oidt and ont_num/ont_dt', () => {
    const records = parse(
      wrap({
        b2ba: [{ ...base, inum: 'INV/2', idt: '08-02-2026', oinum: 'INV/1', oidt: '02-02-2026' }],
        b2bcna: [{ ...base, nt_num: 'CN/2', nt_dt: '11-02-2026', ont_num: 'CN/1', ont_dt: '03-02-2026' }]
      })
    );
    expect(records[0].section).toBe('b2ba');
    expect([records[0].originalInvoiceNo, records[0].originalInvoiceDate]).toEqual([
      'INV/1',
      '2026-02-02'
    ]);
    expect(records[1].section).toBe('cdnra');
    expect([records[1].originalInvoiceNo, records[1].originalInvoiceDate]).toEqual([
      'CN/1',
      '2026-02-03'
    ]);
  });

  it('normalises the SEWP/SEWOP spellings of the supply type', () => {
    const records = parse(
      wrap({
        b2b: [
          { ...base, inum: '1', idt: '08-02-2026', inv_typ: 'SEWP' },
          { ...base, inum: '2', idt: '08-02-2026', inv_typ: 'SEWOP' },
          { ...base, inum: '3', idt: '08-02-2026', inv_typ: 'DE' }
        ]
      })
    );
    expect(records.map((r) => r.supplyType)).toEqual(['SEZWP', 'SEZWOP', 'DE']);
  });

  it('derives the tax period from rtnprd plus the document year', () => {
    const [record] = parse(wrap({ b2b: [{ ...base, inum: '1', idt: '30-12-2025', rtnprd: '01' }] }));
    expect(record.taxPeriod).toBe('2026-01');
  });

  it('lets an explicit tax period override the derivation', () => {
    const [record] = parse(
      wrap({ b2b: [{ ...base, inum: '1', idt: '08-02-2026' }] }),
      { taxPeriod: '2026-03' }
    );
    expect(record.taxPeriod).toBe('2026-03');
  });

  it('also reads the post-upload error envelope', () => {
    const records = parse({
      imsDetailsErr: {
        b2b: [{ ...base, inum: '1', idt: '08-02-2026', error_msg: 'invalid GSTIN' }]
      }
    });
    expect(records[0].errorMessage).toBe('invalid GSTIN');
  });

  it('refuses an unknown section rather than dropping it silently', () => {
    expect(() => parse(wrap({ b2b: [], impg: [] }))).toThrow(/unknown section\(s\): impg/);
  });

  it('refuses unknown coded values instead of defaulting them', () => {
    expect(() =>
      parse(wrap({ b2b: [{ ...base, inum: '1', idt: '08-02-2026', srcfilstatus: 'DRAFT' }] }))
    ).toThrow(/srcfilstatus has unknown value/);
    expect(() =>
      parse(wrap({ b2b: [{ ...base, inum: '1', idt: '08-02-2026', action: 'X' }] }))
    ).toThrow(/action has unknown value/);
    expect(() =>
      parse(wrap({ b2b: [{ ...base, inum: '1', idt: '08-02-2026', inv_typ: 'ZZ' }] }))
    ).toThrow(/inv_typ has unknown value/);
    expect(() =>
      parse(wrap({ b2b: [{ ...base, inum: '1', idt: '08-02-2026', ispendactblocked: 'maybe' }] }))
    ).toThrow(/ispendactblocked is not Y\/N/);
  });

  it('reports where a missing field was', () => {
    expect(() => parse(wrap({ b2b: [{ ...base, idt: '08-02-2026' }] }))).toThrow(
      /imsDetails\.b2b\[0\]: inum is missing/
    );
  });

  it('keeps a 16-digit numeric invoice number exact', () => {
    const [record] = parse(
      wrap({ b2b: [{ ...base, inum: '1234567890123456', idt: '08-02-2026' }] })
    );
    expect(record.invoiceNo).toBe('1234567890123456');
    expect(typeof record.invoiceNo).toBe('string');
  });
});
