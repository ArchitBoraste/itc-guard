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
import { daysBetween, gstinDistance, isValidGstin } from '../matching/normalize.js';
import { itcSign } from './totals.js';
import { ServiceError } from './ingest.js';
import { CONTACT_COLUMNS, contactView } from './supplierContacts.js';

// The supplier a portal record (aliased pr) belongs to: its own GSTIN, or the
// supplier a variant of it was attached to (supplier_gstin_aliases, aliased a).
// Every query that groups portal records by supplier goes through these two.
const SUPPLIER_OF_RECORD = 'COALESCE(a.gstin, pr.supplier_gstin)';
const ALIAS_JOIN =
  'LEFT JOIN supplier_gstin_aliases a ON a.org_id = pr.org_id AND a.alias_gstin = pr.supplier_gstin';

// --- supplier master -------------------------------------------------------

// Imports reach the trader on a Bill of Entry through customs, not on a supplier's
// GSTR-1, so there is no filing record to judge. An overseas one has no GSTIN at
// all; one from an SEZ unit (impgsez) carries the unit's, which made it a
// "supplier" of its own.
const IMPORT_SECTIONS = Object.freeze(['impg', 'impgsez']);

// Upserts a supplier row per supplier seen on the portal side, a mistyped GSTIN
// counting as the supplier it belongs to (resolveGstinAliases), and per supplier
// the trader booked a purchase from: one who never reports anything is exactly
// the one to chase, and the trader may need to set their scheme or contact before
// they ever appear. Imports are skipped (IMPORT_SECTIONS). The portal's name is
// preferred, the register's used until there is one.
export async function syncSuppliers(orgId) {
  const aliases = await resolveGstinAliases(orgId);
  return withTransaction(async (connection) => {
    await connection.query('DELETE FROM supplier_gstin_aliases WHERE org_id = ?', [orgId]);
    if (aliases.length) {
      await insertInChunks(
        connection,
        `INSERT INTO supplier_gstin_aliases
           (org_id, alias_gstin, gstin, evidence, documents, checksum_valid)
         VALUES ?`,
        aliases.map((alias) => [
          orgId, alias.alias, alias.gstin, alias.evidence, alias.documents, alias.checksumValid ? 1 : 0
        ])
      );
    }

    const [portalRows] = await connection.query(
      `SELECT ${SUPPLIER_OF_RECORD} AS supplier_gstin,
              SUBSTRING_INDEX(
                GROUP_CONCAT(pr.supplier_name ORDER BY a.gstin IS NULL DESC, pr.id DESC), ',', 1
              ) AS trade_name,
              MIN(pr.tax_period) AS first_period,
              MAX(pr.tax_period) AS last_period
         FROM portal_records pr ${ALIAS_JOIN}
        WHERE pr.org_id = ? AND pr.supplier_gstin IS NOT NULL AND pr.section NOT IN (?)
        GROUP BY ${SUPPLIER_OF_RECORD}`,
      [orgId, IMPORT_SECTIONS]
    );
    const [booksRows] = await connection.query(
      `SELECT supplier_gstin,
              SUBSTRING_INDEX(GROUP_CONCAT(supplier_name ORDER BY id DESC), ',', 1) AS trade_name,
              MIN(tax_period) AS first_period,
              MAX(tax_period) AS last_period
         FROM expected_invoices WHERE org_id = ?
        GROUP BY supplier_gstin`,
      [orgId]
    );
    const rows = mergeSupplierRows(portalRows, booksRows);
    await dropRetiredSuppliers(connection, orgId, rows.map((row) => row.supplier_gstin));
    if (!rows.length) return { suppliers: 0, aliases: aliases.length };

    // A new row starts on the no-history answer, so even a supplier nothing has
    // been inferred for says why its scheme is assumed.
    const assumed = inferFilingScheme([]);
    await insertInChunks(
      connection,
      `INSERT INTO suppliers
         (org_id, gstin, legal_name, trade_name, state_code, first_seen_period, last_seen_period,
          filing_scheme_reason)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         trade_name = VALUES(trade_name),
         legal_name = COALESCE(suppliers.legal_name, VALUES(legal_name)),
         first_seen_period = LEAST(suppliers.first_seen_period, VALUES(first_seen_period)),
         last_seen_period = GREATEST(suppliers.last_seen_period, VALUES(last_seen_period))`,
      rows.map((row) => [
        orgId,
        row.supplier_gstin,
        row.trade_name,
        row.trade_name,
        row.supplier_gstin.slice(0, 2),
        row.first_period,
        row.last_period,
        assumed.reason
      ])
    );
    return { suppliers: rows.length, aliases: aliases.length };
  });
}

