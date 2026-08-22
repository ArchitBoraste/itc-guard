// Supplier master and per-period filing behaviour, derived from portal records.
//
// This is the input to the preventive mode: the risk model ranks who to chase by
// how reliably they have filed, so days_late has to be measured against the RIGHT
// cut-off — the 11th for a monthly filer, the 13th for QRMP. Using one deadline for
// everybody would mark every QRMP supplier two days late every month and train the
// trader to ignore the warnings.
import { pool } from '../db/pool.js';
import { insertInChunks, withTransaction } from '../db/tx.js';
import { FILING_SCHEMES, cutoffDate, inferFilingScheme } from '../matching/cutoff.js';
import { daysBetween } from '../matching/normalize.js';
import { itcSign } from './totals.js';
import { ServiceError } from './ingest.js';

// --- supplier master -------------------------------------------------------

// Upserts a supplier row per distinct GSTIN seen on the portal side. Imports are
// skipped: an overseas Bill of Entry has no supplier GSTIN to key on.
export async function syncSuppliers(orgId) {
  const [rows] = await pool.query(
    `SELECT supplier_gstin,
            SUBSTRING_INDEX(GROUP_CONCAT(supplier_name ORDER BY id DESC), ',', 1) AS trade_name,
            MIN(tax_period) AS first_period,
            MAX(tax_period) AS last_period
       FROM portal_records
      WHERE org_id = ? AND supplier_gstin IS NOT NULL
      GROUP BY supplier_gstin`,
    [orgId]
  );
  if (!rows.length) return { suppliers: 0 };

  const values = rows.map((row) => [
    orgId,
    row.supplier_gstin,
    row.trade_name,
    row.trade_name,
    row.supplier_gstin.slice(0, 2),
    row.first_period,
    row.last_period
  ]);

  await withTransaction((connection) =>
    insertInChunks(
      connection,
      `INSERT INTO suppliers
         (org_id, gstin, legal_name, trade_name, state_code, first_seen_period, last_seen_period)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         trade_name = VALUES(trade_name),
         legal_name = COALESCE(suppliers.legal_name, VALUES(legal_name)),
         first_seen_period = LEAST(suppliers.first_seen_period, VALUES(first_seen_period)),
         last_seen_period = GREATEST(suppliers.last_seen_period, VALUES(last_seen_period))`,
      values
    )
  );

  return { suppliers: rows.length };
}

// gstin -> filing scheme, for anything that needs the right cut-off.
export async function supplierSchemeMap(orgId) {
  const [rows] = await pool.query(
    'SELECT gstin, filing_scheme FROM suppliers WHERE org_id = ?',
    [orgId]
  );
  return new Map(rows.map((row) => [row.gstin, row.filing_scheme]));
}

// --- filing scheme inference ----------------------------------------------

// Infers each supplier's scheme from their observed filing cadence, then stores it
// so the cut-off used everywhere else is theirs and not a global default.
//
// Honest limitation: a QRMP supplier who uses the Invoice Furnishing Facility
// files every month, two days later — so on this data the signal is weak and most
// suppliers land on MONTHLY with LOW/MEDIUM confidence. inferFilingScheme returns
// the confidence and the reason; both are stored so the UI can say "assumed" for a
// low-confidence guess rather than presenting it as fact.
export async function inferSupplierSchemes(orgId) {
  const [rows] = await pool.query(
    `SELECT supplier_gstin, tax_period, MIN(supplier_filed_on) AS filed_on
       FROM portal_records
      WHERE org_id = ? AND supplier_gstin IS NOT NULL AND supplier_filed_on IS NOT NULL
      GROUP BY supplier_gstin, tax_period
      ORDER BY supplier_gstin, tax_period`,
    [orgId]
  );

  const history = new Map();
  for (const row of rows) {
    if (!history.has(row.supplier_gstin)) history.set(row.supplier_gstin, []);
    history.get(row.supplier_gstin).push({ taxPeriod: row.tax_period, filedOn: row.filed_on });
  }

  const inferred = [];
  for (const [gstin, entries] of history) {
    const result = inferFilingScheme(entries);
    inferred.push({ gstin, ...result });
  }
  if (!inferred.length) return { inferred: 0, quarterly: 0 };

  await withTransaction(async (connection) => {
    for (const entry of inferred) {
      await connection.query(
        `UPDATE suppliers
            SET filing_scheme = ?, filing_scheme_confidence = ?, filing_scheme_reason = ?
          WHERE org_id = ? AND gstin = ?`,
        [entry.scheme, entry.confidence, entry.reason.slice(0, 255), orgId, entry.gstin]
      );
    }
  });

  return {
    inferred: inferred.length,
    quarterly: inferred.filter((entry) => entry.scheme === FILING_SCHEMES.QRMP).length
  };
}

