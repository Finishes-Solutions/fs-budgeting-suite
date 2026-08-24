-- ============================================================================
--  Migration — Projects, budget alternates, and guard-rail summaries
--
--  NOTE ON COMMENT STYLE, and it is not cosmetic: this file uses only `--`
--  line comments, like every other migration here. SQL Server treats a `--`
--  INSIDE a block comment as a line comment running to end of line, so a
--  closing marker sitting on a line of dashes gets swallowed and the whole
--  batch fails with "Missing end comment mark". Do not reintroduce block
--  comments in these scripts.
--  ----------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-bd-budget database that serves EVERY
--           environment including production.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : any time. The deploy that needs these columns tolerates their
--           absence (api/shared/schema.js probes for them), so running this
--           before OR after the release is safe. Nothing here is destructive.
--
--  Idempotent: every statement is existence-guarded, so re-running is a no-op.
--  Wrapped in one transaction with XACT_ABORT ON — a failure rolls the whole
--  thing back rather than leaving the schema half-migrated.
--
--  Statements that reference a column this same batch adds go through
--  sp_executesql, because SQL Server binds column names when it compiles the
--  batch, not when it runs the statement.
--
--  WHAT IT DOES
--    1. dbo.Projects            — the new parent. Its primary key is what
--                                 enforces "one project per ID".
--    2. Budgets.ProjectKey      — which project a budget belongs to.
--    3. InvestmentAnalyses.ProjectKey — the same, for the roll-up.
--    4. Guard-rail summary columns on Budgets and BudgetVersions.
--    5. Widened ID check so a project can carry alternate budgets
--       (BD-0001, BD-0001-02, BD-0001-03 …).
--    6. Backfill: one project per distinct suffix-stripped budget id, with the
--       budget's own name/address/type and a conservatively mapped status.
--
--  WHAT IT DOES NOT DO
--    Nothing is re-keyed. dbo.Budgets keeps ProjectId as its primary key, and
--    the SovLines / BudgetVersions / InvestmentAnalyses foreign keys are
--    untouched. No row is deleted and no existing column changes type.
--
--  Sections: PREFLIGHT (read-only) → MIGRATION → VERIFICATION.
--  ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- ---------------------------------------------------------------------------
--  1 · PREFLIGHT — read-only. Run this on its own first and read the output.
--  ---------------------------------------------------------------------------
PRINT '=== PREFLIGHT ===';

SELECT 'Budgets (active)'          AS Item, COUNT(*) AS N FROM dbo.Budgets WHERE IsDeleted = 0
UNION ALL SELECT 'Budgets (deleted)',        COUNT(*) FROM dbo.Budgets WHERE IsDeleted = 1
UNION ALL SELECT 'Investment analyses',      COUNT(*) FROM dbo.InvestmentAnalyses WHERE IsDeleted = 0
UNION ALL SELECT 'Distinct projects to create',
       -- LEN - 3 rather than LEFT(_, 7): a TST- id is one character longer, and
       -- the migration itself strips by length, so the preflight must agree.
       COUNT(DISTINCT CASE WHEN ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
                             OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
                           THEN LEFT(ProjectId, LEN(ProjectId) - 3) ELSE ProjectId END)
       FROM dbo.Budgets
UNION ALL SELECT 'dbo.Projects already exists',
       CASE WHEN OBJECT_ID('dbo.Projects', 'U') IS NULL THEN 0 ELSE 1 END
UNION ALL SELECT 'Budgets.ProjectKey already exists',
       CASE WHEN COL_LENGTH('dbo.Budgets', 'ProjectKey') IS NULL THEN 0 ELSE 1 END
UNION ALL SELECT 'Budgets.GuardrailStatus already exists',
       CASE WHEN COL_LENGTH('dbo.Budgets', 'GuardrailStatus') IS NULL THEN 0 ELSE 1 END;

-- Any budget id that does not match the widened format would fail the new
-- check constraint. Expect zero rows. If this returns anything, STOP and fix
-- those ids before running section 2.
SELECT ProjectId AS UnexpectedBudgetId
FROM dbo.Budgets
WHERE ProjectId NOT LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
  AND ProjectId NOT LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
  AND ProjectId NOT LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  AND ProjectId NOT LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]';

