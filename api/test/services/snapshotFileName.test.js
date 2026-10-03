// The as-of date an IMS file's name carries. No database.
import { describe, expect, it } from 'vitest';
import { asOfDateInFileName } from '../../src/services/ingest.js';

describe('asOfDateInFileName', () => {
  it('reads the demo files the way they are named', () => {
    expect(asOfDateInFileName('ims_aug26_as_of_05sep.json', '2026-09-11')).toBe('2026-09-05');
    expect(asOfDateInFileName('ims_sep26_as_of_11oct.json', '2026-10-05')).toBe('2026-10-11');
  });

  it('accepts other spellings, and a year when the name has one', () => {
    expect(asOfDateInFileName('IMS as of 7 Sep.json', '2026-09-11')).toBe('2026-09-07');
    expect(asOfDateInFileName('ims-as-of-10-september-2026.json', '2027-01-01')).toBe('2026-09-10');
    expect(asOfDateInFileName('ims_asof05sep26.json', '2030-01-01')).toBe('2026-09-05');
  });

  it('takes the year that puts the date nearest the workspace date', () => {
    expect(asOfDateInFileName('ims_as_of_28dec.json', '2027-01-03')).toBe('2026-12-28');
    expect(asOfDateInFileName('ims_as_of_02jan.json', '2026-12-30')).toBe('2027-01-02');
  });

  it('is null when the name carries no usable date', () => {
    expect(asOfDateInFileName('ims.json', '2026-09-11')).toBeNull();
    expect(asOfDateInFileName('ims_as_of_05xyz.json', '2026-09-11')).toBeNull();
    expect(asOfDateInFileName('ims_as_of_45sep.json', '2026-09-11')).toBeNull();
  });
});
