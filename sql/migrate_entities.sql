-- ============================================================================
--  Migration — Entity Master, and the Project Entity link
--
--  NOTE ON COMMENT STYLE, and it is not cosmetic: this file uses only `--`
--  line comments, like every other migration here. SQL Server treats a `--`
--  INSIDE a block comment as a line comment running to end of line, so a
--  closing marker on a line of dashes gets swallowed and the whole batch fails
--  with "Missing end comment mark". Do not reintroduce block comments.
--  ----------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-bd-budget database that serves EVERY
--           environment including production.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : any time. The deploy that needs these tolerates their absence
--           (api/shared/schema.js probes entitiesTable / projectsEntityId), so
--           running this before OR after the release is safe. Nothing is
--           destructive.
--
--  Idempotent: every statement is existence-guarded, so re-running is a no-op.
--  Wrapped in one transaction with XACT_ABORT ON.
--
--  WHAT IT DOES
--    1. dbo.Entities            — the structured Entity Master. Legal entities
--                                 and the six Finishes operating companies.
--    2. Entities seed           — the six Finishes companies, IsFinishesCompany.
--    3. Projects.EntityId       — which legal entity a project belongs to.
--
--  WHAT IT DOES NOT DO
--    Nothing existing is re-keyed, renamed or deleted. Projects.EntityId is
--    nullable — a project without an entity is valid, as every project is today.
--
--  Sections: PREFLIGHT (read-only) → MIGRATION → VERIFICATION.
--  ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- ---------------------------------------------------------------------------
--  1 · PREFLIGHT — read-only. Run this on its own first and read the output.
--  ---------------------------------------------------------------------------
PRINT '=== PREFLIGHT ===';

SELECT 'dbo.Entities already exists' AS Item,
       CASE WHEN OBJECT_ID('dbo.Entities','U') IS NULL THEN 0 ELSE 1 END AS N
UNION ALL SELECT 'Projects.EntityId already exists',
       CASE WHEN COL_LENGTH('dbo.Projects','EntityId') IS NULL THEN 0 ELSE 1 END
UNION ALL SELECT 'dbo.Projects exists (required)',
       CASE WHEN OBJECT_ID('dbo.Projects','U') IS NULL THEN 0 ELSE 1 END;

-- Projects must exist first (sql/migrate_projects_and_guardrails.sql). Stop if not.
IF OBJECT_ID('dbo.Projects','U') IS NULL
  THROW 50010, 'dbo.Projects is missing — run migrate_projects_and_guardrails.sql first.', 1;

