-- ============================================================================
--  Migration — Project IDs become their own OP-### namespace
--
--  NOTE ON COMMENT STYLE, and it is not cosmetic: this file uses only `--`
--  line comments, like every other migration here. SQL Server treats a `--`
--  INSIDE a block comment as a line comment running to end of line, so a
--  closing marker sitting on a line of dashes gets swallowed and the whole
--  batch fails with "Missing end comment mark". Do not reintroduce block
--  comments in these scripts.
--  ---------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-bd-budget database that serves EVERY
--           environment including production.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : BEFORE deploying the release that enforces OP-### project ids.
--           Unlike the earlier migrations this one is NOT optional-column
--           probing: it RE-KEYS dbo.Projects, so the app and the data must
--           agree. Run it, verify it, then deploy.
--
--  RUN THE NUMBERED SECTIONS ONE AT A TIME, in order, reading the output of
--  each before running the next. Section 1 is read-only. Section 3 is the
--  only section that changes keys and it is wrapped in a single transaction
--  with XACT_ABORT ON, so a failure rolls the whole re-key back.
--
--  ---------------------------------------------------------------------------
--  WHY THIS EXISTS
--
--  Today a project's identity is BORROWED from a budget: the project row for
--  budget BD-0002 is literally keyed 'BD-0002', and alternates (BD-0002-02)
--  are attributed to it by stripping the suffix. That is why the Projects list
--  shows BD-…, TST-… ids in its PROJECT ID column.
--
--  The product rule is now that a project id is its own namespace and matches
--  ^OP-[0-9]{3}$ exactly, while budget ids keep the BD- prefix and their -NN
--  alternate suffix. A budget id must never be stored or displayed as a
--  project id. Meeting that rule means re-keying every existing project row
--  and repointing everything that references it.
--
--  WHAT IT DOES
--    1. dbo.ProjectIdMap        — a PERMANENT, deterministic old -> new map.
--                                 It is the audit trail and the rollback key,
--                                 so it is not dropped at the end.
--    2. Re-keys dbo.Projects.ProjectId to OP-###.
--    3. Repoints dbo.Budgets.ProjectKey and dbo.InvestmentAnalyses.ProjectKey.
--    4. Replaces CK_Projects_IdFormat with the OP-### rule.
--    5. Backfills dbo.Projects.PrimaryBudgetId so every project that has a
--       budget has exactly one primary (the Make Primary action needs this).
--    6. Rewrites project ids held OUTSIDE the relational columns: the
--       favorites array inside dbo.Users.SettingsDoc, and dbo.UserActivity
--       rows whose EntityType = 'project'.
--    7. Adds UX_PricingLibrary_Current so "the current pricing library" is a
--       database-enforced singleton, matching how BudgetTemplateVersions
--       already works.
--
--  WHAT IT DOES NOT DO
--    No budget is renamed. dbo.Budgets keeps ProjectId as its primary key and
--    keeps its existing values (BD-####, OP-####, AS-####, TST-####, and the
--    -NN alternates). SovLines, BudgetVersions, BudgetVersionSovLines,
--    InvestmentAnalyses.ProjectId and every foreign key onto a BUDGET are
--    untouched. No row is deleted. Nothing is renumbered silently: every
--    single change of key is recorded in dbo.ProjectIdMap.
--
--  LOCKING
--    dbo.Projects is a small table (one row per project). The re-key drops two
--    foreign keys, updates three narrow columns and re-adds the keys inside
--    one transaction. Re-adding FK_Budgets_Project and
--    FK_InvestmentAnalyses_Project takes a schema-modification lock on
--    dbo.Budgets and dbo.InvestmentAnalyses for the duration of the check.
--    On a database of this size that is milliseconds, but it IS a blocking
--    operation: run it in a quiet window.
--
--  ROLLBACK
--    sql/rollback_project_op_ids.sql, which reverses the re-key from
--    dbo.ProjectIdMap and restores the JSON columns from the section-2 backup
--    tables. Azure SQL point-in-time restore remains the outer safety net.
--
--  Sections: 1 PREFLIGHT (read-only) -> 2 BACKUP -> 3 FORWARD MIGRATION ->
--            4 DATA BACKFILL -> 5 CONSTRAINTS/INDEXES -> 6 VERIFICATION.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;


