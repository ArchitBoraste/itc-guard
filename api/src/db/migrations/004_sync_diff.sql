-- 004_sync_diff.sql — what moved on the portal between two downloads.
--
-- Phase 4 wrote record_changes from inside the ingest with a three-way guess at
-- the change type. This migration gives the diff its own vocabulary and enough
-- detail for the UI to say WHAT changed rather than only THAT something did.
--
-- ---------------------------------------------------------------------------
-- Naming: AMENDED vs CHANGED_AFTER_REVIEW vs CONFIRMATION_RESET
-- ---------------------------------------------------------------------------
--
-- CHANGED_AFTER_REVIEW and AMENDED are the SAME SIGNAL. Both mean "same
-- identity_key, different content_hash". Nothing in the old code checked that a
-- review had happened, so the name promised something it did not test. AMENDED is
-- now the canonical name; CHANGED_AFTER_REVIEW stays in the enum so the rows
-- already written under it still read, and services/syncDiff.js maps it to
-- AMENDED on the way out. Nothing writes it any more.
--
-- CONFIRMATION_RESET (003) is genuinely DIFFERENT and is deliberately left alone:
--   * AMENDED is an observation about the PORTAL, written at ingest, whether or
--     not anyone ever looked at the record.
--   * CONFIRMATION_RESET is a consequence for a HUMAN DECISION, computed during
--     the run rebuild by carryForward(), and it also fires with no hash change at
--     all — a bucket move (VALUE_MISMATCH -> MATCHED after the books side was
--     corrected) invalidates a decision without the supplier touching anything.
-- One is "the supplier changed this"; the other is "your answer no longer
-- applies". They are not redundant, and there is no second reset mechanism here.
--
-- ---------------------------------------------------------------------------

ALTER TABLE record_changes
  MODIFY COLUMN change_type ENUM(
    -- current vocabulary, written by services/syncDiff.js
    'NEW','AMENDED','DISAPPEARED','REAPPEARED','STATUS_CHANGE',
    -- retired: read by the change feed, never written again.
    -- CHANGED_AFTER_REVIEW is AMENDED under its old name.
    'CHANGED_AFTER_REVIEW','FILING_STATUS_CHANGED','ACTION_CHANGED'
  ) NOT NULL,
  -- Per-field detail: [{ field, oldValue, newValue, delta }]. old_values /
  -- new_values keep the whole before/after snapshot; this is the diff itself, so
  -- the feed does not have to re-derive which of six fields actually moved.
  ADD COLUMN changed_fields JSON NULL AFTER new_values,
  -- The rupee movement, in paise, signed new - old. NULL when the change did not
  -- touch money (a filing-status flip does not).
  ADD COLUMN delta_taxable_value BIGINT NULL AFTER changed_fields,
  ADD COLUMN delta_total_tax     BIGINT NULL AFTER delta_taxable_value,
  -- The feed is "most recent first" over a period, and it joins portal_records
  -- for the source. Keyed for that read.
  ADD KEY ix_changes_org_recent (org_id, id);

-- A supplier can DELETE a saved record before filing (docs/gst-lifecycle-
-- reference.md: "A saved record can be edited (resetting your action) or deleted
-- before filing"). The row is kept — it is still the last thing the portal said,
-- and match_results point at it — but it is marked absent so that a later upload
-- can tell REAPPEARED from a first sighting.
--
-- Reconciliation deliberately still sees an absent record: changing what the
-- matcher does with it would move rupee totals, which is a separate decision from
-- reporting the disappearance.
ALTER TABLE portal_records
  ADD COLUMN absent_since DATETIME NULL
    COMMENT 'set when a record vanished from its source; cleared when it returns'
    AFTER last_seen_at,
  ADD KEY ix_portal_absent (org_id, source, tax_period, absent_since);
