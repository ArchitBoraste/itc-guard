import mysql from 'mysql2/promise';
import { config } from '../config.js';

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

export async function ping() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function closePool() {
  await pool.end();
}
