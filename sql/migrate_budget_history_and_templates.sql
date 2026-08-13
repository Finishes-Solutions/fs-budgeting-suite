-- ============================================================================
-- Finishes Solutions — BD Budgeting
-- Migration: budget version history, admin-managed budget templates,
--            and recoverable (soft) whole-budget deletion.
--
-- Target   : the live Azure SQL database (fs-bd-budget). Run as admin.
-- Idempotent: yes — every object and column is guarded on existence, the
--            baseline backfill only touches budgets that have no version yet,
--            and the template seed only runs when the multifamily template has
--            no published version. Rerunning is a no-op.
-- Atomic   : the migration section runs under SET XACT_ABORT ON inside one
--            explicit transaction; any failure rolls the whole thing back.
--
-- WHAT IT DOES
--   1. Creates dbo.BudgetTemplates and dbo.BudgetTemplateVersions.
--   2. Adds soft-delete columns to dbo.Budgets (IsDeleted, DeletedAt).
--      Guarded per column: fragments of an earlier standalone soft-delete
--      script may or may not have been applied — either way this succeeds.
--   3. Adds template provenance to dbo.Budgets (TemplateKey, TemplateVersionId,
--      both nullable). Existing budgets are NOT assigned a template: provenance
--      means "created from this template version", which cannot be established
--      reliably for pre-migration budgets, so it stays NULL for them.
--   4. Adds LineKey / LineOrder to dbo.SovLines. LineOrder is backfilled
--      deterministically from the current row order (Id per project); LineKey
--      stays NULL for existing rows (old docs carry no stable line IDs to
--      match against). Future saves (Phase 2 API) populate both.
--   5. Creates dbo.BudgetVersions and dbo.BudgetVersionSovLines.
--   6. Seeds the 'multifamily' template: version 1 is built from the CURRENT
--      dbo.PricingLibrary document (line rates) plus the application's
--      built-in Multifamily defaults (unit mix, other income, operating
--      expenses, companies, contingency, project costs — copied from
--      app/index.html blankDoc()/DEFAULT_* as of this commit). It reproduces
--      today's new-Multifamily-budget behavior. Older pricing-library versions
--      are NOT imported as historical template versions: they contain only
--      line rates, and fabricating the rest of the defaults they never had
--      would be invented history. dbo.PricingLibrary is preserved untouched.
--   7. Baseline backfill: every existing budget (including soft-deleted ones)
--      gets Version 1 — a copy of its current Doc, metadata, totals and
--      SovLines — timestamped with the budget's own UpdatedAt. No earlier
--      history is fabricated; reruns create no duplicates.
--
-- CONTENT HASHES
--   ContentHash on version rows is SHA-256 (lowercase hex) computed by the
--   database over the stored Doc string (UTF-16, as NVARCHAR is stored).
--   Application-created versions (Phase 2) hash canonicalized UTF-8 JSON, so
--   migration-era hashes will not match app-computed hashes for the same
--   content; the Phase 2 save path treats normalized-content comparison as
--   the fallback for exactly these baseline rows.
--
-- DELETION MODEL (decided 2026-08-12)
--   Whole-budget deletion becomes a soft delete: the API (Phase 2) flags
--   IsDeleted instead of deleting rows, history survives, and PUT on a
--   soft-deleted ProjectId restores it. In-app hard delete no longer exists;
--   sql/purge_deleted_budgets.sql is the separate admin-run hard purge.
--   The foreign key from dbo.BudgetVersions to dbo.Budgets is deliberately
--   NO ACTION (not ON DELETE CASCADE): nothing in the app deletes the parent
--   row anymore, and the purge script deletes child-first explicitly.
--
--   ⚠ INTERIM BEHAVIOR, until the Phase 2 API deploys: the current
--   DELETE /api/budget/{id} still tries to hard-delete the budget row, which
--   the new foreign key now blocks for any budget with history — the delete
--   button will return an error instead of destroying data. That is
--   deliberate (fail loud, lose nothing) and clears when Phase 2 ships.
--
-- RUN ORDER (live database)
--   1. Run this file. Section 1 (preflight) and Section 3 (verification) are
--      read-only; Section 2 is the migration itself.
--   2. Then run sql/views.sql (its views read the soft-delete columns).
--
-- RUN ORDER (fresh install)
--   schema.sql → seed_pricing.sql → this file (creates nothing new, but seeds
--   the multifamily template; the backfill is a no-op) → views.sql.
--
-- The file has three GO-separated sections. SSMS and Azure Data Studio run it
-- whole. If the Azure portal Query Editor rejects GO, run each section as its
-- own query — the section banners mark the boundaries.
-- ============================================================================


-- ////////////////////////////////////////////////////////////////////////////
-- SECTION 1 — PREFLIGHT (read-only; run before migrating and keep the output)
-- ////////////////////////////////////////////////////////////////////////////
SET NOCOUNT ON;

