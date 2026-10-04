-- 013_supplier_contacts.sql — who to call at each supplier.
--
-- The chase message needs a person and a number. They arrive in the purchase
-- register's optional contact columns (latest upload wins) or are typed in by the
-- trader, which is the only way for a supplier who is on the portal but not in the
-- books.
--
-- Keyed on the GSTIN rather than on suppliers.id, deliberately: the supplier
-- master is rebuilt from the data on every run and drops a supplier the data no
-- longer carries, and a contact must not go with it. A contact arrives with the
-- register, before any run has built the master at all.
CREATE TABLE supplier_contacts (
  org_id          BIGINT UNSIGNED NOT NULL,
  gstin           CHAR(15)        NOT NULL,
  contact_person  VARCHAR(255)    NULL,
  phone           VARCHAR(32)     NULL,
  email           VARCHAR(255)    NULL,
  source          ENUM('REGISTER','USER') NOT NULL
    COMMENT 'REGISTER: from an uploaded register; USER: typed in by the trader',
  upload_id       BIGINT UNSIGNED NULL COMMENT 'the register it last came from',
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, gstin),
  CONSTRAINT fk_supplier_contacts_org FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_supplier_contacts_upload FOREIGN KEY (upload_id)
    REFERENCES uploads (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- suppliers.contact_phone / contact_email (001) were never written by the app.
-- Anything a deployment did put there is carried over, and the columns are left
-- in place so a running older API keeps working while this migration applies.
INSERT INTO supplier_contacts (org_id, gstin, phone, email, source)
SELECT org_id, gstin, contact_phone, contact_email, 'USER'
  FROM suppliers
 WHERE contact_phone IS NOT NULL OR contact_email IS NOT NULL;
