-- 009_supplier_scheme_source.sql — who decided a supplier's filing scheme.
--
-- The scheme sets every cut-off measured against a supplier: the 11th for a
-- monthly GSTR-1 filer, the 13th for QRMP/IFF. Inference cannot always tell the
-- two apart — a QRMP supplier who uses IFF and files by the 11th looks exactly
-- like a monthly one (audit P9) — so the trader can set it, and a scheme the
-- trader set must never be overwritten by the next inference pass.
--
--   INFERRED  services/supplierStats.js inferSupplierSchemes() owns the row
--   USER      set by the trader (PUT /api/suppliers/:gstin/filing-scheme), or
--             pre-set by the demo seeder on the trader's behalf
ALTER TABLE suppliers
  ADD COLUMN filing_scheme_source ENUM('INFERRED','USER') NOT NULL DEFAULT 'INFERRED'
    COMMENT 'INFERRED from filing dates, or USER-set; inference never overwrites USER'
    AFTER filing_scheme_reason;
