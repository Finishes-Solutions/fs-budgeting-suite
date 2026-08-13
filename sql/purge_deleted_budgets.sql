-- Purge soft-deleted budgets — ADMIN-RUN ONLY, never part of a deployment.
--
-- The app has no hard delete: DELETE /api/budget/{id} soft-flags the budget
-- (IsDeleted = 1) and its history survives. This script is the one place a
-- soft-deleted budget and its version history are physically removed.
--
-- Deletes child-first inside one transaction (the FK from BudgetVersions to
-- Budgets is NO ACTION by design):
--   version SOV rows → versions → current SOV rows → budget row.
--
-- Review the preview result set, then run the transaction block and COMMIT.

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- Preview: what would be purged. Review before deleting.
SELECT b.ProjectId, b.Name, b.Status, b.ContractSum, b.DeletedAt,
       (SELECT COUNT(*) FROM dbo.BudgetVersions v WHERE v.ProjectId = b.ProjectId) AS Versions,
       (SELECT COUNT(*) FROM dbo.SovLines s WHERE s.ProjectId = b.ProjectId)       AS CurrentSovLines
FROM dbo.Budgets AS b
WHERE b.IsDeleted = 1
ORDER BY b.DeletedAt DESC;

BEGIN TRANSACTION;

DELETE vs
FROM dbo.BudgetVersionSovLines AS vs
JOIN dbo.BudgetVersions AS v ON v.Id = vs.BudgetVersionId
JOIN dbo.Budgets        AS b ON b.ProjectId = v.ProjectId
WHERE b.IsDeleted = 1;
PRINT CONCAT('Version SOV rows deleted: ', @@ROWCOUNT);

DELETE v
FROM dbo.BudgetVersions AS v
JOIN dbo.Budgets AS b ON b.ProjectId = v.ProjectId
WHERE b.IsDeleted = 1;
PRINT CONCAT('Versions deleted: ', @@ROWCOUNT);

DELETE s
FROM dbo.SovLines AS s
JOIN dbo.Budgets AS b ON b.ProjectId = s.ProjectId
WHERE b.IsDeleted = 1;
PRINT CONCAT('Current SOV rows deleted: ', @@ROWCOUNT);

DELETE FROM dbo.Budgets WHERE IsDeleted = 1;
PRINT CONCAT('Budgets purged: ', @@ROWCOUNT);

-- Inspect the printed counts, then:
COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
