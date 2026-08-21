-- ============================================================================
--  ROLLBACK — undo sql/migrate_project_op_ids.sql
--
--  NOTE ON COMMENT STYLE: `--` line comments only, like every other script
--  here. See the header of the forward migration for why.
--  ---------------------------------------------------------------------------
--  Target : Azure SQL, the fs-bd-budget database.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : only if the OP-### re-key has to be reversed. Run the sections in
--           order, exactly as with the forward migration.
--
--  WHAT IT REVERSES
--    Section 3 of the forward migration (the re-key of dbo.Projects and the
--    repointing of Budgets.ProjectKey / InvestmentAnalyses.ProjectKey), and
--    section 4 (favorites, activity rows, primary-budget backfill).
--
--  HOW
--    The re-key is reversed from dbo.ProjectIdMap, which is exact and
--    lossless: every changed key is in it. The JSON columns are restored
--    wholesale from the section-2 snapshots, which is stronger than trying to
--    un-edit JSON in place.
--
--  WHAT IT DOES NOT REVERSE
--    * UX_PricingLibrary_Current and the IsCurrent flags it tidied. Leaving
--      one current pricing library is correct under both schemas; section 4
--      below can drop the index if it is genuinely unwanted.
--    * Anything written by the application AFTER the migration. A project
--      created as OP-### post-migration has no map row and no snapshot: this
--      script leaves it alone and section 5 reports it, because inventing a
--      pre-migration identity for it would be a guess.
--
--  IF THIS SCRIPT CANNOT RUN — the alternative is an Azure SQL point-in-time
--  restore to a moment before the migration. From the portal: the database's
--  Overview blade -> Restore -> pick the point in time -> restore to a NEW
--  database name -> verify -> rename. That is the outer safety net and does
--  not depend on any object created here.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;


-- ###########################################################################
--  SECTION 1 - PREFLIGHT.  READ-ONLY.  Confirm the inputs still exist.
-- ###########################################################################

SELECT 'dbo.ProjectIdMap rows'                     AS Item, COUNT(*) AS N FROM dbo.ProjectIdMap
UNION ALL SELECT 'dbo.Bak_Projects_OpIds rows',              COUNT(*) FROM dbo.Bak_Projects_OpIds
UNION ALL SELECT 'dbo.Bak_UserSettings_OpIds rows',          COUNT(*) FROM dbo.Bak_UserSettings_OpIds
UNION ALL SELECT 'dbo.Bak_UserActivity_OpIds rows',          COUNT(*) FROM dbo.Bak_UserActivity_OpIds
UNION ALL SELECT 'Projects currently keyed OP-###',          COUNT(*) FROM dbo.Projects
          WHERE ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(ProjectId) = 6
UNION ALL SELECT 'Projects created AFTER the migration (no map row, left as-is)',
          COUNT(*) FROM dbo.Projects AS p
          WHERE NOT EXISTS (SELECT 1 FROM dbo.ProjectIdMap AS m WHERE m.NewProjectId = p.ProjectId);

-- The projects this rollback will rename, and back to what.
SELECT m.NewProjectId AS CurrentId, m.OldProjectId AS RestoredTo, m.Method, p.Name
FROM dbo.ProjectIdMap AS m
JOIN dbo.Projects AS p ON p.ProjectId = m.NewProjectId
ORDER BY m.NewProjectId;


-- ###########################################################################
--  SECTION 2 - REVERSE THE RE-KEY.  One transaction, XACT_ABORT ON.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  IF NOT EXISTS (SELECT 1 FROM dbo.ProjectIdMap)
    THROW 50002, 'dbo.ProjectIdMap is empty - nothing to reverse from. Use a point-in-time restore.', 1;

  -- 2.1 - Drop the foreign keys, same reason as the forward migration: a
  --       parent key cannot move while children still point at it.
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_Project')
    ALTER TABLE dbo.Budgets DROP CONSTRAINT FK_Budgets_Project;

  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InvestmentAnalyses_Project')
    ALTER TABLE dbo.InvestmentAnalyses DROP CONSTRAINT FK_InvestmentAnalyses_Project;

  -- 2.2 - Drop the OP-### check; the restored ids are four-digit.
  IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Projects_IdFormat')
    ALTER TABLE dbo.Projects DROP CONSTRAINT CK_Projects_IdFormat;

  -- 2.3 - Rename back. Only projects that were actually re-keyed.
  UPDATE p SET p.ProjectId = m.OldProjectId, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p
    JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = p.ProjectId;
  PRINT CONCAT('Projects restored: ', @@ROWCOUNT);

  UPDATE b SET b.ProjectKey = m.OldProjectId
    FROM dbo.Budgets AS b
    JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = b.ProjectKey;
  PRINT CONCAT('Budgets repointed back: ', @@ROWCOUNT);

  UPDATE a SET a.ProjectKey = m.OldProjectId
    FROM dbo.InvestmentAnalyses AS a
    JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = a.ProjectKey;
  PRINT CONCAT('Analyses repointed back: ', @@ROWCOUNT);

  -- 2.4 - A project created after the migration keeps its OP-### id and has
  --       no four-digit equivalent, so the old check constraint is restored
  --       WITH NOCHECK: it governs new writes without rejecting those rows.
  ALTER TABLE dbo.Projects WITH NOCHECK ADD CONSTRAINT CK_Projects_IdFormat CHECK (
    ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
    OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]');

  ALTER TABLE dbo.Budgets ADD CONSTRAINT FK_Budgets_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);

  ALTER TABLE dbo.InvestmentAnalyses ADD CONSTRAINT FK_InvestmentAnalyses_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);

  COMMIT TRANSACTION;
  PRINT '=== ROLLBACK SECTION 2 COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== ROLLBACK SECTION 2 REVERTED - nothing changed ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 3 - RESTORE THE JSON AND THE PRIMARY-BUDGET BACKFILL.
