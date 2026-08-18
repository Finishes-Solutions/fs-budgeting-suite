// GET /api/analytics — aggregated KPIs and activity data for the super_admin
//   dashboard, plus a daily activity series for the charts.
// GET /api/analytics?scope=activity[&from&to&userId&limit&offset] — the full
//   activity log, filtered and paged, for the Activity Log and its CSV export.
//
// Both live in this one function rather than a second one because a newly
// added function folder did not register on the deployed host — it answered
// 404 while established endpoints kept working. Extending an endpoint that is
// known to deploy is what actually reaches users.
//
// The SWA route rule gates access to super_admin; the in-function check is
// defense-in-depth (and the only gate for the query-parameter scope, which a
// route rule cannot see).
const { getPool, sql } = require('../shared/db');
const { isSuperAdmin } = require('../shared/auth');

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// Shared by the log query and its count, so the two can never disagree.
function activityFilter(rq, q) {
  const clauses = [];
  if (q.from)   { rq.input('from', sql.DateTime2, q.from);      clauses.push('ua.CreatedAt >= @from'); }
  if (q.to)     { rq.input('to', sql.DateTime2, q.to);          clauses.push('ua.CreatedAt <= @to'); }
  if (q.userId) { rq.input('uid', sql.NVarChar(128), q.userId); clauses.push('ua.UserId = @uid'); }
  return clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
}

module.exports = async function (context, req) {
  if (!isSuperAdmin(req)) {
    context.res = jsonRes(403, { error: 'forbidden', message: 'Requires super_admin role.' });
    return;
  }

  const pool = await getPool();
  const q = req.query || {};

  // ---- the full activity log (filtered, paged)
  if (String(q.scope || '') === 'activity') {
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 500, 1), 5000);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const dataRq = pool.request();
    const countRq = pool.request();
    const where = activityFilter(dataRq, q);
    activityFilter(countRq, q);

    const [rows, counted, people] = await Promise.all([
      dataRq.query(
        `SELECT ua.EventType, ua.EntityType, ua.EntityId, ua.CreatedAt, ua.UserId,
                u.DisplayName, u.Email
         FROM dbo.UserActivity AS ua
         LEFT JOIN dbo.Users AS u ON u.UserId = ua.UserId
         ${where}
         ORDER BY ua.CreatedAt DESC, ua.Id DESC
         OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`),
      countRq.query(`SELECT COUNT(*) AS total FROM dbo.UserActivity AS ua ${where}`),
      pool.request().query(
        `SELECT UserId, DisplayName, Email FROM dbo.Users ORDER BY DisplayName`)
    ]);

    context.res = jsonRes(200, {
      events: rows.recordset.map(x => ({
        eventType: x.EventType, entityType: x.EntityType, entityId: x.EntityId,
        createdAt: x.CreatedAt, userId: x.UserId,
        userName: x.DisplayName || x.Email || 'Unknown'
      })),
      total: counted.recordset[0].total,
      users: people.recordset.map(u => ({
        userId: u.UserId, name: u.DisplayName || u.Email || 'Unknown'
      }))
    });
    return;
  }

  const [budgets, analyses, users, recentActivity, statusBreakdown, analysisStatusBreakdown,
         activityByDay, topBudgets] =
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
        GROUP BY Status`),

      // Daily event counts for the activity trend line. 30 days keeps the
      // series readable; the client fills in the days that saw no events.
      pool.request().query(`
        SELECT CAST(ua.CreatedAt AS DATE) AS Day,
               COUNT(*) AS Total,
               SUM(IIF(ua.EventType = 'login', 1, 0)) AS Logins,
               SUM(IIF(ua.EventType IN ('budget_save','analysis_save'), 1, 0)) AS Saves,
               SUM(IIF(ua.EventType LIKE 'export[_]%', 1, 0)) AS Exports
        FROM dbo.UserActivity AS ua
        WHERE ua.CreatedAt >= DATEADD(DAY, -29, CAST(SYSUTCDATETIME() AS DATE))
        GROUP BY CAST(ua.CreatedAt AS DATE)
        ORDER BY Day`),

      // The biggest active budgets, for the value comparison chart.
      pool.request().query(`
        SELECT TOP 8 ProjectId, Name, ContractSum, ProjectCost
        FROM dbo.Budgets
        WHERE IsDeleted = 0 AND ProjectId NOT LIKE 'TST-%'
        ORDER BY ProjectCost DESC`)
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
    })),
    // Day is a DATE; send the plain YYYY-MM-DD so the client charts calendar
    // days rather than re-deriving them from a timezone-shifted timestamp.
    activityByDay: activityByDay.recordset.map(r => ({
      day: (r.Day instanceof Date ? r.Day.toISOString() : String(r.Day)).slice(0, 10),
      total: r.Total, logins: r.Logins, saves: r.Saves, exports: r.Exports
    })),
    topBudgets: topBudgets.recordset.map(r => ({
      projectId: r.ProjectId, name: r.Name,
      contractSum: Number(r.ContractSum), projectCost: Number(r.ProjectCost)
    }))
  });
};
