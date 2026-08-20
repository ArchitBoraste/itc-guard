import mysql from 'mysql2/promise';
import { config, describeConnection } from '../config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  // Money is BIGINT paise. Return them as JS numbers, not strings — paise stay
  // exact well past any invoice value a small trader will see.
  supportBigNumbers: true,
  bigNumberStrings: false,
  // DATE / DATETIME come back as raw strings so nothing gets shifted into the
  // host timezone. Internal dates are ISO yyyy-mm-dd strings.
  dateStrings: true,
  timezone: 'Z',
  namedPlaceholders: true
});

// Announce the target the first time a connection is actually opened, naming
// where the settings came from. A stale DB_HOST left in the shell resolves to a
// perfectly valid connection against the WRONG database, and the only way to
// notice is to print what was chosen and why.
let announced = false;
pool.on('connection', () => {
  if (announced) return;
  announced = true;
  console.log(`[db] connected ${describeConnection()}`);
});

export async function ping() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

// Confirms both that the server answers AND that it is the ITC Guard schema.
// A reachable server holding somebody else's database is the failure mode that
// looks most like success.
export async function checkConnection() {
  const target = describeConnection();
  try {
    await ping();
  } catch (err) {
    return { ok: false, target, reason: `cannot connect: ${err.code ?? err.message}` };
  }

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM information_schema.tables
      WHERE table_schema = ? AND table_name IN ('schema_migrations','portal_records','runs')`,
    [config.db.database]
  );
  if (Number(rows[0].n) < 3) {
    return {
      ok: false,
      target,
      reason:
        `connected, but '${config.db.database}' does not hold the ITC Guard schema ` +
        '(missing schema_migrations / portal_records / runs). Wrong database, or ' +
        'migrations have not been applied.'
    };
  }
  return { ok: true, target, reason: null };
}

export async function closePool() {
  await pool.end();
}
