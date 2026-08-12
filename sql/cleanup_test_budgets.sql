-- Purge test budgets (TST-####) from the shared production database.
-- Preview environments deploy against the same Azure SQL database as production, so
-- test budgets created while reviewing a pull request land in the real tables. Run this
-- after a review cycle. SovLines first: it has an FK to Budgets.

SET NOCOUNT ON;

SELECT ProjectId, Name, Status, ContractSum, UpdatedAt
FROM dbo.Budgets
WHERE ProjectId LIKE 'TST-%'
ORDER BY UpdatedAt DESC;   -- review before deleting

BEGIN TRANSACTION;

DELETE FROM dbo.SovLines WHERE ProjectId LIKE 'TST-%';
PRINT CONCAT('SovLines deleted: ', @@ROWCOUNT);

DELETE FROM dbo.Budgets  WHERE ProjectId LIKE 'TST-%';
PRINT CONCAT('Budgets deleted: ',  @@ROWCOUNT);

-- Inspect the printed counts, then:
COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