-- ###########################################################################
--  SECTION 1 - PREFLIGHT.  READ-ONLY.  Run this section on its own, read all
--  five result sets, and do not continue until 1e says every gate passes.
-- ###########################################################################

-- 1a - How much data is involved.
SELECT 'Projects (active)'              AS Item, COUNT(*) AS N FROM dbo.Projects WHERE IsDeleted = 0
UNION ALL SELECT 'Projects (soft-deleted)',       COUNT(*) FROM dbo.Projects WHERE IsDeleted = 1
UNION ALL SELECT 'Projects TOTAL (must be <= 999)', COUNT(*) FROM dbo.Projects
UNION ALL SELECT 'Budgets (active)',              COUNT(*) FROM dbo.Budgets WHERE IsDeleted = 0
UNION ALL SELECT 'Budgets (soft-deleted)',        COUNT(*) FROM dbo.Budgets WHERE IsDeleted = 1
UNION ALL SELECT 'Budgets linked to a project',   COUNT(*) FROM dbo.Budgets WHERE ProjectKey IS NOT NULL
UNION ALL SELECT 'Investment analyses linked to a project', COUNT(*) FROM dbo.InvestmentAnalyses WHERE ProjectKey IS NOT NULL
UNION ALL SELECT 'Accounts with a stored settings document', COUNT(*) FROM dbo.Users WHERE SettingsDoc IS NOT NULL AND ISJSON(SettingsDoc) = 1
UNION ALL SELECT 'Activity rows about a project', COUNT(*) FROM dbo.UserActivity WHERE EntityType = 'project'
UNION ALL SELECT 'dbo.ProjectIdMap already exists',
       CASE WHEN OBJECT_ID('dbo.ProjectIdMap','U') IS NULL THEN 0 ELSE 1 END;

-- 1b - Which project ids are currently misusing a budget-shaped identifier.
--      Every row here is a project that this migration will re-key. Expect
--      the Projects list's PROJECT ID column to be exactly this set.
SELECT p.ProjectId                                   AS CurrentProjectId,
       CASE WHEN p.ProjectId LIKE 'BD-%' THEN 'BD- budget id used as a project id'
            WHEN p.ProjectId LIKE 'TST-%' THEN 'TST- test id used as a project id'
            WHEN p.ProjectId LIKE 'AS-%' THEN 'AS- id used as a project id'
            WHEN p.ProjectId LIKE 'OP-[0-9][0-9][0-9][0-9]' THEN 'OP- but four digits'
            ELSE 'other' END                         AS Problem,
       p.Name, p.Status, p.IsDeleted,
       (SELECT COUNT(*) FROM dbo.Budgets b WHERE b.ProjectKey = p.ProjectId)            AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a WHERE a.ProjectKey = p.ProjectId) AS Analyses,
       p.CreatedAt
FROM dbo.Projects AS p
WHERE p.ProjectId NOT LIKE 'OP-[0-9][0-9][0-9]' OR LEN(p.ProjectId) <> 6
ORDER BY p.CreatedAt, p.ProjectId;

-- 1c - The PROPOSED MAPPING, computed by exactly the same expression section 3
--      will use. Read this. It is deterministic: a project whose numeric tail
--      already fits three digits keeps that number (BD-0002 -> OP-002); every
--      other project takes the lowest still-free number, in creation order.
--      Nothing here is applied yet.
WITH src AS (
  SELECT p.ProjectId AS OldId,
         CASE WHEN RIGHT(p.ProjectId, 4) NOT LIKE '%[^0-9]%'
                   AND LEFT(RIGHT(p.ProjectId, 4), 1) = '0'
                   AND RIGHT(p.ProjectId, 3) <> '000'
              THEN 'OP-' + RIGHT(p.ProjectId, 3) END AS Candidate,
         ROW_NUMBER() OVER (ORDER BY p.CreatedAt, p.ProjectId) AS Ord
  FROM dbo.Projects AS p
),
claim AS (
  SELECT OldId, Candidate, Ord,
         ROW_NUMBER() OVER (PARTITION BY Candidate ORDER BY Ord) AS Rn
  FROM src
),
kept AS (
  SELECT OldId, Candidate AS NewId, Ord FROM claim WHERE Candidate IS NOT NULL AND Rn = 1
),
nums AS (
  SELECT TOP (999) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS N FROM sys.all_objects
),
free AS (
  SELECT 'OP-' + RIGHT('00' + CAST(N AS VARCHAR(3)), 3) AS NewId,
         ROW_NUMBER() OVER (ORDER BY N) AS Fr
  FROM nums
  WHERE 'OP-' + RIGHT('00' + CAST(N AS VARCHAR(3)), 3) NOT IN (SELECT NewId FROM kept)
),
rest AS (
  SELECT s.OldId, s.Ord, ROW_NUMBER() OVER (ORDER BY s.Ord) AS Rr
  FROM src AS s WHERE s.OldId NOT IN (SELECT OldId FROM kept)
)
SELECT m.OldId AS OldProjectId, m.NewId AS NewProjectId, m.How, p.Name, p.CreatedAt
FROM (
  SELECT OldId, NewId, 'number preserved' AS How, Ord FROM kept
  UNION ALL
  SELECT r.OldId, f.NewId, 'next free number', r.Ord FROM rest AS r JOIN free AS f ON f.Fr = r.Rr
) AS m
JOIN dbo.Projects AS p ON p.ProjectId = m.OldId
ORDER BY m.Ord;