-- 1a. Which objects and columns already exist. The two soft-delete columns may
--     legitimately show EXISTS if the earlier standalone fragment was applied.
SELECT * FROM (VALUES
  ('table  dbo.BudgetTemplates',        IIF(OBJECT_ID('dbo.BudgetTemplates','U')         IS NULL, 'missing', 'EXISTS')),
  ('table  dbo.BudgetTemplateVersions', IIF(OBJECT_ID('dbo.BudgetTemplateVersions','U')  IS NULL, 'missing', 'EXISTS')),
  ('table  dbo.BudgetVersions',         IIF(OBJECT_ID('dbo.BudgetVersions','U')          IS NULL, 'missing', 'EXISTS')),
  ('table  dbo.BudgetVersionSovLines',  IIF(OBJECT_ID('dbo.BudgetVersionSovLines','U')   IS NULL, 'missing', 'EXISTS')),
  ('column dbo.Budgets.IsDeleted',          IIF(COL_LENGTH('dbo.Budgets','IsDeleted')         IS NULL, 'missing', 'EXISTS')),
  ('column dbo.Budgets.DeletedAt',          IIF(COL_LENGTH('dbo.Budgets','DeletedAt')         IS NULL, 'missing', 'EXISTS')),
  ('column dbo.Budgets.TemplateKey',        IIF(COL_LENGTH('dbo.Budgets','TemplateKey')       IS NULL, 'missing', 'EXISTS')),
  ('column dbo.Budgets.TemplateVersionId',  IIF(COL_LENGTH('dbo.Budgets','TemplateVersionId') IS NULL, 'missing', 'EXISTS')),
  ('column dbo.SovLines.LineKey',           IIF(COL_LENGTH('dbo.SovLines','LineKey')          IS NULL, 'missing', 'EXISTS')),
  ('column dbo.SovLines.LineOrder',         IIF(COL_LENGTH('dbo.SovLines','LineOrder')        IS NULL, 'missing', 'EXISTS'))
) AS v(ObjectChecked, State);

-- 1b. Baseline counts and totals. Record these — Section 3 re-prints the same
--     numbers and they must be unchanged by the migration.
SELECT
  (SELECT COUNT(*)                 FROM dbo.Budgets)                              AS Budgets,
  (SELECT COUNT(*)                 FROM dbo.Budgets WHERE ProjectId LIKE 'TST-%') AS TestBudgets,
  (SELECT ISNULL(SUM(ContractSum),0) FROM dbo.Budgets)                            AS SumContractSum,
  (SELECT ISNULL(SUM(ProjectCost),0) FROM dbo.Budgets)                            AS SumProjectCost,
  (SELECT COUNT(*)                 FROM dbo.SovLines)                             AS SovLines,
  (SELECT ISNULL(SUM(Total),0)     FROM dbo.SovLines)                             AS SumSovTotal,
  (SELECT COUNT(*)                 FROM dbo.Budgets WHERE ISJSON(Doc) <> 1)       AS BudgetsWithBadJson; -- expect 0

-- 1c. Pricing library state. The template seed uses the IsCurrent = 1 row
--     (falling back to the newest by Effective). At least one row must exist.
SELECT Version, Effective, IsCurrent, CreatedAt, LEN(Doc) AS DocChars
FROM dbo.PricingLibrary
ORDER BY IsCurrent DESC, Effective DESC, CreatedAt DESC;
GO


-- ////////////////////////////////////////////////////////////////////////////
-- SECTION 2 — MIGRATION (one transaction; all-or-nothing)
-- ////////////////////////////////////////////////////////////////////////////
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
BEGIN TRANSACTION;

------------------------------------------------------------------------------
-- 2.1 dbo.BudgetTemplates — stable identity and metadata per template
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.BudgetTemplates','U') IS NULL
BEGIN
  CREATE TABLE dbo.BudgetTemplates (
    TemplateKey   VARCHAR(64)    NOT NULL,  -- immutable, URL-safe (lowercase letters, digits, hyphens)
    Name          NVARCHAR(200)  NOT NULL,
    BudgetType    NVARCHAR(50)   NOT NULL,
    Description   NVARCHAR(1000) NOT NULL CONSTRAINT DF_BudgetTemplates_Description DEFAULT (N''),
    IsActive      BIT            NOT NULL CONSTRAINT DF_BudgetTemplates_IsActive    DEFAULT (1),
    CreatedById   NVARCHAR(128)  NULL,      -- SWA principal.userId; NULL for local dev / migration
    CreatedByName NVARCHAR(200)  NULL,
    CreatedAt     DATETIME2      NOT NULL CONSTRAINT DF_BudgetTemplates_CreatedAt   DEFAULT (SYSUTCDATETIME()),
    UpdatedAt     DATETIME2      NOT NULL CONSTRAINT DF_BudgetTemplates_UpdatedAt   DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_BudgetTemplates PRIMARY KEY (TemplateKey),
    CONSTRAINT CK_BudgetTemplates_KeyFormat CHECK (
      TemplateKey <> '' AND TemplateKey NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_100_BIN2)
  );
  CREATE INDEX IX_BudgetTemplates_Active ON dbo.BudgetTemplates (IsActive) INCLUDE (Name, BudgetType);
  PRINT 'Created dbo.BudgetTemplates';
END

