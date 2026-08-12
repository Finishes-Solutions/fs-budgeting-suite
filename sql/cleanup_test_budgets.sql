-- Purge test budgets (TST-####) from the shared production database.
-- Preview environments deploy against the same Azure SQL database as production, so
-- test budgets created while reviewing a pull request land in the real tables. Run this
-- after a review cycle. Child rows first — SovLines and BudgetVersions both FK to
-- Budgets, and version SOV rows FK to BudgetVersions.

SET NOCOUNT ON;
SET XACT_ABORT ON;

SELECT ProjectId, Name, Status, ContractSum, UpdatedAt
FROM dbo.Budgets
WHERE ProjectId LIKE 'TST-%'
ORDER BY UpdatedAt DESC;   -- review before deleting

BEGIN TRANSACTION;

DELETE vs
FROM dbo.BudgetVersionSovLines AS vs
JOIN dbo.BudgetVersions AS v ON v.Id = vs.BudgetVersionId
WHERE v.ProjectId LIKE 'TST-%';
PRINT CONCAT('Version SOV rows deleted: ', @@ROWCOUNT);

DELETE FROM dbo.BudgetVersions WHERE ProjectId LIKE 'TST-%';
PRINT CONCAT('Versions deleted: ', @@ROWCOUNT);

DELETE FROM dbo.SovLines WHERE ProjectId LIKE 'TST-%';
PRINT CONCAT('SovLines deleted: ', @@ROWCOUNT);

DELETE FROM dbo.Budgets  WHERE ProjectId LIKE 'TST-%';
PRINT CONCAT('Budgets deleted: ',  @@ROWCOUNT);

-- Inspect the printed counts, then:
COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