--  Restores whole columns from the section-2 snapshots rather than un-editing
--  JSON, so the result is byte-for-byte what was there before.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  -- 3.1 - Settings documents, including the favorites arrays.
  --       An account created after the migration has no snapshot row and is
  --       left alone.
  UPDATE u SET u.SettingsDoc = s.SettingsDoc, u.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Users AS u
    JOIN dbo.Bak_UserSettings_OpIds AS s ON s.UserId = u.UserId
   WHERE ISNULL(u.SettingsDoc, '') <> ISNULL(s.SettingsDoc, '');
  PRINT CONCAT('Settings documents restored: ', @@ROWCOUNT);

  -- 3.2 - Project activity rows.
  UPDATE ua SET ua.EntityId = s.EntityId
    FROM dbo.UserActivity AS ua
    JOIN dbo.Bak_UserActivity_OpIds AS s ON s.Id = ua.Id
   WHERE ISNULL(ua.EntityId, '') <> ISNULL(s.EntityId, '');
  PRINT CONCAT('Activity rows restored: ', @@ROWCOUNT);

  -- 3.3 - PrimaryBudgetId as it was, for the projects that existed then.
  UPDATE p SET p.PrimaryBudgetId = s.PrimaryBudgetId, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p
    JOIN dbo.Bak_Projects_OpIds AS s ON s.ProjectId = p.ProjectId
   WHERE ISNULL(p.PrimaryBudgetId, '') <> ISNULL(s.PrimaryBudgetId, '');
  PRINT CONCAT('Primary budgets restored: ', @@ROWCOUNT);

  COMMIT TRANSACTION;
  PRINT '=== ROLLBACK SECTION 3 COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== ROLLBACK SECTION 3 REVERTED ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 4 - OPTIONAL.  Only run these if the pricing singleton is genuinely
--  unwanted, or the map and snapshots are being retired. Commented out on
--  purpose: keeping them costs nothing and losing them costs the audit trail.
-- ###########################################################################

-- DROP INDEX UX_PricingLibrary_Current ON dbo.PricingLibrary;
-- DROP TABLE dbo.Bak_Projects_OpIds;
-- DROP TABLE dbo.Bak_BudgetProjectKey_OpIds;
-- DROP TABLE dbo.Bak_AnalysisProjectKey_OpIds;
-- DROP TABLE dbo.Bak_UserSettings_OpIds;
-- DROP TABLE dbo.Bak_UserActivity_OpIds;
-- DROP TABLE dbo.ProjectIdMap;


-- ###########################################################################
--  SECTION 5 - VERIFICATION.  Every row must read PASS.
-- ###########################################################################

SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'No mapped project is still keyed OP-###' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' remaining' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects AS p
  JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = p.ProjectId
  UNION ALL
  SELECT 2, 'Every mapped project is back under its old id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' missing', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.ProjectIdMap AS m
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = m.OldProjectId)
  UNION ALL
  SELECT 3, 'No orphaned budget',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets AS b
  WHERE b.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
  UNION ALL
  SELECT 4, 'No orphaned investment analysis',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses AS a
  WHERE a.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = a.ProjectKey)
  UNION ALL
  SELECT 5, 'Settings documents match the snapshot',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' differing', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Users AS u
  JOIN dbo.Bak_UserSettings_OpIds AS s ON s.UserId = u.UserId
  WHERE ISNULL(u.SettingsDoc, '') <> ISNULL(s.SettingsDoc, '')
  UNION ALL
  SELECT 6, 'Foreign keys are back',
         'FK_Budgets_Project + FK_InvestmentAnalyses_Project',
         CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_Project')
               AND EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InvestmentAnalyses_Project')
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 7, 'Projects created after the migration, reported not changed',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' left keyed OP-### on purpose', 1
  FROM dbo.Projects AS p
  WHERE NOT EXISTS (SELECT 1 FROM dbo.ProjectIdMap AS m WHERE m.NewProjectId = p.ProjectId)
    AND NOT EXISTS (SELECT 1 FROM dbo.ProjectIdMap AS m2 WHERE m2.OldProjectId = p.ProjectId)
) AS v
ORDER BY Ord;
