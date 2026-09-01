// The one claim Before cut-off makes about itself, checked against every
// generated period rather than against a hand-built fixture:
//
//   nothing on this screen is a reverse-charge or ITC-ineligible record.
//
// The hand-built suite in test/services/preventiveTwoB.test.js proves the rule
// fires. This one proves it fires on the data a judge will actually see, which is
// a different question: the generator scatters RCM and Sec 17(5) documents across
// all six periods, at different suppliers, in different sections, and the April
// regression was not visible in any unit fixture — it took 32 real rows to show
// up. Ground truth labels every one of them (defect: 'RCM' / 'INELIGIBLE'), so
// the expected answer is read from the corpus rather than restated here.
//
// The whole stack runs: fixture files -> uploads -> commit -> preventiveAlerts.
//
// Owns org 14.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { preventiveAlerts } from '../../src/services/preventive.js';
import { rebuildSupplierPeriods } from '../../src/services/supplierStats.js';
import {
  TEST_ORGS,
  ensureOrg,
  ingestPeriod,
  requireDatabase,
  resetOrg
} from '../helpers/db.js';
import { FIXTURES_PRESENT, PERIODS, groundTruth } from '../helpers/fixtures.js';

const ORG_ID = TEST_ORGS.alertPopulation;
// organizations.gstin is globally UNIQUE, so this must not collide with another
// suite's: ensureOrg()'s ON DUPLICATE KEY would then update THAT org's row and
// leave this one uncreated. syncDiff already owns 27AABCS1429F6Z3.
const TRADER_GSTIN = '27AABCS1429F0ZN';

if (!FIXTURES_PRESENT) {
  throw new Error(
    'fixtures/ is missing — run `npm run gen:fixtures` from the repo root first'
  );
}

// The 16th of the following month: after 2B generates on the 14th, before GSTR-3B
// falls due on the 20th. Also the worst case for this screen — every supplier's
// cut-off has passed, so every listed row is being called an emergency.
function asOfFor(taxPeriod) {
  const [year, month] = taxPeriod.split('-').map(Number);
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return `${next}-16`;
}

// Every books document the generator marked reverse-charge or ITC-ineligible,
// keyed the way the alert item identifies itself.
//
// The DATE is in the key, and it has to be. Invoice numbers are not unique:
// Navkar Agencies bills 06-17/PNQ/1081 twice in February 2026, once reverse-charge
// on the 1st and once ordinarily on the 3rd, and the generator labels the second
// DUPLICATE_INV_NO. Keyed on the number alone this suite cannot tell them apart —
// it would clear the reverse-charge one the moment the ordinary one appeared, and
// condemn the ordinary one if it ever became listable. Both are wrong answers,
// and the same collapsing bug is what let the reverse-charge row back onto the
// screen in the first place.
const docKey = (gstin, invoiceNo, invoiceDate) => `${gstin}|${invoiceNo}|${invoiceDate}`;

function unchaseableDocs(taxPeriod) {
  const docs = groundTruth(taxPeriod).documents.filter(
    (doc) => doc.presence.inBooks && (doc.defect === 'RCM' || doc.defect === 'INELIGIBLE')
  );
  return new Map(
    docs.map((doc) => [
      docKey(doc.books.supplierGstin, doc.books.invoiceNo, doc.books.invoiceDate),
      doc
    ])
  );
}

