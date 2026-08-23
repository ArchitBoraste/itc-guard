-- 006_reason_length.sql — room for an explanation that names every field.
--
-- recommendation_reason was VARCHAR(255), and the old VALUE_MISMATCH sentence sat
-- just under it at ~230 characters because it only ever described ONE number: the
-- tax delta. Naming each field that actually differs — which is the point of the
-- fix in matching/recommend.js — pushes a two-field mismatch past 255 and the
-- INSERT fails, taking the whole reconciliation run with it.
--
-- 512 is chosen against the longest sentence the engine can currently build: two
-- field clauses with lakh-scale figures, the filed/saved clause, and the
-- deemed-acceptance suffix, which is a little under 300. services/reconcile.js
-- also clamps to this width, so prose can never again fail a run.
ALTER TABLE match_results
  MODIFY COLUMN recommendation_reason VARCHAR(512) NULL
    COMMENT 'plain-English explanation shown on the row; names each differing field';
