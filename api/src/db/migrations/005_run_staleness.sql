-- 005_run_staleness.sql — a result knows which version of the portal it judged.
--
-- The bug this closes: results are computed once and stored, but the API reads
-- the BOOKS and PORTAL sides live on every request. So after a new IMS file
-- lands, a row renders the supplier's new figures — Taxable 7,17,915 vs
-- 7,12,915, both flagged different — under a verdict of "Agrees with the portal",
-- score 1.00, recommending Accept. Every number on screen is real; the sentence
-- joining them is a month old.
--
-- Accepting there is the worst outcome the product can produce: the trader waives
-- a discrepancy they never saw and loses the disputed credit for good.
--
-- Two defences, and this column is the second one:
--   1. committing a source now re-runs the period's existing run, so results and
--      portal rows move together (routes/api.js).
--   2. every result records the portal content_hash it was computed against. When
--      that no longer equals the record's current hash, the row IS stale, and the
--      API refuses to confirm an action on it while the UI greys it out. This
--      holds no matter which path wrote the portal rows — the re-run could fail,
--      or a tool could load data outside the request cycle.
--
-- match_results.confirmed_content_hash (003) is the same idea for one confirmed
-- decision. This is it for every row, whether decided or not.
ALTER TABLE match_results
  ADD COLUMN portal_content_hash CHAR(64) NULL
    COMMENT 'portal content_hash this result was computed from; null when there is no portal side'
    AFTER portal_record_id,
  ADD KEY ix_match_org_run_stale (org_id, run_id, portal_content_hash);
