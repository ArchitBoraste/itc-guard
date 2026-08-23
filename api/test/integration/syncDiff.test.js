// Sync diffing: what moved on the portal between two downloads of the same file.
//
// The trader downloads IMS on the 6th, works the exceptions, downloads again on
// the 10th. Between those two files a supplier can amend a saved record, delete
// one outright, or file what they had only saved. Reconciling the second file
// answers the right question about the wrong day unless the app says what moved.
//
// The two ways this feature fails:
//   * it under-reports — a decision the trader made is quietly invalidated
//   * it OVER-reports — a re-upload of the same bytes shows 400 "changes", the
//     trader learns the panel is noise, and the one real change is lost in it.
// The negative cases below are load-bearing, not padding.
//
// Owns org 6.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { confirmResult, createRun } from '../../src/services/reconcile.js';
import { listChangesForRun } from '../../src/services/syncDiff.js';
import { TEST_ORGS, ensureOrg, ingest, requireDatabase, resetOrg } from '../helpers/db.js';
import { FIXTURES_PRESENT, readJson } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.syncDiff;
// One GSTIN per org: organizations is UNIQUE on gstin, so sharing one with
// another suite would make ensureOrg update that org instead of creating this one.
const TRADER_GSTIN = '27AABCS1429F6Z3';
const PERIOD = '2026-03';
const AS_OF = '2026-04-16';

if (!FIXTURES_PRESENT) {
  throw new Error('fixtures/ is missing — run `npm run gen:fixtures` from the repo root first');
}

const asBuffer = (json) => Buffer.from(JSON.stringify(json), 'utf8');
const toRupees = (paise) => Number((paise / 100).toFixed(2));
const imsKey = (row) => `${row.stin}|${row.inum ?? row.nt_num}`;

// Rewrites the IMS download from an edit map keyed by supplier GSTIN + document
// number. `drop` deletes the record (a supplier withdrawing a saved record);
// `patch` rewrites it. Everything else is copied through byte for byte, so any
// change the diff reports is one this map asked for.
function editIms(json, edits) {
  const applied = new Map();
  const out = { imsDetails: {} };
  for (const [section, rows] of Object.entries(json.imsDetails)) {
    out.imsDetails[section] = [];
    for (const row of rows) {
      const edit = edits[imsKey(row)];
      if (!edit) {
        out.imsDetails[section].push(row);
        continue;
      }
      applied.set(imsKey(row), (applied.get(imsKey(row)) ?? 0) + 1);
      if (edit.drop) continue;
      out.imsDetails[section].push(edit.patch(row));
    }
  }
  return { json: out, applied };
}

// The supplier corrects a transposed value to what the trader actually booked.
const correctTo = (books) => (row) => ({
  ...row,
  txval: toRupees(books.taxable),
  iamt: toRupees(books.igst),
  camt: toRupees(books.cgst),
  samt: toRupees(books.sgst),
  cess: toRupees(books.cess),
  val: toRupees(books.taxable + books.tax)
});

// The supplier files what they had only saved. Not one of the content_hash
// inputs, so this moves nothing else.
const fileIt = (row) => ({ ...row, srcfilstatus: 'FILED' });

// Both at once, which is what a supplier who fixes a draft and then files does.
const correctAndFile = (books) => (row) => fileIt(correctTo(books)(row));

async function changeRows() {
  const [rows] = await pool.query(
    `SELECT rc.id, rc.change_type, rc.portal_record_id, rc.changed_fields,
            rc.delta_taxable_value, rc.delta_total_tax, rc.old_values, rc.new_values,
            pr.source, pr.invoice_no, pr.absent_since
       FROM record_changes rc JOIN portal_records pr ON pr.id = rc.portal_record_id
      WHERE rc.org_id = ? ORDER BY rc.id`,
    [ORG_ID]
  );
  return rows;
}

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

