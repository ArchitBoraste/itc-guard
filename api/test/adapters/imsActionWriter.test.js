import { describe, expect, it } from 'vitest';
import { parse as parseIms } from '../../src/adapters/ims.js';
import { parse as parse2b } from '../../src/adapters/gstr2b.js';
import {
  REMARKS_MAX_LENGTH,
  UPLOAD_SECTIONS,
  buildImsActionJson,
  serializeImsActionJson
} from '../../src/adapters/imsActionWriter.js';
import { FIXTURES_PRESENT, PERIODS, readJson } from '../helpers/fixtures.js';

const TRADER = '27AABCS1429F1Z8';
const describeFixtures = FIXTURES_PRESENT ? describe : describe.skip;

// The recommendation engine is phase 3; for the round trip, choose an action from
// the record itself so every branch of the writer gets exercised.
function demoDecisionFor(record, index) {
  if (record.filingStatus === 'SAVED') {
    // Pending is the natural choice on a saved record — but only where the portal
    // allows it. A caller that ignores pendingBlocked gets an exception, so the
    // recommendation engine must make this same check.
    if (record.pendingBlocked) {
      return { record, action: 'N', remarks: 'Chase supplier; pending is blocked here' };
    }
    return { record, action: 'P', remarks: 'Awaiting supplier correction before filing' };
  }
  if (index % 7 === 0) {
    return { record, action: 'R', remarks: 'Not our purchase — please withdraw' };
  }
  return { record, action: 'A' };
}