------------------------------------------------------------------------------
-- 2.2 dbo.BudgetTemplateVersions — immutable published template versions
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.BudgetTemplateVersions','U') IS NULL
BEGIN
  CREATE TABLE dbo.BudgetTemplateVersions (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    TemplateKey           VARCHAR(64)    NOT NULL,
    VersionNumber         INT            NOT NULL,
    VersionLabel          NVARCHAR(100)  NULL,
    IsCurrent             BIT            NOT NULL CONSTRAINT DF_BudgetTemplateVersions_IsCurrent DEFAULT (0),
    TemplateSchemaVersion INT            NOT NULL CONSTRAINT DF_BudgetTemplateVersions_Schema    DEFAULT (1),
    PricingVersion        NVARCHAR(32)   NULL,
    Doc                   NVARCHAR(MAX)  NOT NULL,  -- complete new-budget template JSON
    ContentHash           CHAR(64)       NOT NULL,  -- SHA-256 hex; see header for hashing convention
    ChangeSummary         NVARCHAR(1000) NULL,
    CreatedById           NVARCHAR(128)  NULL,
    CreatedByName         NVARCHAR(200)  NULL,
    CreatedAt             DATETIME2      NOT NULL CONSTRAINT DF_BudgetTemplateVersions_CreatedAt DEFAULT (SYSUTCDATETIME()),
    PublishedAt           DATETIME2      NULL,
    CONSTRAINT PK_BudgetTemplateVersions PRIMARY KEY (Id),
    CONSTRAINT FK_BudgetTemplateVersions_Template FOREIGN KEY (TemplateKey) REFERENCES dbo.BudgetTemplates (TemplateKey),
    CONSTRAINT UQ_BudgetTemplateVersions_Version UNIQUE (TemplateKey, VersionNumber),
    CONSTRAINT CK_BudgetTemplateVersions_Doc     CHECK (ISJSON(Doc) = 1),
    CONSTRAINT CK_BudgetTemplateVersions_Number  CHECK (VersionNumber >= 1)
  );
  -- at most one current version per template — publishing flips this atomically
  CREATE UNIQUE INDEX UX_BudgetTemplateVersions_Current
    ON dbo.BudgetTemplateVersions (TemplateKey) WHERE IsCurrent = 1;
  CREATE INDEX IX_BudgetTemplateVersions_Template_VersionDesc
    ON dbo.BudgetTemplateVersions (TemplateKey, VersionNumber DESC);
  PRINT 'Created dbo.BudgetTemplateVersions';
END

------------------------------------------------------------------------------
-- 2.3 dbo.Budgets — soft delete + template provenance (guarded per column)
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Budgets','IsDeleted') IS NULL
BEGIN
  ALTER TABLE dbo.Budgets ADD IsDeleted BIT NOT NULL CONSTRAINT DF_Budgets_IsDeleted DEFAULT (0);
  PRINT 'Added dbo.Budgets.IsDeleted';
END
IF COL_LENGTH('dbo.Budgets','DeletedAt') IS NULL
BEGIN
  ALTER TABLE dbo.Budgets ADD DeletedAt DATETIME2 NULL;
  PRINT 'Added dbo.Budgets.DeletedAt';
END
IF COL_LENGTH('dbo.Budgets','TemplateKey') IS NULL
BEGIN
  ALTER TABLE dbo.Budgets ADD TemplateKey VARCHAR(64) NULL;
  PRINT 'Added dbo.Budgets.TemplateKey';
END
IF COL_LENGTH('dbo.Budgets','TemplateVersionId') IS NULL
BEGIN
  ALTER TABLE dbo.Budgets ADD TemplateVersionId BIGINT NULL;
  PRINT 'Added dbo.Budgets.TemplateVersionId';
END

-- Constraints and indexes on the new columns go through sp_executesql: a plain
-- statement naming a column added earlier in this same batch fails to compile.
IF OBJECT_ID('dbo.FK_Budgets_TemplateKey','F') IS NULL
  EXEC sp_executesql N'ALTER TABLE dbo.Budgets WITH CHECK
    ADD CONSTRAINT FK_Budgets_TemplateKey FOREIGN KEY (TemplateKey) REFERENCES dbo.BudgetTemplates (TemplateKey);';
IF OBJECT_ID('dbo.FK_Budgets_TemplateVersion','F') IS NULL
  EXEC sp_executesql N'ALTER TABLE dbo.Budgets WITH CHECK
    ADD CONSTRAINT FK_Budgets_TemplateVersion FOREIGN KEY (TemplateVersionId) REFERENCES dbo.BudgetTemplateVersions (Id);';
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_Template' AND object_id = OBJECT_ID('dbo.Budgets'))
  EXEC sp_executesql N'CREATE INDEX IX_Budgets_Template ON dbo.Budgets (TemplateKey, TemplateVersionId);';

------------------------------------------------------------------------------
-- 2.4 dbo.SovLines — stable line identity and persistent order
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.SovLines','LineKey') IS NULL
BEGIN
  ALTER TABLE dbo.SovLines ADD LineKey VARCHAR(64) NULL;
  PRINT 'Added dbo.SovLines.LineKey';