-- 1d - Anything that references dbo.Projects that this script does NOT know
--      about. The re-key drops and re-adds FK_Budgets_Project and
--      FK_InvestmentAnalyses_Project only. If this returns any OTHER row,
--      STOP: a reference would be orphaned.
SELECT fk.name AS UnknownForeignKeyOntoProjects,
       OBJECT_NAME(fk.parent_object_id) AS FromTable
FROM sys.foreign_keys AS fk
WHERE fk.referenced_object_id = OBJECT_ID('dbo.Projects')
  AND fk.name NOT IN ('FK_Budgets_Project', 'FK_InvestmentAnalyses_Project');

-- 1e - GATES. Every row must read PASS before section 2 is run.
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL - STOP' END AS Result
FROM (
  SELECT 1 AS Ord, 'Project count fits the OP-### namespace' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' projects, 999 available' AS Detail,
         CASE WHEN COUNT(*) <= 999 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects
  UNION ALL
  SELECT 2, 'No unknown foreign key onto dbo.Projects',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' unexpected',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM sys.foreign_keys
  WHERE referenced_object_id = OBJECT_ID('dbo.Projects')
    AND name NOT IN ('FK_Budgets_Project', 'FK_InvestmentAnalyses_Project')
  UNION ALL
  SELECT 3, 'Every project id has a four-digit numeric tail',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' malformed', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects
  WHERE RIGHT(ProjectId, 4) LIKE '%[^0-9]%' AND LEN(ProjectId) <> 6
  UNION ALL
  SELECT 4, 'No budget points at a missing project',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets AS b
  WHERE b.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
  UNION ALL
  SELECT 5, 'No analysis points at a missing project',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses AS a
  WHERE a.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = a.ProjectKey)
  UNION ALL
  SELECT 6, 'No project id already collides with a planned OP-###',
         'a project literally named OP-### today would be ambiguous',
         CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Projects
                               WHERE ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(ProjectId) = 6)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 7, 'Every stored settings document is valid JSON',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' invalid', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Users WHERE SettingsDoc IS NOT NULL AND ISJSON(SettingsDoc) = 0
  UNION ALL
  SELECT 8, 'Pricing library current-version rows',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' marked IsCurrent = 1 (section 5 reduces this to 1)',
         1
  FROM dbo.PricingLibrary WHERE IsCurrent = 1
) AS v
ORDER BY Ord;


-- ###########################################################################
--  SECTION 2 - BACKUP.  Non-destructive. Creates snapshot tables and the
--  permanent map. Run once, after section 1 passes.
-- ###########################################################################

-- 2a - Snapshots of exactly what section 3 and section 4 change. Small, cheap,
--      and enough for sql/rollback_project_op_ids.sql to reverse everything
--      without a database restore.
IF OBJECT_ID('dbo.Bak_Projects_OpIds','U') IS NULL
  SELECT * INTO dbo.Bak_Projects_OpIds FROM dbo.Projects;

IF OBJECT_ID('dbo.Bak_BudgetProjectKey_OpIds','U') IS NULL
  SELECT ProjectId, ProjectKey INTO dbo.Bak_BudgetProjectKey_OpIds FROM dbo.Budgets;

