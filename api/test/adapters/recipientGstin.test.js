// The trader (recipient) GSTIN each upload kind can name, read without parsing the
// file and without ever throwing: it decides whether a file may be taken at all.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as gstr2b from '../../src/adapters/gstr2b.js';
import * as ims from '../../src/adapters/ims.js';
import * as purchaseRegister from '../../src/adapters/purchaseRegister.js';
import { TRADER } from '../../../tools/demo-timeline.js';
import { demoIms, demoRegister, demoTwoB } from '../helpers/demoFiles.js';
import { readBuffer } from '../helpers/fixtures.js';

const json = (value) => Buffer.from(JSON.stringify(value));

describe('recipientGstin', () => {
  it('reads the demo files: every one names Sharma Electronics', () => {
    expect(purchaseRegister.recipientGstin(readFileSync(demoRegister('aug')))).toBe(TRADER.gstin);
    expect(ims.recipientGstin(readFileSync(demoIms('aug', '2026-09-05')))).toBe(TRADER.gstin);
    expect(gstr2b.recipientGstin(readFileSync(demoTwoB('aug')))).toBe(TRADER.gstin);
  });

  it('reads the template register of the big fixtures, whose portal files name nobody', () => {
    expect(purchaseRegister.recipientGstin(readBuffer('2026-03', 'purchase_register.xlsx'))).toBe('27AABCS1429F1Z8');
    expect(ims.recipientGstin(readBuffer('2026-03', 'ims.json'))).toBeNull();
    expect(gstr2b.recipientGstin(readBuffer('2026-03', 'gstr2b.json'))).toBeNull();
  });

  it('takes an IMS file’s rtin as well as gstin, and normalises case', () => {
    expect(ims.recipientGstin(json({ rtin: '27aabcs1080f1zn', imsDetails: {} }))).toBe('27AABCS1080F1ZN');
  });

  it('is null for anything that is not a GSTIN, and for a file that is not JSON or a workbook', () => {
    expect(ims.recipientGstin(json({ gstin: 'NOT-A-GSTIN', imsDetails: {} }))).toBeNull();
    expect(gstr2b.recipientGstin(Buffer.from('{ not json'))).toBeNull();
    expect(purchaseRegister.recipientGstin(Buffer.from('GSTIN of Supplier,Document number\n'))).toBeNull();
  });
});
