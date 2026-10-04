-- 012_upload_snapshots.sql — an IMS upload is a snapshot of one day, and a newer
-- one replaces it.
--
-- A trader downloads IMS again and again through the month. Each download is the
-- portal as it stood on one day, so the upload records that day: the workspace
-- date when it was uploaded. A later upload of the same kind and period replaces
-- what an earlier one held (services/ingest.js), and the earlier one stays in the
-- history marked as replaced instead of vanishing.
ALTER TABLE uploads
  ADD COLUMN snapshot_date DATE NULL
    COMMENT 'IMS: the workspace date it was uploaded on, the day the download describes'
    AFTER tax_period,
  ADD COLUMN replaced_at DATETIME NULL
    COMMENT 'when a later upload of the same kind and period replaced it'
    AFTER committed_at,
  ADD COLUMN replaced_by_upload_id BIGINT UNSIGNED NULL
    COMMENT 'the upload that replaced it; NULL again if that one is deleted'
    AFTER replaced_at,
  ADD CONSTRAINT fk_uploads_replaced_by FOREIGN KEY (replaced_by_upload_id)
    REFERENCES uploads (id) ON DELETE SET NULL;
