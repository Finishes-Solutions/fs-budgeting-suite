const sql = require('mssql');
let pool;
async function getPool() {
  if (pool) return pool;
  const conn = process.env.SQL_CONN;
  if (!conn) throw new Error('SQL_CONN app setting is not configured');
  pool = await sql.connect(conn);
  return pool;
}
module.exports = { getPool, sql };
