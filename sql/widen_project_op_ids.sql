-- ============================================================================
--  Migration — widen project ids from OP-### to OP-####
--
--  NOTE ON COMMENT STYLE: `--` line comments only, like every other script
--  here. See the header of sql/migrate_project_op_ids.sql for why.
--  ---------------------------------------------------------------------------
--  Target : Azure SQL, the fs-bd-budget database.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : AFTER sql/migrate_project_op_ids.sql has been run and verified,
--           and BEFORE deploying the release that validates ^OP-[0-9]{4}$.
--
--  WHY
--    The first migration minted three-digit project ids (OP-001). The product
--    rule is now four digits (OP-0001), which also lifts the ceiling from 999
--    projects to 9,999.
--
--  WHAT IT DOES
--    Pads every project id with one leading zero — OP-007 becomes OP-0007 —
--    and repoints Budgets.ProjectKey, InvestmentAnalyses.ProjectKey, the
--    favorites arrays inside Users.SettingsDoc, the project rows in
--    UserActivity, and dbo.ProjectIdMap.NewProjectId so the rollback script
--    still reverses correctly.
--
--    The mapping is a pure string transform, so there is nothing to choose and
--    nothing to collide: OP-### and OP-#### are different lengths, and every
--    id moves at once inside one transaction.
--
--  WHAT IT DOES NOT DO
--    No budget is renamed. No row is deleted. dbo.ProjectIdMap.OldProjectId is
--    untouched, so the rollback still knows the original BD-… identity.
--
--  Sections: 1 PREFLIGHT (read-only) -> 2 MIGRATION -> 3 VERIFICATION.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;


-- ###########################################################################
--  SECTION 1 - PREFLIGHT.  READ-ONLY.  Run on its own and read both results.
-- ###########################################################################

SELECT p.ProjectId AS CurrentId,
       'OP-0' + RIGHT(p.ProjectId, 3) AS NewId,
       p.Name, p.Status, p.PrimaryBudgetId,
       (SELECT COUNT(*) FROM dbo.Budgets b WHERE b.ProjectKey = p.ProjectId)            AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a WHERE a.ProjectKey = p.ProjectId) AS Analyses
FROM dbo.Projects AS p
ORDER BY p.ProjectId;

SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL - STOP' END AS Result
FROM (
  SELECT 1 AS Ord, 'Every project id is currently OP-###' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' not three-digit OP' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects
  WHERE ProjectId NOT LIKE 'OP-[0-9][0-9][0-9]' OR LEN(ProjectId) <> 6
  UNION ALL
  SELECT 2, 'No four-digit project id exists yet',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' already widened',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects WHERE ProjectId LIKE 'OP-[0-9][0-9][0-9][0-9]'
  UNION ALL
  SELECT 3, 'dbo.ProjectIdMap is present to keep in step',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' mapped projects',
         CASE WHEN OBJECT_ID('dbo.ProjectIdMap','U') IS NOT NULL THEN 1 ELSE 0 END
  FROM dbo.ProjectIdMap
  UNION ALL
  SELECT 4, 'No unknown foreign key onto dbo.Projects',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' unexpected',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM sys.foreign_keys
  WHERE referenced_object_id = OBJECT_ID('dbo.Projects')
    AND name NOT IN ('FK_Budgets_Project', 'FK_InvestmentAnalyses_Project')
) AS v
ORDER BY Ord;


