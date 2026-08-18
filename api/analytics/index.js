// GET /api/analytics — aggregated KPIs and activity data for the super_admin
// dashboard. The SWA route rule gates access to super_admin; the in-function
// check is defense-in-depth.
const { getPool, sql } = require('../shared/db');
const { isSuperAdmin } = require('../shared/auth');

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

module.exports = async function (context, req) {
  if (!isSuperAdmin(req)) {
    context.res = jsonRes(403, { error: 'forbidden', message: 'Requires super_admin role.' });
    return;
  }

  const pool = await getPool();

  const [budgets, analyses, users, recentActivity, statusBreakdown, analysisStatusBreakdown] =
    await Promise.all([
      pool.request().query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN IsDeleted = 0 THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN IsDeleted = 1 THEN 1 ELSE 0 END) AS deleted,
               SUM(CASE WHEN IsDeleted = 0 THEN ContractSum ELSE 0 END) AS totalContractSum,
               SUM(CASE WHEN IsDeleted = 0 THEN ProjectCost ELSE 0 END) AS totalProjectCost,
               MIN(CASE WHEN IsDeleted = 0 THEN CreatedAt END) AS earliest,
               MAX(CASE WHEN IsDeleted = 0 THEN UpdatedAt END) AS lastUpdated
        FROM dbo.Budgets WHERE ProjectId NOT LIKE 'TST-%'`),

      pool.request().query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN IsDeleted = 0 THEN 1 ELSE 0 END) AS active,
               AVG(CASE WHEN IsDeleted = 0 THEN PurchasePrice END) AS avgPurchasePrice,
               AVG(CASE WHEN IsDeleted = 0 THEN Year1NOI END) AS avgYear1NOI,
               AVG(CASE WHEN IsDeleted = 0 AND FinalYearEquityIRR IS NOT NULL
                    THEN FinalYearEquityIRR END) AS avgIRR
        FROM dbo.InvestmentAnalyses
        WHERE ProjectId NOT LIKE 'TST-%'`),

      pool.request().query(`
        SELECT COUNT(*) AS total,
               SUM(LoginCount) AS totalLogins,
               MAX(LastSeenAt) AS lastActive
        FROM dbo.Users`),

      pool.request().query(`
        SELECT TOP 50 ua.EventType, ua.EntityType, ua.EntityId, ua.CreatedAt,
               u.DisplayName, u.Email
        FROM dbo.UserActivity ua
        LEFT JOIN dbo.Users u ON u.UserId = ua.UserId
        ORDER BY ua.CreatedAt DESC, ua.Id DESC`),

      pool.request().query(`
        SELECT Status, COUNT(*) AS cnt
        FROM dbo.Budgets WHERE IsDeleted = 0 AND ProjectId NOT LIKE 'TST-%'
        GROUP BY Status`),

      pool.request().query(`
        SELECT Status, COUNT(*) AS cnt
        FROM dbo.InvestmentAnalyses WHERE IsDeleted = 0 AND ProjectId NOT LIKE 'TST-%'
        GROUP BY Status`)
    ]);

  const b = budgets.recordset[0];
  const a = analyses.recordset[0];
  const u = users.recordset[0];

  context.res = jsonRes(200, {
    budgets: {
      total: b.total, active: b.active, deleted: b.deleted,
      totalContractSum: b.totalContractSum, totalProjectCost: b.totalProjectCost,
      earliest: b.earliest, lastUpdated: b.lastUpdated,
      statusBreakdown: statusBreakdown.recordset.map(r => ({ status: r.Status || 'Draft', count: r.cnt }))
    },
    analyses: {
      total: a.total, active: a.active,
      avgPurchasePrice: a.avgPurchasePrice, avgYear1NOI: a.avgYear1NOI,
      avgIRR: a.avgIRR,
      statusBreakdown: analysisStatusBreakdown.recordset.map(r => ({ status: r.Status || 'Draft', count: r.cnt }))
    },
    users: {
      total: u.total, totalLogins: u.totalLogins, lastActive: u.lastActive
    },
    recentActivity: recentActivity.recordset.map(r => ({
      eventType: r.EventType, entityType: r.EntityType, entityId: r.EntityId,
      createdAt: r.CreatedAt, userName: r.DisplayName || r.Email || 'Unknown'
    }))
  });
};