END
IF COL_LENGTH('dbo.SovLines','LineOrder') IS NULL
BEGIN
  ALTER TABLE dbo.SovLines ADD LineOrder INT NULL;
  PRINT 'Added dbo.SovLines.LineOrder';
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_SovLines_Project_LineKey' AND object_id = OBJECT_ID('dbo.SovLines'))
  EXEC sp_executesql N'CREATE UNIQUE INDEX UX_SovLines_Project_LineKey
    ON dbo.SovLines (ProjectId, LineKey) WHERE LineKey IS NOT NULL;';

-- Backfill LineOrder deterministically from today's row order (Id ascending is
-- insertion order — the API writes doc.lines in document order). LineKey stays
-- NULL: pre-migration docs have no line IDs to match safely.
EXEC sp_executesql N'
  WITH ordered AS (
    SELECT Id, LineOrder,
           ROW_NUMBER() OVER (PARTITION BY ProjectId ORDER BY Id) AS rn
    FROM dbo.SovLines
  )
  UPDATE ordered SET LineOrder = rn WHERE LineOrder IS NULL;';
PRINT CONCAT('SovLines.LineOrder backfilled: ', @@ROWCOUNT, ' row(s)');

------------------------------------------------------------------------------
-- 2.5 dbo.BudgetVersions — one immutable snapshot per saved budget version
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.BudgetVersions','U') IS NULL
BEGIN
  CREATE TABLE dbo.BudgetVersions (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    ProjectId             VARCHAR(16)    NOT NULL,
    VersionNumber         INT            NOT NULL,
    Name                  NVARCHAR(200)  NOT NULL CONSTRAINT DF_BudgetVersions_Name   DEFAULT (N''),
    Type                  NVARCHAR(50)   NOT NULL CONSTRAINT DF_BudgetVersions_Type   DEFAULT (N'Multifamily'),
    Status                NVARCHAR(30)   NOT NULL CONSTRAINT DF_BudgetVersions_Status DEFAULT (N'Draft'),
    ContractSum           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_BudgetVersions_CS     DEFAULT (0),
    ProjectCost           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_BudgetVersions_PC     DEFAULT (0),
    PricingVersion        NVARCHAR(32)   NULL,
    TemplateKey           VARCHAR(64)    NULL,
    TemplateVersionId     BIGINT         NULL,
    Doc                   NVARCHAR(MAX)  NOT NULL,  -- complete immutable budget JSON
    ContentHash           CHAR(64)       NOT NULL,
    DocumentSchemaVersion INT            NOT NULL CONSTRAINT DF_BudgetVersions_Schema DEFAULT (1),
    ChangeSummary         NVARCHAR(1000) NULL,
    CreatedById           NVARCHAR(128)  NULL,
    CreatedByName         NVARCHAR(200)  NULL,
    CreatedAt             DATETIME2      NOT NULL CONSTRAINT DF_BudgetVersions_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_BudgetVersions PRIMARY KEY (Id),
    -- NO ACTION by design: in-app deletion soft-flags the budget and never
    -- deletes the parent row; only sql/purge_deleted_budgets.sql removes
    -- history, child-first, inside one transaction.
    CONSTRAINT FK_BudgetVersions_Budget          FOREIGN KEY (ProjectId)         REFERENCES dbo.Budgets (ProjectId),
    CONSTRAINT FK_BudgetVersions_TemplateKey     FOREIGN KEY (TemplateKey)       REFERENCES dbo.BudgetTemplates (TemplateKey),
    CONSTRAINT FK_BudgetVersions_TemplateVersion FOREIGN KEY (TemplateVersionId) REFERENCES dbo.BudgetTemplateVersions (Id),
    CONSTRAINT UQ_BudgetVersions_Version UNIQUE (ProjectId, VersionNumber),
    CONSTRAINT CK_BudgetVersions_Doc     CHECK (ISJSON(Doc) = 1),
    CONSTRAINT CK_BudgetVersions_Number  CHECK (VersionNumber >= 1)
  );
  CREATE INDEX IX_BudgetVersions_Project_VersionDesc ON dbo.BudgetVersions (ProjectId, VersionNumber DESC);
  CREATE INDEX IX_BudgetVersions_Project_CreatedDesc ON dbo.BudgetVersions (ProjectId, CreatedAt DESC);
  PRINT 'Created dbo.BudgetVersions';
END

