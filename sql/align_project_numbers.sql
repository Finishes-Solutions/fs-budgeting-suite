-- ============================================================================
--  Migration — give each project the number its budget already carries
--
--  NOTE ON COMMENT STYLE: `--` line comments only, like every other script
--  here. See the header of sql/migrate_project_op_ids.sql for why.
--  ---------------------------------------------------------------------------
--  Target : Azure SQL, the fs-bd-budget database.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : any time. The application change that ships alongside this only
--           affects which id is SUGGESTED for a new budget, so the app works
--           correctly whether or not this has run. Running it is what makes
--           the convention true of the records that already exist.
--
--  WHY
--    A project and its budgets should read as one family: OP-9999 carries
--    BD-9999, BD-9999-02, and so on. Two of the seven projects already do;
--    the rest were numbered sequentially when sql/migrate_project_op_ids.sql
--    re-keyed them off borrowed budget ids, so OP-0005 ended up holding
--    BD-4821.
--
--  WHY THE PROJECTS MOVE AND NOT THE BUDGETS
--    Renaming a budget would cascade through dbo.SovLines, dbo.BudgetVersions,
--    dbo.BudgetVersionSovLines, dbo.InvestmentAnalyses, the projectId inside
--    every budget document AND every immutable version snapshot, and the
--    source provenance inside every analysis. Rewriting immutable snapshots is
--    the one thing this schema promises never to do. Budget numbers like
--    BD-4821 are also the ones that appear in proposals and email outside the
--    app.
--
--    A project id, by contrast, was minted a day ago and is referenced by four
--    things this script can move atomically — which is exactly what
--    sql/widen_project_op_ids.sql already proved.
--
--  THE MAPPING — four rows move. It is a lookup, not a rule: it is written out
--  in full below and nothing is computed from a pattern, because the two
--  collisions below need a human decision, not an algorithm.
--
--    OP-0003 -> OP-2519   (BD-2519, Greenville Townhomes)
--    OP-0005 -> OP-4821   (BD-4821, Jones Rd Apartments — 5 analyses follow)
--    OP-0006 -> OP-9999   (BD-9999, Test Project 3)
--    OP-0007 -> OP-2108   (BD-2108)
--
--    OP-0001 / BD-0001 and OP-0002 / BD-0002 already match — untouched.
--    OP-0004 holds TST-9999 and would also want 9999. TST- is test data
--    (excluded from views, purgeable by sql/cleanup_test_budgets.sql), so the
--    real budget takes the number and OP-0004 keeps its own.
--
--  WHAT IT DOES NOT DO
--    No budget is renamed. No row is deleted. No constraint changes —
--    CK_Projects_IdFormat already allows any OP-####.
--
--  Sections: 1 PREFLIGHT (read-only) -> 2 MIGRATION -> 3 VERIFICATION.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;


-- ###########################################################################
--  SECTION 1 - PREFLIGHT.  READ-ONLY.  Run on its own and read both results.
-- ###########################################################################

-- 1a - Every project, its primary budget, and whether they already agree.
SELECT p.ProjectId,
       p.PrimaryBudgetId,
       p.Name,
       CASE WHEN p.PrimaryBudgetId IS NULL THEN 'no budget yet'
            -- The suffix is stripped first: an alternate primary is
            -- BD-0001-02, whose last four characters are "1-02".
            WHEN RIGHT(p.ProjectId, 4) = RIGHT(
                   CASE WHEN p.PrimaryBudgetId LIKE '%-[0-9][0-9]'
                        THEN LEFT(p.PrimaryBudgetId, LEN(p.PrimaryBudgetId) - 3)
                        ELSE p.PrimaryBudgetId END, 4) THEN 'already matches'
            ELSE 'mismatched' END                                        AS State,
       (SELECT COUNT(*) FROM dbo.Budgets b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0)            AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS Analyses
FROM dbo.Projects AS p
ORDER BY p.ProjectId;