describeFixtures('IMS action writer — round trip from the IMS fixtures', () => {
  it.each(PERIODS)('%s: parse -> assign -> write produces a portal-shaped upload', (period) => {
    const records = parseIms(readJson(period, 'ims.json'));
    const decisions = records.map((record, index) => demoDecisionFor(record, index));
    const { json, warnings } = buildImsActionJson({ rtin: TRADER, decisions });

    expect(json.rtin).toBe(TRADER);
    expect(json.reqtyp).toBe('SAVE');
    expect(Object.keys(json.invdata)).toEqual(UPLOAD_SECTIONS);

    const written = UPLOAD_SECTIONS.flatMap((s) => json.invdata[s]);
    // Every record that was not blocked out is present exactly once.
    expect(written).toHaveLength(records.length);

    for (const wire of written) {
      const isNote = 'nt_num' in wire;

      // inum is a STRING — a 16-digit numeric invoice number must not become a number.
      expect(typeof wire[isNote ? 'nt_num' : 'inum']).toBe('string');
      // dates go out dd-mm-yyyy, never ISO
      expect(wire[isNote ? 'nt_dt' : 'idt']).toMatch(/^\d{2}-\d{2}-\d{4}$/);
      // bare 2-digit POS code, not '27-Maharashtra'
      expect(wire.pos).toMatch(/^\d{2}$/);
      // single-letter action code, not a label
      expect(['A', 'R', 'P', 'N']).toContain(wire.action);
      expect(wire.stin).toMatch(/^[0-9A-Z]{15}$/);
      expect(wire.rtnprd).toMatch(/^\d{2}$/);
      expect(wire.srcform).toBeTruthy();
      // money goes back out as rupees
      expect(Number.isFinite(wire.txval)).toBe(true);
      expect(Number.isFinite(wire.val)).toBe(true);
      for (const key of ['iamt', 'camt', 'samt', 'cess']) {
        expect(Number.isFinite(wire[key])).toBe(true);
        expect(Number(wire[key].toFixed(2))).toBe(wire[key]);
      }

      // remarks only on R or P, and never longer than the portal's limit
      if ('remarks' in wire) {
        expect(['R', 'P']).toContain(wire.action);
        expect(wire.remarks.length).toBeLessThanOrEqual(REMARKS_MAX_LENGTH);
      }
    }

    // The fixtures include remarks-blocked records, so the drop must have fired.
    const blocked = records.filter((r) => r.remarksBlocked && r.filingStatus === 'SAVED');
    if (blocked.length) {
      expect(warnings.filter((w) => w.code === 'REMARKS_DROPPED_BLOCKED').length).toBe(
        blocked.length
      );
    }
  });

  it.each(PERIODS)('%s: notes land in b2bdn/b2bcn with nt_num, invoices in b2b', (period) => {
    const records = parseIms(readJson(period, 'ims.json'));
    const { json } = buildImsActionJson({
      rtin: TRADER,
      records,
      actionFor: () => 'A'
    });

    const raw = readJson(period, 'ims.json').imsDetails;
    expect(json.invdata.b2b).toHaveLength((raw.b2b ?? []).length);
    expect(json.invdata.b2bdn).toHaveLength((raw.b2bdn ?? []).length);
    expect(json.invdata.b2bcn).toHaveLength((raw.b2bcn ?? []).length);

    for (const wire of [...json.invdata.b2bdn, ...json.invdata.b2bcn]) {
      expect(wire).toHaveProperty('nt_num');
      expect(wire).toHaveProperty('nt_dt');
      expect(wire).not.toHaveProperty('inum');
      expect(wire).not.toHaveProperty('idt');
    }
    for (const wire of json.invdata.b2b) {
      expect(wire).toHaveProperty('inum');
      expect(wire).not.toHaveProperty('nt_num');
    }
  });

  it.each(PERIODS)('%s: values survive the paise round trip', (period) => {
    const records = parseIms(readJson(period, 'ims.json'));
    const raw = readJson(period, 'ims.json').imsDetails;
    const { json } = buildImsActionJson({ rtin: TRADER, records, actionFor: () => 'A' });

    // b2b keeps its input order, so compare position by position against the file.
    (raw.b2b ?? []).forEach((original, index) => {
      const wire = json.invdata.b2b[index];
      expect(wire.txval).toBe(original.txval);
      expect(wire.iamt).toBe(original.iamt);
      expect(wire.camt).toBe(original.camt);
      expect(wire.samt).toBe(original.samt);
      expect(wire.cess).toBe(original.cess);
      expect(wire.val).toBe(original.val);
      expect(wire.inum).toBe(original.inum);
      expect(wire.idt).toBe(original.idt);
      expect(wire.pos).toBe(original.pos);
      expect(wire.srcform).toBe(original.srcform);
      expect(wire.rtnprd).toBe(original.rtnprd);
      expect(wire.inv_typ).toBe(original.inv_typ);
    });
  });

  it.each(PERIODS)('%s: refuses PENDING on every pending-blocked record', (period) => {
    const records = parseIms(readJson(period, 'ims.json'));
    const blocked = records.filter((r) => r.pendingBlocked);
    expect(blocked.length).toBeGreaterThan(0);

    for (const record of blocked) {
      expect(() =>
        buildImsActionJson({ rtin: TRADER, decisions: [{ record, action: 'P' }] })
      ).toThrow(/action P is blocked/);
      // the same record accepts A/R/N
      for (const action of ['A', 'R', 'N']) {
        expect(() =>
          buildImsActionJson({ rtin: TRADER, decisions: [{ record, action }] })
        ).not.toThrow();
      }
    }
  });

  it.each(PERIODS)('%s: emits no remarks on any remarks-blocked record', (period) => {
    const records = parseIms(readJson(period, 'ims.json'));
    const blocked = records.filter((r) => r.remarksBlocked);
    expect(blocked.length).toBeGreaterThan(0);

    const { json, warnings } = buildImsActionJson({
      rtin: TRADER,
      decisions: blocked.map((record) => ({ record, action: 'R', remarks: 'value mismatch' }))
    });
    const written = UPLOAD_SECTIONS.flatMap((s) => json.invdata[s]);
    expect(written).toHaveLength(blocked.length);
    for (const wire of written) {
      expect(wire).not.toHaveProperty('remarks');
      // the action itself is preserved — only the commentary is dropped
      expect(wire.action).toBe('R');
    }
    expect(warnings.every((w) => w.code === 'REMARKS_DROPPED_BLOCKED')).toBe(true);
  });

  it.each(PERIODS)('%s: refuses 2B-only records outright', (period) => {
    const twoB = parse2b(readJson(period, 'gstr2b.json'));
    const isdOrImpg = twoB.filter((r) => ['isd', 'isda', 'impg', 'impgsez'].includes(r.section));
    expect(isdOrImpg.length).toBeGreaterThan(0);

    for (const record of isdOrImpg) {
      expect(() =>
        buildImsActionJson({ rtin: TRADER, decisions: [{ record, action: 'A' }] })
      ).toThrow(/needs IMS-sourced records/);
    }
  });

  it.each(PERIODS)('%s: serialises to JSON that keeps inum quoted', (period) => {
    const records = parseIms(readJson(period, 'ims.json')).slice(0, 5);
    const { json } = buildImsActionJson({ rtin: TRADER, records, actionFor: () => 'A' });
    const text = serializeImsActionJson(json);
    const reparsed = JSON.parse(text);

    for (const wire of reparsed.invdata.b2b) {
      expect(typeof wire.inum).toBe('string');
      expect(text).toContain(`"inum": "${wire.inum}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Focused cases on a hand-built record
// ---------------------------------------------------------------------------

function imsRecord(overrides = {}) {
  const [record] = parseIms({
    imsDetails: {
      b2b: [
        {
          stin: '27AABCU9603R1ZM',
          tradenm: 'Dell India Pvt Ltd',
          inum: '1234567890123456',
          inv_typ: 'R',
          idt: '08-02-2026',
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
          srcfilstatus: 'FILED',
          ispendactblocked: 'N',
          isRemarksBlocked: 'N',
          itcRedReqBlocked: 'N',
          ...overrides
        }
      ]
    }
  });
  return record;
}

describe('IMS action writer — wire rules', () => {
  it('writes the documented envelope with all eight sections', () => {
    const { json } = buildImsActionJson({
      rtin: TRADER,
      decisions: [{ record: imsRecord(), action: 'A' }]
    });
    expect(json).toMatchObject({ rtin: TRADER, reqtyp: 'SAVE' });
    expect(Object.keys(json.invdata)).toEqual([
      'b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna', 'ecom', 'ecoma'
    ]);
    // Empty sections stay present as empty arrays.
    expect(json.invdata.b2ba).toEqual([]);
  });

  it('writes every documented key for a b2b record', () => {
    const { json } = buildImsActionJson({
      rtin: TRADER,
      decisions: [{ record: imsRecord(), action: 'A' }]
    });
    expect(json.invdata.b2b[0]).toEqual({
      stin: '27AABCU9603R1ZM',
      inum: '1234567890123456',
      inv_typ: 'R',
      idt: '08-02-2026',
      val: 118000,
      action: 'A',
      pos: '27',
      txval: 100000,
      iamt: 18000,
      camt: 0,
      samt: 0,
      cess: 0,
      srcform: 'R1',
      rtnprd: '02'
    });
  });

  it('keeps a 16-digit invoice number as a string through JSON.stringify', () => {
    const { json } = buildImsActionJson({
      rtin: TRADER,
      decisions: [{ record: imsRecord(), action: 'A' }]
    });
    expect(serializeImsActionJson(json)).toContain('"inum": "1234567890123456"');
  });

  it('omits remarks on Accept and No-action, keeps them on Reject and Pending', () => {
    const cases = [
      ['A', false],
      ['N', false],
      ['R', true],
      ['P', true]
    ];
    for (const [action, kept] of cases) {
      const { json, warnings } = buildImsActionJson({
        rtin: TRADER,
        decisions: [{ record: imsRecord(), action, remarks: 'because' }]
      });
      const wire = json.invdata.b2b[0];
      expect('remarks' in wire).toBe(kept);
      if (!kept) {
        expect(warnings.map((w) => w.code)).toContain('REMARKS_DROPPED_ACTION');
      }
    }
  });

  it('truncates remarks at 250 characters and says so', () => {
    const { json, warnings } = buildImsActionJson({
      rtin: TRADER,
      decisions: [{ record: imsRecord(), action: 'R', remarks: 'x'.repeat(400) }]
    });
    expect(json.invdata.b2b[0].remarks).toHaveLength(REMARKS_MAX_LENGTH);
    expect(warnings.map((w) => w.code)).toContain('REMARKS_TRUNCATED');
  });

  it('maps the supply type back to the IMS inv_typ vocabulary', () => {
    const pairs = [
      ['R', 'R'],
      ['DE', 'DE'],
      ['SEWP', 'SEWP'],
      ['SEWOP', 'SEWOP']
    ];
    for (const [input, expected] of pairs) {
      const { json } = buildImsActionJson({
        rtin: TRADER,
        decisions: [{ record: imsRecord({ inv_typ: input }), action: 'A' }]
      });
      expect(json.invdata.b2b[0].inv_typ).toBe(expected);
    }
  });

  it('carries the amended original document reference', () => {
    const [record] = parseIms({
      imsDetails: {
        b2ba: [
          {
            stin: '27AABCU9603R1ZM',
            inum: 'INV/2',
            idt: '08-02-2026',
            oinum: 'INV/1',
            oidt: '02-02-2026',
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
            srcfilstatus: 'FILED'
          }
        ]
      }
    });
    const { json } = buildImsActionJson({ rtin: TRADER, decisions: [{ record, action: 'A' }] });
    expect(json.invdata.b2ba[0]).toMatchObject({ oinum: 'INV/1', oidt: '02-02-2026' });
  });

  it('writes the ITC-reduction block only on Accept, and never when blocked', () => {
    const itcReduction = { required: true, igst: 500000, cgst: 0, sgst: 0, cess: 0 };

    const { json } = buildImsActionJson({
      rtin: TRADER,
      decisions: [{ record: imsRecord(), action: 'A', itcReduction }]
    });
    expect(json.invdata.b2b[0]).toMatchObject({ itc_red_req: 'Y', decl_igst: 5000 });

    expect(() =>
      buildImsActionJson({
        rtin: TRADER,
        decisions: [{ record: imsRecord(), action: 'R', itcReduction }]
      })
    ).toThrow(/only valid on action A/);

    expect(() =>
      buildImsActionJson({
        rtin: TRADER,
        decisions: [{ record: imsRecord({ itcRedReqBlocked: 'Y' }), action: 'A', itcReduction }]
      })
    ).toThrow(/ITC reduction is blocked/);
  });

  it('refuses an unknown action and a missing rtin', () => {
    expect(() =>
      buildImsActionJson({ rtin: TRADER, decisions: [{ record: imsRecord(), action: 'Accepted' }] })
    ).toThrow(/action must be one of A\/R\/P\/N/);
    expect(() =>
      buildImsActionJson({ decisions: [{ record: imsRecord(), action: 'A' }] })
    ).toThrow(/rtin .* is required/);
  });

  it('refuses a record with no place of supply or source form', () => {
    const record = imsRecord();
    expect(() =>
      buildImsActionJson({
        rtin: TRADER,
        decisions: [{ record: { ...record, placeOfSupply: null }, action: 'A' }]
      })
    ).toThrow(/placeOfSupply is required/);
    expect(() =>
      buildImsActionJson({
        rtin: TRADER,
        decisions: [{ record: { ...record, sourceForm: null }, action: 'A' }]
      })
    ).toThrow(/sourceForm is required/);
  });

  it('accepts the records + actionFor form as well as explicit decisions', () => {
    const records = [imsRecord({ inum: 'A/1' }), imsRecord({ inum: 'A/2' })];
    const { json } = buildImsActionJson({
      rtin: TRADER,
      records,
      actionFor: (record) => (record.invoiceNo === 'A/1' ? 'A' : { action: 'R', remarks: 'no' })
    });
    expect(json.invdata.b2b.map((w) => w.action)).toEqual(['A', 'R']);
    expect(json.invdata.b2b[1].remarks).toBe('no');
  });
});
