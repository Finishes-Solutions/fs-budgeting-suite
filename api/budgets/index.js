const { getPool } = require('../shared/db');

module.exports = async function (context, req) {
  const pool = await getPool();
  // Soft-deleted budgets stay in the table with their history intact, but the
  // app must not list them. sql/purge_deleted_budgets.sql is the admin recycle bin.
  const r = await pool.request().query(
    `SELECT ProjectId, Name, Type, Status, ContractSum, ProjectCost, UpdatedAt
     FROM dbo.Budgets WHERE IsDeleted = 0 ORDER BY UpdatedAt DESC`);
  const list = r.recordset.map(x => ({
    projectId: x.ProjectId, name: x.Name, type: x.Type, status: x.Status,
    contractSum: Number(x.ContractSum), projectCost: Number(x.ProjectCost),
    updated: x.UpdatedAt.toISOString()
  }));
  context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) };
};