-- 1b - GATES. Every row must read PASS before section 2 is run.
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL - STOP' END AS Result
FROM (
  SELECT 1 AS Ord, 'The four projects this script moves are present' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' of 4 found' AS Detail,
         CASE WHEN COUNT(*) = 4 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects WHERE ProjectId IN ('OP-0003','OP-0005','OP-0006','OP-0007')
  UNION ALL
  SELECT 2, 'None of the four destination numbers is already taken',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' occupied', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Projects WHERE ProjectId IN ('OP-2519','OP-4821','OP-9999','OP-2108')
  UNION ALL
  SELECT 3, 'Each mover still holds the budget the new number is taken from',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' of 4 confirmed', CASE WHEN COUNT(*) = 4 THEN 1 ELSE 0 END
  FROM dbo.Projects
  WHERE (ProjectId = 'OP-0003' AND PrimaryBudgetId = 'BD-2519')
     OR (ProjectId = 'OP-0005' AND PrimaryBudgetId = 'BD-4821')
     OR (ProjectId = 'OP-0006' AND PrimaryBudgetId = 'BD-9999')
     OR (ProjectId = 'OP-0007' AND PrimaryBudgetId = 'BD-2108')
  UNION ALL
  SELECT 4, 'No unknown foreign key onto dbo.Projects',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' unexpected', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM sys.foreign_keys
  WHERE referenced_object_id = OBJECT_ID('dbo.Projects')
    AND name NOT IN ('FK_Budgets_Project', 'FK_InvestmentAnalyses_Project')
  UNION ALL
  SELECT 5, 'dbo.ProjectIdMap is present to keep in step',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' mapped projects',
         CASE WHEN OBJECT_ID('dbo.ProjectIdMap','U') IS NOT NULL THEN 1 ELSE 0 END
  FROM dbo.ProjectIdMap
) AS v
ORDER BY Ord;


-- ###########################################################################
--  SECTION 2 - MIGRATION.  One transaction, XACT_ABORT ON.
-- ###########################################################################

BEGIN TRANSACTION;
BEGIN TRY

  -- 2.1 - The mapping, as data. A table variable rather than four repeated
  --       CASE expressions: every statement below reads the same rows, so the
  --       parent and its children cannot drift apart through a typo.
  DECLARE @map TABLE (OldId VARCHAR(16) PRIMARY KEY, NewId VARCHAR(16) NOT NULL UNIQUE);
  INSERT INTO @map (OldId, NewId) VALUES
    ('OP-0003','OP-2519'),
    ('OP-0005','OP-4821'),
    ('OP-0006','OP-9999'),
    ('OP-0007','OP-2108');

  -- 2.2 - Drop the foreign keys: a parent key cannot move while children still
  --       point at it. Re-added in 2.6 once every child has moved.
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_Project')
    ALTER TABLE dbo.Budgets DROP CONSTRAINT FK_Budgets_Project;
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InvestmentAnalyses_Project')
    ALTER TABLE dbo.InvestmentAnalyses DROP CONSTRAINT FK_InvestmentAnalyses_Project;

  -- 2.3 - The projects. Old and new ids are disjoint (gate 2 proved it), so
  --       PK_Projects stays satisfied throughout the statement.
  UPDATE p SET p.ProjectId = m.NewId, p.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.Projects AS p JOIN @map AS m ON m.OldId = p.ProjectId;
  PRINT CONCAT('Projects renumbered: ', @@ROWCOUNT);

  -- 2.4 - Children. ProjectKey is the only project id they carry; their own
  --       ProjectId columns are BUDGET ids and deliberately do not move.
  UPDATE b SET b.ProjectKey = m.NewId
    FROM dbo.Budgets AS b JOIN @map AS m ON m.OldId = b.ProjectKey;
  PRINT CONCAT('Budgets repointed: ', @@ROWCOUNT);

  UPDATE a SET a.ProjectKey = m.NewId
    FROM dbo.InvestmentAnalyses AS a JOIN @map AS m ON m.OldId = a.ProjectKey;
  PRINT CONCAT('Analyses repointed: ', @@ROWCOUNT);

  -- 2.5 - Keep the map in step, so sql/rollback_project_op_ids.sql still
  --       reverses from the CURRENT key back to the original BD-… identity.
  UPDATE x SET x.NewProjectId = m.NewId
    FROM dbo.ProjectIdMap AS x JOIN @map AS m ON m.OldId = x.NewProjectId;
  PRINT CONCAT('Map rows updated: ', @@ROWCOUNT);

  -- 2.6 - The keys back, validated against every row.
  ALTER TABLE dbo.Budgets ADD CONSTRAINT FK_Budgets_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);
  ALTER TABLE dbo.InvestmentAnalyses ADD CONSTRAINT FK_InvestmentAnalyses_Project
    FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);

  -- 2.7 - Project ids held outside a relational column. Same element-by-element
  --       rebuild as the earlier migrations: order preserved, and an entry that
  --       is not in the map is left exactly as it is.
  UPDATE u SET SettingsDoc = JSON_MODIFY(u.SettingsDoc, '$.favorites.project', JSON_QUERY(x.NewArr))
  FROM dbo.Users AS u
  CROSS APPLY (
    SELECT '[' + ISNULL(STRING_AGG('"' + STRING_ESCAPE(
             ISNULL((SELECT m.NewId FROM @map AS m WHERE m.OldId = j.value), j.value), 'json') + '"', ',')
             WITHIN GROUP (ORDER BY CAST(j.[key] AS INT)), '') + ']' AS NewArr
    FROM OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                  '$.favorites.project') AS j
  ) AS x
  WHERE u.SettingsDoc IS NOT NULL AND ISJSON(u.SettingsDoc) = 1
    AND JSON_QUERY(u.SettingsDoc, '$.favorites.project') IS NOT NULL;
  PRINT CONCAT('Accounts whose favorites were repointed: ', @@ROWCOUNT);

  UPDATE ua SET ua.EntityId = m.NewId
    FROM dbo.UserActivity AS ua JOIN @map AS m ON m.OldId = ua.EntityId
   WHERE ua.EntityType = 'project';
  PRINT CONCAT('Activity rows repointed: ', @@ROWCOUNT);

  COMMIT TRANSACTION;
  PRINT '=== ALIGNMENT COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== ALIGNMENT ROLLED BACK - nothing changed ===';
  THROW;