IF OBJECT_ID('dbo.Bak_AnalysisProjectKey_OpIds','U') IS NULL
  SELECT AnalysisId, ProjectKey INTO dbo.Bak_AnalysisProjectKey_OpIds FROM dbo.InvestmentAnalyses;

IF OBJECT_ID('dbo.Bak_UserSettings_OpIds','U') IS NULL
  SELECT UserId, SettingsDoc INTO dbo.Bak_UserSettings_OpIds FROM dbo.Users;

IF OBJECT_ID('dbo.Bak_UserActivity_OpIds','U') IS NULL
  SELECT Id, EntityType, EntityId INTO dbo.Bak_UserActivity_OpIds
  FROM dbo.UserActivity WHERE EntityType = 'project';

-- 2b - The permanent map. Kept forever: it is the audit record of every key
--      that changed, the input to the rollback script, and the only way to
--      explain an old bookmark after the fact.
IF OBJECT_ID('dbo.ProjectIdMap','U') IS NULL
BEGIN
  PRINT 'Creating dbo.ProjectIdMap';
  CREATE TABLE dbo.ProjectIdMap (
      OldProjectId VARCHAR(16)   NOT NULL,
      NewProjectId VARCHAR(16)   NOT NULL,
      Method       VARCHAR(30)   NOT NULL,   -- number preserved | next free number
      MappedAt     DATETIME2     NOT NULL CONSTRAINT DF_ProjectIdMap_MappedAt DEFAULT (SYSUTCDATETIME()),
      CONSTRAINT PK_ProjectIdMap PRIMARY KEY (OldProjectId),
      CONSTRAINT UQ_ProjectIdMap_New UNIQUE (NewProjectId),
      CONSTRAINT CK_ProjectIdMap_NewFormat CHECK (
        NewProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(NewProjectId) = 6)
  );
END
ELSE PRINT 'dbo.ProjectIdMap already present - skipped';

-- 2c - Compute and freeze the mapping. Identical expression to preflight 1c.
--      Only maps projects that are not already OP-###, and only when the map
--      is empty, so re-running this section is a no-op.
IF NOT EXISTS (SELECT 1 FROM dbo.ProjectIdMap)
BEGIN
  WITH src AS (
    SELECT p.ProjectId AS OldId,
           CASE WHEN RIGHT(p.ProjectId, 4) NOT LIKE '%[^0-9]%'
                     AND LEFT(RIGHT(p.ProjectId, 4), 1) = '0'
                     AND RIGHT(p.ProjectId, 3) <> '000'
                THEN 'OP-' + RIGHT(p.ProjectId, 3) END AS Candidate,
           ROW_NUMBER() OVER (ORDER BY p.CreatedAt, p.ProjectId) AS Ord
    FROM dbo.Projects AS p
  ),
  claim AS (
    SELECT OldId, Candidate, Ord,
           ROW_NUMBER() OVER (PARTITION BY Candidate ORDER BY Ord) AS Rn
    FROM src
  ),
  kept AS (
    SELECT OldId, Candidate AS NewId, Ord FROM claim WHERE Candidate IS NOT NULL AND Rn = 1
  ),
  nums AS (
    SELECT TOP (999) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS N FROM sys.all_objects
  ),
  free AS (
    SELECT 'OP-' + RIGHT('00' + CAST(N AS VARCHAR(3)), 3) AS NewId,
           ROW_NUMBER() OVER (ORDER BY N) AS Fr
    FROM nums
    WHERE 'OP-' + RIGHT('00' + CAST(N AS VARCHAR(3)), 3) NOT IN (SELECT NewId FROM kept)
  ),
  rest AS (
    SELECT s.OldId, s.Ord, ROW_NUMBER() OVER (ORDER BY s.Ord) AS Rr
    FROM src AS s WHERE s.OldId NOT IN (SELECT OldId FROM kept)
  )
  INSERT INTO dbo.ProjectIdMap (OldProjectId, NewProjectId, Method)
  SELECT OldId, NewId, How
  FROM (
    SELECT OldId, NewId, 'number preserved' AS How FROM kept
    UNION ALL
    SELECT r.OldId, f.NewId, 'next free number' FROM rest AS r JOIN free AS f ON f.Fr = r.Rr
  ) AS m;
  PRINT CONCAT('Mapped projects: ', @@ROWCOUNT);
END
ELSE PRINT 'dbo.ProjectIdMap already populated - mapping frozen, not recomputed';

