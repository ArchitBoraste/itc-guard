import { pool } from './pool.js';

// Runs fn inside a transaction on a dedicated connection, committing on success
// and rolling back on any throw. Every write path in services/ goes through this
// so a half-written run can never be observed.
export async function withTransaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      // The original error is the useful one.
    }
    throw err;
  } finally {
    connection.release();
  }
}

// Inserts rows in chunks. mysql2 sends one packet per statement, and a 400-row
// purchase register in single inserts is 400 round trips.
export async function insertInChunks(connection, sql, rows, chunkSize = 200) {
  let affected = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const [result] = await connection.query(sql, [chunk]);
    affected += result.affectedRows ?? 0;
  }
  return affected;
}