// --- per-period stats ------------------------------------------------------

// Rebuilds supplier_periods for one tax period from the portal records already
// stored. Idempotent: keyed on (org_id, supplier_id, tax_period).
//
// Columns, and where each comes from:
//   gstr1_filed_on  the supplier's GSTR-1 filing date, as reported in the 2B
//                   supplier block. Null when only IMS has seen them (saved,
//                   not filed).
//   days_late       gstr1_filed_on minus THAT supplier's cut-off. Negative or
//                   zero means on time; positive is days late.
//   appeared_in_2b  did anything of theirs reach 2B — the only records that
//                   actually carry claimable credit.
//   appeared_in_ims did anything of theirs reach IMS, which happens earlier, at
//                   supplier-save time.
//   invoice_count   portal documents observed for them this period.
//   mismatch_count  how many of those did not land in MATCHED, from the run.
//   missed          expected in books but nothing observed on the portal at all.
export async function rebuildSupplierPeriods(orgId, taxPeriod, { runId = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod ?? ''))) {
    throw new ServiceError('taxPeriod must be YYYY-MM');
  }

  await syncSuppliers(orgId);
  await inferSupplierSchemes(orgId);

  const [suppliers] = await pool.query(
    'SELECT id, gstin, filing_scheme FROM suppliers WHERE org_id = ?',
    [orgId]
  );
  const supplierByGstin = new Map(suppliers.map((row) => [row.gstin, row]));

  // Portal side: one row per supplier for this period.
  //
  // A filed invoice is present in BOTH the IMS download and 2B. Those are two rows
  // describing ONE document, so the money has to be deduplicated before it is
  // summed — otherwise observed tax comes out at roughly 1.8x expected and every
  // supplier looks like they over-reported. Dedupe keeps the 2B row when both
  // exist, since 2B is the legal basis for the claim, and falls back to IMS for a
  // record the supplier has saved but not yet filed.
  //
  // identity_seq is part of the partition so that two genuinely different invoices
  // sharing supplier, number, date and type are not collapsed into one.
  const [portalRows] = await pool.query(
    `SELECT supplier_gstin,
            COUNT(*) AS invoice_count,
            MAX(in_2b) AS in_2b,
            MAX(in_ims) AS in_ims,
            MIN(gstr1_filed_on) AS gstr1_filed_on,
            SUM(CASE WHEN doc_type IN ('CREDIT_NOTE','ISD_CREDIT') THEN -total_tax ELSE total_tax END) AS observed_tax,
            SUM(CASE WHEN doc_type IN ('CREDIT_NOTE','ISD_CREDIT') THEN -taxable_value ELSE taxable_value END) AS observed_taxable
       FROM (
         SELECT supplier_gstin, doc_type, total_tax, taxable_value,
                supplier_filed_on AS gstr1_filed_on,
                MAX(CASE WHEN source = 'GSTR2B' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY supplier_gstin) AS in_2b,
                MAX(CASE WHEN source = 'IMS' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY supplier_gstin) AS in_ims,
                ROW_NUMBER() OVER (
                  PARTITION BY supplier_gstin, section, invoice_no_norm, invoice_date,
                               doc_type, identity_seq
                  ORDER BY CASE WHEN source = 'GSTR2B' THEN 0 ELSE 1 END
                ) AS dedupe_rank
           FROM portal_records
          WHERE org_id = ? AND tax_period = ? AND supplier_gstin IS NOT NULL
       ) deduped
      WHERE dedupe_rank = 1
      GROUP BY supplier_gstin`,
    [orgId, taxPeriod]
  );

  // Books side: what the trader expected from each supplier.
  const [booksRows] = await pool.query(
    `SELECT supplier_gstin,
            COUNT(*) AS expected_count,
            SUM(CASE WHEN doc_type = 'CREDIT_NOTE' THEN -total_tax ELSE total_tax END) AS expected_tax,
            SUM(CASE WHEN doc_type = 'CREDIT_NOTE' THEN -taxable_value ELSE taxable_value END) AS expected_taxable
       FROM expected_invoices
      WHERE org_id = ? AND tax_period = ?
      GROUP BY supplier_gstin`,
    [orgId, taxPeriod]
  );

  // Mismatches come from the run, so this reflects the matcher's verdict rather
  // than a second, divergent definition of "problem".
  const mismatchByGstin = new Map();
  if (runId) {
    const [mismatchRows] = await pool.query(
      `SELECT COALESCE(ei.supplier_gstin, pr.supplier_gstin) AS supplier_gstin,
              SUM(CASE WHEN mr.bucket <> 'MATCHED' AND mr.bucket <> 'NON_IMS' THEN 1 ELSE 0 END) AS mismatches
         FROM match_results mr
         LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
         LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
        WHERE mr.org_id = ? AND mr.run_id = ?
        GROUP BY COALESCE(ei.supplier_gstin, pr.supplier_gstin)`,
      [orgId, runId]
    );
    for (const row of mismatchRows) {
      if (row.supplier_gstin) mismatchByGstin.set(row.supplier_gstin, Number(row.mismatches));
    }
  }

  const portalByGstin = new Map(portalRows.map((row) => [row.supplier_gstin, row]));
  const booksByGstin = new Map(booksRows.map((row) => [row.supplier_gstin, row]));
  const allGstins = new Set([...portalByGstin.keys(), ...booksByGstin.keys()]);

  const values = [];
  for (const supplierGstin of allGstins) {
    const supplier = supplierByGstin.get(supplierGstin);
    if (!supplier) continue; // books-only supplier never seen on the portal

    const portalRow = portalByGstin.get(supplierGstin);
    const booksRow = booksByGstin.get(supplierGstin);
    const scheme = supplier.filing_scheme ?? FILING_SCHEMES.MONTHLY;
    const cutOff = cutoffDate(taxPeriod, scheme);
    const filedOn = portalRow?.gstr1_filed_on ?? null;

    // Positive = days past their own deadline.
    const daysLate = filedOn ? -daysBetween(filedOn, cutOff) : null;
    const invoiceCount = Number(portalRow?.invoice_count ?? 0);
    const expectedCount = Number(booksRow?.expected_count ?? 0);

    values.push([
      orgId,
      supplier.id,
      taxPeriod,
      expectedCount,
      invoiceCount,
      Number(portalRow?.in_2b ?? 0),
      Number(portalRow?.in_ims ?? 0),
      mismatchByGstin.get(supplierGstin) ?? 0,
      scheme,
      Number(booksRow?.expected_taxable ?? 0),
      Number(booksRow?.expected_tax ?? 0),
      Number(portalRow?.observed_taxable ?? 0),
      Number(portalRow?.observed_tax ?? 0),
      filedOn,
      cutOff,
      daysLate,
      daysLate !== null && daysLate > 0 ? 1 : 0,
      // Missed: the trader booked purchases from them and nothing arrived.
      expectedCount > 0 && invoiceCount === 0 ? 1 : 0
    ]);
  }

  if (!values.length) return { periods: 0 };

  await withTransaction((connection) =>
    insertInChunks(
      connection,
      `INSERT INTO supplier_periods
         (org_id, supplier_id, tax_period, expected_count, invoice_count,
          appeared_in_2b, appeared_in_ims, mismatch_count, filing_scheme,
          expected_taxable_value, expected_total_tax, observed_taxable_value,
          observed_total_tax, gstr1_filed_on, cut_off_date, days_late, filed_late, missed)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         expected_count = VALUES(expected_count),
         invoice_count = VALUES(invoice_count),
         appeared_in_2b = VALUES(appeared_in_2b),
         appeared_in_ims = VALUES(appeared_in_ims),
         mismatch_count = VALUES(mismatch_count),
         filing_scheme = VALUES(filing_scheme),
         expected_taxable_value = VALUES(expected_taxable_value),
         expected_total_tax = VALUES(expected_total_tax),
         observed_taxable_value = VALUES(observed_taxable_value),
         observed_total_tax = VALUES(observed_total_tax),
         gstr1_filed_on = VALUES(gstr1_filed_on),
         cut_off_date = VALUES(cut_off_date),
         days_late = VALUES(days_late),
         filed_late = VALUES(filed_late),
         missed = VALUES(missed)`,
      values
    )
  );

  return { periods: values.length };
}