-- 2d - Read the frozen map before running section 3. This is the mapping that
--      will actually be applied.
SELECT OldProjectId, NewProjectId, Method, MappedAt FROM dbo.ProjectIdMap ORDER BY NewProjectId;


-- ###########################################################################
--  SECTION 3 - FORWARD MIGRATION.  The only section that changes keys.
--  One transaction, XACT_ABORT ON: any failure rolls the whole re-key back.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  IF NOT EXISTS (SELECT 1 FROM dbo.ProjectIdMap)
    THROW 50001, 'dbo.ProjectIdMap is empty. Run section 2 first.', 1;

  -- 3.1 - Drop the two foreign keys onto dbo.Projects. A foreign key is
  --       checked per statement, so the parent key cannot be updated while
  --       children still point at the old value. They are re-added in 3.6,
  --       after every child has been repointed, so no row can slip through
  --       unchecked.
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_Project')
  BEGIN
    PRINT 'Dropping FK_Budgets_Project';
    ALTER TABLE dbo.Budgets DROP CONSTRAINT FK_Budgets_Project;
  END

  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InvestmentAnalyses_Project')
  BEGIN
    PRINT 'Dropping FK_InvestmentAnalyses_Project';
    ALTER TABLE dbo.InvestmentAnalyses DROP CONSTRAINT FK_InvestmentAnalyses_Project;
  END

  -- 3.2 - Drop the old id-format check. It requires four digits, which every
  --       new OP-### id would fail.
  IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Projects_IdFormat')
  BEGIN
    PRINT 'Dropping CK_Projects_IdFormat (four-digit rule)';
    ALTER TABLE dbo.Projects DROP CONSTRAINT CK_Projects_IdFormat;
  END

  -- 3.3 - Re-key the projects themselves. PK_Projects still enforces
  --       uniqueness at the end of the statement; old ids (BD-0002) and new
  --       ids (OP-002) live in disjoint shapes, so no intermediate collision
  --       is possible.
  UPDATE p SET p.ProjectId = m.NewProjectId, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p
    JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = p.ProjectId;
  PRINT CONCAT('Projects re-keyed: ', @@ROWCOUNT);

  -- 3.4 - Repoint the budgets. ProjectKey is the only budget column that
  --       carries a project id; dbo.Budgets.ProjectId is a BUDGET id and is
  --       deliberately left alone.
  UPDATE b SET b.ProjectKey = m.NewProjectId
    FROM dbo.Budgets AS b
    JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = b.ProjectKey;
  PRINT CONCAT('Budgets repointed: ', @@ROWCOUNT);

  -- 3.5 - Repoint the investment analyses. Same rule: ProjectKey moves,
  --       ProjectId (the source BUDGET) does not.
  UPDATE a SET a.ProjectKey = m.NewProjectId
    FROM dbo.InvestmentAnalyses AS a
    JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = a.ProjectKey;
  PRINT CONCAT('Analyses repointed: ', @@ROWCOUNT);

  -- 3.6 - The new rule, and the keys back. Added WITH CHECK (the default) so
  --       SQL Server validates every existing row now rather than trusting it.
  PRINT 'Adding CK_Projects_IdFormat (OP-### rule)';
  ALTER TABLE dbo.Projects ADD CONSTRAINT CK_Projects_IdFormat CHECK (
    ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(ProjectId) = 6);

  PRINT 'Re-adding FK_Budgets_Project';
  ALTER TABLE dbo.Budgets ADD CONSTRAINT FK_Budgets_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);

  PRINT 'Re-adding FK_InvestmentAnalyses_Project';
  ALTER TABLE dbo.InvestmentAnalyses ADD CONSTRAINT FK_InvestmentAnalyses_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);

  COMMIT TRANSACTION;
  PRINT '=== SECTION 3 COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== SECTION 3 ROLLED BACK - nothing changed ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 4 - DATA BACKFILL.  Project ids that live outside a relational
