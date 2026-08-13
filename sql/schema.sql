-- Finishes Solutions — BD Budgeting schema
-- Target: Azure SQL Database. Run once against the fs-bd-budget database.
--
-- Fresh-install order: schema.sql → seed_pricing.sql →
-- migrate_budget_history_and_templates.sql (no-op on this schema except
-- seeding the multifamily template) → views.sql.
--
-- This file is kept in parity with the migration: same objects, same
-- constraint and index names. A database built from this file plus the seed
-- and migration is identical to the migrated live database.

CREATE TABLE dbo.PricingLibrary (
    Version      NVARCHAR(32)  NOT NULL PRIMARY KEY,
    Effective    DATE          NOT NULL,
    IsCurrent    BIT           NOT NULL DEFAULT 0,
    Doc          NVARCHAR(MAX) NOT NULL CHECK (ISJSON(Doc) = 1),
    CreatedAt    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_PricingLibrary_Current ON dbo.PricingLibrary (IsCurrent) INCLUDE (Version);

-- Admin-managed budget templates: stable identity + metadata. The template
-- system is the authoritative source of new-budget defaults; dbo.PricingLibrary
-- remains the published line-rate history it is seeded from.
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

-- Immutable published template versions. Publishing inserts a new row and
-- flips IsCurrent atomically; a published Doc is never updated.
CREATE TABLE dbo.BudgetTemplateVersions (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    TemplateKey           VARCHAR(64)    NOT NULL,
    VersionNumber         INT            NOT NULL,   -- sequential within the template
    VersionLabel          NVARCHAR(100)  NULL,
    IsCurrent             BIT            NOT NULL CONSTRAINT DF_BudgetTemplateVersions_IsCurrent DEFAULT (0),
    TemplateSchemaVersion INT            NOT NULL CONSTRAINT DF_BudgetTemplateVersions_Schema    DEFAULT (1),
    PricingVersion        NVARCHAR(32)   NULL,
    Doc                   NVARCHAR(MAX)  NOT NULL,   -- complete new-budget template JSON
    ContentHash           CHAR(64)       NOT NULL,   -- SHA-256 hex of the template document
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
-- at most one current version per template
CREATE UNIQUE INDEX UX_BudgetTemplateVersions_Current
  ON dbo.BudgetTemplateVersions (TemplateKey) WHERE IsCurrent = 1;
CREATE INDEX IX_BudgetTemplateVersions_Template_VersionDesc
  ON dbo.BudgetTemplateVersions (TemplateKey, VersionNumber DESC);

CREATE TABLE dbo.Budgets (
    ProjectId      VARCHAR(16)   NOT NULL PRIMARY KEY,  -- OP-#### / BD-#### / AS-#### / TST-####
    Name           NVARCHAR(200) NOT NULL DEFAULT '',
    Type           NVARCHAR(50)  NOT NULL DEFAULT 'Multifamily',
    Status         NVARCHAR(30)  NOT NULL DEFAULT 'Draft',
    ContractSum    DECIMAL(18,2) NOT NULL DEFAULT 0,   -- construction contract (lender package number)
    ProjectCost    DECIMAL(18,2) NOT NULL DEFAULT 0,   -- total project incl. land/soft/fees
    PricingVersion NVARCHAR(32)  NULL,                 -- pricing library snapshot the doc carries
    Doc            NVARCHAR(MAX) NOT NULL CHECK (ISJSON(Doc) = 1),
    CreatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    -- Soft delete: the app flags budgets instead of deleting rows, so history
    -- survives and PUT on the same ProjectId restores. Hard removal is the
    -- admin-run sql/purge_deleted_budgets.sql only.
    IsDeleted      BIT           NOT NULL CONSTRAINT DF_Budgets_IsDeleted DEFAULT (0),
    DeletedAt      DATETIME2     NULL,
    -- Template provenance: the exact template version this budget was created
    -- from. NULL for budgets that predate the template system.
    TemplateKey       VARCHAR(64) NULL,
    TemplateVersionId BIGINT      NULL,
    CONSTRAINT FK_Budgets_TemplateKey     FOREIGN KEY (TemplateKey)       REFERENCES dbo.BudgetTemplates (TemplateKey),
    CONSTRAINT FK_Budgets_TemplateVersion FOREIGN KEY (TemplateVersionId) REFERENCES dbo.BudgetTemplateVersions (Id)
);
CREATE INDEX IX_Budgets_Template ON dbo.Budgets (TemplateKey, TemplateVersionId);

-- Normalized SOV lines: the read surface for the Master Lender Package pipeline
-- and future AIA-style draw sheets. Rewritten on every budget save.
CREATE TABLE dbo.SovLines (
    Id         INT IDENTITY(1,1) PRIMARY KEY,
    ProjectId  VARCHAR(16)   NOT NULL REFERENCES dbo.Budgets(ProjectId),
    Scope      VARCHAR(10)   NOT NULL,   -- res | amen | soft
    Grp        NVARCHAR(120) NOT NULL,   -- phase group (General Conditions, Shell, ...)
    Code       NVARCHAR(20)  NOT NULL,   -- CSI MasterFormat code
    Descr      NVARCHAR(300) NOT NULL,
    Basis      VARCHAR(10)   NOT NULL,   -- sf | asf | unit | ls
    Qty        DECIMAL(18,2) NOT NULL,
    Rate       DECIMAL(18,4) NOT NULL,
    Total      DECIMAL(18,2) NOT NULL,
    Provenance NVARCHAR(30)  NOT NULL DEFAULT 'parametric-estimate',  -- graduates to vendor-quote / contracted
    UpdatedAt  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    LineKey    VARCHAR(64)   NULL,       -- stable budget line identifier (doc lineId)
    LineOrder  INT           NULL        -- persistent display / SOV order
);
CREATE INDEX IX_SovLines_Project ON dbo.SovLines (ProjectId) INCLUDE (Scope, Total);
CREATE UNIQUE INDEX UX_SovLines_Project_LineKey ON dbo.SovLines (ProjectId, LineKey) WHERE LineKey IS NOT NULL;

-- One immutable snapshot per saved budget version. Rows are written once by
-- the save transaction and never updated.
CREATE TABLE dbo.BudgetVersions (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    ProjectId             VARCHAR(16)    NOT NULL,
    VersionNumber         INT            NOT NULL,   -- sequential within the budget
    Name                  NVARCHAR(200)  NOT NULL CONSTRAINT DF_BudgetVersions_Name   DEFAULT (N''),
    Type                  NVARCHAR(50)   NOT NULL CONSTRAINT DF_BudgetVersions_Type   DEFAULT (N'Multifamily'),
    Status                NVARCHAR(30)   NOT NULL CONSTRAINT DF_BudgetVersions_Status DEFAULT (N'Draft'),
    ContractSum           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_BudgetVersions_CS     DEFAULT (0),
    ProjectCost           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_BudgetVersions_PC     DEFAULT (0),
    PricingVersion        NVARCHAR(32)   NULL,
    TemplateKey           VARCHAR(64)    NULL,
    TemplateVersionId     BIGINT         NULL,
    Doc                   NVARCHAR(MAX)  NOT NULL,   -- complete immutable budget JSON
    ContentHash           CHAR(64)       NOT NULL,   -- SHA-256 hex (see migration header for convention)
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

-- Immutable normalized SOV rows for each saved budget version.
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
