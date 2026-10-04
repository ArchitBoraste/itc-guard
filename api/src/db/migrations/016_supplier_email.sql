-- 016_supplier_email.sql — supplier messages sent from the app, and the replies.
--
-- message_threads: one per email the trader sends a supplier from the app
-- (services/supplierEmail.js). to_address is the address it actually went to,
-- kept as sent: a later register that changes the supplier's email changes the
-- NEXT send, never an earlier thread. ref is the tag in the subject
-- ("[ITC Guard #K7Q2XM]") and message_id our own Message-ID, the two ways a reply
-- finds its thread (services/mailInbox.js). Both are unique across workspaces:
-- every workspace sends from one mailbox.
--
-- message_replies: the new text of each reply (quoted history stripped), with the
-- optional Gemini check of what it says. Untrusted text, shown escaped.
--
-- organizations.trader_phone: the trader's own number, from the register's
-- "Contact phone" label (latest register wins). The email signature carries it.
ALTER TABLE organizations
  ADD COLUMN trader_phone VARCHAR(32) NULL
    COMMENT 'the trader''s own phone, from the latest register carrying one'
    AFTER workspace_gstin;

CREATE TABLE message_threads (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id          BIGINT UNSIGNED NOT NULL,
  ref             CHAR(6)         NOT NULL,
  supplier_gstin  CHAR(15)        NOT NULL,
  supplier_name   VARCHAR(255)    NULL,
  document_refs   JSON            NOT NULL COMMENT 'the invoice numbers the message is about',
  tax_period      CHAR(7)         NULL,
  context         VARCHAR(20)     NULL COMMENT 'the screen it was sent from',
  to_address      VARCHAR(255)    NOT NULL,
  subject         VARCHAR(500)    NOT NULL,
  body            TEXT            NOT NULL,
  message_id      VARCHAR(255)    NOT NULL,
  sent_at         DATETIME        NOT NULL COMMENT 'UTC',
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_threads_ref (ref),
  UNIQUE KEY uq_message_threads_message_id (message_id),
  KEY ix_message_threads_org_supplier (org_id, supplier_gstin),
  KEY ix_message_threads_org_sent (org_id, sent_at),
  CONSTRAINT fk_message_threads_org FOREIGN KEY (org_id) REFERENCES organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE message_replies (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                BIGINT UNSIGNED NOT NULL,
  thread_id             BIGINT UNSIGNED NOT NULL,
  message_id            VARCHAR(255)    NULL COMMENT 'the reply''s own Message-ID, so a mail is stored once',
  from_address          VARCHAR(255)    NULL,
  received_at           DATETIME        NOT NULL COMMENT 'UTC',
  body                  TEXT            NOT NULL COMMENT 'the new reply text only',
  intent                VARCHAR(20)     NOT NULL DEFAULT 'unchecked',
  summary               VARCHAR(500)    NULL,
  promised_date         DATE            NULL,
  mentions_our_invoice  TINYINT(1)      NULL,
  read_at               DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_replies_message_id (message_id),
  KEY ix_message_replies_org_read (org_id, read_at),
  CONSTRAINT fk_message_replies_org FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_message_replies_thread FOREIGN KEY (thread_id)
    REFERENCES message_threads (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
