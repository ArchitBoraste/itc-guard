// Applies src/db/migrations/*.sql in filename order and records each one in
// schema_migrations. Re-running is a no-op. Run with: npm run migrate
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { config, describeConnection } from '../config.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const CREATE_LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   VARCHAR(255) NOT NULL,
  checksum   CHAR(64)     NOT NULL,
  applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export async function migrate({ log = console.log } = {}) {
  // multipleStatements lets a whole .sql file run as one call. The pool does not
  // enable it — only the migrator needs it.
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true
  });

  try {
    // The migration runner is the most dangerous place to be pointed at the wrong
    // database: it CREATEs tables, so a stale DB_NAME in the shell silently
    // installs this schema into somebody else's database. Always say where.
    log(`[db] migrating ${describeConnection()}`);
    await conn.query(CREATE_LEDGER);
    const [applied] = await conn.query('SELECT filename, checksum FROM schema_migrations');
    const appliedBy = new Map(applied.map((r) => [r.filename, r.checksum]));

    const files = await listMigrations();
    let ran = 0;

    for (const filename of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = appliedBy.get(filename);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `${filename} was already applied but its contents changed. ` +
              'Add a new migration instead of editing an applied one.'
          );
        }
        log(`skip  ${filename}`);
        continue;
      }

      log(`apply ${filename}`);
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [
        filename,
        checksum
      ]);
      ran += 1;
    }

    log(ran === 0 ? 'up to date' : `applied ${ran} migration(s)`);
    return ran;
  } finally {
    await conn.end();
  }
}

// Only run when invoked directly, so tests can import the module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