------------------------------------------------------------------------------
-- 2.6 dbo.BudgetVersionSovLines — immutable normalized SOV rows per version
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.BudgetVersionSovLines','U') IS NULL
BEGIN
  CREATE TABLE dbo.BudgetVersionSovLines (
    Id              BIGINT        IDENTITY(1,1) NOT NULL,
    BudgetVersionId BIGINT        NOT NULL,
    LineOrder       INT           NOT NULL,
    LineKey         VARCHAR(64)   NULL,
    Scope           VARCHAR(10)   NOT NULL,
    Grp             NVARCHAR(120) NOT NULL,
    Code            NVARCHAR(20)  NOT NULL,
    Descr           NVARCHAR(300) NOT NULL,
    Basis           VARCHAR(10)   NOT NULL,
    Qty             DECIMAL(18,2) NOT NULL,
    Rate            DECIMAL(18,4) NOT NULL,
    Total           DECIMAL(18,2) NOT NULL,
    Provenance      NVARCHAR(30)  NOT NULL CONSTRAINT DF_BudgetVersionSovLines_Prov DEFAULT (N'parametric-estimate'),
    CONSTRAINT PK_BudgetVersionSovLines PRIMARY KEY (Id),
    CONSTRAINT FK_BudgetVersionSovLines_Version FOREIGN KEY (BudgetVersionId)
      REFERENCES dbo.BudgetVersions (Id) ON DELETE CASCADE,
    CONSTRAINT UQ_BudgetVersionSovLines_Order UNIQUE (BudgetVersionId, LineOrder)
  );
  CREATE INDEX IX_BudgetVersionSovLines_LineKey ON dbo.BudgetVersionSovLines (LineKey) WHERE LineKey IS NOT NULL;
  PRINT 'Created dbo.BudgetVersionSovLines';
END

------------------------------------------------------------------------------
-- 2.7 Seed the 'multifamily' template (version 1, current)
------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.BudgetTemplateVersions WHERE TemplateKey = 'multifamily')
BEGIN
  -- Rates come from the live published pricing library, not from a copy baked
  -- into this file, so the seed matches whatever the admin last published.
  DECLARE @pricingDoc NVARCHAR(MAX), @pv NVARCHAR(32);
  SELECT TOP 1 @pricingDoc = Doc, @pv = Version
  FROM dbo.PricingLibrary
  ORDER BY IsCurrent DESC, Effective DESC, CreatedAt DESC;

  IF @pricingDoc IS NULL
    THROW 50001, 'dbo.PricingLibrary is empty — run sql/seed_pricing.sql before this migration so the multifamily template can be seeded.', 1;

  -- Template lines mirror blankDoc(): each pricing line plus qty (1 for lump
  -- sum, else 0 = auto), auto (false for lump sum), baseUnit (= the library
  -- rate the line was born with) and a stable template lineId. New budgets
  -- created from the template regenerate line IDs (Phase 2). unit/baseUnit are
  -- injected as the pricing doc's own numeric text, so no float reformatting.
  DECLARE @lines NVARCHAR(MAX);
  SELECT @lines = N'[' + STRING_AGG(CAST(
      N'{"lineId":"' + LOWER(CONVERT(VARCHAR(36), NEWID()))
    + N'","code":"'  + STRING_ESCAPE(JSON_VALUE(j.[value], '$.code'),  'json')
    + N'","grp":"'   + STRING_ESCAPE(JSON_VALUE(j.[value], '$.grp'),   'json')
    + N'","scope":"' + STRING_ESCAPE(JSON_VALUE(j.[value], '$.scope'), 'json')
    + N'","desc":"'  + STRING_ESCAPE(JSON_VALUE(j.[value], '$.desc'),  'json')
    + N'","basis":"' + STRING_ESCAPE(JSON_VALUE(j.[value], '$.basis'), 'json')
    + N'","unit":'     + ISNULL(JSON_VALUE(j.[value], '$.unit'), N'0')
    + N',"baseUnit":'  + ISNULL(JSON_VALUE(j.[value], '$.unit'), N'0')
    + N',"qty":'  + IIF(JSON_VALUE(j.[value], '$.basis') = 'ls', N'1', N'0')
    + N',"auto":' + IIF(JSON_VALUE(j.[value], '$.basis') = 'ls', N'false', N'true')
    + N'}' AS NVARCHAR(MAX)), N',') WITHIN GROUP (ORDER BY CAST(j.[key] AS INT)) + N']'
  FROM OPENJSON(@pricingDoc, '$.lines') AS j;

  IF @lines IS NULL
    THROW 50002, 'The current pricing library document has no $.lines array — cannot seed the multifamily template.', 1;

  -- Everything below the lines array reproduces app/index.html blankDoc('multifamily')
  -- and its DEFAULT_OTHER / DEFAULT_EXPENSES constants as of this commit.
  DECLARE @tplDoc NVARCHAR(MAX) =
      N'{"templateSchemaVersion":1'
    + N',"name":"Multifamily"'
    + N',"type":"Multifamily"'
    + N',"resSF":51365,"amenSF":1200,"siteSF":0'
    + N',"units":['
    +   N'{"label":"Studio (630)","bd":0,"bth":1,"sf":630,"count":16,"rent":1203},'
    +   N'{"label":"Studio (400)","bd":0,"bth":1,"sf":400,"count":14,"rent":1160},'
    +   N'{"label":"Townhome (1,063)","bd":2,"bth":2,"sf":1063,"count":14,"rent":1520},'
    +   N'{"label":"Townhome (1,200)","bd":2,"bth":2.5,"sf":1200,"count":14,"rent":1500}]'
    + N',"other":['
    +   N'{"label":"Utilities billback","rate":77,"count":0,"auto":true},'
    +   N'{"label":"Technology package (fiber + comms)","rate":75,"count":0,"auto":true},'
    +   N'{"label":"Parking (reserved spaces)","rate":25,"count":15,"auto":false},'
    +   N'{"label":"Pet rent (~30% of units)","rate":25,"count":18,"auto":false},'
    +   N'{"label":"Admin fees","rate":20,"count":0,"auto":true},'
    +   N'{"label":"Premium units","rate":25,"count":23,"auto":false},'
    +   N'{"label":"Valet trash","rate":25,"count":0,"auto":true},'
    +   N'{"label":"Misc","rate":15,"count":0,"auto":true}]'
    + N',"expenses":['
    +   N'{"label":"City of Waller water & sewer (≈$40–60/unit)","per":"unit","rate":60,"count":0,"auto":true},'
    +   N'{"label":"Ezee Fiber","per":"unit","rate":40,"count":0,"auto":true},'
    +   N'{"label":"Finishes Communications","per":"unit","rate":15,"count":0,"auto":true},'
    +   N'{"label":"Ally Waste valet trash service","per":"unit","rate":15,"count":0,"auto":true},'
    +   N'{"label":"City of Waller dumpster — 1 cu yd, 2×/wk pickup","per":"fixed","rate":383,"count":1,"auto":false},'
    +   N'{"label":"Admin / processing costs","per":"unit","rate":10,"count":0,"auto":true}]'
    + N',"lines":' + @lines
    + N',"companies":[{"name":"Finishes Solutions LLC","pct":12}]'
    + N',"contingency":{"mode":"psf","val":2}'
    + N',"projectCosts":{"land":1200000,"dev":200000,"mkt":75000,"cls":0}'
    + N',"status":"Draft"'
    + N',"pricingVersion":"' + STRING_ESCAPE(@pv, 'json') + N'"}';

  IF ISJSON(@tplDoc) <> 1
    THROW 50003, 'Composed multifamily template document is not valid JSON — aborting.', 1;

  IF NOT EXISTS (SELECT 1 FROM dbo.BudgetTemplates WHERE TemplateKey = 'multifamily')
    INSERT INTO dbo.BudgetTemplates (TemplateKey, Name, BudgetType, Description, IsActive, CreatedById, CreatedByName)
    VALUES ('multifamily', N'Multifamily', N'Multifamily',
            N'Default multifamily budget template. Seeded from the published pricing library and the application''s built-in new-budget defaults.',
            1, NULL, N'System (migration)');

  INSERT INTO dbo.BudgetTemplateVersions
    (TemplateKey, VersionNumber, VersionLabel, IsCurrent, TemplateSchemaVersion,
     PricingVersion, Doc, ContentHash, ChangeSummary, CreatedById, CreatedByName, PublishedAt)
  VALUES
    ('multifamily', 1, N'Initial Version', 1, 1,
     @pv, @tplDoc,
     LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', @tplDoc), 2)),
     N'Seeded from pricing library ' + @pv + N' and the application''s built-in Multifamily defaults (migration).',
     NULL, N'System (migration)', SYSUTCDATETIME());

  PRINT CONCAT('Seeded multifamily template v1 from pricing library ', @pv);
