-- 011_workspace_clock.sql — one as-of date per workspace.
--
-- Every recommendation, cut-off state, "days left" and deadline is a statement
-- about a date. Each run used to carry its own (by default the 16th of the month
-- after its period), so two screens could read the same supplier on different
-- days. The workspace now has one date, and every run is computed against it.
--
-- NULL means "today": the API reads the current date in India each time it is
-- asked. A set date stays until it is changed or cleared, which is how a demo
-- walks through a filing month without touching the system clock.
ALTER TABLE organizations
  ADD COLUMN as_of_date DATE NULL
    COMMENT 'the date every computation reads; NULL follows today in India'
    AFTER filer_type;