describe('sync diffing between two downloads of the same source', () => {
  let runId;
  // amended, deleted, filed, amended-and-filed, and one left alone
  let amended;
  let deleted;
  let filed;
  let both;
  let untouched;

  beforeAll(async () => {
    await requireDatabase();
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await resetOrg(ORG_ID);

    await ingest(ORG_ID, 'PURCHASE_REGISTER', 'purchase_register.xlsx', PERIOD);
    await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD);
    await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD);

    const run = await createRun({ orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF });
    runId = run.id;

    // Targets are chosen to be UNIQUE within their source: identity_key carries an
    // ordinal, and the fixtures contain DUPLICATE_INV_NO documents whose ordinals
    // shift when a sibling is deleted. Picking one of those would let an ordinal
    // shift masquerade as an amendment and the suite would pass for the wrong
    // reason.
    const uniqueness =
      `NOT EXISTS (SELECT 1 FROM portal_records q
                    WHERE q.org_id = pr.org_id AND q.source = pr.source AND q.id <> pr.id
                      AND q.supplier_gstin = pr.supplier_gstin
                      AND q.invoice_no_norm = pr.invoice_no_norm)`;

    // SAVED records are IMS-only by construction — only FILED records reach 2B —
    // so amending one is a single-source change with a single change row.
    const [saved] = await pool.query(
      `SELECT pr.id, pr.supplier_gstin, pr.invoice_no, pr.taxable_value, pr.total_tax,
              mr.id AS result_id, mr.bucket,
              ei.taxable_value AS b_taxable, ei.igst AS b_igst, ei.cgst AS b_cgst,
              ei.sgst AS b_sgst, ei.cess AS b_cess, ei.total_tax AS b_tax
         FROM portal_records pr
         JOIN match_results mr
           ON mr.org_id = pr.org_id AND mr.run_id = ? AND mr.portal_record_id = pr.id
         JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
        WHERE pr.org_id = ? AND pr.source = 'IMS' AND pr.filing_status = 'SAVED'
          AND ${uniqueness}
        ORDER BY pr.id`,
      [runId, ORG_ID]
    );
    expect(saved.length, 'fixture must hold at least 4 unique SAVED IMS records').toBeGreaterThanOrEqual(4);

    const withBooks = (row) => ({
      id: row.id,
      resultId: row.result_id,
      bucket: row.bucket,
      gstin: row.supplier_gstin,
      invoiceNo: row.invoice_no,
      portalTaxable: Number(row.taxable_value),
      portalTax: Number(row.total_tax),
      books: {
        taxable: Number(row.b_taxable),
        igst: Number(row.b_igst),
        cgst: Number(row.b_cgst),
        sgst: Number(row.b_sgst),
        cess: Number(row.b_cess),
        tax: Number(row.b_tax)
      }
    });

    [amended, deleted, filed, both] = saved.slice(0, 4).map(withBooks);

    // The control: a clean, filed, matched record nobody touches. Its confirmation
    // has to survive every rebuild below, or "the decision was reset" would just
    // mean "decisions do not persist".
    const [clean] = await pool.query(
      `SELECT pr.id, pr.invoice_no, mr.id AS result_id
         FROM portal_records pr
         JOIN match_results mr
           ON mr.org_id = pr.org_id AND mr.run_id = ? AND mr.portal_record_id = pr.id
        WHERE pr.org_id = ? AND pr.source = 'IMS' AND pr.filing_status = 'FILED'
          AND mr.bucket = 'MATCHED' AND ${uniqueness}
        ORDER BY pr.id LIMIT 1`,
      [runId, ORG_ID]
    );
    expect(clean.length, 'fixture must hold a clean matched IMS record').toBe(1);
    untouched = { id: clean[0].id, resultId: clean[0].result_id, invoiceNo: clean[0].invoice_no };

    // Three decisions, made about the state of the portal as it is right now.
    // Two of them are about records that are about to move under the trader.
    await confirmResult(ORG_ID, amended.resultId, { confirmedAction: 'REJECT' });
    await confirmResult(ORG_ID, deleted.resultId, { confirmedAction: 'REJECT' });
    await confirmResult(ORG_ID, untouched.resultId, { confirmedAction: 'ACCEPT' });
  }, 240000);

  afterAll(async () => {
    await closePool();
  });

  it('says nothing at all about a first upload', async () => {
    // 800-odd records arriving for the first time is not 800 changes. Reporting
    // them would bury the two that matter in the next upload.
    expect(await changeRows()).toHaveLength(0);
  });

  it('re-ingesting an unchanged file produces zero change rows', async () => {
    const ims = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD);
    const twoB = await ingest(ORG_ID, 'GSTR2B', 'gstr2b.json', PERIOD);

    expect(ims.inserted).toBe(0);
    expect(twoB.inserted).toBe(0);
    // The most important negative case in this file: a diff that cries wolf on
    // identical bytes is worse than no diff at all.
    expect(ims.changes).toBe(0);
    expect(twoB.changes).toBe(0);
    expect(await changeRows()).toHaveLength(0);
  }, 240000);

  it('reports exactly three changes for exactly three mutated records', async () => {
    const edits = {
      [`${amended.gstin}|${amended.invoiceNo}`]: { patch: correctTo(amended.books) },
      [`${deleted.gstin}|${deleted.invoiceNo}`]: { drop: true },
      [`${filed.gstin}|${filed.invoiceNo}`]: { patch: fileIt }
    };
    const mutated = editIms(readJson(PERIOD, 'ims.json'), edits);
    // Each edit hit exactly one record — otherwise "three changes" would be an
    // accident of the fixture rather than a property of the diff.
    expect([...mutated.applied.values()]).toEqual([1, 1, 1]);

    const result = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(mutated.json));
    expect(result.changes).toBe(3);
    // A deleted record is not a deleted row: the last thing the portal said about
    // it is still the only record of it.
    expect(result.inserted).toBe(0);

    const rows = await changeRows();
    expect(rows).toHaveLength(3);

    const byRecord = new Map(rows.map((row) => [row.portal_record_id, row]));
    expect(byRecord.get(amended.id).change_type).toBe('AMENDED');
    expect(byRecord.get(deleted.id).change_type).toBe('DISAPPEARED');
    expect(byRecord.get(filed.id).change_type).toBe('STATUS_CHANGE');

    // The amendment says which field moved and by how much, in paise.
    const amendedRow = byRecord.get(amended.id);
    const fields = parseJson(amendedRow.changed_fields);
    expect(fields.find((f) => f.field === 'taxableValue')).toMatchObject({
      oldValue: amended.portalTaxable,
      newValue: amended.books.taxable,
      delta: amended.books.taxable - amended.portalTaxable
    });
    expect(Number(amendedRow.delta_total_tax)).toBe(amended.books.tax - amended.portalTax);

    // A filing does not move money, and claiming a delta of zero rupees where
    // there is no rupee change at all is a different statement.
    const filedRow = byRecord.get(filed.id);
    expect(filedRow.delta_total_tax).toBeNull();
    expect(parseJson(filedRow.changed_fields)).toEqual([
      { field: 'filingStatus', oldValue: 'SAVED', newValue: 'FILED', delta: null }
    ]);

    // The disappeared record is marked absent so a later upload can tell a return
    // from a first sighting.
    expect(byRecord.get(deleted.id).absent_since).toBeTruthy();
  }, 240000);

  it('never marks GSTR-2B records as disappeared when only IMS was uploaded', async () => {
    // The likeliest false positive in the whole feature, and the most alarming:
    // "your suppliers deleted 400 records" because the trader uploaded one file.
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n
         FROM record_changes rc JOIN portal_records pr ON pr.id = rc.portal_record_id
        WHERE rc.org_id = ? AND rc.change_type = 'DISAPPEARED' AND pr.source = 'GSTR2B'`,
      [ORG_ID]
    );
    expect(Number(rows[0].n)).toBe(0);

    const [absent] = await pool.query(
      `SELECT COUNT(*) AS n FROM portal_records
        WHERE org_id = ? AND source = 'GSTR2B' AND absent_since IS NOT NULL`,
      [ORG_ID]
    );
    expect(Number(absent[0].n)).toBe(0);
  });

  it('drops the decision made about the amended record and keeps the untouched one', async () => {
    const rerun = await createRun({
      orgId: ORG_ID, taxPeriod: PERIOD, mode: 'REACTIVE', asOfDate: AS_OF
    });
    expect(rerun.id).toBe(runId);

    const [ids] = await pool.query(
      `SELECT id, portal_record_id, bucket, confirmed_action, flags
         FROM match_results WHERE org_id = ? AND run_id = ? AND portal_record_id IN (?)`,
      [ORG_ID, runId, [amended.id, untouched.id]]
    );
    const byRecord = new Map(ids.map((row) => [row.portal_record_id, row]));

    // The supplier corrected the value, so the REJECT was a decision about a
    // record that no longer exists in that form. IMS resets the action in exactly
    // this case; so does the rebuild.
    const now = byRecord.get(amended.id);
    expect(now.bucket).toBe('MATCHED');
    expect(now.confirmed_action).toBeNull();
    expect(parseJson(now.flags)).toContain('CONFIRMATION_RESET');

    // ...and the reset is targeted.
    const survived = byRecord.get(untouched.id);
    expect(survived.confirmed_action).toBe('ACCEPT');
    expect(parseJson(survived.flags) ?? []).not.toContain('CONFIRMATION_RESET');
  }, 240000);

  it('serves a feed that says what changed and whose decision it cost', async () => {
    const feed = await listChangesForRun(ORG_ID, runId);

    expect(feed.taxPeriod).toBe(PERIOD);
    expect(feed.total).toBe(3);
    expect(feed.counts).toEqual({ AMENDED: 1, DISAPPEARED: 1, STATUS_CHANGE: 1 });

    // Most recent first.
    const ids = feed.changes.map((change) => change.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);

    const amendedChange = feed.changes.find((change) => change.record.id === amended.id);
    expect(amendedChange.changeType).toBe('AMENDED');
    expect(amendedChange.record.source).toBe('IMS');
    expect(amendedChange.record.invoiceNo).toBe(amended.invoiceNo);
    expect(amendedChange.deltaTotalTax).toBe(amended.books.tax - amended.portalTax);
    expect(amendedChange.fields.some((f) => f.field === 'taxableValue' && f.delta !== 0)).toBe(true);
    expect(amendedChange.detectedFrom.kind).toBe('IMS');
    // The whole point of the panel: this one invalidated a decision.
    expect(amendedChange.review.invalidatedDecision).toBe(true);
    expect(amendedChange.review.confirmationReset).toBe(true);

    // A withdrawn record is the other way a decision stops applying, and it is the
    // one carryForward() cannot see: nothing about the record changed, so the
    // REJECT is still on file — attached to a record that is no longer on the
    // portal. The feed has to be the thing that says so.
    const disappearedChange = feed.changes.find((change) => change.record.id === deleted.id);
    expect(disappearedChange.changeType).toBe('DISAPPEARED');
    expect(disappearedChange.review.confirmedAction).toBe('REJECT');
    expect(disappearedChange.review.confirmationReset).toBe(false);
    expect(disappearedChange.review.invalidatedDecision).toBe(true);

    // Nobody had decided anything about the filing, so it is information rather
    // than an alarm — and the UI renders the two differently.
    const filedChange = feed.changes.find((change) => change.record.id === filed.id);
    expect(filedChange.changeType).toBe('STATUS_CHANGE');
    expect(filedChange.review.reviewed).toBe(false);
    expect(filedChange.review.invalidatedDecision).toBe(false);

    expect(feed.invalidatedCount).toBe(2);
  });

  it('emits both kinds when a record is amended AND filed in one upload', async () => {
    const before = (await changeRows()).length;

    // The earlier edits are carried forward: replaying only the new one would
    // revert the other three and report four more changes.
    const edits = {
      [`${amended.gstin}|${amended.invoiceNo}`]: { patch: correctTo(amended.books) },
      [`${deleted.gstin}|${deleted.invoiceNo}`]: { drop: true },
      [`${filed.gstin}|${filed.invoiceNo}`]: { patch: fileIt },
      [`${both.gstin}|${both.invoiceNo}`]: { patch: correctAndFile(both.books) }
    };
    const mutated = editIms(readJson(PERIOD, 'ims.json'), edits);
    expect([...mutated.applied.values()]).toEqual([1, 1, 1, 1]);

    const result = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(mutated.json));
    // Two things happened to one record and both are reported. Collapsing them
    // would hide the filing, and only the amendment was still free to fix.
    expect(result.changes).toBe(2);

    const rows = await changeRows();
    expect(rows).toHaveLength(before + 2);

    const fresh = rows.slice(before);
    expect(fresh.every((row) => row.portal_record_id === both.id)).toBe(true);
    expect(fresh.map((row) => row.change_type).sort()).toEqual(['AMENDED', 'STATUS_CHANGE']);

    // The amendment carries the money; the filing carries the status.
    const amendment = fresh.find((row) => row.change_type === 'AMENDED');
    expect(Number(amendment.delta_total_tax)).toBe(both.books.tax - both.portalTax);
    const status = fresh.find((row) => row.change_type === 'STATUS_CHANGE');
    expect(parseJson(status.changed_fields)).toEqual([
      { field: 'filingStatus', oldValue: 'SAVED', newValue: 'FILED', delta: null }
    ]);
  }, 240000);

  it('reports a record coming back, and one the supplier has just added', async () => {
    const before = (await changeRows()).length;

    // Everything stays as it was except: the withdrawn record is reported again,
    // and one document nobody has ever seen appears.
    const edits = {
      [`${amended.gstin}|${amended.invoiceNo}`]: { patch: correctTo(amended.books) },
      [`${filed.gstin}|${filed.invoiceNo}`]: { patch: fileIt },
      [`${both.gstin}|${both.invoiceNo}`]: { patch: correctAndFile(both.books) }
    };
    const restored = editIms(readJson(PERIOD, 'ims.json'), edits);
    const template = restored.json.imsDetails.b2b[0];
    restored.json.imsDetails.b2b.push({ ...template, inum: 'SYNTH/9001' });

    const result = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(restored.json));
    expect(result.inserted).toBe(1);
    expect(result.changes).toBe(2);

    const fresh = (await changeRows()).slice(before);
    expect(fresh.map((row) => row.change_type).sort()).toEqual(['NEW', 'REAPPEARED']);

    // Back on the portal means back in play: the absent mark has to clear, or the
    // next upload would report it as returning all over again.
    const returned = fresh.find((row) => row.change_type === 'REAPPEARED');
    expect(returned.portal_record_id).toBe(deleted.id);
    expect(returned.absent_since).toBeNull();

    // A first sighting has no before, so it claims no field changes and no delta.
    const added = fresh.find((row) => row.change_type === 'NEW');
    expect(added.invoice_no).toBe('SYNTH/9001');
    expect(added.delta_total_tax).toBeNull();
    expect(added.changed_fields).toBeNull();
  }, 240000);

  it('still reports nothing when that same mutated file is uploaded again', async () => {
    // The diff is against the LAST state, not against the pristine fixture. A
    // second upload of the file that changed things has changed nothing.
    const edits = {
      [`${amended.gstin}|${amended.invoiceNo}`]: { patch: correctTo(amended.books) },
      [`${filed.gstin}|${filed.invoiceNo}`]: { patch: fileIt },
      [`${both.gstin}|${both.invoiceNo}`]: { patch: correctAndFile(both.books) }
    };
    const mutated = editIms(readJson(PERIOD, 'ims.json'), edits);
    mutated.json.imsDetails.b2b.push({ ...mutated.json.imsDetails.b2b[0], inum: 'SYNTH/9001' });
    const result = await ingest(ORG_ID, 'IMS', 'ims.json', PERIOD, asBuffer(mutated.json));

    expect(result.inserted).toBe(0);
    expect(result.changes).toBe(0);
  }, 240000);
});