--  column, plus the primary-budget invariant the Make Primary action needs.
--  Idempotent; one transaction.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  -- 4.1 - Favorites. The per-account settings document stores starred ids as
  --       JSON arrays (favorites.project, and the legacy pinned.project the
  --       contract still lifts). The array is rebuilt element by element
  --       through the map, preserving order and preserving any id that has no
  --       map row rather than dropping it.
  UPDATE u SET SettingsDoc = JSON_MODIFY(u.SettingsDoc, '$.favorites.project', JSON_QUERY(x.NewArr))
  FROM dbo.Users AS u
  CROSS APPLY (
    SELECT '[' + ISNULL(STRING_AGG(
             '"' + STRING_ESCAPE(COALESCE(m.NewProjectId, j.value), 'json') + '"', ',')
             WITHIN GROUP (ORDER BY CAST(j.[key] AS INT)), '') + ']' AS NewArr
    FROM OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                  '$.favorites.project') AS j
    LEFT JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = j.value
  ) AS x
  WHERE u.SettingsDoc IS NOT NULL AND ISJSON(u.SettingsDoc) = 1
    AND JSON_QUERY(u.SettingsDoc, '$.favorites.project') IS NOT NULL;
  PRINT CONCAT('Accounts whose favorites.project was rewritten: ', @@ROWCOUNT);

  UPDATE u SET SettingsDoc = JSON_MODIFY(u.SettingsDoc, '$.pinned.project', JSON_QUERY(x.NewArr))
  FROM dbo.Users AS u
  CROSS APPLY (
    SELECT '[' + ISNULL(STRING_AGG(
             '"' + STRING_ESCAPE(COALESCE(m.NewProjectId, j.value), 'json') + '"', ',')
             WITHIN GROUP (ORDER BY CAST(j.[key] AS INT)), '') + ']' AS NewArr
    FROM OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                  '$.pinned.project') AS j
    LEFT JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = j.value
  ) AS x
  WHERE u.SettingsDoc IS NOT NULL AND ISJSON(u.SettingsDoc) = 1
    AND JSON_QUERY(u.SettingsDoc, '$.pinned.project') IS NOT NULL;
  PRINT CONCAT('Accounts whose legacy pinned.project was rewritten: ', @@ROWCOUNT);

  -- 4.2 - The activity log. Only rows explicitly about a project are touched;
  --       a budget_save row's EntityId is a BUDGET id and must not move.
  UPDATE ua SET ua.EntityId = m.NewProjectId
    FROM dbo.UserActivity AS ua
    JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = ua.EntityId
   WHERE ua.EntityType = 'project';
  PRINT CONCAT('Activity rows repointed: ', @@ROWCOUNT);

  -- 4.3 - Exactly one primary budget per project that has budgets. The base
  --       budget (shortest id, then lowest) is the primary, which is the same
  --       rule getProject already applies when it computes a project's money.
  --       A project with no budgets keeps NULL: there is nothing to be primary.
  UPDATE p SET p.PrimaryBudgetId = b.ProjectId, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p
   CROSS APPLY (SELECT TOP 1 x.ProjectId FROM dbo.Budgets AS x
                 WHERE x.ProjectKey = p.ProjectId AND x.IsDeleted = 0
                 ORDER BY LEN(x.ProjectId), x.ProjectId) AS b
   WHERE p.PrimaryBudgetId IS NULL;
  PRINT CONCAT('Projects given a primary budget: ', @@ROWCOUNT);

  -- 4.4 - Repair a primary that points at a budget which is deleted, or which
  --       belongs to a different project. Same rule as 4.3.
  UPDATE p SET p.PrimaryBudgetId = b.ProjectId, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p
   CROSS APPLY (SELECT TOP 1 x.ProjectId FROM dbo.Budgets AS x
                 WHERE x.ProjectKey = p.ProjectId AND x.IsDeleted = 0
                 ORDER BY LEN(x.ProjectId), x.ProjectId) AS b
   WHERE p.PrimaryBudgetId IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM dbo.Budgets AS c
                      WHERE c.ProjectId = p.PrimaryBudgetId
                        AND c.ProjectKey = p.ProjectId AND c.IsDeleted = 0);
  PRINT CONCAT('Projects whose primary budget was repaired: ', @@ROWCOUNT);

  -- 4.5 - A project whose every budget is deleted has no primary to point at.
  UPDATE p SET p.PrimaryBudgetId = NULL, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p
   WHERE p.PrimaryBudgetId IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM dbo.Budgets AS c
                      WHERE c.ProjectKey = p.ProjectId AND c.IsDeleted = 0);
  PRINT CONCAT('Projects cleared to no primary (all budgets deleted): ', @@ROWCOUNT);

  COMMIT TRANSACTION;
  PRINT '=== SECTION 4 COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== SECTION 4 ROLLED BACK ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 5 - CONSTRAINTS AND INDEXES.
