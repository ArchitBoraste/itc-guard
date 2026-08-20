-- 003_confirmation_staleness.sql
--
-- A confirmed_action is a decision about a SPECIFIC version of a record. When a
-- supplier amends what they reported, that decision is no longer about the same
-- thing — and IMS itself behaves this way: editing a saved record replaces it and
-- RESETS the recipient's action.
--
-- Without this, re-running a period carries a stale REJECT forward onto a row
-- that now matches cleanly, and the IMS upload would reject an invoice the trader
-- had already agreed with. Nothing about that looks wrong on screen.
--
-- These two columns record what was true at the moment of confirmation. The
-- rebuild carries the decision forward only when both still hold.
ALTER TABLE match_results
  ADD COLUMN confirmed_content_hash CHAR(64) NULL
    COMMENT 'portal content_hash when the action was confirmed; null if no portal side'
    AFTER confirmed_action,
  ADD COLUMN confirmed_bucket VARCHAR(24) NULL
    COMMENT 'bucket when the action was confirmed'
    AFTER confirmed_content_hash;