-- ---------------------------------------------------------------------------
--  2 · MIGRATION
--  ---------------------------------------------------------------------------
BEGIN TRANSACTION;
BEGIN TRY

  ------------------------------------------------------------------ 2.1 Entities
  IF OBJECT_ID('dbo.Entities', 'U') IS NULL
  BEGIN
    PRINT 'Creating dbo.Entities';
    CREATE TABLE dbo.Entities (
        EntityId    INT IDENTITY(1,1) NOT NULL,
        -- A stable slug ('finishes-solutions'), so budgets and templates can
        -- name an entity by a key that never changes even if the legal name is
        -- corrected. This is what doc.companies[].entityKey points at.
        EntityKey   VARCHAR(64)   NOT NULL,
        LegalName   NVARCHAR(300) NOT NULL,
        DisplayName NVARCHAR(200) NOT NULL,
        EntityType  NVARCHAR(50)  NOT NULL CONSTRAINT DF_Entities_Type    DEFAULT (N'LLC'),
        Address     NVARCHAR(300) NOT NULL CONSTRAINT DF_Entities_Address DEFAULT (N''),
        -- The six Finishes operating companies that participate in contracts.
        -- Everything else is a project (owner) entity.
        IsFinishesCompany BIT     NOT NULL CONSTRAINT DF_Entities_Fin     DEFAULT (0),
        -- Master data is deactivated, never deleted (the template precedent):
        -- an entity referenced by a project or contract must not vanish.
        IsActive    BIT           NOT NULL CONSTRAINT DF_Entities_Active  DEFAULT (1),
        CreatedById NVARCHAR(128) NULL,
        CreatedByName NVARCHAR(200) NULL,
        CreatedAt   DATETIME2     NOT NULL CONSTRAINT DF_Entities_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt   DATETIME2     NOT NULL CONSTRAINT DF_Entities_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_Entities PRIMARY KEY (EntityId),
        CONSTRAINT UQ_Entities_Key UNIQUE (EntityKey),
        CONSTRAINT CK_Entities_Key CHECK (EntityKey NOT LIKE '%[^a-z0-9-]%')
    );
    CREATE INDEX IX_Entities_Active ON dbo.Entities (IsActive, DisplayName);
  END
  ELSE PRINT 'dbo.Entities already present — skipped';

  ------------------------------------------------- 2.2 Seed the Finishes companies
  -- Idempotent per key. The Finishes Solutions LegalName is exactly
  -- 'Finishes Solutions LLC' so a legacy free-text doc.companies entry lifts
  -- onto this row by name (FSBudgetFinance.slugify) without a data migration.
  PRINT 'Seeding the six Finishes companies';
  ;WITH seed(EntityKey, LegalName, DisplayName) AS (
    SELECT 'finishes-solutions',    N'Finishes Solutions LLC',    N'Finishes Solutions'
    UNION ALL SELECT 'finishes-construction', N'Finishes Construction LLC', N'Finishes Construction'
    UNION ALL SELECT 'finishes-development',  N'Finishes Development LLC',  N'Finishes Development'
    UNION ALL SELECT 'finishes-marketing',    N'Finishes Marketing LLC',    N'Finishes Marketing'
    UNION ALL SELECT 'brokerage',             N'Finishes Brokerage LLC',    N'Brokerage'
    UNION ALL SELECT 'property-management',   N'Finishes Property Management LLC', N'Property Management'
  )
  INSERT INTO dbo.Entities (EntityKey, LegalName, DisplayName, EntityType, IsFinishesCompany, IsActive)
  SELECT s.EntityKey, s.LegalName, s.DisplayName, N'LLC', 1, 1
  FROM seed AS s
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Entities AS e WHERE e.EntityKey = s.EntityKey);

  ------------------------------------------------- 2.3 Projects.EntityId + FK
  IF COL_LENGTH('dbo.Projects', 'EntityId') IS NULL
  BEGIN
    PRINT 'Adding dbo.Projects.EntityId';
    ALTER TABLE dbo.Projects ADD EntityId INT NULL;
  END

  IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Projects_Entity')
  BEGIN
    PRINT 'Adding FK_Projects_Entity';
    EXEC sp_executesql N'ALTER TABLE dbo.Projects ADD CONSTRAINT FK_Projects_Entity
      FOREIGN KEY (EntityId) REFERENCES dbo.Entities (EntityId);';
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
--  3 · VERIFICATION — one result set, because the portal exports only one.
--      Every row must read PASS.
--  ---------------------------------------------------------------------------
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'dbo.Entities exists' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(50)) + ' entity rows' AS Detail,
         CASE WHEN OBJECT_ID('dbo.Entities','U') IS NOT NULL THEN 1 ELSE 0 END AS Pass
  FROM dbo.Entities
  UNION ALL
  SELECT 2, 'Six Finishes companies seeded',
         CAST(COUNT(*) AS NVARCHAR(50)) + ' Finishes companies',
         CASE WHEN COUNT(*) = 6 THEN 1 ELSE 0 END
  FROM dbo.Entities WHERE IsFinishesCompany = 1
  UNION ALL
  SELECT 3, 'Finishes Solutions legal name matches the seeded default',
         ISNULL(MAX(LegalName), N'(missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM dbo.Entities
                           WHERE EntityKey = 'finishes-solutions'
                             AND LegalName = N'Finishes Solutions LLC') THEN 1 ELSE 0 END
  FROM dbo.Entities WHERE EntityKey = 'finishes-solutions'
  UNION ALL
  SELECT 4, 'Projects.EntityId present', 'nullable FK to dbo.Entities',
         CASE WHEN COL_LENGTH('dbo.Projects','EntityId') IS NOT NULL THEN 1 ELSE 0 END
  UNION ALL
  SELECT 5, 'FK_Projects_Entity in place', 'Projects.EntityId -> Entities.EntityId',
         CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_Projects_Entity') THEN 1 ELSE 0 END
  UNION ALL
  SELECT 6, 'EntityKey is unique', 'UQ_Entities_Key',
         CASE WHEN EXISTS (SELECT 1 FROM sys.key_constraints WHERE name='UQ_Entities_Key') THEN 1 ELSE 0 END
) AS v
ORDER BY Ord;
