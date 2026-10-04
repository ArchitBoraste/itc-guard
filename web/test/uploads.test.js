// What the Upload screen says about a period: the cards, the step and the
// reconcile bar read one view, so they cannot disagree.
import { describe, expect, it } from 'vitest';
import { currentUpload, uploadView } from '../src/lib/uploads.js';

const JULY = '2026-07';
const upload = (id, kind, extra = {}) => ({
  id,
  kind,
  original_filename: `${kind.toLowerCase()}.json`,
  tax_period: JULY,
  snapshot_date: null,
  row_count: 10,
  committed_at: '2026-09-01 11:18:46',
  replaced_by_upload_id: null,
  ...extra
});

const JULY_FILES = [upload(1, 'PURCHASE_REGISTER'), upload(2, 'IMS'), upload(3, 'GSTR2B')];
const JULY_COUNTS = {
  taxPeriod: JULY,
  register: { documents: 394, suppliers: 40, invoices: 372, creditNotes: 12, debitNotes: 10, contacts: 0 },
  imsRecords: { records: 368, suppliers: 50, filed: 366, saved: 2 },
  twoB: { records: 398, suppliers: 50 }
};

describe('the cards', () => {
  it("show the period's files with the period's counts", () => {
    const view = uploadView({ uploads: JULY_FILES, inventory: JULY_COUNTS, period: JULY, run: { id: 7 } });
    expect(view.cards.PURCHASE_REGISTER.upload.id).toBe(1);
    expect(view.cards.PURCHASE_REGISTER.figures).toEqual([[394, 'documents'], [40, 'suppliers']]);
    expect(view.cards.IMS.line).toBe('366 filed · 2 saved, not filed');
    expect(view.cards.GSTR2B.figures).toEqual([[398, 'records'], [50, 'suppliers']]);
  });

  it('show a file even where the counts say nothing about it', () => {
    // A period's counts without the per-file detail, as an older API answers.
    const view = uploadView({ uploads: JULY_FILES, inventory: { taxPeriod: JULY, hasBooks: true }, period: JULY });
    for (const kind of ['PURCHASE_REGISTER', 'IMS', 'GSTR2B']) expect(view.cards[kind]).not.toBeNull();
    expect(view.cards.IMS.figures).toEqual([[10, 'records']]);
  });

  it('show an IMS download with nothing in it yet as a file read, not an empty card', () => {
    const empty = upload(2, 'IMS', { row_count: 0, snapshot_date: '2026-08-02' });
    const view = uploadView({ uploads: [JULY_FILES[0], empty], inventory: { register: JULY_COUNTS.register }, period: JULY });
    expect(view.cards.IMS.figures).toEqual([[0, 'records']]);
    expect(view.cards.IMS.line).toBe('Downloaded 2 Aug 2026');
    expect(view.portal).toBe(true);
  });

  it("ignore another period's files and replaced ones", () => {
    const others = [
      upload(4, 'PURCHASE_REGISTER', { tax_period: '2026-06' }),
      upload(5, 'IMS', { replaced_by_upload_id: 6 }),
      upload(6, 'IMS', { committed_at: null })
    ];
    expect(uploadView({ uploads: others, inventory: null, period: JULY }).cards).toEqual({
      PURCHASE_REGISTER: null,
      IMS: null,
      GSTR2B: null
    });
    expect(currentUpload([...others, upload(7, 'IMS'), upload(8, 'IMS')], 'IMS', JULY).id).toBe(8);
  });
});

describe('the step and the reconcile bar', () => {
  it('follow the cards', () => {
    expect(uploadView({ uploads: [], inventory: null, period: JULY })).toMatchObject({
      step: 1,
      ready: false,
      stillNeeded: 'your purchase register and an IMS download'
    });
    const booksOnly = uploadView({ uploads: [JULY_FILES[0]], inventory: null, period: JULY });
    expect(booksOnly).toMatchObject({ step: 1, books: true, portal: false, stillNeeded: 'an IMS download' });
    expect(uploadView({ uploads: JULY_FILES, inventory: null, period: JULY })).toMatchObject({ step: 2, ready: true });
    expect(uploadView({ uploads: JULY_FILES, inventory: null, period: JULY, run: { id: 7 } }).step).toBe(3);
  });

  it('a run with the cards empty is not Review', () => {
    expect(uploadView({ uploads: [], inventory: null, period: JULY, run: { id: 7 } }).step).toBe(1);
  });

  it('name what the register is checked against, with or without a download date', () => {
    expect(uploadView({ uploads: JULY_FILES, inventory: JULY_COUNTS, period: JULY }).against).toBe('IMS and GSTR-2B');
    const dated = [JULY_FILES[0], upload(2, 'IMS', { snapshot_date: '2026-09-11' })];
    expect(uploadView({ uploads: dated, inventory: null, period: JULY }).against).toBe('IMS as of 11 Sep 2026');
    const twoBOnly = [JULY_FILES[0], JULY_FILES[2]];
    expect(uploadView({ uploads: twoBOnly, inventory: null, period: JULY }).against).toBe('GSTR-2B');
  });
});