// One row per supplier GSTIN across the portal and the books: the portal's name
// when it has one, and the widest span of periods either side has seen.
function mergeSupplierRows(portalRows, booksRows) {
  const merged = new Map(portalRows.map((row) => [row.supplier_gstin, { ...row }]));
  for (const row of booksRows) {
    const existing = merged.get(row.supplier_gstin);
    if (!existing) {
      merged.set(row.supplier_gstin, { ...row });
      continue;
    }
    existing.trade_name = existing.trade_name ?? row.trade_name;
    existing.first_period = [existing.first_period, row.first_period].sort()[0];
    existing.last_period = [existing.last_period, row.last_period].sort().at(-1);
  }
  return [...merged.values()];
}

// Which reported GSTINs are a variant of another supplier's (audit P15: each
// typo became a supplier of its own, 108 suppliers for 40). Only a GSTIN the
// trader never booked a purchase under qualifies, and then on evidence:
//   MATCHED_PARTNER  the matcher paired its records with books rows of supplier
//                    G (the GSTIN-typo fallback), G at most two characters away;
//                    the G with the most such pairs
//   ONE_CHARACTER    failing that, exactly one booked GSTIN is one character away
// The check digit is recorded and not required. Any one-character typo of a valid
// GSTIN fails it — but the sample data's GSTINs carry random check characters, so
// there it would decide nothing.
async function resolveGstinAliases(orgId) {
  const [booksRows] = await pool.query(
    'SELECT DISTINCT supplier_gstin FROM expected_invoices WHERE org_id = ?',
    [orgId]
  );
  const [reportedRows] = await pool.query(
    `SELECT supplier_gstin, COUNT(*) AS n FROM portal_records
      WHERE org_id = ? AND supplier_gstin IS NOT NULL AND section NOT IN (?)
      GROUP BY supplier_gstin`,
    [orgId, IMPORT_SECTIONS]
  );
  const [pairRows] = await pool.query(
    `SELECT pr.supplier_gstin AS reported, ei.supplier_gstin AS booked, COUNT(*) AS n
       FROM match_results mr
       JOIN portal_records pr ON pr.id = mr.portal_record_id
       JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
      WHERE mr.org_id = ? AND pr.supplier_gstin <> ei.supplier_gstin
      GROUP BY pr.supplier_gstin, ei.supplier_gstin`,
    [orgId]
  );

  const booked = new Set(booksRows.map((row) => row.supplier_gstin));
  const aliases = [];
  for (const { supplier_gstin: reported, n } of reportedRows) {
    if (booked.has(reported)) continue;
    const partner = pairRows
      .filter((pair) => pair.reported === reported && booked.has(pair.booked))
      .filter((pair) => gstinDistance(reported, pair.booked) <= 2)
      .sort((x, y) => Number(y.n) - Number(x.n) || x.booked.localeCompare(y.booked))[0];
    const near = [...booked].filter((gstin) => gstinDistance(reported, gstin) === 1);

    const gstin = partner?.booked ?? (near.length === 1 ? near[0] : null);
    if (!gstin) continue;
    aliases.push({
      alias: reported,
      gstin,
      evidence: partner ? 'MATCHED_PARTNER' : 'ONE_CHARACTER',
      documents: Number(n),
      checksumValid: isValidGstin(reported)
    });
  }
  return aliases;
}

// Supplier rows the master no longer derives from the data — a GSTIN now known to
// be another supplier's, an import unit — go, with their figures. Child rows
// first: the supplier FKs are RESTRICT.
async function dropRetiredSuppliers(connection, orgId, keep) {
  const [rows] = keep.length
    ? await connection.query('SELECT id FROM suppliers WHERE org_id = ? AND gstin NOT IN (?)', [orgId, keep])
    : await connection.query('SELECT id FROM suppliers WHERE org_id = ?', [orgId]);
  const ids = rows.map((row) => row.id);
  if (!ids.length) return;
  for (const table of ['supplier_periods', 'supplier_risk']) {
    await connection.query(`DELETE FROM ${table} WHERE org_id = ? AND supplier_id IN (?)`, [orgId, ids]);
  }
  await connection.query('DELETE FROM suppliers WHERE org_id = ? AND id IN (?)', [orgId, ids]);
}

