-- 001_init.sql — ITC Guard initial schema.
--
-- Conventions:
--   * Money is BIGINT integer paise. Never DECIMAL, never FLOAT.
--   * Dates are DATE, read back as ISO yyyy-mm-dd strings (see db/pool.js).
--   * tax_period is CHAR(7) 'YYYY-MM'.
--   * Every tenant-owned table carries org_id and is queried on it.
--     organizations.id IS the org_id — it is not duplicated onto itself.
--   * GSTIN is CHAR(15).

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gstin           CHAR(15)        NOT NULL,
  legal_name      VARCHAR(255)    NOT NULL,
  trade_name      VARCHAR(255)    NULL,
  state_code      CHAR(2)         NULL,
  -- Drives the GSTR-2B cut-off: 11th for MONTHLY GSTR-1 filers, 13th for QRMP.
  filer_type      ENUM('MONTHLY','QRMP') NOT NULL DEFAULT 'MONTHLY',
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organizations_gstin (gstin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stubbed single user for the prototype. No auth, no roles.
CREATE TABLE users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id          BIGINT UNSIGNED NOT NULL,
  email           VARCHAR(255)    NOT NULL,
  display_name    VARCHAR(255)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_org_email (org_id, email),
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Ingestion
-- ---------------------------------------------------------------------------

CREATE TABLE uploads (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  kind              ENUM('PURCHASE_REGISTER','IMS','GSTR2B') NOT NULL,
  file_format       ENUM('CSV','XLSX','JSON')                NOT NULL,
  original_filename VARCHAR(512)    NOT NULL,
  byte_size         BIGINT UNSIGNED NULL,
  -- sha256 of the raw bytes: catches a re-upload of the same file.
  file_hash         CHAR(64)        NULL,
  tax_period        CHAR(7)         NULL,
  row_count         INT UNSIGNED    NULL,
  status            ENUM('RECEIVED','PARSED','FAILED') NOT NULL DEFAULT 'RECEIVED',
  error_message     TEXT            NULL,
  uploaded_by       BIGINT UNSIGNED NULL,
  parsed_at         DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_uploads_org_kind_period (org_id, kind, tax_period),
  KEY ix_uploads_org_hash (org_id, file_hash),
  CONSTRAINT fk_uploads_org  FOREIGN KEY (org_id)      REFERENCES organizations (id),
  CONSTRAINT fk_uploads_user FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Books side — purchase-register rows grouped into documents
-- ---------------------------------------------------------------------------

CREATE TABLE expected_invoices (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  upload_id         BIGINT UNSIGNED NULL,
  supplier_gstin    CHAR(15)        NOT NULL,
  supplier_name     VARCHAR(255)    NULL,
  doc_type          ENUM('INVOICE','DEBIT_NOTE','CREDIT_NOTE') NOT NULL DEFAULT 'INVOICE',
  supply_type       ENUM('B2B','DE','SEZWP','SEZWOP')          NOT NULL DEFAULT 'B2B',
  invoice_no        VARCHAR(64)     NOT NULL,
  invoice_no_norm   VARCHAR(64)     NOT NULL,
  invoice_date      DATE            NOT NULL,
  tax_period        CHAR(7)         NOT NULL,
  place_of_supply   CHAR(2)         NULL,
  taxable_value     BIGINT          NOT NULL DEFAULT 0,
  igst              BIGINT          NOT NULL DEFAULT 0,
  cgst              BIGINT          NOT NULL DEFAULT 0,
  sgst              BIGINT          NOT NULL DEFAULT 0,
  cess              BIGINT          NOT NULL DEFAULT 0,
  total_tax         BIGINT          NOT NULL DEFAULT 0,
  -- Invoice value incl. tax. Needed verbatim for the IMS `val` field.
  invoice_value     BIGINT          NULL,
  reverse_charge    TINYINT(1)      NOT NULL DEFAULT 0,
  -- The trader's own eligibility call from the PR: Inputs / Capital goods /
  -- Input services / Ineligible.
  itc_eligibility   VARCHAR(32)     NULL,
  -- Credit and debit notes point back at the invoice they adjust.
  original_invoice_no   VARCHAR(64) NULL,
  original_invoice_date DATE        NULL,
  source_row_no     INT UNSIGNED    NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_expected_blocking (org_id, supplier_gstin, invoice_no_norm, tax_period),
  KEY ix_expected_org_period (org_id, tax_period),
  KEY ix_expected_upload (upload_id),
  CONSTRAINT fk_expected_org    FOREIGN KEY (org_id)    REFERENCES organizations (id),
  CONSTRAINT fk_expected_upload FOREIGN KEY (upload_id) REFERENCES uploads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One purchase-register row = one invoice x one tax rate.
CREATE TABLE expected_rate_lines (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id              BIGINT UNSIGNED NOT NULL,
  expected_invoice_id BIGINT UNSIGNED NOT NULL,
  hsn                 VARCHAR(16)     NULL,
  rate                DECIMAL(5,2)    NULL,
  taxable_value       BIGINT          NOT NULL DEFAULT 0,
  igst                BIGINT          NOT NULL DEFAULT 0,
  cgst                BIGINT          NOT NULL DEFAULT 0,
  sgst                BIGINT          NOT NULL DEFAULT 0,
  cess                BIGINT          NOT NULL DEFAULT 0,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_expected_lines_parent (org_id, expected_invoice_id),
  CONSTRAINT fk_expected_lines_org    FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_expected_lines_parent FOREIGN KEY (expected_invoice_id)
    REFERENCES expected_invoices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Portal side — one row per document observed in IMS or GSTR-2B
-- ---------------------------------------------------------------------------

CREATE TABLE portal_records (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  upload_id         BIGINT UNSIGNED NULL,
  source            ENUM('IMS','GSTR2B') NOT NULL,
  -- 2B has 10 sections, IMS 8. isd/isda and impg/impgsez are 2B-only.
  section           ENUM('b2b','b2ba','cdnr','cdnra','isd','isda','impg','impgsez','ecom','ecoma')
                    NOT NULL,
  -- NULL for overseas imports: impg carries no supplier GSTIN.
  supplier_gstin    CHAR(15)        NULL,
  supplier_name     VARCHAR(255)    NULL,
  doc_type          ENUM('INVOICE','DEBIT_NOTE','CREDIT_NOTE','ISD_INVOICE','ISD_CREDIT','BOE')
                    NOT NULL DEFAULT 'INVOICE',
  supply_type       ENUM('B2B','DE','SEZWP','SEZWOP') NULL,
  -- For impg/impgsez this holds the Bill of Entry number.
  invoice_no        VARCHAR(64)     NOT NULL,
  invoice_no_norm   VARCHAR(64)     NOT NULL,
  invoice_date      DATE            NOT NULL,
  tax_period        CHAR(7)         NOT NULL,
  place_of_supply   CHAR(2)         NULL,
  taxable_value     BIGINT          NOT NULL DEFAULT 0,
  igst              BIGINT          NOT NULL DEFAULT 0,
  cgst              BIGINT          NOT NULL DEFAULT 0,
  sgst              BIGINT          NOT NULL DEFAULT 0,
  cess              BIGINT          NOT NULL DEFAULT 0,
  total_tax         BIGINT          NOT NULL DEFAULT 0,
  invoice_value     BIGINT          NULL,
  reverse_charge    TINYINT(1)      NOT NULL DEFAULT 0,
  -- 2B itcavl / rsn. RCM, ISD and ITC-ineligible records never enter IMS.
  itc_available          TINYINT(1)   NULL,
  itc_ineligible_reason  VARCHAR(255) NULL,
  -- 2B supfildt (supplier's GSTR-1 filing date) and cfs.
  supplier_filed_on          DATE    NULL,
  counterparty_filing_status CHAR(1) NULL,
  supplier_return_period     CHAR(7) NULL,
  -- 2B diffprcnt. Absent in the JSON means 100.
  differential_percent   DECIMAL(6,3) NULL,
  -- IMS srcfilstatus. Only FILED records reach GSTR-2B.
  filing_status     ENUM('SAVED','FILED') NULL,
  -- IMS action. N is the dangerous default: no action = deemed accepted.
  ims_action        ENUM('A','R','P','N') NULL,
  -- IMS blocked flags. Violating them makes the portal reject the whole upload.
  pending_blocked        TINYINT(1) NOT NULL DEFAULT 0,
  remarks_blocked        TINYINT(1) NOT NULL DEFAULT 0,
  itc_reduction_blocked  TINYINT(1) NOT NULL DEFAULT 0,
  -- Amendment sections reference the original document.
  original_invoice_no   VARCHAR(64) NULL,
  original_invoice_date DATE        NULL,
  -- Imports key on port code + BoE number instead of a GSTIN.
  port_code         VARCHAR(16)     NULL,
  -- IMS srcform: R1 / R5 / R1A.
  source_form       VARCHAR(8)      NULL,
  -- sha256 over (supplier_gstin, invoice_no_norm, invoice_date, taxable_value,
  -- total_tax, doc_type). A changed hash on the same identity key means the
  -- supplier amended a saved record: raise CHANGED_AFTER_REVIEW.
  content_hash      CHAR(64)        NOT NULL,
  first_seen_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_portal_blocking (org_id, supplier_gstin, invoice_no_norm, tax_period),
  KEY ix_portal_org_source_period (org_id, source, tax_period),
  KEY ix_portal_content_hash (org_id, content_hash),
  KEY ix_portal_upload (upload_id),
  CONSTRAINT fk_portal_org    FOREIGN KEY (org_id)    REFERENCES organizations (id),
  CONSTRAINT fk_portal_upload FOREIGN KEY (upload_id) REFERENCES uploads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE portal_rate_lines (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  portal_record_id  BIGINT UNSIGNED NOT NULL,
  hsn               VARCHAR(16)     NULL,
  rate              DECIMAL(5,2)    NULL,
  taxable_value     BIGINT          NOT NULL DEFAULT 0,
  igst              BIGINT          NOT NULL DEFAULT 0,
  cgst              BIGINT          NOT NULL DEFAULT 0,
  sgst              BIGINT          NOT NULL DEFAULT 0,
  cess              BIGINT          NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_portal_lines_parent (org_id, portal_record_id),
  CONSTRAINT fk_portal_lines_org    FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_portal_lines_parent FOREIGN KEY (portal_record_id)
    REFERENCES portal_records (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What moved on the portal between two observations of the same record.
CREATE TABLE record_changes (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  portal_record_id  BIGINT UNSIGNED NOT NULL,
  change_type       ENUM('NEW','CHANGED_AFTER_REVIEW','FILING_STATUS_CHANGED',
                         'ACTION_CHANGED','DISAPPEARED') NOT NULL,
  old_content_hash  CHAR(64)        NULL,
  new_content_hash  CHAR(64)        NULL,
  old_values        JSON            NULL,
  new_values        JSON            NULL,
  detected_from_upload_id BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_changes_org_record (org_id, portal_record_id),
  KEY ix_changes_org_type (org_id, change_type),
  CONSTRAINT fk_changes_org    FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_changes_record FOREIGN KEY (portal_record_id)
    REFERENCES portal_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_changes_upload FOREIGN KEY (detected_from_upload_id) REFERENCES uploads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  tax_period        CHAR(7)         NOT NULL,
  -- PREVENTIVE: 1st-11th, chase before the cut-off. REACTIVE: 14th-20th.
  mode              ENUM('PREVENTIVE','REACTIVE') NOT NULL DEFAULT 'REACTIVE',
  pr_upload_id      BIGINT UNSIGNED NULL,
  ims_upload_id     BIGINT UNSIGNED NULL,
  gstr2b_upload_id  BIGINT UNSIGNED NULL,
  status            ENUM('PENDING','RUNNING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
  engine_version    VARCHAR(32)     NULL,
  -- Weights and thresholds in force for this run, so old results stay explainable.
  thresholds        JSON            NULL,
  -- Bucket counts and rupee totals.
  summary           JSON            NULL,
  error_message     TEXT            NULL,
  started_at        DATETIME        NULL,
  finished_at       DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_runs_org_period (org_id, tax_period, created_at),
  CONSTRAINT fk_runs_org    FOREIGN KEY (org_id)           REFERENCES organizations (id),
  CONSTRAINT fk_runs_pr     FOREIGN KEY (pr_upload_id)     REFERENCES uploads (id),
  CONSTRAINT fk_runs_ims    FOREIGN KEY (ims_upload_id)    REFERENCES uploads (id),
  CONSTRAINT fk_runs_gstr2b FOREIGN KEY (gstr2b_upload_id) REFERENCES uploads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE match_results (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id              BIGINT UNSIGNED NOT NULL,
  run_id              BIGINT UNSIGNED NOT NULL,
  -- One side is NULL for MISSING_IN_PORTAL / MISSING_IN_BOOKS.
  expected_invoice_id BIGINT UNSIGNED NULL,
  portal_record_id    BIGINT UNSIGNED NULL,
  bucket              ENUM('MATCHED','VALUE_MISMATCH','SUGGESTED','MISSING_IN_PORTAL',
                           'MISSING_IN_BOOKS','INELIGIBLE','NON_IMS') NOT NULL,
  score               DECIMAL(6,4)    NULL,
  -- Per-component scores. The UI must show why something matched.
  score_breakdown     JSON            NULL,
  -- e.g. ["GSTIN_MISMATCH"], ["CHANGED_AFTER_REVIEW"].
  flags               JSON            NULL,
  recommended_action  ENUM('ACCEPT','REJECT','PENDING','CHASE_SUPPLIER','VERIFY',
                           'DEFERRED','NO_ACTION') NULL,
  recommendation_reason VARCHAR(255)  NULL,
  -- IMS remarks: valid only on REJECT/PENDING, max 250 chars.
  remarks             VARCHAR(250)    NULL,
  delta_taxable_value BIGINT          NULL,
  delta_total_tax     BIGINT          NULL,
  -- Rupee impact of getting this one wrong, in paise.
  itc_at_risk         BIGINT          NULL,
  -- A REJECT is never auto-applied; the human decision lands here.
  confirmed_action    ENUM('ACCEPT','REJECT','PENDING','NO_ACTION') NULL,
  confirmed_by        BIGINT UNSIGNED NULL,
  confirmed_at        DATETIME        NULL,
  exported_at         DATETIME        NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_match_org_run_bucket (org_id, run_id, bucket),
  KEY ix_match_org_expected (org_id, expected_invoice_id),
  KEY ix_match_org_portal (org_id, portal_record_id),
  CONSTRAINT fk_match_org      FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_match_run      FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_match_expected FOREIGN KEY (expected_invoice_id)
    REFERENCES expected_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_match_portal   FOREIGN KEY (portal_record_id)
    REFERENCES portal_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_match_user     FOREIGN KEY (confirmed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Supplier risk model
-- ---------------------------------------------------------------------------

CREATE TABLE suppliers (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  gstin             CHAR(15)        NOT NULL,
  legal_name        VARCHAR(255)    NULL,
  trade_name        VARCHAR(255)    NULL,
  state_code        CHAR(2)         NULL,
  -- For the pre-filled chase message. No supplier account, just a data row.
  contact_phone     VARCHAR(20)     NULL,
  contact_email     VARCHAR(255)    NULL,
  notes             TEXT            NULL,
  first_seen_period CHAR(7)         NULL,
  last_seen_period  CHAR(7)         NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppliers_org_gstin (org_id, gstin),
  CONSTRAINT fk_suppliers_org FOREIGN KEY (org_id) REFERENCES organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per supplier per tax period: did they file, and how late.
CREATE TABLE supplier_periods (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                 BIGINT UNSIGNED NOT NULL,
  supplier_id            BIGINT UNSIGNED NOT NULL,
  tax_period             CHAR(7)         NOT NULL,
  expected_count         INT UNSIGNED    NOT NULL DEFAULT 0,
  observed_count         INT UNSIGNED    NOT NULL DEFAULT 0,
  expected_taxable_value BIGINT          NOT NULL DEFAULT 0,
  expected_total_tax     BIGINT          NOT NULL DEFAULT 0,
  observed_taxable_value BIGINT          NOT NULL DEFAULT 0,
  observed_total_tax     BIGINT          NOT NULL DEFAULT 0,
  -- From 2B supfildt, measured against this org's 11th/13th cut-off.
  filed_on               DATE            NULL,
  cut_off_date           DATE            NULL,
  days_late              INT             NULL,
  filed_late             TINYINT(1)      NOT NULL DEFAULT 0,
  missed                 TINYINT(1)      NOT NULL DEFAULT 0,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_periods (org_id, supplier_id, tax_period),
  CONSTRAINT fk_supplier_periods_org FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_supplier_periods_sup FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rolled-up risk band used to rank the chase list.
CREATE TABLE supplier_risk (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  supplier_id       BIGINT UNSIGNED NOT NULL,
  as_of_period      CHAR(7)         NOT NULL,
  risk_band         ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'LOW',
  risk_score        DECIMAL(6,4)    NULL,
  periods_observed  INT UNSIGNED    NOT NULL DEFAULT 0,
  on_time_count     INT UNSIGNED    NOT NULL DEFAULT 0,
  late_count        INT UNSIGNED    NOT NULL DEFAULT 0,
  missed_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  avg_days_late     DECIMAL(6,2)    NULL,
  amount_at_risk    BIGINT          NOT NULL DEFAULT 0,
  -- Inputs to the score, so the band is explainable in the UI.
  features          JSON            NULL,
  computed_at       DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_risk (org_id, supplier_id, as_of_period),
  KEY ix_supplier_risk_band (org_id, as_of_period, risk_band),
  CONSTRAINT fk_supplier_risk_org FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_supplier_risk_sup FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
