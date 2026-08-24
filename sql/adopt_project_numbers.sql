-- ============================================================================
--  Migration — surface the PROJECT NUMBER, and prepare for child ids
--
--  NOTE ON COMMENT STYLE: `--` line comments only, like every other script
--  here. See the header of sql/migrate_project_op_ids.sql for why.
--  ---------------------------------------------------------------------------
--  Target : Azure SQL, the fs-bd-budget database.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : BEFORE the release that mints BDG-####-## budgets and shows
--           INA-####-## analysis ids. Safe to run early: the app probes for
--           these columns (api/shared/schema.js) and behaves as today until
--           both the column and the release are present.
--
--  WHY — this is the budgeting suite's step toward the company identifier
--  model (PROJECT_NUMBERS_GUIDE.md): a project is a NUMBER; prefixes are
--  labels; children key on the number plus an item number; machines join on
--  the number, never on the display string.
--
--  This suite is the guide's acknowledged legacy system: its tables are keyed
--  by display id (ProjectId VARCHAR — a rule-4 violation "by design of its
--  era"), and re-keying dbo.Budgets would cascade through SovLines,
--  BudgetVersions, every immutable snapshot and every analysis's provenance.
--  So this script does NOT re-key anything. It makes the NUMBER real and
--  queryable beside the keys that exist:
--
--    1. dbo.Projects.ProjectNumber           — the number itself, computed
--       from the id, persisted, unique. "Everything on this project" becomes
--       WHERE ProjectNumber = 42 for any current or future system.
--    2. dbo.Budgets.ProjectNumber            — the same number on each budget,
--       computed from its ProjectKey link (never from the budget's own id).
--    3. dbo.InvestmentAnalyses.ProjectNumber — likewise.
--    4. dbo.InvestmentAnalyses.ItemNumber    — which analysis within the
--       project (INA-0042-01's "01"), backfilled in creation order.
--
--  Budgets need no item column: a BDG-0042-01 budget carries its item number
--  in its id, and legacy BD-#### budgets never get one (nothing is renamed
--  under a live user — guide §8).
--
--  WHAT IT DOES NOT DO
--    No row is renamed, deleted, or re-keyed. No constraint on existing data
--    changes — CK_Budgets_IdFormat has allowed three-letter prefixes with an
--    item suffix since the projects migration, so BDG-0042-01 already passes.
--    The master/facet registry, the allocator, retirement and SupersededBy
--    belong to the central system the guide describes, not to this suite.
--
--  Sections: 1 PREFLIGHT (read-only) -> 2 MIGRATION -> 3 VERIFICATION.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;


-- ###########################################################################
--  SECTION 1 - PREFLIGHT.  READ-ONLY.
-- ###########################################################################

SELECT 'Projects'                              AS Item, COUNT(*) AS N FROM dbo.Projects
UNION ALL SELECT 'Budgets (all)',                        COUNT(*) FROM dbo.Budgets
UNION ALL SELECT 'Budgets linked to a project',          COUNT(*) FROM dbo.Budgets WHERE ProjectKey IS NOT NULL
UNION ALL SELECT 'Analyses linked to a project',         COUNT(*) FROM dbo.InvestmentAnalyses WHERE ProjectKey IS NOT NULL
UNION ALL SELECT 'Analyses with no project (standalone)',COUNT(*) FROM dbo.InvestmentAnalyses WHERE ProjectKey IS NULL
UNION ALL SELECT 'Existing BDG- budgets (expect 0)',     COUNT(*) FROM dbo.Budgets WHERE ProjectId LIKE 'BDG-%'
UNION ALL SELECT 'Projects.ProjectNumber already exists',
       CASE WHEN COL_LENGTH('dbo.Projects','ProjectNumber') IS NULL THEN 0 ELSE 1 END
UNION ALL SELECT 'InvestmentAnalyses.ItemNumber already exists',
       CASE WHEN COL_LENGTH('dbo.InvestmentAnalyses','ItemNumber') IS NULL THEN 0 ELSE 1 END;

SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL - STOP' END AS Result
FROM (
  SELECT 1 AS Ord, 'Every project id ends in four digits' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' malformed' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects WHERE RIGHT(ProjectId, 4) LIKE '%[^0-9]%'
  UNION ALL
  SELECT 2, 'No two projects share a number',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' duplicated numbers',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM (SELECT RIGHT(ProjectId, 4) AS D FROM dbo.Projects
        GROUP BY RIGHT(ProjectId, 4) HAVING COUNT(*) > 1) AS d
  UNION ALL
  SELECT 3, 'Every linked budget''s ProjectKey ends in four digits',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' malformed',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets WHERE ProjectKey IS NOT NULL AND RIGHT(ProjectKey, 4) LIKE '%[^0-9]%'
) AS v
ORDER BY Ord;


-- ###########################################################################
--  SECTION 2 - MIGRATION.  Idempotent; one transaction.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  -- 2.1 - The project number, on the project. Persisted and computed FROM the
  --       id rather than stored beside it, so the two can never disagree —
  --       there is exactly one expression producing the number (guide rule 7).
  --       CK_Projects_IdFormat guarantees the digits, so plain CONVERT is safe.
  IF COL_LENGTH('dbo.Projects', 'ProjectNumber') IS NULL
  BEGIN
    PRINT 'Adding dbo.Projects.ProjectNumber';
    ALTER TABLE dbo.Projects ADD ProjectNumber AS CONVERT(INT, RIGHT(ProjectId, 4)) PERSISTED;
  END

  -- 2.2 - The number on each budget and analysis, computed from the ProjectKey
  --       LINK — never from the record's own id, because a budget id is not a
  --       project id (a BD-4821 budget can belong to project 42). NULL where
  --       there is no link, which is what "standalone" means.
  IF COL_LENGTH('dbo.Budgets', 'ProjectNumber') IS NULL
  BEGIN
    PRINT 'Adding dbo.Budgets.ProjectNumber';
    ALTER TABLE dbo.Budgets ADD ProjectNumber AS TRY_CONVERT(INT, RIGHT(ProjectKey, 4)) PERSISTED;
  END

  IF COL_LENGTH('dbo.InvestmentAnalyses', 'ProjectNumber') IS NULL
  BEGIN
    PRINT 'Adding dbo.InvestmentAnalyses.ProjectNumber';
    ALTER TABLE dbo.InvestmentAnalyses ADD ProjectNumber AS TRY_CONVERT(INT, RIGHT(ProjectKey, 4)) PERSISTED;
  END

  -- 2.3 - Which analysis within the project: INA-0042-01's "01". A real
  --       column, not computed — the analysis's PRIMARY key stays its GUID
  --       (already number-shaped, already rule-4 compliant), and the item
  --       number is allocated once at creation and never renumbered, so a
  --       deleted analysis leaves a gap rather than shifting its siblings.
  IF COL_LENGTH('dbo.InvestmentAnalyses', 'ItemNumber') IS NULL
  BEGIN
    PRINT 'Adding dbo.InvestmentAnalyses.ItemNumber';
    ALTER TABLE dbo.InvestmentAnalyses ADD ItemNumber INT NULL;
  END

  COMMIT TRANSACTION;
  PRINT '=== COLUMNS COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== ROLLED BACK - nothing changed ===';
  THROW;
END CATCH;

-- 2.4 - Backfill item numbers in creation order, per project, soft-deleted
--       analyses included — they hold their slot, exactly as a deleted
--       analysis created tomorrow would. sp_executesql because the column was
--       added in this same script and a direct reference would not compile.
--       Separate transaction: the ALTERs must be committed before an index
--       can be built over the new columns anyway.
BEGIN TRANSACTION;
BEGIN TRY
  --       Only rows WITHOUT a number are touched, and they are appended after
  --       the project's current highest — an item number is allocated once and
  --       never renumbered, so re-running this after the app has allocated its
  --       own numbers fills gaps in coverage without moving anything.
  EXEC sp_executesql N'
    WITH taken AS (
      SELECT ProjectKey, MAX(ItemNumber) AS MaxItem
      FROM dbo.InvestmentAnalyses
      WHERE ProjectKey IS NOT NULL
      GROUP BY ProjectKey
    ),
    numbered AS (
      SELECT a.ItemNumber,
             ROW_NUMBER() OVER (PARTITION BY a.ProjectKey ORDER BY a.CreatedAt, a.AnalysisId)
               + ISNULL(t.MaxItem, 0) AS NewItem
      FROM dbo.InvestmentAnalyses AS a
      LEFT JOIN taken AS t ON t.ProjectKey = a.ProjectKey
      WHERE a.ProjectKey IS NOT NULL AND a.ItemNumber IS NULL
    )
    UPDATE numbered SET ItemNumber = NewItem;';
  PRINT CONCAT('Analyses given item numbers: ', @@ROWCOUNT);

  -- 2.5 - Indexes: the number is only a join key if it is indexed, and the
  --       item number is only trustworthy if two analyses cannot share one.
  --       The ProjectNumber indexes are NOT filtered: a filtered index's WHERE
  --       clause may not reference a computed column (SQL Server refuses with
  --       "Rewrite the filter expression"), so the NULL rows ride along —
  --       harmless at this size. UX_InvestmentAnalyses_Item CAN filter,
  --       because ProjectKey and ItemNumber are both real columns.
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Projects_Number')
    EXEC sp_executesql N'CREATE UNIQUE INDEX UX_Projects_Number ON dbo.Projects (ProjectNumber);';
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_ProjectNumber')
    EXEC sp_executesql N'CREATE INDEX IX_Budgets_ProjectNumber ON dbo.Budgets (ProjectNumber)
      INCLUDE (Name, Status);';
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvestmentAnalyses_ProjectNumber')
    EXEC sp_executesql N'CREATE INDEX IX_InvestmentAnalyses_ProjectNumber
      ON dbo.InvestmentAnalyses (ProjectNumber);';
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_InvestmentAnalyses_Item')
    EXEC sp_executesql N'CREATE UNIQUE INDEX UX_InvestmentAnalyses_Item
      ON dbo.InvestmentAnalyses (ProjectKey, ItemNumber)
      WHERE ProjectKey IS NOT NULL AND ItemNumber IS NOT NULL;';

  COMMIT TRANSACTION;
  PRINT '=== BACKFILL AND INDEXES COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== BACKFILL ROLLED BACK (columns from 2.1-2.3 remain, harmlessly) ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 3 - VERIFICATION.  Every row must read PASS. Send this output back.
-- ###########################################################################

-- Wrapped in sp_executesql, and it is not optional: these queries verify
-- columns created earlier in this same batch, and SQL Server binds column
-- names when it compiles the batch — a direct reference fails the WHOLE
-- file with "Invalid column name" before anything runs. Same rule the
-- header of sql/migrate_projects_and_guardrails.sql records.
EXEC sp_executesql N'
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN ''PASS'' ELSE ''FAIL'' END AS Result
FROM (
  SELECT 1 AS Ord, ''Every project carries its number'' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + '' without one'' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects WHERE ProjectNumber IS NULL
  UNION ALL
  SELECT 2, ''Numbers are unique across projects'', ''UX_Projects_Number enforces it'',
         CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE name = ''UX_Projects_Number'' AND is_unique = 1)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 3, ''Every linked budget carries its project''''s number'',
         CAST(COUNT(*) AS NVARCHAR(20)) + '' disagree with their ProjectKey'',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets
  WHERE ProjectKey IS NOT NULL
    AND (ProjectNumber IS NULL OR ProjectNumber <> CONVERT(INT, RIGHT(ProjectKey, 4)))
  UNION ALL
  SELECT 4, ''Every linked analysis carries its project''''s number'',
         CAST(COUNT(*) AS NVARCHAR(20)) + '' disagree with their ProjectKey'',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses
  WHERE ProjectKey IS NOT NULL
    AND (ProjectNumber IS NULL OR ProjectNumber <> CONVERT(INT, RIGHT(ProjectKey, 4)))
  UNION ALL
  SELECT 5, ''Every linked analysis has an item number'',
         CAST(COUNT(*) AS NVARCHAR(20)) + '' without one'',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses WHERE ProjectKey IS NOT NULL AND ItemNumber IS NULL
  UNION ALL
  -- Valid at backfill time. A later admin purge of deleted analyses
  -- legitimately leaves gaps (a number is never re-issued), so this check is
  -- about THIS run, not a permanent invariant.
  SELECT 6, ''Item numbers start at 1 and are dense per project'',
         CAST(COUNT(*) AS NVARCHAR(20)) + '' projects with gaps or a bad start'',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM (SELECT ProjectKey FROM dbo.InvestmentAnalyses
        WHERE ProjectKey IS NOT NULL
        GROUP BY ProjectKey
        HAVING MIN(ItemNumber) <> 1 OR MAX(ItemNumber) <> COUNT(*)) AS g
  UNION ALL
  SELECT 7, ''Two analyses cannot share an item number'', ''UX_InvestmentAnalyses_Item enforces it'',
         CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE name = ''UX_InvestmentAnalyses_Item'' AND is_unique = 1)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 8, ''Standalone analyses were left alone'',
         CAST(COUNT(*) AS NVARCHAR(20)) + '' standalone rows given a number or item'',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses
  WHERE ProjectKey IS NULL AND (ProjectNumber IS NOT NULL OR ItemNumber IS NOT NULL)
  UNION ALL
  SELECT 9, ''Nothing was renamed'',
         CAST(COUNT(*) AS NVARCHAR(20)) + '' budget ids differ from the earlier snapshot'',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Bak_BudgetProjectKey_OpIds AS s
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Budgets AS b WHERE b.ProjectId = s.ProjectId)
) AS v
ORDER BY Ord;';

-- The number beside everything it threads together — the guide's one-predicate
-- view, straight off the new columns.
EXEC sp_executesql N'
SELECT p.ProjectNumber, p.ProjectId, p.Name,
       (SELECT COUNT(*) FROM dbo.Budgets b
         WHERE b.ProjectNumber = p.ProjectNumber AND b.IsDeleted = 0)            AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a
         WHERE a.ProjectNumber = p.ProjectNumber AND a.IsDeleted = 0)            AS Analyses
FROM dbo.Projects AS p
WHERE p.IsDeleted = 0
ORDER BY p.ProjectNumber;';