-- ###########################################################################
--  SECTION 2 - MIGRATION.  One transaction, XACT_ABORT ON.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  -- 2.1 - Drop the foreign keys: a parent key cannot move while children
  --       still point at it. Re-added in 2.6 after every child has moved.
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_Project')
    ALTER TABLE dbo.Budgets DROP CONSTRAINT FK_Budgets_Project;
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InvestmentAnalyses_Project')
    ALTER TABLE dbo.InvestmentAnalyses DROP CONSTRAINT FK_InvestmentAnalyses_Project;

  -- 2.2 - Drop the three-digit checks.
  IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Projects_IdFormat')
    ALTER TABLE dbo.Projects DROP CONSTRAINT CK_Projects_IdFormat;
  IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ProjectIdMap_NewFormat')
    ALTER TABLE dbo.ProjectIdMap DROP CONSTRAINT CK_ProjectIdMap_NewFormat;

  -- 2.3 - Widen the projects. OP-### and OP-#### are different lengths, so no
  --       intermediate collision is possible and PK_Projects stays satisfied.
  UPDATE dbo.Projects
     SET ProjectId = 'OP-0' + RIGHT(ProjectId, 3), UpdatedAt = SYSUTCDATETIME()
   WHERE ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(ProjectId) = 6;
  PRINT CONCAT('Projects widened: ', @@ROWCOUNT);

  -- 2.4 - Children. ProjectKey is the only project id a budget or an analysis
  --       carries; their own ProjectId columns are BUDGET ids and do not move.
  UPDATE dbo.Budgets
     SET ProjectKey = 'OP-0' + RIGHT(ProjectKey, 3)
   WHERE ProjectKey LIKE 'OP-[0-9][0-9][0-9]' AND LEN(ProjectKey) = 6;
  PRINT CONCAT('Budgets repointed: ', @@ROWCOUNT);

  UPDATE dbo.InvestmentAnalyses
     SET ProjectKey = 'OP-0' + RIGHT(ProjectKey, 3)
   WHERE ProjectKey LIKE 'OP-[0-9][0-9][0-9]' AND LEN(ProjectKey) = 6;
  PRINT CONCAT('Analyses repointed: ', @@ROWCOUNT);

  -- 2.5 - Keep the map in step, so sql/rollback_project_op_ids.sql still
  --       reverses to the original BD-… identity from the CURRENT key.
  UPDATE dbo.ProjectIdMap
     SET NewProjectId = 'OP-0' + RIGHT(NewProjectId, 3)
   WHERE NewProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(NewProjectId) = 6;
  PRINT CONCAT('Map rows widened: ', @@ROWCOUNT);

  -- 2.6 - The four-digit rule, and the keys back, validated against every row.
  ALTER TABLE dbo.Projects ADD CONSTRAINT CK_Projects_IdFormat CHECK (
    ProjectId LIKE 'OP-[0-9][0-9][0-9][0-9]' AND LEN(ProjectId) = 7);
  ALTER TABLE dbo.ProjectIdMap ADD CONSTRAINT CK_ProjectIdMap_NewFormat CHECK (
    NewProjectId LIKE 'OP-[0-9][0-9][0-9][0-9]' AND LEN(NewProjectId) = 7);
  ALTER TABLE dbo.Budgets ADD CONSTRAINT FK_Budgets_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);
  ALTER TABLE dbo.InvestmentAnalyses ADD CONSTRAINT FK_InvestmentAnalyses_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);

  -- 2.7 - Project ids held outside a relational column. Same rebuild as the
  --       first migration: element by element, order preserved, and an entry
  --       that does not match the three-digit shape is left exactly as it is.
  UPDATE u SET SettingsDoc = JSON_MODIFY(u.SettingsDoc, '$.favorites.project', JSON_QUERY(x.NewArr))
  FROM dbo.Users AS u
  CROSS APPLY (
    SELECT '[' + ISNULL(STRING_AGG('"' + STRING_ESCAPE(
             CASE WHEN j.value LIKE 'OP-[0-9][0-9][0-9]' AND LEN(j.value) = 6
                  THEN 'OP-0' + RIGHT(j.value, 3) ELSE j.value END, 'json') + '"', ',')
             WITHIN GROUP (ORDER BY CAST(j.[key] AS INT)), '') + ']' AS NewArr
    FROM OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                  '$.favorites.project') AS j
  ) AS x
  WHERE u.SettingsDoc IS NOT NULL AND ISJSON(u.SettingsDoc) = 1
    AND JSON_QUERY(u.SettingsDoc, '$.favorites.project') IS NOT NULL;
  PRINT CONCAT('Accounts whose favorites were widened: ', @@ROWCOUNT);

  UPDATE dbo.UserActivity
     SET EntityId = 'OP-0' + RIGHT(EntityId, 3)
   WHERE EntityType = 'project'
     AND EntityId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(EntityId) = 6;
  PRINT CONCAT('Activity rows widened: ', @@ROWCOUNT);

  COMMIT TRANSACTION;
  PRINT '=== WIDEN COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== WIDEN ROLLED BACK - nothing changed ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 3 - VERIFICATION.  Every row must read PASS. Send this output back.
-- ###########################################################################

SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'Every project id matches ^OP-[0-9]{4}$' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' violating' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects
  WHERE ProjectId NOT LIKE 'OP-[0-9][0-9][0-9][0-9]' OR LEN(ProjectId) <> 7
  UNION ALL
  SELECT 2, 'Project ids are unique',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' duplicated', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM (SELECT ProjectId FROM dbo.Projects GROUP BY ProjectId HAVING COUNT(*) > 1) AS d
  UNION ALL
  SELECT 3, 'The four-digit rule is enforced and trusted', 'CK_Projects_IdFormat',
         CASE WHEN EXISTS (SELECT 1 FROM sys.check_constraints
                           WHERE name = 'CK_Projects_IdFormat' AND is_not_trusted = 0)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 4, 'No orphaned budget',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets AS b
  WHERE b.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
  UNION ALL
  SELECT 5, 'No orphaned investment analysis',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses AS a
  WHERE a.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = a.ProjectKey)
  UNION ALL
  SELECT 6, 'Budget ids untouched — still BD-/OP-/AS-/TST- budget shapes',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' malformed', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets
  WHERE ProjectId NOT LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
    AND ProjectId NOT LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
    AND ProjectId NOT LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND ProjectId NOT LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  UNION ALL
  SELECT 7, 'Every project with a live budget has exactly one primary',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' without a valid primary',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects AS p
  WHERE EXISTS (SELECT 1 FROM dbo.Budgets AS b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0)
    AND NOT EXISTS (SELECT 1 FROM dbo.Budgets AS b
                     WHERE b.ProjectId = p.PrimaryBudgetId
                       AND b.ProjectKey = p.ProjectId AND b.IsDeleted = 0)
  UNION ALL
  SELECT 8, 'The map points at the current keys',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' map rows with no matching project',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.ProjectIdMap AS m
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = m.NewProjectId)
  UNION ALL
  SELECT 9, 'No favorite still points at a three-digit project id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' stale entries',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Users AS u
  CROSS APPLY OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                       '$.favorites.project') AS j
  WHERE j.value LIKE 'OP-[0-9][0-9][0-9]' AND LEN(j.value) = 6
  UNION ALL
  SELECT 10, 'No project activity row still points at a three-digit id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' stale rows',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.UserActivity
  WHERE EntityType = 'project' AND EntityId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(EntityId) = 6
) AS v
ORDER BY Ord;

-- The project index in its final shape.
SELECT p.ProjectId, m.OldProjectId AS WasKeyedAs, p.Name, p.Status, p.PrimaryBudgetId,
       (SELECT COUNT(*) FROM dbo.Budgets b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0) AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS Analyses
FROM dbo.Projects AS p
LEFT JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = p.ProjectId
ORDER BY p.ProjectId;