END
ELSE
  PRINT 'Multifamily template already seeded — skipped';

------------------------------------------------------------------------------
-- 2.8 Baseline backfill — Version 1 for every budget that has none
------------------------------------------------------------------------------
-- Soft-deleted budgets (if the earlier fragment ever flagged any) are included:
-- history must survive deletion. Timestamps reuse the budget's own UpdatedAt —
-- no fabricated history. Provenance stays NULL (see header note 3).
DECLARE @baselines TABLE (Id BIGINT NOT NULL, ProjectId VARCHAR(16) NOT NULL);
DECLARE @baselineCount INT;

INSERT INTO dbo.BudgetVersions
  (ProjectId, VersionNumber, Name, Type, Status, ContractSum, ProjectCost,
   PricingVersion, TemplateKey, TemplateVersionId, Doc, ContentHash,
   DocumentSchemaVersion, ChangeSummary, CreatedById, CreatedByName, CreatedAt)
OUTPUT inserted.Id, inserted.ProjectId INTO @baselines (Id, ProjectId)
SELECT
  b.ProjectId, 1, b.Name, b.Type, b.Status, b.ContractSum, b.ProjectCost,
  b.PricingVersion, NULL, NULL, b.Doc,
  LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', b.Doc), 2)),
  1, N'Initial version — migration baseline', NULL, N'System (migration)', b.UpdatedAt
FROM dbo.Budgets AS b
WHERE NOT EXISTS (SELECT 1 FROM dbo.BudgetVersions AS v WHERE v.ProjectId = b.ProjectId);

-- PRINT cannot take a subquery (Msg 1046), so count into a variable first
SET @baselineCount = @@ROWCOUNT;
PRINT CONCAT('Baseline versions created: ', @baselineCount);

-- Copy each baselined budget's current SOV rows into the version, numbering
-- them by today's row order (same determinism as the LineOrder backfill).
INSERT INTO dbo.BudgetVersionSovLines
  (BudgetVersionId, LineOrder, LineKey, Scope, Grp, Code, Descr, Basis, Qty, Rate, Total, Provenance)