describe.each(PERIODS)('no reverse-charge or ineligible record reaches Before cut-off — %s', (taxPeriod) => {
  let alerts;
  let unchaseable;

  beforeAll(async () => {
    await requireDatabase();
    await resetOrg(ORG_ID);
    await ensureOrg(ORG_ID, TRADER_GSTIN);
    await ingestPeriod(ORG_ID, taxPeriod);
    await rebuildSupplierPeriods(ORG_ID, taxPeriod);
    alerts = await preventiveAlerts(ORG_ID, { taxPeriod, asOfDate: asOfFor(taxPeriod) });
    unchaseable = unchaseableDocs(taxPeriod);
  }, 180000);

  afterAll(async () => {
    await resetOrg(ORG_ID);
  });

  it('has some of them to exclude, so the assertion below is not vacuous', () => {
    expect(unchaseable.size).toBeGreaterThan(0);
  });

  it('lists none of them in any supplier, any band, or any invoice row', () => {
    const listed = [];
    for (const supplier of alerts.suppliers) {
      for (const invoice of supplier.invoices) {
        if (unchaseable.has(docKey(supplier.gstin, invoice.invoiceNo, invoice.invoiceDate))) {
          listed.push(`${supplier.tradeName} ${invoice.invoiceNo} (${invoice.invoiceDate})`);
        }
        // Belt and braces: whatever ground truth says, nothing carrying an
        // exclusion reason may ever be rendered.
        expect(invoice.excludedReason).toBeNull();
      }
    }
    expect(listed).toEqual([]);

    // The bands are what the screen actually renders, and they are built
    // separately from `suppliers`. Check them on their own terms.
    for (const band of alerts.bands) {
      for (const supplier of band.suppliers) {
        for (const invoice of supplier.invoices) {
          expect(
            unchaseable.has(docKey(supplier.gstin, invoice.invoiceNo, invoice.invoiceDate))
          ).toBe(false);
        }
      }
    }
  });

  it('counts none of their money in any total', () => {
    // Totals are the sum of the bands, and the bands are the sum of the
    // suppliers. If an excluded row had leaked in anywhere, one of these three
    // views would disagree with the others.
    const fromSuppliers = alerts.suppliers.reduce((sum, entry) => sum + entry.itcAtStake, 0);
    const fromBands = alerts.bands.reduce((sum, band) => sum + band.itcAtStake, 0);
    expect(fromSuppliers).toBe(alerts.totals.itcAtStake);
    expect(fromBands).toBe(alerts.totals.itcAtStake);

    const invoiceCount = alerts.suppliers.reduce((sum, entry) => sum + entry.invoiceCount, 0);
    expect(invoiceCount).toBe(alerts.totals.invoiceCount);
  });

  it('names no unchaseable invoice in any chase message', () => {
    // The worst symptom of the old behaviour: a copy-ready message asking a
    // supplier to fix a reverse-charge invoice they had filed correctly.
    //
    // Scoped to the supplier's OWN unchaseable documents. A blanket search would
    // fail on a number that legitimately appears twice — the message would be
    // quoting the chaseable twin.
    for (const supplier of alerts.suppliers) {
      const theirs = [...unchaseable.values()].filter(
        (doc) => doc.books.supplierGstin === supplier.gstin
      );
      const listed = new Set(supplier.invoices.map((invoice) => invoice.invoiceNo));
      for (const doc of theirs) {
        if (listed.has(doc.books.invoiceNo)) continue; // the chaseable twin
        expect(supplier.chaseMessage).not.toContain(doc.books.invoiceNo);
      }
    }
  });

  // The specific shape that made the first version of this suite pass while the
  // screen was still wrong. February 2026 has it; the others may not, so this
  // asserts only where the corpus actually provides one.
  it('tells apart two documents that share an invoice number', () => {
    const byNumber = new Map();
    for (const doc of groundTruth(taxPeriod).documents) {
      if (!doc.presence.inBooks) continue;
      const key = `${doc.books.supplierGstin}|${doc.books.invoiceNo}`;
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(doc);
    }
    const collisions = [...byNumber.values()].filter(
      (docs) =>
        docs.length > 1 && docs.some((doc) => doc.defect === 'RCM' || doc.defect === 'INELIGIBLE')
    );

    for (const docs of collisions) {
      for (const doc of docs) {
        const shown = alerts.suppliers
          .flatMap((supplier) => supplier.invoices)
          .find(
            (invoice) =>
              invoice.invoiceNo === doc.books.invoiceNo &&
              invoice.invoiceDate === doc.books.invoiceDate
          );
        const unchaseableDoc = doc.defect === 'RCM' || doc.defect === 'INELIGIBLE';
        if (unchaseableDoc) expect(shown).toBeUndefined();
      }
    }
  });

  // Before cut-off measures EXPOSURE — how much credit is unsettled and still
  // chaseable — so nothing it headlines can be negative. It used to add a credit
  // note to an invoice: Patel Systems' April pair netted to MINUS Rs 5,577 on a
  // card headed "ITC at stake", and Fortune Hardware's June card headlined MINUS
  // Rs 17,128.92 off a single credit note. Both were the screen quietly
  // reporting less exposure than it had found.
  it('headlines no negative figure anywhere', () => {
    expect(alerts.totals.itcAtStake).toBeGreaterThanOrEqual(0);
    for (const band of alerts.bands) {
      expect(band.itcAtStake).toBeGreaterThanOrEqual(0);
      for (const supplier of band.suppliers) {
        expect(supplier.itcAtStake).toBeGreaterThanOrEqual(0);
      }
    }
    for (const supplier of alerts.suppliers) {
      expect(supplier.itcAtStake).toBeGreaterThanOrEqual(0);
    }
    expect(alerts.excluded.itcAtStake).toBeGreaterThanOrEqual(0);
  });

  it('adds documents by size rather than cancelling them against each other', () => {
    // The gross is the sum of the magnitudes, and equals the net only when
    // nothing pulls the other way. Asserting both halves means a future change
    // that reintroduces netting fails here even on a period with no credit notes.
    for (const supplier of alerts.suppliers) {
      const gross = supplier.invoices.reduce((sum, i) => sum + Math.abs(i.itcAtStake), 0);
      const net = supplier.invoices.reduce((sum, i) => sum + i.itcAtStake, 0);
      expect(supplier.itcAtStake).toBe(gross);
      expect(supplier.netItc).toBe(net);
      const { otherDocuments, creditNotes } = supplier.breakdown;
      // Gross exceeds |net| only when BOTH directions are present. Fortune
      // Hardware's June card is a single credit note: gross Rs 17,128.92 and net
      // MINUS Rs 17,128.92, equal in magnitude — and the point of the change is
      // that the card headlines the positive one.
      if (otherDocuments.count && creditNotes.count) {
        expect(gross).toBeGreaterThan(Math.abs(net));
      } else {
        expect(gross).toBe(Math.abs(net));
      }
    }
  });

  it('splits the two directions so a supplier can act on one of them', () => {
    for (const supplier of alerts.suppliers) {
      const { otherDocuments, creditNotes } = supplier.breakdown;
      expect(otherDocuments.count + creditNotes.count).toBe(supplier.invoiceCount);
      expect(Math.abs(otherDocuments.itc) + Math.abs(creditNotes.itc)).toBe(
        supplier.itcAtStake
      );
      // Credit notes are never presented as credit the trader is owed. The chase
      // message has to make the opposite request for them.
      if (creditNotes.count) {
        expect(supplier.chaseMessage).toContain('still claiming and should not be');
        expect(supplier.chaseMessage).toContain('credit note');
      }
      // And the netted figure never appears as the headline anywhere.
      if (creditNotes.count && otherDocuments.count) {
        expect(supplier.consequence).toContain('credit you are owed');
      }
    }
  });

  it('accounts for what it set aside instead of dropping it silently', () => {
    expect(alerts.excluded.invoiceCount).toBeGreaterThan(0);
    // Every reason present is one of the three, and the parts sum to the whole.
    const summed = Object.values(alerts.excluded.byReason).reduce(
      (acc, part) => ({
        count: acc.count + part.count,
        itcAtStake: acc.itcAtStake + part.itcAtStake
      }),
      { count: 0, itcAtStake: 0 }
    );
    expect(summed.count).toBe(alerts.excluded.invoiceCount);
    expect(summed.itcAtStake).toBe(alerts.excluded.itcAtStake);
  });
});

afterAll(async () => {
  await closePool();
});
