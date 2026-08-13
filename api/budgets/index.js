const { getPool } = require('../shared/db');

module.exports = async function (context, req) {
  const pool = await getPool();
  // Soft-deleted budgets stay in the table with their history intact, but the
  // app must not list them. sql/purge_deleted_budgets.sql is the admin recycle bin.
  // Address is carried inside the document rather than as a column. Reading it with
  // JSON_VALUE keeps the list groupable by address without another migration; the
  // list is small and unindexed on this field, so the cost is not worth a schema
  // change. Promote it to a persisted computed column if this ever gets large.
  const r = await pool.request().query(
    `SELECT ProjectId, Name, Type, Status, ContractSum, ProjectCost, UpdatedAt,
            JSON_VALUE(Doc, '$.address') AS Address
     FROM dbo.Budgets WHERE IsDeleted = 0 ORDER BY UpdatedAt DESC`);
  const list = r.recordset.map(x => ({
    projectId: x.ProjectId, name: x.Name, type: x.Type, status: x.Status,
    address: x.Address || '',
    contractSum: Number(x.ContractSum), projectCost: Number(x.ProjectCost),
    updated: x.UpdatedAt.toISOString()
  }));
  context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) };
};