// gstin -> filing scheme, for anything that needs the right cut-off. A variant
// GSTIN carries its supplier's scheme.
export async function supplierSchemeMap(orgId) {
  const [rows] = await pool.query(
    `SELECT gstin, filing_scheme FROM suppliers WHERE org_id = ?
     UNION ALL
     SELECT a.alias_gstin, s.filing_scheme
       FROM supplier_gstin_aliases a
       JOIN suppliers s ON s.org_id = a.org_id AND s.gstin = a.gstin
      WHERE a.org_id = ?`,
    [orgId, orgId]
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
    `SELECT ${SUPPLIER_OF_RECORD} AS supplier_gstin, pr.tax_period,
            MIN(pr.supplier_filed_on) AS filed_on
       FROM portal_records pr ${ALIAS_JOIN}
      WHERE pr.org_id = ? AND pr.supplier_gstin IS NOT NULL AND pr.supplier_filed_on IS NOT NULL
      GROUP BY ${SUPPLIER_OF_RECORD}, pr.tax_period
      ORDER BY supplier_gstin, pr.tax_period`,
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

  // A scheme the trader set is theirs: inference never overwrites it.
  await withTransaction(async (connection) => {
    for (const entry of inferred) {
      await connection.query(
        `UPDATE suppliers
            SET filing_scheme = ?, filing_scheme_confidence = ?, filing_scheme_reason = ?
          WHERE org_id = ? AND gstin = ? AND filing_scheme_source = 'INFERRED'`,
        [entry.scheme, entry.confidence, entry.reason.slice(0, 255), orgId, entry.gstin]
      );
    }
  });

  return {
    inferred: inferred.length,
    quarterly: inferred.filter((entry) => entry.scheme === FILING_SCHEMES.QRMP).length
  };
}

export const USER_SCHEME_REASON = 'set by you';

// The trader settles a supplier's scheme. Stored as USER, so inference leaves it
// alone from here on. `onlyIfInferred` lets the demo seeder pre-set a scheme
// without overriding one the visitor already chose. Returns whether a row changed.
//
// This writes the scheme and nothing else. Every figure measured against it is
// rebuilt by the caller — see services/supplierScheme.js.
export async function setSupplierScheme(orgId, gstin, scheme, { onlyIfInferred = false } = {}) {
  if (!Object.values(FILING_SCHEMES).includes(scheme)) {
    throw new ServiceError(`scheme must be one of ${Object.values(FILING_SCHEMES).join(', ')}`);
  }
  const [result] = await pool.query(
    `UPDATE suppliers
        SET filing_scheme = ?, filing_scheme_confidence = 'HIGH', filing_scheme_reason = ?,
            filing_scheme_source = 'USER'
      WHERE org_id = ? AND gstin = ?${onlyIfInferred ? " AND filing_scheme_source = 'INFERRED'" : ''}`,
    [scheme, USER_SCHEME_REASON, orgId, gstin]
  );
  return result.affectedRows > 0;
}

// The register's optional "Supplier filing frequency" column: the trader saying how
// a supplier files, recorded exactly as PUT /suppliers/:gstin/filing-scheme records
// it (USER), so whichever of the two came last wins. A blank cell says nothing.
// -> { declared, changed }: changed counts suppliers whose scheme or source moved,
// which is what tells the caller every reconciled period needs re-running.
export async function applyDeclaredSchemes(orgId, invoices) {
  const declared = new Map();
  for (const invoice of invoices) {
    if (invoice.supplierFilingScheme) declared.set(invoice.supplierGstin, invoice.supplierFilingScheme);
  }
  if (!declared.size) return { declared: 0, changed: 0 };

  // The master as the data stands, so a supplier first seen in this register has
  // a row to carry the scheme.
  await refreshSupplierMaster(orgId);
  let changed = 0;
  for (const [gstin, scheme] of declared) {
    const [result] = await pool.query(
      `UPDATE suppliers
          SET filing_scheme = ?, filing_scheme_confidence = 'HIGH', filing_scheme_reason = ?,
              filing_scheme_source = 'USER'
        WHERE org_id = ? AND gstin = ?
          AND NOT (filing_scheme = ? AND filing_scheme_source = 'USER')`,
      [scheme, USER_SCHEME_REASON, orgId, gstin, scheme]
    );
    changed += result.affectedRows;
  }
  return { declared: declared.size, changed };
}

// Hands the scheme back to inference. Reset to the no-history answer first, so a
// supplier with no filing dates for inference to read does not keep the trader's
// scheme under an INFERRED label; the next inference pass decides the rest.
export async function clearSupplierScheme(orgId, gstin) {
  const fallback = inferFilingScheme([]);
  await pool.query(
    `UPDATE suppliers
        SET filing_scheme = ?, filing_scheme_confidence = ?, filing_scheme_reason = ?,
            filing_scheme_source = 'INFERRED'
      WHERE org_id = ? AND gstin = ?`,
    [fallback.scheme, fallback.confidence, fallback.reason, orgId, gstin]
  );
}

// The supplier master, its GSTIN variants and every inferred scheme, refreshed
// from the data as it stands now.
export async function refreshSupplierMaster(orgId) {
  await syncSuppliers(orgId);
  await inferSupplierSchemes(orgId);
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
//   mismatch_count  how many of those the run found with DIFFERENT AMOUNTS
//                   (VALUE_MISMATCH) — see below.
//   missed          expected in books but nothing observed on the portal at all.
//
// A record reported under a mistyped GSTIN counts for the supplier it belongs to.
// refreshMaster: false when the caller has just refreshed the master and schemes.
export async function rebuildSupplierPeriods(orgId, taxPeriod, { runId = null, refreshMaster = true } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod ?? ''))) {
    throw new ServiceError('taxPeriod must be YYYY-MM');
  }

  if (refreshMaster) await refreshSupplierMaster(orgId);

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
         SELECT ${SUPPLIER_OF_RECORD} AS supplier_gstin, pr.doc_type, pr.total_tax,
                pr.taxable_value, pr.supplier_filed_on AS gstr1_filed_on,
                MAX(CASE WHEN pr.source = 'GSTR2B' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY ${SUPPLIER_OF_RECORD}) AS in_2b,
                MAX(CASE WHEN pr.source = 'IMS' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY ${SUPPLIER_OF_RECORD}) AS in_ims,
                ROW_NUMBER() OVER (
                  PARTITION BY ${SUPPLIER_OF_RECORD}, pr.section, pr.invoice_no_norm,
                               pr.invoice_date, pr.doc_type, pr.identity_seq
                  ORDER BY CASE WHEN pr.source = 'GSTR2B' THEN 0 ELSE 1 END
                ) AS dedupe_rank
           FROM portal_records pr ${ALIAS_JOIN}
          WHERE pr.org_id = ? AND pr.tax_period = ? AND pr.supplier_gstin IS NOT NULL
            AND pr.absent_since IS NULL
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
  // than a second, divergent definition of "problem". It feeds "amounts differed
  // from your books on N of M documents" and the risk model's mismatch rate, so it
  // counts exactly that: VALUE_MISMATCH. It used to count every result that was
  // not MATCHED — invoice-number-only differences, phantoms, reverse charge,
  // ineligible — and was false for 22 of 24 suppliers showing it (audit P8).
  const mismatchByGstin = new Map();
  if (runId) {
    const [mismatchRows] = await pool.query(
      `SELECT COALESCE(ei.supplier_gstin, ${SUPPLIER_OF_RECORD}) AS supplier_gstin,
              SUM(mr.bucket = 'VALUE_MISMATCH') AS mismatches
         FROM match_results mr
         LEFT JOIN expected_invoices ei ON ei.id = mr.expected_invoice_id
         LEFT JOIN portal_records pr ON pr.id = mr.portal_record_id
         ${ALIAS_JOIN}
        WHERE mr.org_id = ? AND mr.run_id = ?
        GROUP BY COALESCE(ei.supplier_gstin, ${SUPPLIER_OF_RECORD})`,
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

// window: the tax periods every figure on a row is summed over — the same ones
// the supplier's risk band was scored on (supplierRisk.supplierView). A row once
// read "Periods 3 · Docs 68" beside "differed on 10 of 36 documents": three
// figures, two spans of history (audit P17). null sums every period held.
export async function listSuppliers(orgId, { limit = 200, window = null } = {}) {
  const inWindow = window?.length ? 'AND sp.tax_period IN (?)' : '';
  const [rows] = await pool.query(
    `SELECT s.id, s.gstin, s.trade_name, s.legal_name, s.state_code, s.filing_scheme,
            s.filing_scheme_confidence, s.filing_scheme_reason, s.filing_scheme_source,
            s.first_seen_period, s.last_seen_period, ${CONTACT_COLUMNS},
            ${VARIANTS_OF_SUPPLIER} AS gstin_variants,
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
       LEFT JOIN supplier_contacts sc ON sc.org_id = s.org_id AND sc.gstin = s.gstin
       LEFT JOIN supplier_periods sp
              ON sp.supplier_id = s.id AND sp.org_id = s.org_id ${inWindow}
      WHERE s.org_id = ?
      GROUP BY s.id
      ORDER BY late_count DESC, missed_count DESC, s.trade_name
      LIMIT ?`,
    window?.length ? [window, orgId, limit] : [orgId, limit]
  );

  return rows.map((row) => ({
    gstin: row.gstin,
    // False on the sample data for every supplier: its generator writes a random
    // check character. On real data a false here is worth a second look.
    gstinChecksumValid: isValidGstin(row.gstin),
    // GSTINs the portal reported that were attached to this supplier: flagged,
    // never a supplier of their own.
    gstinVariants: parseVariants(row.gstin_variants),
    tradeName: row.trade_name,
    legalName: row.legal_name,
    stateCode: row.state_code,
    filingScheme: row.filing_scheme,
    filingSchemeConfidence: row.filing_scheme_confidence,
    filingSchemeReason: row.filing_scheme_reason,
    filingSchemeSource: row.filing_scheme_source,
    firstSeenPeriod: row.first_seen_period,
    lastSeenPeriod: row.last_seen_period,
    // Who to call; null until the register or the trader says. whatsapp is the
    // number a wa.me link takes, null for anything that is not a mobile number.
    contact: contactView(row),
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

// A supplier's GSTIN variants as one column, for a query aliased s.
const VARIANTS_OF_SUPPLIER = `(
  SELECT GROUP_CONCAT(
           CONCAT_WS(':', a.alias_gstin, a.evidence, a.documents, a.checksum_valid)
           ORDER BY a.alias_gstin SEPARATOR ','
         )
    FROM supplier_gstin_aliases a
   WHERE a.org_id = s.org_id AND a.gstin = s.gstin)`;

// 'GSTIN:EVIDENCE:docs:valid,...' -> [{ gstin, evidence, documents, checksumValid }]
function parseVariants(column) {
  if (!column) return [];
  return String(column).split(',').map((entry) => {
    const [gstin, evidence, documents, valid] = entry.split(':');
    return { gstin, evidence, documents: Number(documents), checksumValid: valid === '1' };
  });
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

// A GSTIN variant answers with the supplier it belongs to.
export async function getSupplierHistory(orgId, gstinValue) {
  const [suppliers] = await pool.query(
    `SELECT s.id, s.gstin, s.trade_name, s.legal_name, s.state_code, s.filing_scheme,
            s.filing_scheme_confidence, s.filing_scheme_reason, s.filing_scheme_source,
            ${CONTACT_COLUMNS}, ${VARIANTS_OF_SUPPLIER} AS gstin_variants
       FROM suppliers s
       LEFT JOIN supplier_contacts sc ON sc.org_id = s.org_id AND sc.gstin = s.gstin
      WHERE s.org_id = ?
        AND s.gstin = COALESCE(
              (SELECT gstin FROM supplier_gstin_aliases WHERE org_id = ? AND alias_gstin = ?), ?)`,
    [orgId, orgId, gstinValue, gstinValue]
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
    gstinChecksumValid: isValidGstin(supplier.gstin),
    gstinVariants: parseVariants(supplier.gstin_variants),
    tradeName: supplier.trade_name,
    legalName: supplier.legal_name,
    stateCode: supplier.state_code,
    filingScheme: supplier.filing_scheme,
    filingSchemeConfidence: supplier.filing_scheme_confidence,
    filingSchemeReason: supplier.filing_scheme_reason,
    filingSchemeSource: supplier.filing_scheme_source,
    contact: contactView(supplier),
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
