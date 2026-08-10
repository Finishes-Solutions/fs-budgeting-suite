const { getPool, sql } = require('../shared/db');

const ID_RX = /^(OP-\d{3}|BD-\d{4}|AS-\d{4})$/;

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toUpperCase();
  if (!ID_RX.test(id)) { context.res = { status: 400, body: 'Invalid project ID (OP-### / BD-#### / AS-####)' }; return; }
  const pool = await getPool();

  if (req.method === 'GET') {
    const r = await pool.request().input('id', sql.VarChar(16), id)
      .query('SELECT Doc FROM dbo.Budgets WHERE ProjectId = @id');
    if (!r.recordset.length) { context.res = { status: 404, body: 'Not found' }; return; }
    context.res = { headers: { 'Content-Type': 'application/json' }, body: r.recordset[0].Doc };
    return;
  }

  if (req.method === 'DELETE') {
    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      await new sql.Request(tx).input('id', sql.VarChar(16), id).query('DELETE FROM dbo.SovLines WHERE ProjectId = @id');
      await new sql.Request(tx).input('id', sql.VarChar(16), id).query('DELETE FROM dbo.Budgets WHERE ProjectId = @id');
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    context.res = { status: 204 };
    return;
  }

  // PUT — upsert budget doc + meta, and rewrite normalized SOV lines
  // (SovLines is the read surface for the lender-package pipeline).
  const { meta, doc } = req.body || {};
  if (!doc || !meta) { context.res = { status: 400, body: 'Body must be { meta, doc }' }; return; }
  if ((doc.projectId || '').toUpperCase() !== id) { context.res = { status: 400, body: 'Body projectId must match route' }; return; }

  const tx = new sql.Transaction(pool); await tx.begin();
  try {
    await new sql.Request(tx)
      .input('id', sql.VarChar(16), id)
      .input('name', sql.NVarChar(200), meta.name || '')
      .input('type', sql.NVarChar(50), meta.type || 'Multifamily')
      .input('status', sql.NVarChar(30), meta.status || 'Draft')
      .input('cs', sql.Decimal(18, 2), meta.contractSum || 0)
      .input('pc', sql.Decimal(18, 2), meta.projectCost || 0)
      .input('pv', sql.NVarChar(32), doc.pricingVersion || '')
      .input('doc', sql.NVarChar(sql.MAX), JSON.stringify(doc))
      .query(`MERGE dbo.Budgets AS t
              USING (SELECT @id AS ProjectId) AS s ON t.ProjectId = s.ProjectId
              WHEN MATCHED THEN UPDATE SET Name=@name, Type=@type, Status=@status,
                ContractSum=@cs, ProjectCost=@pc, PricingVersion=@pv, Doc=@doc, UpdatedAt=SYSUTCDATETIME()
              WHEN NOT MATCHED THEN INSERT (ProjectId, Name, Type, Status, ContractSum, ProjectCost, PricingVersion, Doc)
                VALUES (@id, @name, @type, @status, @cs, @pc, @pv, @doc);`);

    await new sql.Request(tx).input('id', sql.VarChar(16), id).query('DELETE FROM dbo.SovLines WHERE ProjectId = @id');
    const units = (doc.units || []).reduce((s, u) => s + (u.count || 0), 0);
    const qtyOf = (l) => l.auto === false ? (l.qty || 0)
      : l.basis === 'sf' ? (doc.resSF || 0)
      : l.basis === 'asf' ? (doc.amenSF || 0)
      : l.basis === 'unit' ? units : 1;
    for (const l of (doc.lines || [])) {
      const qty = qtyOf(l);
      await new sql.Request(tx)
        .input('id', sql.VarChar(16), id)
        .input('scope', sql.VarChar(10), l.scope || 'res')
        .input('grp', sql.NVarChar(120), l.grp || '')
        .input('code', sql.NVarChar(20), l.code || '')
        .input('desc', sql.NVarChar(300), l.desc || '')
        .input('basis', sql.VarChar(10), l.basis || 'ls')
        .input('qty', sql.Decimal(18, 2), qty)
        .input('rate', sql.Decimal(18, 4), l.unit || 0)
        .input('total', sql.Decimal(18, 2), qty * (l.unit || 0))
        .query(`INSERT INTO dbo.SovLines (ProjectId, Scope, Grp, Code, Descr, Basis, Qty, Rate, Total, Provenance)
                VALUES (@id, @scope, @grp, @code, @desc, @basis, @qty, @rate, @total, 'parametric-estimate')`);
    }
    await tx.commit();
  } catch (e) { await tx.rollback(); throw e; }
  context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
};
