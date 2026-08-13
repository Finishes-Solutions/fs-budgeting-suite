const sql = require('mssql');

// Azure SQL serverless auto-pauses when idle. The first request after a pause
// gets an immediate error — 40613 "Database is not currently available" — while
// the database resumes, which takes tens of seconds. Failing that request makes
// a perfectly healthy app look broken, so transient faults are retried with
// backoff here and the frontend shows a waking state meanwhile.
const TRANSIENT = new Set([
  40613,  // database not currently available (resuming)
  40197, 40501, 40540, 40143,  // service busy / throttling
  49918, 49919, 49920,         // not enough resources to process request
  4060,                        // cannot open database (during resume)
  10928, 10929,                // resource limits
  233, 64, -2                  // connection reset / transport / timeout
]);

const isTransient = (e) => TRANSIENT.has(e && e.number)
  || /not currently available|is not currently|timeout|ECONNRESET|ETIMEDOUT|ESOCKET|EPIPE/i.test((e && e.message) || '');

let pool = null;
let connecting = null;

async function getPool() {
  if (pool && pool.connected) return pool;
  // Concurrent callers during a cold start share one connect attempt rather than
  // each opening their own and multiplying the load on a resuming database.
  if (connecting) return connecting;
  connecting = connectWithRetry().finally(() => { connecting = null; });
  return connecting;
}

async function connectWithRetry() {
  const conn = process.env.SQL_CONN;
  if (!conn) throw new Error('SQL_CONN app setting is not configured');
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      pool = await new sql.ConnectionPool(conn).connect();
      pool.on('error', () => { pool = null; });   // drop a broken pool so the next call reconnects
      return pool;
    } catch (e) {
      if (pool) { try { await pool.close(); } catch (_) {} }
      pool = null;
      // ~60s of total waiting, which covers a serverless resume.
      if (attempt >= 7 || !isTransient(e)) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
}

module.exports = { getPool, sql, isTransient };
