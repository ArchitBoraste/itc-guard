-- 014_cross_period_links.sql — an earlier period's document arriving late.
--
-- A run reads only its own period's portal records. A GSTR-1A amendment, or a
-- document the supplier reported late, can belong to an EARLIER period's books
-- row: the run links the two (matching/link.js), so the result has the earlier
-- books row on one side and this period's record on the other. These say so, and
-- keep the row out of this period's own totals, which describe its own books:
-- the credit the link brings to the period is reported apart (getRun().carriedIn).
ALTER TABLE match_results
  ADD COLUMN linked_period CHAR(7) NULL
    COMMENT 'tax period of the earlier books document this result links; NULL for the run''s own'
    AFTER claimable_itc,
  ADD COLUMN linked_via VARCHAR(16) NULL
    COMMENT 'how it arrived: AMENDMENT (b2ba/cdnra) or LATE_FILING'
    AFTER linked_period,
  ADD KEY ix_match_org_linked (org_id, linked_period);
