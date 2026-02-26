import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// UUID format (no single quotes allowed - safe to interpolate)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run a function with app.current_user_id set for RLS.
 * SET LOCAL does not accept $1 parameters in PostgreSQL, so we set the value safely.
 * @param {string} userId - UUID of the current user (from JWT)
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    if (!userId || !UUID_REGEX.test(String(userId))) {
      throw new Error('Invalid user id for RLS');
    }
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

/**
 * Run query without setting user (for auth routes that need to look up by email, etc.)
 */
export function query(text, params) {
  return pool.query(text, params);
}

export default pool;