// --- reading ---------------------------------------------------------------

export async function listSuppliers(orgId, { limit = 200 } = {}) {
  const [rows] = await pool.query(
    `SELECT s.id, s.gstin, s.trade_name, s.legal_name, s.state_code, s.filing_scheme,
            s.filing_scheme_confidence, s.filing_scheme_reason,
            s.first_seen_period, s.last_seen_period, s.contact_phone,
            COUNT(sp.id) AS periods_observed,
            SUM(sp.filed_late) AS late_count,
            SUM(sp.missed) AS missed_count,
            SUM(sp.invoice_count) AS invoice_count,
            SUM(sp.mismatch_count) AS mismatch_count,
            AVG(sp.days_late) AS avg_days_late,
            SUM(sp.observed_total_tax) AS observed_total_tax,
            SUM(sp.expected_total_tax) AS expected_total_tax,
            -- The days-late trend, inline. The supplier table renders one sparkline
            -- per row; fetching each supplier's periods separately would be one
            -- request per row for a list that is already a single query.
            GROUP_CONCAT(
              CONCAT_WS(':', sp.tax_period, COALESCE(sp.days_late, ''))
              ORDER BY sp.tax_period SEPARATOR ','
            ) AS days_late_series
       FROM suppliers s
       LEFT JOIN supplier_periods sp ON sp.supplier_id = s.id AND sp.org_id = s.org_id
      WHERE s.org_id = ?
      GROUP BY s.id
      ORDER BY late_count DESC, missed_count DESC, s.trade_name
      LIMIT ?`,
    [orgId, limit]
  );

  return rows.map((row) => ({
    gstin: row.gstin,
    tradeName: row.trade_name,
    legalName: row.legal_name,
    stateCode: row.state_code,
    filingScheme: row.filing_scheme,
    filingSchemeConfidence: row.filing_scheme_confidence,
    filingSchemeReason: row.filing_scheme_reason,
    firstSeenPeriod: row.first_seen_period,
    lastSeenPeriod: row.last_seen_period,
    contactPhone: row.contact_phone,
    stats: {
      periodsObserved: Number(row.periods_observed ?? 0),
      lateCount: Number(row.late_count ?? 0),
      missedCount: Number(row.missed_count ?? 0),
      invoiceCount: Number(row.invoice_count ?? 0),
      mismatchCount: Number(row.mismatch_count ?? 0),
      avgDaysLate: row.avg_days_late === null ? null : Number(row.avg_days_late),
      observedTotalTax: Number(row.observed_total_tax ?? 0),
      expectedTotalTax: Number(row.expected_total_tax ?? 0),
      trend: parseTrend(row.days_late_series)
    }
  }));
}

