const { getPool, sql } = require('../shared/db');
const { hasRole } = require('../shared/auth');

module.exports = async function (context, req) {
  const pool = await getPool();

  if (req.method === 'GET') {
    const r = await pool.request().query(
      'SELECT TOP 1 Doc FROM dbo.PricingLibrary WHERE IsCurrent = 1 ORDER BY Effective DESC');
    if (!r.recordset.length) { context.res = { status: 404, body: 'No pricing library published' }; return; }
    // no-store, and it is not belt and braces: a budget created moments after
    // a publish must be born on the version that was just published. A cached
    // response here is the difference between a new budget being current and
    // it opening with an "update to current pricing" banner it has no business
    // showing.
    context.res = { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: r.recordset[0].Doc };
    return;
  }

  // PUT — publish a new version. Defense in depth: SWA route rules already
  // restrict this to pricing_admin, and we verify the role again here.
  if (!hasRole(req, 'pricing_admin')) { context.res = { status: 403, body: 'pricing_admin role required' }; return; }

  const doc = req.body;
  if (!doc || !doc.version || !Array.isArray(doc.lines)) {
    context.res = { status: 400, body: 'Body must be a pricing document with version and lines[]' }; return;
  }
  delete doc.adminPass; // never persist the local-dev passcode
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query('UPDATE dbo.PricingLibrary SET IsCurrent = 0 WHERE IsCurrent = 1');
    await new sql.Request(tx)
      .input('v', sql.NVarChar(32), doc.version)
      .input('e', sql.Date, doc.effective || new Date())
      .input('d', sql.NVarChar(sql.MAX), JSON.stringify(doc))
      .query('INSERT INTO dbo.PricingLibrary (Version, Effective, IsCurrent, Doc) VALUES (@v, @e, 1, @d)');
    await tx.commit();
  } catch (e) { await tx.rollback(); throw e; }
  context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, version: doc.version }) };
};
