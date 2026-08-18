import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  ddmmyyyyToISO,
  financialYearMonthToPeriod,
  isoToDDMMYYYY,
  mmyyyyToPeriod,
  periodFromMMAndDate,
  placeOfSupplyCode,
  registerDateToISO,
  rupeesToPaise,
  stripBom,
  ynToBool
} from '../../src/adapters/values.js';

describe('rupeesToPaise', () => {
  it('converts plain numbers', () => {
    expect(rupeesToPaise(253992)).toBe(25399200);
    expect(rupeesToPaise(0)).toBe(0);
  });

  it('converts numbers whose x100 is not exact in binary floating point', () => {
    // 28469.23 * 100 === 2846922.9999999995
    expect(rupeesToPaise(28469.23)).toBe(2846923);
    expect(rupeesToPaise(282461.23)).toBe(28246123);
    expect(rupeesToPaise(5313.25)).toBe(531325);
  });

  it('rounds a half-paise the way the input actually represents it', () => {
    // The double nearest 1.005 is 1.00499999999999989, so two-decimal rounding
    // of the number is 1.00 — while the exact decimal string is 1.005 and rounds up.
    expect(rupeesToPaise(1.005)).toBe(100);
    expect(rupeesToPaise('1.005')).toBe(101);
  });

  it('parses Indian comma grouping', () => {
    expect(rupeesToPaise('5,16,195')).toBe(51619500);
    expect(rupeesToPaise('91,959.54')).toBe(9195954);
    expect(rupeesToPaise('1,54,118')).toBe(15411800);
    expect(rupeesToPaise('0')).toBe(0);
  });

  it('tolerates a rupee sign and stray spaces', () => {
    expect(rupeesToPaise(' ₹ 1,234.50 ')).toBe(123450);
  });

  it('handles negatives and bare decimals', () => {
    expect(rupeesToPaise('-1,234.56')).toBe(-123456);
    expect(rupeesToPaise('.5')).toBe(50);
  });

  it('treats an empty amount cell as zero, but a required one as an error', () => {
    expect(rupeesToPaise(null)).toBe(0);
    expect(rupeesToPaise('')).toBe(0);
    expect(() => rupeesToPaise(null, { required: true, field: 'taxable value' })).toThrow(
      AdapterError
    );
  });

  it('refuses text that is not a number instead of coercing it to zero', () => {
    expect(() => rupeesToPaise('n/a')).toThrow(/not a number/);
    expect(() => rupeesToPaise('12.3.4')).toThrow(/not a number/);
    expect(() => rupeesToPaise(Number.NaN)).toThrow(/not a finite number/);
  });
});

describe('dates', () => {
  it('reads the dd-mm-yyyy portal format', () => {
    expect(ddmmyyyyToISO('02-03-2026')).toBe('2026-03-02');
    expect(ddmmyyyyToISO('11-12-2025')).toBe('2025-12-11');
  });

  it('reads the d-MMM-yy register format', () => {
    expect(registerDateToISO('2-Mar-26')).toBe('2026-03-02');
    expect(registerDateToISO('28-Mar-26')).toBe('2026-03-28');
    expect(registerDateToISO('9-Feb-26')).toBe('2026-02-09');
    expect(registerDateToISO('12-Jul-17')).toBe('2017-07-12');
  });

  it('reads a real Date cell and an Excel serial', () => {
    expect(registerDateToISO(new Date(Date.UTC(2026, 2, 2)))).toBe('2026-03-02');
    expect(registerDateToISO(46083)).toBe('2026-03-02');
  });

  it('round-trips back to dd-mm-yyyy for the upload', () => {
    expect(isoToDDMMYYYY('2026-03-02')).toBe('02-03-2026');
  });

  it('refuses an ambiguous or unparseable date', () => {
    expect(() => ddmmyyyyToISO('2026-03-02')).toThrow(/not dd-mm-yyyy/);
    expect(() => registerDateToISO('2-Smarch-26')).toThrow(/unknown month/);
    expect(() => ddmmyyyyToISO('32-03-2026')).toThrow(/not a real date/);
  });
});

describe('periods', () => {
  it('converts the 2B mmyyyy return period', () => {
    expect(mmyyyyToPeriod('032026')).toBe('2026-03');
    expect(mmyyyyToPeriod('122025')).toBe('2025-12');
    expect(() => mmyyyyToPeriod('03')).toThrow(/not mmyyyy/);
  });

  it('derives the IMS period from the MM-only rtnprd plus the document date', () => {
    expect(periodFromMMAndDate('03', '2026-03-02')).toBe('2026-03');
    // A December document reported in the January period, and the reverse.
    expect(periodFromMMAndDate('01', '2025-12-30')).toBe('2026-01');
    expect(periodFromMMAndDate('12', '2026-01-02')).toBe('2025-12');
  });

  it('resolves financial year plus month name from the register header', () => {
    expect(financialYearMonthToPeriod('2025-26', 'March')).toBe('2026-03');
    expect(financialYearMonthToPeriod('2025-26', 'April')).toBe('2025-04');
    expect(financialYearMonthToPeriod('2026-27', 'December')).toBe('2026-12');
  });

  it('refuses a quarter, which names a range rather than one period', () => {
    expect(() => financialYearMonthToPeriod('2025-26', 'April-June')).toThrow(
      /not a single month/
    );
  });
});

describe('small conversions', () => {
  it('splits the state code out of a code-and-name place of supply', () => {
    expect(placeOfSupplyCode('29-Karnataka')).toBe('29');
    expect(placeOfSupplyCode('27')).toBe('27');
    expect(placeOfSupplyCode('8')).toBe('08');
    expect(placeOfSupplyCode(null)).toBe(null);
    expect(() => placeOfSupplyCode('Karnataka')).toThrow(/no state code/);
  });

  it('maps Y/N flags without inventing a value for anything else', () => {
    expect(ynToBool('Y')).toBe(true);
    expect(ynToBool('N')).toBe(false);
    expect(ynToBool(null, { fallback: false })).toBe(false);
    expect(ynToBool(null, { fallback: null })).toBe(null);
    expect(() => ynToBool('maybe')).toThrow(/not Y\/N/);
  });

  it('strips a leading byte-order mark', () => {
    expect(stripBom('﻿GSTIN')).toBe('GSTIN');
    expect(stripBom('GSTIN')).toBe('GSTIN');
  });
});