END CATCH;


-- ###########################################################################
--  SECTION 3 - VERIFICATION.  Every row must read PASS. Send this output back.
-- ###########################################################################

SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'Every project id still matches ^OP-[0-9]{4}$' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(20)) + ' violating' AS Detail,
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects
  WHERE ProjectId NOT LIKE 'OP-[0-9][0-9][0-9][0-9]' OR LEN(ProjectId) <> 7
  UNION ALL
  SELECT 2, 'Project ids are unique',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' duplicated', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM (SELECT ProjectId FROM dbo.Projects GROUP BY ProjectId HAVING COUNT(*) > 1) AS d
  UNION ALL
  -- The point of the whole script.
  SELECT 3, 'Every project shares its primary budget''s number',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' still mismatched (TST-9999 on OP-0004 is the known exception)',
         CASE WHEN COUNT(*) <= 1 THEN 1 ELSE 0 END
  FROM dbo.Projects
  WHERE PrimaryBudgetId IS NOT NULL
    AND RIGHT(ProjectId, 4) <> RIGHT(
          CASE WHEN PrimaryBudgetId LIKE '%-[0-9][0-9]'
               THEN LEFT(PrimaryBudgetId, LEN(PrimaryBudgetId) - 3)
               ELSE PrimaryBudgetId END, 4)
  UNION ALL
  SELECT 4, 'No budget id was renamed',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' differ from the pre-migration snapshot',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Bak_BudgetProjectKey_OpIds AS s
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Budgets AS b WHERE b.ProjectId = s.ProjectId)
  UNION ALL
  SELECT 5, 'No orphaned budget',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets AS b
  WHERE b.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
  UNION ALL
  SELECT 6, 'No orphaned investment analysis',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' orphaned', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses AS a
  WHERE a.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = a.ProjectKey)
  UNION ALL
  SELECT 7, 'Every project with a live budget still has exactly one primary',
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
  SELECT 9, 'No favorite still points at a moved project id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' stale entries',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Users AS u
  CROSS APPLY OPENJSON(CASE WHEN ISJSON(u.SettingsDoc) = 1 THEN u.SettingsDoc ELSE N'{}' END,
                       '$.favorites.project') AS j
  WHERE j.value IN ('OP-0003','OP-0005','OP-0006','OP-0007')
  UNION ALL
  SELECT 10, 'No project activity row still points at a moved id',
         CAST(COUNT(*) AS NVARCHAR(20)) + ' stale rows',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.UserActivity
  WHERE EntityType = 'project' AND EntityId IN ('OP-0003','OP-0005','OP-0006','OP-0007')
) AS v
ORDER BY Ord;

-- The project index in its final shape, beside the budgets it now matches.
SELECT p.ProjectId, p.PrimaryBudgetId, m.OldProjectId AS OriginallyKeyedAs,
       p.Name, p.Status,
       (SELECT COUNT(*) FROM dbo.Budgets b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0) AS Budgets,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS Analyses
FROM dbo.Projects AS p
LEFT JOIN dbo.ProjectIdMap AS m ON m.NewProjectId = p.ProjectId
ORDER BY p.ProjectId;
