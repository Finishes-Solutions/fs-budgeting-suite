-- ============================================================================
--  Migration — Budget approval pointer
--
--  NOTE ON COMMENT STYLE: only `--` line comments, like every migration here.
--  A `--` inside a block comment swallows the closing marker and fails the
--  whole batch. Do not reintroduce block comments.
--  ----------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-bd-budget database (all environments).
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : any time. The deploy tolerates the columns' absence
--           (api/shared/schema.js probes budgetsApproved), so before OR after
--           the release is safe. Nothing here is destructive.
--
--  Idempotent, one transaction, XACT_ABORT ON.
--
--  WHAT IT DOES
--    Adds an explicit "approved version" pointer to dbo.Budgets. Approval is a
--    deliberate act (PUT /api/budget/{id}?scope=approve, director+) that pins
--    one immutable BudgetVersions row as the one contracts are cut from. It is
--    NOT the same as Status = 'Completed', which is a mutable pill that pins
--    nothing.
--
--  WHAT IT DOES NOT DO
--    Nothing is approved by this migration. Every budget starts unapproved
--    (ApprovedVersionId NULL), exactly as today.
--
--  Sections: PREFLIGHT (read-only) → MIGRATION → VERIFICATION.
--  ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- ---------------------------------------------------------------------------
--  1 · PREFLIGHT
--  ---------------------------------------------------------------------------
PRINT '=== PREFLIGHT ===';
SELECT 'Budgets.ApprovedVersionId already exists' AS Item,
       CASE WHEN COL_LENGTH('dbo.Budgets','ApprovedVersionId') IS NULL THEN 0 ELSE 1 END AS N
UNION ALL SELECT 'dbo.BudgetVersions exists (required)',
       CASE WHEN OBJECT_ID('dbo.BudgetVersions','U') IS NULL THEN 0 ELSE 1 END;

IF OBJECT_ID('dbo.BudgetVersions','U') IS NULL
  THROW 50020, 'dbo.BudgetVersions is missing — run migrate_budget_history_and_templates.sql first.', 1;

-- ---------------------------------------------------------------------------
--  2 · MIGRATION
--  ---------------------------------------------------------------------------
BEGIN TRANSACTION;
BEGIN TRY

  IF COL_LENGTH('dbo.Budgets', 'ApprovedVersionId') IS NULL
  BEGIN
    PRINT 'Adding approval columns to dbo.Budgets';
    ALTER TABLE dbo.Budgets ADD
      ApprovedVersionId BIGINT        NULL,
      ApprovedAt        DATETIME2     NULL,
      ApprovedById      NVARCHAR(128) NULL,
      ApprovedByName    NVARCHAR(200) NULL;
  END

  IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_ApprovedVersion')
  BEGIN
    PRINT 'Adding FK_Budgets_ApprovedVersion';
    EXEC sp_executesql N'ALTER TABLE dbo.Budgets ADD CONSTRAINT FK_Budgets_ApprovedVersion
      FOREIGN KEY (ApprovedVersionId) REFERENCES dbo.BudgetVersions (Id);';
  END

  COMMIT TRANSACTION;
  PRINT '=== MIGRATION COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== MIGRATION ROLLED BACK ===';
  THROW;
END CATCH;

-- ---------------------------------------------------------------------------
--  3 · VERIFICATION — one result set. Every row must read PASS.
--  ---------------------------------------------------------------------------
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'Approval columns present' AS Check_, 'ApprovedVersionId + At + ById + ByName' AS Detail,
         CASE WHEN COL_LENGTH('dbo.Budgets','ApprovedVersionId') IS NOT NULL
               AND COL_LENGTH('dbo.Budgets','ApprovedAt') IS NOT NULL
               AND COL_LENGTH('dbo.Budgets','ApprovedById') IS NOT NULL
               AND COL_LENGTH('dbo.Budgets','ApprovedByName') IS NOT NULL THEN 1 ELSE 0 END AS Pass
  UNION ALL
  SELECT 2, 'Foreign key in place', 'ApprovedVersionId -> BudgetVersions.Id',
         CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_Budgets_ApprovedVersion') THEN 1 ELSE 0 END
) AS v
ORDER BY Ord;
