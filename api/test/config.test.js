// MATERIALITY_TOLERANCE_PAISE: the one money setting read from the environment.
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { DEFAULT_MATERIALITY_TOLERANCE_PAISE } from '../src/matching/recommend.js';

const KEY = 'MATERIALITY_TOLERANCE_PAISE';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('config.matching.materialityTolerancePaise', () => {
  it('falls back to the engine default when unset or blank', () => {
    delete process.env[KEY];
    expect(config.matching.materialityTolerancePaise).toBe(DEFAULT_MATERIALITY_TOLERANCE_PAISE);
    process.env[KEY] = '  ';
    expect(config.matching.materialityTolerancePaise).toBe(DEFAULT_MATERIALITY_TOLERANCE_PAISE);
  });

  it('reads whole paise, including zero', () => {
    process.env[KEY] = '250';
    expect(config.matching.materialityTolerancePaise).toBe(250);
    process.env[KEY] = '0';
    expect(config.matching.materialityTolerancePaise).toBe(0);
  });

  it('refuses rupees, fractions and negatives by name', () => {
    for (const bad of ['1.50', '-100', 'Rs 1', '1e3x']) {
      process.env[KEY] = bad;
      expect(() => config.matching.materialityTolerancePaise).toThrow(/MATERIALITY_TOLERANCE_PAISE/);
    }
  });
});
