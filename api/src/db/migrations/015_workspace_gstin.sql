-- 015_workspace_gstin.sql — the trader GSTIN a workspace is for.
--
-- An empty workspace adopts the trader GSTIN from the first uploaded file that
-- carries one (the register's "GSTIN of recipient", an IMS or 2B file's gstin),
-- and refuses a later file for another GSTIN (services/workspaceGstin.js). The
-- IMS export goes out under it.
--
-- A column of its own, not organizations.gstin: that one is UNIQUE and every
-- visitor workspace has a synthetic one, while any number of visitors may upload
-- the same sample trader's files. NULL until adopted; emptying the workspace
-- (Clear all data) sets it back to NULL.
ALTER TABLE organizations
  ADD COLUMN workspace_gstin CHAR(15) NULL
    COMMENT 'trader GSTIN adopted from the first uploaded file carrying one; NULL until then'
    AFTER gstin;
