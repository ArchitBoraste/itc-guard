// Corrections: what earlier periods needed from their suppliers, and whether it has
// arrived by this one.
//
// One item per earlier document left open in its own period's run: not filed,
// saved but never filed, or filed with a different amount (carryOver.neededFix).
// Phantoms and invoice-number-only differences need nothing from a supplier and
// are not listed. For the period asked about, each item is
//
//   ARRIVED  this period's run linked a FILED record to it: an amendment or a late
//            filing, in which upload, and what it brings to this period
//   WAITING  nothing filed for it yet: how long it has waited and the supplier's
//            next chance, or the record saved in this period that is not filed yet
//
// An item a period in between already received is closed and not listed again.
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { FILING_SCHEMES, cutoffDate } from '../matching/cutoff.js';
import { addMonths, periodsApart } from '../matching/normalize.js';
import { formatPaise } from '../matching/recommend.js';
import { NEEDED, earlierItems, hasArrived } from './carryOver.js';
import { ServiceError } from './ingest.js';
import { loadEarlierRows } from './reconcile.js';
import { contactsByGstin } from './supplierContacts.js';
import { supplierSchemeMap } from './supplierStats.js';
import { itcSign } from './totals.js';
import { displayDate, displayPeriod, workspaceAsOf } from './workspaceClock.js';

export const CORRECTION_STATUS = Object.freeze({ ARRIVED: 'ARRIVED', WAITING: 'WAITING' });

const rupees = (paise) => `₹${formatPaise(paise)}`;

// The supplier's next cut-off on or after asOf, starting from taxPeriod's, and the
// return period whose GSTR-2B a fix made by then reaches.
export function nextChance(asOf, taxPeriod, scheme = FILING_SCHEMES.MONTHLY) {
  let period = taxPeriod;
  let date = cutoffDate(period, scheme);
  while (date && asOf > date) {
    period = addMonths(period, 1);
    date = cutoffDate(period, scheme);
  }
  return { date, reachesPeriod: period, scheme };
}

function chanceText({ date, reachesPeriod, scheme }, needed, name) {
  const by = displayDate(date);
  const reaches = `your ${displayPeriod(reachesPeriod)} GSTR-2B`;
  if (needed === NEEDED.VALUE_MISMATCH) return `${name} can still amend it by ${by} for ${reaches}.`;
  if (scheme === FILING_SCHEMES.QRMP) {
    return `${name} files quarterly: filed by ${by}, their GSTR-1 cut-off, it reaches ${reaches}.`;
  }
  return `${name} can still file it by ${by} for ${reaches}.`;
}

function neededText(item) {
  const { row, needed } = item;
  const month = displayPeriod(row.tax_period);
  if (needed === NEEDED.NOT_FILED) return `Not filed by their cut-off for ${month}.`;
  if (needed === NEEDED.SAVED_NOT_FILED) return `Saved but never filed by their cut-off for ${month}.`;
  return (
    `Filed with tax ${rupees(Number(row.portal_total_tax))} against ${rupees(Number(row.total_tax))} ` +
    'in your books: needs an amendment (GSTR-1A).'
  );
}

function arrivalText(link, seenIn) {
  const how = link.linked_via === 'AMENDMENT'
    ? 'Amended by the supplier'
    : link.portal_source_form === 'R1A' ? 'Added through GSTR-1A' : 'Filed late';
  // IMS carries no filing date; 2B does.
  const filed = link.portal_filed_on ? ` on ${displayDate(link.portal_filed_on)}` : '';
  const where = seenIn
    .map((entry) => (entry.source === 'GSTR2B'
      ? 'GSTR-2B'
      : `the IMS download of ${entry.snapshotDate ? displayDate(entry.snapshotDate) : 'this period'}`))
    .join(' and ');
  return `${how}${filed}${where ? `: in ${where}` : ''}.`;
}

// Where each arrival was seen in taxPeriod: every live record of the document
// (IMS and 2B each carry their own copy), with the upload it came from.
async function sightings(orgId, taxPeriod, links) {
  if (!links.length) return new Map();
  const [rows] = await pool.query(
    `SELECT pr.source, pr.section, pr.supplier_gstin, pr.invoice_no_norm, pr.invoice_date,
            pr.doc_type, u.id AS upload_id, u.original_filename, u.snapshot_date
       FROM portal_records pr
       JOIN uploads u ON u.id = pr.upload_id AND u.org_id = pr.org_id
      WHERE pr.org_id = ? AND pr.tax_period = ? AND pr.absent_since IS NULL
        AND pr.supplier_gstin IN (?)
      ORDER BY pr.source DESC, pr.id`,
    [orgId, taxPeriod, [...new Set(links.map((link) => link.portal_supplier_gstin))]]
  );
  const key = (gstin, norm, date, docType) => [gstin, norm, date, docType].join('|');
  const byKey = new Map();
  for (const row of rows) {
    const k = key(row.supplier_gstin, row.invoice_no_norm, row.invoice_date, row.doc_type);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({
      source: row.source,
      section: row.section,
      uploadId: row.upload_id,
      filename: row.original_filename,
      snapshotDate: row.snapshot_date
    });
  }
  return new Map(links.map((link) => [
    link.result_id,
    byKey.get(key(link.portal_supplier_gstin, link.portal_invoice_no_norm, link.portal_invoice_date, link.portal_doc_type)) ?? []
  ]));
}

