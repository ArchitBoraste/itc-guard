-- 008_claimable_split.sql — an accepted mismatch is claimed in part.
--
-- Accepting a value mismatch claims only what both sides agree on: the smaller
-- figure for an invoice or debit note, the larger reversal for a credit note (see
-- acceptedItc in services/totals.js). The rest of the books amount is the
-- difference still being chased, and stays at risk. One result can now feed two
-- totals, so the claimable part is stored beside signed_itc instead of being
-- implied by total_bucket.
ALTER TABLE match_results
  ADD COLUMN claimable_itc BIGINT NOT NULL DEFAULT 0
    COMMENT 'paise this result adds to claimable; the rest of signed_itc on a CLAIMABLE row is at risk'
    AFTER total_bucket;

-- Every result written before this was claimed whole.
UPDATE match_results SET claimable_itc = COALESCE(signed_itc, 0) WHERE total_bucket = 'CLAIMABLE';