SELECT
  nb.Id,
  ROW_NUMBER() OVER (PARTITION BY s.ProjectId ORDER BY s.Id),
  NULL, s.Scope, s.Grp, s.Code, s.Descr, s.Basis, s.Qty, s.Rate, s.Total, s.Provenance
FROM dbo.SovLines AS s
JOIN @baselines AS nb ON nb.ProjectId = s.ProjectId;

PRINT CONCAT('Baseline SOV rows copied: ', @@ROWCOUNT);

------------------------------------------------------------------------------
-- 2.9 In-transaction assertions — roll everything back if any critical
--     guarantee does not hold
------------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM dbo.Budgets AS b
           WHERE NOT EXISTS (SELECT 1 FROM dbo.BudgetVersions AS v WHERE v.ProjectId = b.ProjectId))
  THROW 50004, 'At least one budget has no baseline version after backfill — rolling back.', 1;

IF EXISTS (
  SELECT 1
  FROM @baselines AS nb
  JOIN (SELECT ProjectId, COUNT(*) AS n FROM dbo.SovLines GROUP BY ProjectId) AS cur
    ON cur.ProjectId = nb.ProjectId
  LEFT JOIN (SELECT BudgetVersionId, COUNT(*) AS n FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) AS ver
    ON ver.BudgetVersionId = nb.Id
  WHERE ISNULL(ver.n, 0) <> cur.n)
  THROW 50005, 'Baseline SOV row counts do not reconcile with current SovLines — rolling back.', 1;

IF NOT EXISTS (SELECT 1 FROM dbo.BudgetTemplateVersions WHERE TemplateKey = 'multifamily' AND IsCurrent = 1)
  THROW 50006, 'The multifamily template has no current version — rolling back.', 1;

COMMIT TRANSACTION;
PRINT '=== Migration committed successfully ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== Migration FAILED and was rolled back ===';
  THROW;
END CATCH
GO


-- ////////////////////////////////////////////////////////////////////////////
-- SECTION 3 — POST-MIGRATION VERIFICATION (read-only)
-- Every query states its expected result. Compare 3b with preflight 1b.
-- ////////////////////////////////////////////////////////////////////////////
SET NOCOUNT ON;

-- 3a. All required objects exist — every row must say EXISTS.
SELECT * FROM (VALUES
  ('table  dbo.BudgetTemplates',        IIF(OBJECT_ID('dbo.BudgetTemplates','U')         IS NULL, 'MISSING', 'EXISTS')),
  ('table  dbo.BudgetTemplateVersions', IIF(OBJECT_ID('dbo.BudgetTemplateVersions','U')  IS NULL, 'MISSING', 'EXISTS')),
  ('table  dbo.BudgetVersions',         IIF(OBJECT_ID('dbo.BudgetVersions','U')          IS NULL, 'MISSING', 'EXISTS')),
  ('table  dbo.BudgetVersionSovLines',  IIF(OBJECT_ID('dbo.BudgetVersionSovLines','U')   IS NULL, 'MISSING', 'EXISTS')),
  ('column dbo.Budgets.IsDeleted',          IIF(COL_LENGTH('dbo.Budgets','IsDeleted')         IS NULL, 'MISSING', 'EXISTS')),
  ('column dbo.Budgets.DeletedAt',          IIF(COL_LENGTH('dbo.Budgets','DeletedAt')         IS NULL, 'MISSING', 'EXISTS')),
  ('column dbo.Budgets.TemplateKey',        IIF(COL_LENGTH('dbo.Budgets','TemplateKey')       IS NULL, 'MISSING', 'EXISTS')),
  ('column dbo.Budgets.TemplateVersionId',  IIF(COL_LENGTH('dbo.Budgets','TemplateVersionId') IS NULL, 'MISSING', 'EXISTS')),
  ('column dbo.SovLines.LineKey',           IIF(COL_LENGTH('dbo.SovLines','LineKey')          IS NULL, 'MISSING', 'EXISTS')),
  ('column dbo.SovLines.LineOrder',         IIF(COL_LENGTH('dbo.SovLines','LineOrder')        IS NULL, 'MISSING', 'EXISTS'))
) AS v(ObjectChecked, State);

-- 3b. Budgets and current SOV rows are untouched — these numbers must equal
--     preflight 1b exactly.
SELECT
  (SELECT COUNT(*)                 FROM dbo.Budgets)                              AS Budgets,
  (SELECT COUNT(*)                 FROM dbo.Budgets WHERE ProjectId LIKE 'TST-%') AS TestBudgets,
  (SELECT ISNULL(SUM(ContractSum),0) FROM dbo.Budgets)                            AS SumContractSum,
  (SELECT ISNULL(SUM(ProjectCost),0) FROM dbo.Budgets)                            AS SumProjectCost,
  (SELECT COUNT(*)                 FROM dbo.SovLines)                             AS SovLines,
  (SELECT ISNULL(SUM(Total),0)     FROM dbo.SovLines)                             AS SumSovTotal,
  (SELECT COUNT(*)                 FROM dbo.PricingLibrary)                       AS PricingVersions; -- unchanged too