// listCorrections(orgId, { taxPeriod }) ->
//   { taxPeriod, asOfDate, runId, counts: { arrived, waiting }, arrivedItc, waitingItc, items }
//
// arrivedItc  what the arrivals bring to taxPeriod (their linked results' value)
// waitingItc  what the waiting documents still have outstanding
export async function listCorrections(orgId, { taxPeriod }) {
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod ?? ''))) {
    throw new ServiceError('taxPeriod is required (YYYY-MM)');
  }
  const [asOf, rows, schemeMap, contacts, [runs]] = await Promise.all([
    workspaceAsOf(orgId),
    loadEarlierRows(orgId, taxPeriod),
    supplierSchemeMap(orgId),
    contactsByGstin(orgId),
    pool.query('SELECT id FROM runs WHERE org_id = ? AND tax_period = ?', [orgId, taxPeriod])
  ]);

  const open = earlierItems(rows, taxPeriod, {
    materialityTolerancePaise: config.matching.materialityTolerancePaise
  }).filter((item) => item.open);
  const arrived = (item) => Boolean(item.link) && hasArrived(item.link);
  const seen = await sightings(orgId, taxPeriod, open.filter(arrived).map((item) => item.link));

  const items = open.map((item) => {
    const { row, needed, link } = item;
    const gstin = row.supplier_gstin;
    const name = row.supplier_name ?? gstin;
    const scheme = schemeMap.get(gstin) ?? FILING_SCHEMES.MONTHLY;
    const claimedItc = Number(row.claimable_itc ?? 0);
    const view = {
      taxPeriod: row.tax_period,
      resultId: row.result_id,
      runId: row.run_id,
      supplier: { gstin, name, filingScheme: scheme, contact: contacts.get(gstin) ?? null },
      document: {
        invoiceNo: row.invoice_no,
        invoiceDate: row.invoice_date,
        docType: row.doc_type,
        taxableValue: Number(row.taxable_value),
        totalTax: Number(row.total_tax)
      },
      needed: {
        kind: needed,
        route: needed === NEEDED.VALUE_MISMATCH ? 'AMEND' : 'FILE',
        text: neededText(item),
        portal: needed === NEEDED.VALUE_MISMATCH
          ? { taxableValue: Number(row.portal_taxable_value), totalTax: Number(row.portal_total_tax) }
          : null,
        // What its own period claims for it, and what that leaves outstanding.
        claimedItc,
        outstandingItc: itcSign(row.doc_type) * Number(row.total_tax) - claimedItc
      },
      status: arrived(item) ? CORRECTION_STATUS.ARRIVED : CORRECTION_STATUS.WAITING,
      arrival: null,
      waiting: null
    };

    if (view.status === CORRECTION_STATUS.ARRIVED) {
      const seenIn = seen.get(link.result_id) ?? [];
      view.arrival = {
        via: link.linked_via,
        sourceForm: link.portal_source_form,
        filedOn: link.portal_filed_on,
        resultId: link.result_id,
        bucket: link.bucket,
        recommendedAction: link.recommended_action,
        portal: {
          invoiceNo: link.portal_invoice_no,
          taxableValue: Number(link.portal_taxable_value),
          totalTax: Number(link.portal_total_tax)
        },
        seenIn,
        inGstr2b: seenIn.some((entry) => entry.source === 'GSTR2B'),
        // What it brings to this period, and the part claimable right now (the
        // rest waits on a decision on its row).
        creditItc: Number(link.signed_itc ?? 0),
        claimableItc: Number(link.claimable_itc ?? 0),
        text: arrivalText(link, seenIn)
      };
    } else {
      const chance = nextChance(asOf, taxPeriod, scheme);
      view.waiting = {
        monthsWaiting: periodsApart(row.tax_period, taxPeriod),
        // Saved in this period, not filed yet: on its way, not safe.
        saved: link ? { resultId: link.result_id, filingStatus: link.portal_filing_status } : null,
        laterArrival: item.laterLink ? { taxPeriod: item.laterLink.run_period } : null,
        nextChance: { ...chance, text: chanceText(chance, needed, name) }
      };
    }
    return view;
  });

  // Arrivals first, then the oldest wait; within each, by supplier and number.
  items.sort((a, b) =>
    (a.status === b.status ? 0 : a.status === CORRECTION_STATUS.ARRIVED ? -1 : 1) ||
    a.taxPeriod.localeCompare(b.taxPeriod) ||
    a.supplier.name.localeCompare(b.supplier.name) ||
    a.document.invoiceNo.localeCompare(b.document.invoiceNo)
  );

  const sum = (list, value) => list.reduce((total, entry) => total + value(entry), 0);
  const arrivedItems = items.filter((entry) => entry.status === CORRECTION_STATUS.ARRIVED);
  const waitingItems = items.filter((entry) => entry.status === CORRECTION_STATUS.WAITING);
  return {
    taxPeriod,
    asOfDate: asOf,
    // Arrivals are read from this period's run; without one, everything waits.
    runId: runs[0]?.id ?? null,
    counts: { arrived: arrivedItems.length, waiting: waitingItems.length },
    arrivedItc: sum(arrivedItems, (entry) => entry.arrival.creditItc),
    waitingItc: sum(waitingItems, (entry) => entry.needed.outstandingItc),
    items
  };
}
