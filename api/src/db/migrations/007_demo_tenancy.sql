-- 007_demo_tenancy.sql — one private org per visitor, for public demo hosting.
--
-- Until now stubAuth pinned every request to org 1, so every visitor shared one
-- dataset. These columns turn `organizations` into a small pool: rows are seeded
-- ahead of time, handed to a visitor on their first request, and reclaimed when
-- they stop using them.
--
-- demo_state IS NULL is the load-bearing part. It means "not a demo tenant", and
-- it is what protects org 1 (the presenter's own org) and every reserved test org
-- in test/helpers/db.js: the reaper only ever considers rows where demo_state IS
-- NOT NULL, so nothing it does can reach them even if an org id is miscomputed.
--
--   PROVISIONING — being seeded right now; not yet usable
--   POOL         — seeded and idle, waiting for the next visitor
--   CLAIMED      — handed to a visitor, addressed by their session cookie
--   RETIRED      — finished with; the reaper deletes it on its next pass

ALTER TABLE organizations
  ADD COLUMN demo_state ENUM('PROVISIONING','POOL','CLAIMED','RETIRED') NULL
    AFTER filer_type,
  -- When the row was handed to a visitor. Kept across a reset so a reset does not
  -- look like a brand new claim.
  ADD COLUMN claimed_at DATETIME NULL AFTER demo_state,
  -- Touched (at most once a minute) on every request that presents this org's
  -- cookie. The reaper's idle clock reads this and nothing else.
  ADD COLUMN last_seen_at DATETIME NULL AFTER claimed_at,
  -- Why the last seed or reset failed, if it did. Surfaced by GET /api/session so
  -- a visitor whose reset broke is told, rather than left on an empty screen.
  ADD COLUMN demo_error VARCHAR(255) NULL AFTER last_seen_at;

-- Claiming is `... WHERE demo_state = 'POOL' ORDER BY id LIMIT 1 FOR UPDATE
-- SKIP LOCKED`, and the reaper sweeps on last_seen_at. Both want this.
CREATE INDEX ix_organizations_demo ON organizations (demo_state, last_seen_at);

-- Demo orgs are AUTO_INCREMENT ids. test/helpers/db.js reserves 2-12 by inserting
-- them explicitly, so the counter is pushed clear of that range: a pooled org can
-- never be handed an id a test suite is about to write over. (MySQL ignores this
-- when the table's counter is already higher, which is the behaviour we want.)
ALTER TABLE organizations AUTO_INCREMENT = 1000;