-- 3c. Every budget has at least one version — expect ZERO rows.
SELECT b.ProjectId, b.Name AS BudgetWithoutVersion
FROM dbo.Budgets AS b
WHERE NOT EXISTS (SELECT 1 FROM dbo.BudgetVersions AS v WHERE v.ProjectId = b.ProjectId);

-- 3d. Baseline SOV counts reconcile with current SovLines — expect ZERO rows.
--     (Valid immediately after migration, before any Phase 2 saves.)
SELECT v.ProjectId, cur.n AS CurrentSovLines, ISNULL(ver.n, 0) AS BaselineSovLines
FROM dbo.BudgetVersions AS v
JOIN (SELECT ProjectId, COUNT(*) AS n FROM dbo.SovLines GROUP BY ProjectId) AS cur
  ON cur.ProjectId = v.ProjectId
LEFT JOIN (SELECT BudgetVersionId, COUNT(*) AS n FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) AS ver
  ON ver.BudgetVersionId = v.Id
WHERE v.VersionNumber = 1 AND ISNULL(ver.n, 0) <> cur.n;

-- 3e. Baseline SOV dollar totals reconcile per budget — expect ZERO rows.
SELECT v.ProjectId, cur.t AS CurrentTotal, ISNULL(ver.t, 0) AS BaselineTotal
FROM dbo.BudgetVersions AS v
JOIN (SELECT ProjectId, SUM(Total) AS t FROM dbo.SovLines GROUP BY ProjectId) AS cur
  ON cur.ProjectId = v.ProjectId
LEFT JOIN (SELECT BudgetVersionId, SUM(Total) AS t FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) AS ver
  ON ver.BudgetVersionId = v.Id
WHERE v.VersionNumber = 1 AND ISNULL(ver.t, 0) <> cur.t;

-- 3f. No duplicate budget version numbers — expect ZERO rows.
SELECT ProjectId, VersionNumber, COUNT(*) AS Dupes
FROM dbo.BudgetVersions GROUP BY ProjectId, VersionNumber HAVING COUNT(*) > 1;

-- 3g. No duplicate template version numbers — expect ZERO rows.
SELECT TemplateKey, VersionNumber, COUNT(*) AS Dupes
FROM dbo.BudgetTemplateVersions GROUP BY TemplateKey, VersionNumber HAVING COUNT(*) > 1;

-- 3h. Exactly one current version per template — expect one row per template,
--     each with CurrentVersions = 1 (at minimum: 'multifamily', 1).
SELECT t.TemplateKey, SUM(CASE WHEN v.IsCurrent = 1 THEN 1 ELSE 0 END) AS CurrentVersions
FROM dbo.BudgetTemplates AS t
LEFT JOIN dbo.BudgetTemplateVersions AS v ON v.TemplateKey = t.TemplateKey
GROUP BY t.TemplateKey;

-- 3i. No orphaned version or version-SOV rows — expect ZERO rows.
SELECT v.Id AS OrphanVersionId
FROM dbo.BudgetVersions AS v
LEFT JOIN dbo.Budgets AS b ON b.ProjectId = v.ProjectId
WHERE b.ProjectId IS NULL
UNION ALL
SELECT s.Id
FROM dbo.BudgetVersionSovLines AS s
LEFT JOIN dbo.BudgetVersions AS v ON v.Id = s.BudgetVersionId
WHERE v.Id IS NULL;

-- 3j. The multifamily template has a current version — expect ONE row:
--     VersionNumber 1, IsCurrent 1, PricingVersion matching preflight 1c's
--     current library version, TemplateLines = the library's line count.
SELECT v.TemplateKey, v.VersionNumber, v.VersionLabel, v.IsCurrent,
       v.PricingVersion, v.PublishedAt,
       (SELECT COUNT(*) FROM OPENJSON(v.Doc, '$.lines')) AS TemplateLines,
       ISJSON(v.Doc) AS DocIsJson  -- expect 1
FROM dbo.BudgetTemplateVersions AS v
WHERE v.TemplateKey = 'multifamily' AND v.IsCurrent = 1;

-- 3k. SovLines.LineOrder fully backfilled — expect 0.
SELECT COUNT(*) AS SovLinesMissingLineOrder FROM dbo.SovLines WHERE LineOrder IS NULL;

-- 3l. Soft-delete state — expect PreexistingDeleted to match what you knew
--     about (normally 0), and every budget visible in the app to have
--     IsDeleted = 0.
SELECT COUNT(*) AS PreexistingDeleted FROM dbo.Budgets WHERE IsDeleted = 1;

-- 3m. Version history overview — eyeball: one Version 1 per budget, dated at
--     the budget's own UpdatedAt.
SELECT TOP 20 v.ProjectId, v.VersionNumber, v.Name, v.Status, v.ContractSum,
       v.ProjectCost, v.PricingVersion, v.ChangeSummary, v.CreatedAt
FROM dbo.BudgetVersions AS v
ORDER BY v.ProjectId, v.VersionNumber;
GO
