-- 002_persistence.sql — wiring the matching engine to the database.
--
-- Adds: idempotent upsert keys for ingested rows, explicit run totals in paise,
-- and the supplier-stats columns the risk model needs.

-- ---------------------------------------------------------------------------
-- Idempotent ingest keys
-- ---------------------------------------------------------------------------
--
-- Re-uploading the same file for the same period must UPDATE rows, not insert
-- duplicates. The build spec proposed keying portal records on
--   (org_id, section, supplier_gstin, invoice_no_norm, tax_period)
-- but that key is lossy against this data: it collides 37 times across the six
-- fixture periods, because the DUPLICATE_INV_NO case is two genuinely different
-- invoices sharing supplier + number + period. Overwriting one of them would
-- destroy exactly the documents the matcher works hardest to resolve.
--
-- identity_key is a sha256 over the spec's fields PLUS source, doc_type,
-- invoice_date, port_code (imports carry no GSTIN) and identity_seq. Adding the
-- date takes collisions 37 -> 4; the last 4 are two real invoices that differ
-- only in amount, which identity_seq separates by ordering them deterministically
-- within their group. Amounts stay OUT of the key so that a supplier amending a
-- record is still seen as an UPDATE with a changed content_hash
-- (CHANGED_AFTER_REVIEW) rather than as a brand-new record.

ALTER TABLE portal_records
  ADD COLUMN identity_seq SMALLINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'ordinal within an otherwise identical identity group'
    AFTER content_hash,
  ADD COLUMN identity_key CHAR(64) NULL
    COMMENT 'sha256 identity for idempotent upsert; excludes money on purpose'
    AFTER identity_seq,
  ADD UNIQUE KEY uq_portal_identity (org_id, identity_key);

ALTER TABLE expected_invoices
  ADD COLUMN identity_seq SMALLINT UNSIGNED NOT NULL DEFAULT 0
    AFTER source_row_no,
  ADD COLUMN identity_key CHAR(64) NULL
    COMMENT 'sha256 identity for idempotent re-upload of the purchase register'
    AFTER identity_seq,
  ADD UNIQUE KEY uq_expected_identity (org_id, identity_key);

-- The preview -> commit flow needs the bytes to survive between two requests.
-- Held in the row rather than on disk: a file storage service is out of scope for
-- the prototype, and the largest fixture is under 400 KB.
ALTER TABLE uploads
  ADD COLUMN raw_bytes LONGBLOB NULL AFTER error_message,
  ADD COLUMN detected_format VARCHAR(32) NULL AFTER file_format,
  ADD COLUMN committed_at DATETIME NULL AFTER parsed_at;

-- ---------------------------------------------------------------------------
-- Run totals — integer paise, no floats anywhere
-- ---------------------------------------------------------------------------
--
-- Every total is a sum of signed tax, where a CREDIT NOTE contributes NEGATIVE
-- tax: a credit note reduces the credit available. Portal and register formats
-- both carry note amounts as positive numbers, so the sign is applied here.
--
-- Which buckets feed which total (see services/totals.js for the single source
-- of truth):
--   claimable_itc  = MATCHED + SUGGESTED confirmed as ACCEPT
--   at_risk_itc    = VALUE_MISMATCH + MISSING_IN_BOOKS + unconfirmed SUGGESTED
--                    + MISSING_IN_PORTAL still inside the cut-off
--   deferred_itc   = MISSING_IN_PORTAL after the cut-off
--   ineligible_itc = INELIGIBLE
--   non_ims_itc    = NON_IMS, informational only and NOT part of expected
--
-- Invariants asserted by the integration test:
--   expected_total_itc = claimable + at_risk + deferred + ineligible
--   expected_total_itc + non_ims_itc = grand_total_itc
ALTER TABLE runs
  ADD COLUMN expected_total_itc BIGINT NOT NULL DEFAULT 0 AFTER summary,
  ADD COLUMN claimable_itc      BIGINT NOT NULL DEFAULT 0 AFTER expected_total_itc,
  ADD COLUMN at_risk_itc        BIGINT NOT NULL DEFAULT 0 AFTER claimable_itc,
  ADD COLUMN deferred_itc       BIGINT NOT NULL DEFAULT 0 AFTER at_risk_itc,
  ADD COLUMN ineligible_itc     BIGINT NOT NULL DEFAULT 0 AFTER deferred_itc,
  ADD COLUMN non_ims_itc        BIGINT NOT NULL DEFAULT 0 AFTER ineligible_itc,
  ADD COLUMN grand_total_itc    BIGINT NOT NULL DEFAULT 0 AFTER non_ims_itc,
  ADD COLUMN as_of_date         DATE   NULL AFTER mode,
  ADD COLUMN filing_scheme      ENUM('MONTHLY','QRMP') NOT NULL DEFAULT 'MONTHLY' AFTER as_of_date,
  ADD COLUMN cut_off_date       DATE   NULL AFTER filing_scheme,
  -- Re-running a period REPLACES its results rather than versioning them: one
  -- current run per (org, period). Documented in services/reconcile.js.
  ADD UNIQUE KEY uq_runs_org_period (org_id, tax_period);

-- itc_at_risk was named for the exception buckets, but the column holds the
-- rupee impact of every result including zero-risk matches. Renamed to say so.
ALTER TABLE match_results
  CHANGE COLUMN itc_at_risk itc_impact BIGINT NULL
    COMMENT 'signed rupee impact in paise; credit notes negative',
  ADD COLUMN signed_itc BIGINT NULL
    COMMENT 'signed tax this result contributes to the run totals' AFTER itc_impact,
  ADD COLUMN total_bucket VARCHAR(16) NULL
    COMMENT 'which run total this result fed: CLAIMABLE/AT_RISK/DEFERRED/INELIGIBLE/NON_IMS'
    AFTER signed_itc,
  ADD COLUMN matched_via VARCHAR(32) NULL AFTER score,
  ADD KEY ix_match_org_run_total (org_id, run_id, total_bucket);

-- ---------------------------------------------------------------------------
-- Supplier stats
-- ---------------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN filing_scheme ENUM('MONTHLY','QRMP') NOT NULL DEFAULT 'MONTHLY'
    AFTER state_code,
  ADD COLUMN filing_scheme_confidence ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'LOW'
    AFTER filing_scheme,
  ADD COLUMN filing_scheme_reason VARCHAR(255) NULL AFTER filing_scheme_confidence;

-- filed_on -> gstr1_filed_on: it is specifically the supplier's GSTR-1 filing
-- date, not their GSTR-3B, and the two are routinely different.
ALTER TABLE supplier_periods
  CHANGE COLUMN filed_on gstr1_filed_on DATE NULL
    COMMENT 'supplier GSTR-1 filing date, from the 2B supplier block',
  CHANGE COLUMN observed_count invoice_count INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'portal documents observed for this supplier and period',
  ADD COLUMN appeared_in_2b TINYINT(1) NOT NULL DEFAULT 0 AFTER invoice_count,
  ADD COLUMN appeared_in_ims TINYINT(1) NOT NULL DEFAULT 0 AFTER appeared_in_2b,
  ADD COLUMN mismatch_count INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'documents for this supplier that did not land in MATCHED'
    AFTER appeared_in_2b,
  ADD COLUMN filing_scheme ENUM('MONTHLY','QRMP') NOT NULL DEFAULT 'MONTHLY'
    AFTER mismatch_count;
