import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listMigrations } from '../src/db/migrate.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const TABLES = [
  'organizations',
  'users',
  'uploads',
  'expected_invoices',
  'expected_rate_lines',
  'portal_records',
  'portal_rate_lines',
  'record_changes',
  'runs',
  'match_results',
  'suppliers',
  'supplier_periods',
  'supplier_risk'
];

describe('migrations', () => {
  it('are numbered and sort in apply order', async () => {
    const files = await listMigrations(MIGRATIONS_DIR);
    expect(files[0]).toBe('001_init.sql');
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
  });

  it('001_init creates every table in the schema', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');
    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
  });

  it('carries the blocking index on both matching sides', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');
    const blocking = /\(org_id, supplier_gstin, invoice_no_norm, tax_period\)/g;
    expect(sql.match(blocking)).toHaveLength(2);
  });

  it('keeps money columns as BIGINT paise — never DECIMAL or FLOAT', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');
    for (const col of ['taxable_value', 'igst', 'cgst', 'sgst', 'cess', 'total_tax']) {
      const decls = sql.match(new RegExp(`^\\s+${col}\\s+(\\S+)`, 'gm')) ?? [];
      expect(decls.length).toBeGreaterThan(0);
      for (const decl of decls) expect(decl).toMatch(/BIGINT/);
    }
  });
});