-- ---------------------------------------------------------------------------
--  2 · MIGRATION
--  ---------------------------------------------------------------------------
BEGIN TRANSACTION;
BEGIN TRY

  ------------------------------------------------------------------ 2.1 Projects
  IF OBJECT_ID('dbo.Projects', 'U') IS NULL
  BEGIN
    PRINT 'Creating dbo.Projects';
    CREATE TABLE dbo.Projects (
        ProjectId       VARCHAR(16)    NOT NULL,   -- OP-#### / BD-#### / AS-#### / TST-####
        Name            NVARCHAR(200)  NOT NULL CONSTRAINT DF_Projects_Name     DEFAULT (N''),
        Address         NVARCHAR(300)  NOT NULL CONSTRAINT DF_Projects_Address  DEFAULT (N''),
        Type            NVARCHAR(50)   NOT NULL CONSTRAINT DF_Projects_Type     DEFAULT (N'Multifamily'),
        -- Lead / Qualified / Budgeting / Proposal Sent / Awarded /
        -- Converted to Project / On Hold / Lost. Deliberately NOT constrained
        -- to a list: the app owns the vocabulary, and a CHECK here would need
        -- a migration every time a status is added.
        Status          NVARCHAR(40)   NOT NULL CONSTRAINT DF_Projects_Status   DEFAULT (N'Lead'),
        PrimaryBudgetId VARCHAR(16)    NULL,       -- which budget is "the" budget
        -- Stamped when Status becomes 'Converted to Project'. Contract and
        -- project amounts are SNAPSHOTS taken at that moment, not a live join:
        -- a budget edited after conversion must not restate reported backlog.
        ConvertedAt     DATETIME2      NULL,
        ContractAmount  DECIMAL(18,2)  NULL,
        ProjectAmount   DECIMAL(18,2)  NULL,
        Notes           NVARCHAR(2000) NOT NULL CONSTRAINT DF_Projects_Notes    DEFAULT (N''),
        CreatedById     NVARCHAR(128)  NULL,
        CreatedByName   NVARCHAR(200)  NULL,
        CreatedAt       DATETIME2      NOT NULL CONSTRAINT DF_Projects_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt       DATETIME2      NOT NULL CONSTRAINT DF_Projects_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        -- Soft delete only, matching dbo.Budgets. The app never removes a row.
        IsDeleted       BIT            NOT NULL CONSTRAINT DF_Projects_IsDeleted DEFAULT (0),
        DeletedAt       DATETIME2      NULL,
        CONSTRAINT PK_Projects PRIMARY KEY (ProjectId)
    );
    CREATE INDEX IX_Projects_Status_Updated ON dbo.Projects (Status, UpdatedAt DESC) WHERE IsDeleted = 0;
    CREATE INDEX IX_Projects_Converted ON dbo.Projects (ConvertedAt DESC)
      INCLUDE (ContractAmount, ProjectAmount) WHERE IsDeleted = 0;
  END
  ELSE PRINT 'dbo.Projects already present — skipped';

  ------------------------------------------------- 2.2 Budgets.ProjectKey
  IF COL_LENGTH('dbo.Budgets', 'ProjectKey') IS NULL
  BEGIN
    PRINT 'Adding dbo.Budgets.ProjectKey';
    ALTER TABLE dbo.Budgets ADD ProjectKey VARCHAR(16) NULL;
  END

  ------------------------------ 2.3 InvestmentAnalyses.ProjectKey
  IF COL_LENGTH('dbo.InvestmentAnalyses', 'ProjectKey') IS NULL
  BEGIN
    PRINT 'Adding dbo.InvestmentAnalyses.ProjectKey';
    ALTER TABLE dbo.InvestmentAnalyses ADD ProjectKey VARCHAR(16) NULL;
  END

  ------------------------------------------ 2.4 Guard-rail summary columns
  IF COL_LENGTH('dbo.Budgets', 'GuardrailStatus') IS NULL
  BEGIN
    PRINT 'Adding guard-rail columns to dbo.Budgets';
    ALTER TABLE dbo.Budgets ADD
      GuardrailStatus      VARCHAR(10) NULL,   -- ok | warn | breach
      GuardrailBreachCount INT         NULL;
  END

  IF COL_LENGTH('dbo.BudgetVersions', 'GuardrailStatus') IS NULL
  BEGIN
    PRINT 'Adding guard-rail columns to dbo.BudgetVersions';
    ALTER TABLE dbo.BudgetVersions ADD
      GuardrailStatus      VARCHAR(10) NULL,
      GuardrailBreachCount INT         NULL;
  END

  ----------------------------------- 2.5 Widen the budget id format
  -- A project's alternates are BD-0001-02, BD-0001-03 … The base budget keeps
  -- its plain id, so nothing existing is renamed.
  IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Budgets_IdFormat')
  BEGIN
    PRINT 'Adding CK_Budgets_IdFormat (allows -NN budget alternates)';
    ALTER TABLE dbo.Budgets WITH NOCHECK ADD CONSTRAINT CK_Budgets_IdFormat CHECK (
      ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]');
  END

  IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Projects_IdFormat')
  BEGIN
    -- A project id never carries an alternate suffix — that is what makes it
    -- the parent.
    ALTER TABLE dbo.Projects ADD CONSTRAINT CK_Projects_IdFormat CHECK (
      ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]');
  END

  ------------------------------------------------------- 2.6 Backfill
  -- sp_executesql throughout: ProjectKey is added by this same batch, so a
  -- direct reference would fail to compile before it exists.
  PRINT 'Backfilling dbo.Projects from existing budgets';
  EXEC sp_executesql N'
    INSERT INTO dbo.Projects (ProjectId, Name, Address, Type, Status,
                              PrimaryBudgetId, CreatedById, CreatedByName, CreatedAt, UpdatedAt)
    SELECT src.ProjectKey,
           ISNULL(MAX(src.Name), N''''),
           -- JSON_VALUE returns NULL when the document has no address, and
           -- Projects.Address is NOT NULL — an explicit NULL bypasses the
           -- column default and would fail the whole insert.
           ISNULL(MAX(src.Address), N''''),
           ISNULL(MAX(src.Type), N''Multifamily''),
           -- Conservative mapping. Nothing is auto-declared converted: that is
           -- a decision a person makes, and it snapshots money when they make it.
           CASE MAX(src.StatusRank)
             WHEN 4 THEN N''Awarded''
             WHEN 3 THEN N''Proposal Sent''
             WHEN 1 THEN N''Lost''
             ELSE N''Lead''
           END,
           MIN(src.ProjectId),
           MAX(src.CreatedById), MAX(src.CreatedByName),
           MIN(src.CreatedAt), MAX(src.UpdatedAt)
    FROM (
      SELECT b.ProjectId,
             CASE WHEN b.ProjectId LIKE ''[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]''
                    OR b.ProjectId LIKE ''[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]''
                  THEN LEFT(b.ProjectId, LEN(b.ProjectId) - 3)
                  ELSE b.ProjectId END AS ProjectKey,
             b.Name, b.Type, b.CreatedById, b.CreatedByName, b.CreatedAt, b.UpdatedAt,
             CAST(JSON_VALUE(b.Doc, ''$.address'') AS NVARCHAR(300)) AS Address,
             CASE b.Status WHEN N''Completed'' THEN 4 WHEN N''Finalized'' THEN 4
                           WHEN N''In Review'' THEN 3 WHEN N''Cancelled'' THEN 1
                           ELSE 2 END AS StatusRank
      FROM dbo.Budgets AS b
      WHERE b.IsDeleted = 0
    ) AS src
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = src.ProjectKey)
    GROUP BY src.ProjectKey;';

  PRINT 'Linking budgets to their project';
  EXEC sp_executesql N'
    UPDATE b SET ProjectKey =
      CASE WHEN b.ProjectId LIKE ''[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]''
             OR b.ProjectId LIKE ''[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]''
           THEN LEFT(b.ProjectId, LEN(b.ProjectId) - 3)
           ELSE b.ProjectId END
    FROM dbo.Budgets AS b
    WHERE b.ProjectKey IS NULL;';

  PRINT 'Linking investment analyses to their project';
  EXEC sp_executesql N'
    UPDATE a SET ProjectKey =
      CASE WHEN a.ProjectId LIKE ''[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]''
             OR a.ProjectId LIKE ''[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]''
           THEN LEFT(a.ProjectId, LEN(a.ProjectId) - 3)
           ELSE a.ProjectId END
    FROM dbo.InvestmentAnalyses AS a
    WHERE a.ProjectId IS NOT NULL AND a.ProjectKey IS NULL;';

  -- Deleted budgets get a project row too, so restoring one has a parent to
  -- come back to. Only creates what the active pass missed.
  EXEC sp_executesql N'
    INSERT INTO dbo.Projects (ProjectId, Name, Type, Status)
    SELECT DISTINCT b.ProjectKey, ISNULL(MAX(b.Name), N''''), ISNULL(MAX(b.Type), N''Multifamily''), N''Lead''
    FROM dbo.Budgets AS b
    WHERE b.ProjectKey IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
    GROUP BY b.ProjectKey;';

  ------------------------------------------------ 2.7 Foreign keys, last
  -- Added after the backfill so no existing row can violate them.
  IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Budgets_Project')
  BEGIN
    PRINT 'Adding FK_Budgets_Project';
    EXEC sp_executesql N'ALTER TABLE dbo.Budgets ADD CONSTRAINT FK_Budgets_Project
      FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);';
  END

  IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InvestmentAnalyses_Project')
  BEGIN
    PRINT 'Adding FK_InvestmentAnalyses_Project';
    EXEC sp_executesql N'ALTER TABLE dbo.InvestmentAnalyses ADD CONSTRAINT FK_InvestmentAnalyses_Project
      FOREIGN KEY (ProjectKey) REFERENCES dbo.Projects (ProjectId);';
  END

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_ProjectKey')
    EXEC sp_executesql N'CREATE INDEX IX_Budgets_ProjectKey ON dbo.Budgets (ProjectKey)
      INCLUDE (Name, Status, ContractSum, ProjectCost) WHERE IsDeleted = 0;';

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvestmentAnalyses_ProjectKey')
    EXEC sp_executesql N'CREATE INDEX IX_InvestmentAnalyses_ProjectKey
      ON dbo.InvestmentAnalyses (ProjectKey, UpdatedAt DESC) WHERE IsDeleted = 0;';

  COMMIT TRANSACTION;
  PRINT '=== MIGRATION COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== MIGRATION ROLLED BACK ===';
  THROW;
END CATCH;

-- ---------------------------------------------------------------------------
--  3 · VERIFICATION — one result set, because the portal exports only one.
--      Every row must read PASS.
--  ---------------------------------------------------------------------------
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'dbo.Projects exists' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(50)) + ' project rows' AS Detail,
         CASE WHEN OBJECT_ID('dbo.Projects','U') IS NOT NULL THEN 1 ELSE 0 END AS Pass
  FROM dbo.Projects
  UNION ALL
  SELECT 2, 'Every active budget has a ProjectKey',
         CAST(COUNT(*) AS NVARCHAR(50)) + ' unlinked',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets WHERE IsDeleted = 0 AND ProjectKey IS NULL
  UNION ALL
  SELECT 3, 'Every linked analysis has a ProjectKey',
         CAST(COUNT(*) AS NVARCHAR(50)) + ' unlinked',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.InvestmentAnalyses WHERE IsDeleted = 0 AND ProjectId IS NOT NULL AND ProjectKey IS NULL
  UNION ALL
  SELECT 4, 'Guard-rail columns present on Budgets', 'GuardrailStatus + GuardrailBreachCount',
         CASE WHEN COL_LENGTH('dbo.Budgets','GuardrailStatus') IS NOT NULL
               AND COL_LENGTH('dbo.Budgets','GuardrailBreachCount') IS NOT NULL THEN 1 ELSE 0 END
  UNION ALL
  SELECT 5, 'Guard-rail columns present on BudgetVersions', 'GuardrailStatus + GuardrailBreachCount',
         CASE WHEN COL_LENGTH('dbo.BudgetVersions','GuardrailStatus') IS NOT NULL
               AND COL_LENGTH('dbo.BudgetVersions','GuardrailBreachCount') IS NOT NULL THEN 1 ELSE 0 END
  UNION ALL
  SELECT 6, 'Foreign keys in place', 'FK_Budgets_Project + FK_InvestmentAnalyses_Project',
         CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_Budgets_Project')
               AND EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_InvestmentAnalyses_Project')
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 7, 'No orphan budgets',
         CAST(COUNT(*) AS NVARCHAR(50)) + ' budgets pointing at a missing project',
         CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
  FROM dbo.Budgets AS b
  WHERE b.ProjectKey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.Projects AS p WHERE p.ProjectId = b.ProjectKey)
  UNION ALL
  SELECT 8, 'One project per ID', 'PK_Projects enforces it',
         CASE WHEN EXISTS (SELECT 1 FROM sys.key_constraints WHERE name='PK_Projects') THEN 1 ELSE 0 END
) AS v
ORDER BY Ord;