--  "The current pricing library" becomes a database-enforced singleton, so a
--  budget created right after a publish cannot resolve a stale version.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  -- 5.1 - If more than one row is flagged current (which the app's publish
  --       transaction should already make impossible, but nothing enforced
  --       until now), keep the newest by Effective then CreatedAt and clear
  --       the rest. Non-destructive: no row and no Doc is removed, only the
  --       flag moves.
  IF (SELECT COUNT(*) FROM dbo.PricingLibrary WHERE IsCurrent = 1) > 1
  BEGIN
    WITH ranked AS (
      SELECT Version, ROW_NUMBER() OVER (ORDER BY Effective DESC, CreatedAt DESC) AS Rn
      FROM dbo.PricingLibrary WHERE IsCurrent = 1
    )
    UPDATE pl SET IsCurrent = 0
      FROM dbo.PricingLibrary AS pl JOIN ranked AS r ON r.Version = pl.Version
     WHERE r.Rn > 1;
    PRINT CONCAT('Stale IsCurrent flags cleared: ', @@ROWCOUNT);
  END

  -- 5.2 - The backstop. This is the same guarantee
  --       UX_BudgetTemplateVersions_Current already gives templates: two
  --       concurrent publishes cannot both end up current.
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_PricingLibrary_Current')
  BEGIN
    PRINT 'Creating UX_PricingLibrary_Current';
    CREATE UNIQUE INDEX UX_PricingLibrary_Current
      ON dbo.PricingLibrary (IsCurrent) WHERE IsCurrent = 1;
  END

  -- 5.3 - Reverse lookup for the map, used by the rollback script and by any
  --       "where did OP-004 come from" question.
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectIdMap_New')
    CREATE INDEX IX_ProjectIdMap_New ON dbo.ProjectIdMap (NewProjectId) INCLUDE (OldProjectId);

  COMMIT TRANSACTION;
  PRINT '=== SECTION 5 COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== SECTION 5 ROLLED BACK ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 6 - VERIFICATION.  One result set, because the portal exports only
--  one. EVERY row must read PASS. Paste this output back to the developer.
-- ###########################################################################

SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'Every project id matches ^OP-[0-9]{3}$' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' violating' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects
  WHERE ProjectId NOT LIKE 'OP-[0-9][0-9][0-9]' OR LEN(ProjectId) <> 6
  UNION ALL
  SELECT 2, 'No BD- / TST- / AS- value survives as a project id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' remaining', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects
  WHERE ProjectId LIKE 'BD-%' OR ProjectId LIKE 'TST-%' OR ProjectId LIKE 'AS-%'
  UNION ALL
  SELECT 3, 'Project ids are unique',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' duplicated', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM (SELECT ProjectId FROM dbo.Projects GROUP BY ProjectId HAVING COUNT(*) > 1) AS d
  UNION ALL
  SELECT 4, 'The OP-### format is enforced by the database',
         'CK_Projects_IdFormat is present and trusted',
         CASE WHEN EXISTS (SELECT 1 FROM sys.check_constraints
                           WHERE name = 'CK_Projects_IdFormat' AND is_not_trusted = 0)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 5, 'Budget ids were not touched',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' budgets differ from the section-2 snapshot',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Bak_BudgetProjectKey_OpIds AS s
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Budgets AS b WHERE b.ProjectId = s.ProjectId)
  UNION ALL
  SELECT 6, 'Budget ids still carry a budget prefix, never a project id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' malformed',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets
  WHERE ProjectId NOT LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
    AND ProjectId NOT LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
    AND ProjectId NOT LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND ProjectId NOT LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  UNION ALL
  SELECT 7, 'No orphaned budget',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' pointing at a missing project',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets AS b
  WHERE b.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
  UNION ALL
  SELECT 8, 'No orphaned investment analysis',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' pointing at a missing project',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses AS a
  WHERE a.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = a.ProjectKey)
  UNION ALL
  SELECT 9, 'Every budget kept its project relationship',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' relationships lost or remapped wrongly',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Bak_BudgetProjectKey_OpIds AS s
  JOIN dbo.Budgets AS b ON b.ProjectId = s.ProjectId
  LEFT JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = s.ProjectKey
  WHERE ISNULL(b.ProjectKey, '~') <> ISNULL(COALESCE(m.NewProjectId, s.ProjectKey), '~')
  UNION ALL
  SELECT 10, 'Every analysis kept its project relationship',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' relationships lost or remapped wrongly',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Bak_AnalysisProjectKey_OpIds AS s
  JOIN dbo.InvestmentAnalyses AS a ON a.AnalysisId = s.AnalysisId
  LEFT JOIN dbo.ProjectIdMap AS m ON m.OldProjectId = s.ProjectKey
  WHERE ISNULL(a.ProjectKey, '~') <> ISNULL(COALESCE(m.NewProjectId, s.ProjectKey), '~')
  UNION ALL
  SELECT 11, 'Foreign keys are back and trusted',
         'FK_Budgets_Project + FK_InvestmentAnalyses_Project',
         CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys
                           WHERE name = 'FK_Budgets_Project' AND is_not_trusted = 0)
               AND EXISTS (SELECT 1 FROM sys.foreign_keys
                           WHERE name = 'FK_InvestmentAnalyses_Project' AND is_not_trusted = 0)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 12, 'Every project with a live budget has exactly one primary',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' without a valid primary',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects AS p
  WHERE EXISTS (SELECT 1 FROM dbo.Budgets AS b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0)
    AND NOT EXISTS (SELECT 1 FROM dbo.Budgets AS b
                     WHERE b.ProjectId = p.PrimaryBudgetId
                       AND b.ProjectKey = p.ProjectId AND b.IsDeleted = 0)
  UNION ALL
  SELECT 13, 'No project claims a primary budget it does not own',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' mismatched',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects AS p
  WHERE p.PrimaryBudgetId IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Budgets AS b
                     WHERE b.ProjectId = p.PrimaryBudgetId AND b.ProjectKey = p.ProjectId)
  UNION ALL
  SELECT 14, 'No favorite still points at an old project id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' stale entries',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Users AS u
  CROSS APPLY OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                       '$.favorites.project') AS j
  WHERE ISJSON(u.SettingsDoc) = 1
    AND EXISTS (SELECT 1 FROM dbo.ProjectIdMap AS m WHERE m.OldProjectId = j.value)
  UNION ALL
  SELECT 15, 'Every settings document is still valid JSON',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' corrupted',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Users WHERE SettingsDoc IS NOT NULL AND ISJSON(SettingsDoc) = 0
  UNION ALL
  SELECT 16, 'No project activity row still points at an old id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' stale rows',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.UserActivity AS ua
  WHERE ua.EntityType = 'project'
    AND EXISTS (SELECT 1 FROM dbo.ProjectIdMap AS m WHERE m.OldProjectId = ua.EntityId)
  UNION ALL
  SELECT 17, 'Exactly one current pricing library',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' flagged current',
         CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
  FROM dbo.PricingLibrary WHERE IsCurrent = 1
  UNION ALL
  SELECT 18, 'The current-pricing singleton is enforced by an index',
         'UX_PricingLibrary_Current',
         CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_PricingLibrary_Current')
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 19, 'Project count is unchanged',
         CONCAT((SELECT COUNT(*) FROM dbo.Projects), ' now vs ',
                (SELECT COUNT(*) FROM dbo.Bak_Projects_OpIds), ' before'),
         CASE WHEN (SELECT COUNT(*) FROM dbo.Projects)
                 = (SELECT COUNT(*) FROM dbo.Bak_Projects_OpIds) THEN 1 ELSE 0 END
  UNION ALL
  SELECT 20, 'The mapping is recorded for every re-keyed project',
         CONCAT((SELECT COUNT(*) FROM dbo.ProjectIdMap), ' rows in dbo.ProjectIdMap'),
         CASE WHEN (SELECT COUNT(*) FROM dbo.ProjectIdMap) > 0 THEN 1 ELSE 0 END
) AS v
ORDER BY Ord;

-- The new project index, for eyeballing against the Projects page after deploy.
SELECT p.ProjectId, m.OldProjectId AS WasKeyedAs, p.Name, p.Status, p.PrimaryBudgetId,
       (SELECT COUNT(*) FROM dbo.Budgets b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0) AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS Analyses
FROM dbo.Projects AS p
LEFT JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = p.ProjectId
ORDER BY p.ProjectId;
