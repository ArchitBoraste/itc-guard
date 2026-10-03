-- 010_supplier_gstin_aliases.sql — a mistyped GSTIN is not a supplier.
--
-- The supplier master is built from the GSTINs the portal reports, and a supplier
-- who mistypes their own GSTIN on one invoice reports it under a GSTIN that is
-- nobody's. Each such typo became a supplier of its own: 108 suppliers for 40 on
-- the sample, "National Supply Co" five times (audit P15).
--
-- A variant GSTIN is attached to the supplier it belongs to (see
-- services/supplierStats.js resolveGstinAliases) and every supplier figure counts
-- its documents under that supplier. The variant is kept, not rewritten: it is
-- what the portal says, and the screens flag it.
CREATE TABLE supplier_gstin_aliases (
  org_id             BIGINT UNSIGNED NOT NULL,
  alias_gstin        CHAR(15)        NOT NULL COMMENT 'a GSTIN the portal reported that belongs to another supplier',
  gstin              CHAR(15)        NOT NULL COMMENT 'the supplier it belongs to',
  evidence           ENUM('MATCHED_PARTNER','ONE_CHARACTER') NOT NULL,
  documents          INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'portal records reported under the variant',
  checksum_valid     TINYINT(1)      NOT NULL DEFAULT 0 COMMENT 'whether the variant passes the GSTIN check digit',
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, alias_gstin),
  KEY ix_aliases_supplier (org_id, gstin),
  CONSTRAINT fk_aliases_org FOREIGN KEY (org_id) REFERENCES organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
