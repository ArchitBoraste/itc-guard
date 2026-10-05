-- 017_message_channels.sql — supplier messages on more than one channel.
--
-- message_threads.channel: a thread is email or WhatsApp; every earlier thread is
-- email. The thread's own columns still describe its FIRST message: to_address is
-- where it went (an email address, or a WhatsApp number in E.164, "+919876543210"),
-- message_id our Message-ID or the wamid WhatsApp returned for it.
--
-- message_sends: every message the app sent on a thread, oldest first. An email
-- thread has exactly one. A WhatsApp thread gains one each time the trader writes
-- to the same number about the same documents again (services/supplierWhatsapp.js).
-- The daily send limit counts these rows, both channels together. external_id is
-- the email's Message-ID or the WhatsApp wamid, which is how a swipe-reply and a
-- delivery status find their message. status is WhatsApp's latest delivery state
-- (sent < delivered < read; failed wins), status_detail why it failed, in plain
-- words.
--
-- Every existing thread gets its one send, so the limit and the thread view read
-- the old email threads exactly as before.
ALTER TABLE message_threads
  ADD COLUMN channel VARCHAR(10) NOT NULL DEFAULT 'email' COMMENT 'email | whatsapp' AFTER ref;

CREATE TABLE message_sends (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id         BIGINT UNSIGNED NOT NULL,
  thread_id      BIGINT UNSIGNED NOT NULL,
  channel        VARCHAR(10)     NOT NULL COMMENT 'email | whatsapp',
  format         VARCHAR(10)     NOT NULL COMMENT 'email | template | text',
  to_address     VARCHAR(255)    NOT NULL COMMENT 'the address or E.164 number it went to',
  body           TEXT            NOT NULL COMMENT 'what the supplier was sent',
  external_id    VARCHAR(255)    NOT NULL COMMENT 'our Message-ID, or the wamid WhatsApp returned',
  status         VARCHAR(10)     NULL COMMENT 'WhatsApp: sent | delivered | read | failed',
  status_detail  VARCHAR(255)    NULL COMMENT 'why it failed, in plain words',
  status_at      DATETIME        NULL COMMENT 'UTC',
  sent_at        DATETIME        NOT NULL COMMENT 'UTC',
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_sends_external_id (external_id),
  KEY ix_message_sends_org_sent (org_id, sent_at),
  KEY ix_message_sends_thread (thread_id),
  KEY ix_message_sends_channel_to (channel, to_address, sent_at),
  CONSTRAINT fk_message_sends_org FOREIGN KEY (org_id) REFERENCES organizations (id),
  CONSTRAINT fk_message_sends_thread FOREIGN KEY (thread_id)
    REFERENCES message_threads (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO message_sends (org_id, thread_id, channel, format, to_address, body, external_id, sent_at)
SELECT org_id, id, 'email', 'email', to_address, body, message_id, sent_at
  FROM message_threads;