// '2026-03:2,2026-04:,2026-05:-3' -> [{ taxPeriod, daysLate }]. An empty segment
// is a period with no observed filing date, which is not the same as zero days
// late and must not be plotted as one.
function parseTrend(series) {
  if (!series) return [];
  return String(series)
    .split(',')
    .map((entry) => {
      const [taxPeriod, days] = entry.split(':');
      if (!taxPeriod) return null;
      return { taxPeriod, daysLate: days === '' || days === undefined ? null : Number(days) };
    })
    .filter(Boolean);
}

export async function getSupplierHistory(orgId, gstinValue) {
  const [suppliers] = await pool.query(
    `SELECT id, gstin, trade_name, legal_name, state_code, filing_scheme,
            filing_scheme_confidence, filing_scheme_reason, contact_phone
       FROM suppliers WHERE org_id = ? AND gstin = ?`,
    [orgId, gstinValue]
  );
  if (!suppliers.length) throw new ServiceError('supplier not found', 404, 'not_found');
  const supplier = suppliers[0];

  const [periods] = await pool.query(
    `SELECT tax_period, expected_count, invoice_count, appeared_in_2b, appeared_in_ims,
            mismatch_count, filing_scheme, expected_taxable_value, expected_total_tax,
            observed_taxable_value, observed_total_tax, gstr1_filed_on, cut_off_date,
            days_late, filed_late, missed
       FROM supplier_periods
      WHERE org_id = ? AND supplier_id = ?
      ORDER BY tax_period`,
    [orgId, supplier.id]
  );

  return {
    gstin: supplier.gstin,
    tradeName: supplier.trade_name,
    legalName: supplier.legal_name,
    stateCode: supplier.state_code,
    filingScheme: supplier.filing_scheme,
    filingSchemeConfidence: supplier.filing_scheme_confidence,
    filingSchemeReason: supplier.filing_scheme_reason,
    contactPhone: supplier.contact_phone,
    periods: periods.map((row) => ({
      taxPeriod: row.tax_period,
      expectedCount: Number(row.expected_count),
      invoiceCount: Number(row.invoice_count),
      appearedIn2b: Boolean(row.appeared_in_2b),
      appearedInIms: Boolean(row.appeared_in_ims),
      mismatchCount: Number(row.mismatch_count),
      filingScheme: row.filing_scheme,
      expectedTaxableValue: Number(row.expected_taxable_value),
      expectedTotalTax: Number(row.expected_total_tax),
      observedTaxableValue: Number(row.observed_taxable_value),
      observedTotalTax: Number(row.observed_total_tax),
      gstr1FiledOn: row.gstr1_filed_on,
      cutOffDate: row.cut_off_date,
      daysLate: row.days_late === null ? null : Number(row.days_late),
      filedLate: Boolean(row.filed_late),
      missed: Boolean(row.missed)
    }))
  };
}

export { itcSign };
