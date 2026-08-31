-- Finishes Solutions — BD Budgeting schema
-- Target: Azure SQL Database. Run once against the fs-bd-budget database.
--
-- Fresh-install order: schema.sql → seed_pricing.sql →
-- migrate_budget_history_and_templates.sql (no-op on this schema except
-- seeding the multifamily template) → views.sql.
-- migrate_projects_and_guardrails.sql is likewise a no-op here: this file
-- already describes its end state, including dbo.Projects.
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

-- Projects — the parent of budgets and investment analyses. Its primary key is
-- what enforces "one project per ID", and that ID is OP-#### — a namespace of
-- its own, never borrowed from a budget. A project carries a base budget plus
-- any number of alternates (BD-0001, BD-0001-02, BD-0001-03 …), which is why
-- the budget id format below allows a two-digit suffix.
-- The structured Entity Master (sql/migrate_entities.sql). Legal entities plus
-- the six Finishes operating companies that participate in contracts. Master
-- data deactivates (IsActive) rather than deletes. Defined before dbo.Projects
-- because Projects.EntityId references it.
CREATE TABLE dbo.Entities (
    EntityId    INT IDENTITY(1,1) NOT NULL,
    EntityKey   VARCHAR(64)   NOT NULL,   -- stable slug ('finishes-solutions')
    LegalName   NVARCHAR(300) NOT NULL,
    DisplayName NVARCHAR(200) NOT NULL,
    EntityType  NVARCHAR(50)  NOT NULL CONSTRAINT DF_Entities_Type    DEFAULT (N'LLC'),
    Address     NVARCHAR(300) NOT NULL CONSTRAINT DF_Entities_Address DEFAULT (N''),
    IsFinishesCompany BIT     NOT NULL CONSTRAINT DF_Entities_Fin     DEFAULT (0),
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

CREATE TABLE dbo.Projects (
    ProjectId       VARCHAR(16)    NOT NULL,   -- OP-####
    Name            NVARCHAR(200)  NOT NULL CONSTRAINT DF_Projects_Name     DEFAULT (N''),
    Address         NVARCHAR(300)  NOT NULL CONSTRAINT DF_Projects_Address  DEFAULT (N''),
    Type            NVARCHAR(50)   NOT NULL CONSTRAINT DF_Projects_Type     DEFAULT (N'Multifamily'),
    -- Lead / Qualified / Budgeting / Proposal Sent / Awarded /
    -- Converted to Project / On Hold / Lost. Deliberately unconstrained: the
    -- app owns the vocabulary, and a CHECK would need a migration per status.
    Status          NVARCHAR(40)   NOT NULL CONSTRAINT DF_Projects_Status   DEFAULT (N'Lead'),
    PrimaryBudgetId VARCHAR(16)    NULL,
    -- Stamped when Status becomes 'Converted to Project'. The two amounts are
    -- SNAPSHOTS taken at that moment, not a live join — a budget edited after
    -- conversion must not restate reported backlog.
    ConvertedAt     DATETIME2      NULL,
    ContractAmount  DECIMAL(18,2)  NULL,
    ProjectAmount   DECIMAL(18,2)  NULL,
    Notes           NVARCHAR(2000) NOT NULL CONSTRAINT DF_Projects_Notes    DEFAULT (N''),
    -- The project's legal entity (sql/migrate_entities.sql). Nullable — a
    -- project without an entity is valid. Inherited by its budgets and contracts.
    EntityId        INT            NULL CONSTRAINT FK_Projects_Entity REFERENCES dbo.Entities (EntityId),
    CreatedById     NVARCHAR(128)  NULL,
    CreatedByName   NVARCHAR(200)  NULL,
    CreatedAt       DATETIME2      NOT NULL CONSTRAINT DF_Projects_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt       DATETIME2      NOT NULL CONSTRAINT DF_Projects_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    IsDeleted       BIT            NOT NULL CONSTRAINT DF_Projects_IsDeleted DEFAULT (0),
    DeletedAt       DATETIME2      NULL,
    CONSTRAINT PK_Projects PRIMARY KEY (ProjectId),
    -- A project id is its OWN namespace: OP-####, never a budget id. See
    -- sql/migrate_project_op_ids.sql and sql/widen_project_op_ids.sql for the
    -- migration that brought an existing database to this end state.
    CONSTRAINT CK_Projects_IdFormat CHECK (
      ProjectId LIKE 'OP-[0-9][0-9][0-9][0-9]' AND LEN(ProjectId) = 7)
);
CREATE INDEX IX_Projects_Status_Updated ON dbo.Projects (Status, UpdatedAt DESC) WHERE IsDeleted = 0;
CREATE INDEX IX_Projects_Converted ON dbo.Projects (ConvertedAt DESC)
  INCLUDE (ContractAmount, ProjectAmount) WHERE IsDeleted = 0;

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
    CreatedById    NVARCHAR(128) NULL,                  -- SWA principal.userId; NULL for legacy rows
    CreatedByName  NVARCHAR(200) NULL,
    -- Soft delete: the app flags budgets instead of deleting rows, so history
    -- survives and PUT on the same ProjectId restores. Hard removal is the
    -- admin-run sql/purge_deleted_budgets.sql only.
    IsDeleted      BIT           NOT NULL CONSTRAINT DF_Budgets_IsDeleted DEFAULT (0),
    DeletedAt      DATETIME2     NULL,
    -- Template provenance: the exact template version this budget was created
    -- from. NULL for budgets that predate the template system.
    TemplateKey       VARCHAR(64) NULL,
    TemplateVersionId BIGINT      NULL,
    -- Which project this budget belongs to: the id with any alternate suffix
    -- stripped. Nullable so a pre-Projects deploy keeps working.
    ProjectKey        VARCHAR(16) NULL,
    -- What the guard rails said at the last save. The rails themselves live in
    -- app/guardrails.js + api/shared/guardrails.js (byte-identical); this is a
    -- queryable summary for the lists, never the authority.
    GuardrailStatus      VARCHAR(10) NULL,   -- ok | warn | breach
    GuardrailBreachCount INT         NULL,
    CONSTRAINT FK_Budgets_TemplateKey     FOREIGN KEY (TemplateKey)       REFERENCES dbo.BudgetTemplates (TemplateKey),
    CONSTRAINT FK_Budgets_TemplateVersion FOREIGN KEY (TemplateVersionId) REFERENCES dbo.BudgetTemplateVersions (Id),
    CONSTRAINT FK_Budgets_Project         FOREIGN KEY (ProjectKey)        REFERENCES dbo.Projects (ProjectId),
    -- A project's alternates are BD-0001-02, BD-0001-03 …; the base budget
    -- keeps the plain id.
    CONSTRAINT CK_Budgets_IdFormat CHECK (
      ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      OR ProjectId LIKE '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
CREATE INDEX IX_Budgets_ProjectKey ON dbo.Budgets (ProjectKey)
  INCLUDE (Name, Status, ContractSum, ProjectCost) WHERE IsDeleted = 0;
CREATE INDEX IX_Budgets_Template ON dbo.Budgets (TemplateKey, TemplateVersionId);
CREATE INDEX IX_Budgets_CreatedById ON dbo.Budgets (CreatedById) WHERE IsDeleted = 0;

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
    GuardrailStatus       VARCHAR(10)    NULL,   -- what the rails said at this save
    GuardrailBreachCount  INT            NULL,
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

-- ============================================================================
-- Investment analyses — a separate underwriting aggregate. Never writes into
-- SovLines and never changes what the budget tables mean; an analysis links to
-- an immutable BudgetVersions row when it was created from a budget.
-- ============================================================================

CREATE TABLE dbo.InvestmentAnalyses (
    AnalysisId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_InvestmentAnalyses_Id DEFAULT (NEWSEQUENTIALID()),
    ProjectId             VARCHAR(16)    NULL,        -- the exact budget this was built from
    ProjectKey            VARCHAR(16)    NULL,        -- the project it rolls up to
    Name                  NVARCHAR(200)  NOT NULL,
    Status                NVARCHAR(30)   NOT NULL CONSTRAINT DF_InvestmentAnalyses_Status DEFAULT (N'Draft'),
    ProjectionYears       TINYINT        NOT NULL CONSTRAINT DF_InvestmentAnalyses_Years  DEFAULT (5),
    TaxMode               VARCHAR(20)    NOT NULL CONSTRAINT DF_InvestmentAnalyses_Tax    DEFAULT ('beforeTax'),
    CurrentVersionNumber  INT            NOT NULL CONSTRAINT DF_InvestmentAnalyses_CurVer DEFAULT (0),
    SourceBudgetVersionId BIGINT         NULL,        -- exact immutable budget version imported from
    InputDoc              NVARCHAR(MAX)  NOT NULL,    -- raw assumptions as entered
    NormalizedInputDoc    NVARCHAR(MAX)  NOT NULL,    -- defaults applied, canonical numeric shape
    ResultDoc             NVARCHAR(MAX)  NOT NULL,    -- canonical server-calculated result
    ContentHash           CHAR(64)       NOT NULL,    -- SHA-256 over {rawInput, sourceBudgetVersionId, calculationVersion}
    InputSchemaVersion    INT            NOT NULL CONSTRAINT DF_InvestmentAnalyses_Schema DEFAULT (1),
    CalculationVersion    VARCHAR(40)    NOT NULL,    -- engine that produced ResultDoc, e.g. before-tax-5y-1.0.0
    -- Queryable summary values for list views; ResultDoc stays authoritative.
    PurchasePrice         DECIMAL(19,4)  NULL,
    Year1NOI              DECIMAL(19,4)  NULL,
    InitialEquity         DECIMAL(19,4)  NULL,
    FinalYearEquityIRR    DECIMAL(19,10) NULL,
    OptimalHoldingYear    TINYINT        NULL,
    CreatedById           NVARCHAR(128)  NULL,
    CreatedByName         NVARCHAR(200)  NULL,
    CreatedAt             DATETIME2      NOT NULL CONSTRAINT DF_InvestmentAnalyses_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt             DATETIME2      NOT NULL CONSTRAINT DF_InvestmentAnalyses_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    IsDeleted             BIT            NOT NULL CONSTRAINT DF_InvestmentAnalyses_IsDeleted DEFAULT (0),
    DeletedAt             DATETIME2      NULL,
    CONSTRAINT PK_InvestmentAnalyses PRIMARY KEY (AnalysisId),
    -- NO ACTION on both: soft delete keeps every row, and the admin purge
    -- scripts handle ordering explicitly.
    CONSTRAINT FK_InvestmentAnalyses_Budget        FOREIGN KEY (ProjectId)             REFERENCES dbo.Budgets (ProjectId),
    CONSTRAINT FK_InvestmentAnalyses_Project       FOREIGN KEY (ProjectKey)            REFERENCES dbo.Projects (ProjectId),
    CONSTRAINT FK_InvestmentAnalyses_BudgetVersion FOREIGN KEY (SourceBudgetVersionId) REFERENCES dbo.BudgetVersions (Id),
    CONSTRAINT CK_InvestmentAnalyses_Input      CHECK (ISJSON(InputDoc) = 1),
    CONSTRAINT CK_InvestmentAnalyses_Normalized CHECK (ISJSON(NormalizedInputDoc) = 1),
    CONSTRAINT CK_InvestmentAnalyses_Result     CHECK (ISJSON(ResultDoc) = 1)
);
CREATE INDEX IX_InvestmentAnalyses_Project_Updated
  ON dbo.InvestmentAnalyses (ProjectId, UpdatedAt DESC) WHERE IsDeleted = 0;
CREATE INDEX IX_InvestmentAnalyses_Updated
  ON dbo.InvestmentAnalyses (UpdatedAt DESC) WHERE IsDeleted = 0;
CREATE INDEX IX_InvestmentAnalyses_ProjectKey
  ON dbo.InvestmentAnalyses (ProjectKey, UpdatedAt DESC) WHERE IsDeleted = 0;

-- Immutable analysis versions: raw input, normalized input, result, and
-- provenance are copied whole. A version row is written once, never updated,
-- and never recalculated when read.
CREATE TABLE dbo.InvestmentAnalysisVersions (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    AnalysisId            UNIQUEIDENTIFIER NOT NULL,
    VersionNumber         INT            NOT NULL,
    ProjectId             VARCHAR(16)    NULL,
    SourceBudgetVersionId BIGINT         NULL,
    Name                  NVARCHAR(200)  NOT NULL CONSTRAINT DF_InvestmentAnalysisVersions_Name DEFAULT (N''),
    InputDoc              NVARCHAR(MAX)  NOT NULL,
    NormalizedInputDoc    NVARCHAR(MAX)  NOT NULL,
    ResultDoc             NVARCHAR(MAX)  NOT NULL,
    InputSchemaVersion    INT            NOT NULL CONSTRAINT DF_InvestmentAnalysisVersions_Schema DEFAULT (1),
    CalculationVersion    VARCHAR(40)    NOT NULL,
    ContentHash           CHAR(64)       NOT NULL,
    ChangeSummary         NVARCHAR(1000) NULL,
    PurchasePrice         DECIMAL(19,4)  NULL,
    Year1NOI              DECIMAL(19,4)  NULL,
    InitialEquity         DECIMAL(19,4)  NULL,
    FinalYearEquityIRR    DECIMAL(19,10) NULL,
    OptimalHoldingYear    TINYINT        NULL,
    CreatedById           NVARCHAR(128)  NULL,
    CreatedByName         NVARCHAR(200)  NULL,
    CreatedAt             DATETIME2      NOT NULL CONSTRAINT DF_InvestmentAnalysisVersions_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_InvestmentAnalysisVersions PRIMARY KEY (Id),
    CONSTRAINT FK_InvestmentAnalysisVersions_Analysis FOREIGN KEY (AnalysisId) REFERENCES dbo.InvestmentAnalyses (AnalysisId),
    CONSTRAINT UQ_InvestmentAnalysisVersions_Version UNIQUE (AnalysisId, VersionNumber),
    CONSTRAINT CK_InvestmentAnalysisVersions_Input      CHECK (ISJSON(InputDoc) = 1),
    CONSTRAINT CK_InvestmentAnalysisVersions_Normalized CHECK (ISJSON(NormalizedInputDoc) = 1),
    CONSTRAINT CK_InvestmentAnalysisVersions_Result     CHECK (ISJSON(ResultDoc) = 1),
    CONSTRAINT CK_InvestmentAnalysisVersions_Number     CHECK (VersionNumber >= 1)
);
CREATE INDEX IX_InvestmentAnalysisVersions_Analysis_VersionDesc
  ON dbo.InvestmentAnalysisVersions (AnalysisId, VersionNumber DESC);

-- Five current annual rows per calculated analysis — the queryable/report
-- surface. Rewritten atomically by every meaningful save; ResultDoc remains
-- the authority they must reconcile with.
CREATE TABLE dbo.InvestmentAnnualResults (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    AnalysisId            UNIQUEIDENTIFIER NOT NULL,
    AnalysisYear          TINYINT        NOT NULL,
    PeriodEnd             CHAR(7)        NOT NULL,     -- YYYY-MM
    PotentialIncome       DECIMAL(19,4)  NOT NULL,
    VacancyLoss           DECIMAL(19,4)  NOT NULL,
    EffectiveRentalIncome DECIMAL(19,4)  NOT NULL,
    OtherIncome           DECIMAL(19,4)  NOT NULL,
    GrossOperatingIncome  DECIMAL(19,4)  NOT NULL,
    OperatingExpenses     DECIMAL(19,4)  NOT NULL,
    NetOperatingIncome    DECIMAL(19,4)  NOT NULL,
    CapitalExpenses       DECIMAL(19,4)  NOT NULL,
    DebtService           DECIMAL(19,4)  NOT NULL,
    CashFlowBeforeTaxes   DECIMAL(19,4)  NOT NULL,
    EndingLoanBalance     DECIMAL(19,4)  NOT NULL,
    GrossSalePrice        DECIMAL(19,4)  NOT NULL,
    SellingCosts          DECIMAL(19,4)  NOT NULL,
    NetSaleProceeds       DECIMAL(19,4)  NOT NULL,
    ProjectedLTV          DECIMAL(19,10) NULL,
    DSCR                  DECIMAL(19,10) NULL,
    DebtYield             DECIMAL(19,10) NULL,
    CashOnCash            DECIMAL(19,10) NULL,
    ReturnOnEquity        DECIMAL(19,10) NULL,
    EquityMultiple        DECIMAL(19,10) NULL,
    PropertyIRR           DECIMAL(19,10) NULL,
    EffectiveLoanRate     DECIMAL(19,10) NULL,
    EquityIRR             DECIMAL(19,10) NULL,
    LeverageImpact        DECIMAL(19,10) NULL,
    CONSTRAINT PK_InvestmentAnnualResults PRIMARY KEY (Id),
    CONSTRAINT FK_InvestmentAnnualResults_Analysis FOREIGN KEY (AnalysisId) REFERENCES dbo.InvestmentAnalyses (AnalysisId),
    CONSTRAINT UQ_InvestmentAnnualResults_Year UNIQUE (AnalysisId, AnalysisYear),
    CONSTRAINT CK_InvestmentAnnualResults_Year CHECK (AnalysisYear BETWEEN 1 AND 10)
);

-- Immutable copy of the annual rows for each analysis version, following the
-- BudgetVersionSovLines pattern (CASCADE from the version row).
CREATE TABLE dbo.InvestmentVersionAnnualResults (
    Id                    BIGINT         IDENTITY(1,1) NOT NULL,
    AnalysisVersionId     BIGINT         NOT NULL,
    AnalysisYear          TINYINT        NOT NULL,
    PeriodEnd             CHAR(7)        NOT NULL,
    PotentialIncome       DECIMAL(19,4)  NOT NULL,
    VacancyLoss           DECIMAL(19,4)  NOT NULL,
    EffectiveRentalIncome DECIMAL(19,4)  NOT NULL,
    OtherIncome           DECIMAL(19,4)  NOT NULL,
    GrossOperatingIncome  DECIMAL(19,4)  NOT NULL,
    OperatingExpenses     DECIMAL(19,4)  NOT NULL,
    NetOperatingIncome    DECIMAL(19,4)  NOT NULL,
    CapitalExpenses       DECIMAL(19,4)  NOT NULL,
    DebtService           DECIMAL(19,4)  NOT NULL,
    CashFlowBeforeTaxes   DECIMAL(19,4)  NOT NULL,
    EndingLoanBalance     DECIMAL(19,4)  NOT NULL,
    GrossSalePrice        DECIMAL(19,4)  NOT NULL,
    SellingCosts          DECIMAL(19,4)  NOT NULL,
    NetSaleProceeds       DECIMAL(19,4)  NOT NULL,
    ProjectedLTV          DECIMAL(19,10) NULL,
    DSCR                  DECIMAL(19,10) NULL,
    DebtYield             DECIMAL(19,10) NULL,
    CashOnCash            DECIMAL(19,10) NULL,
    ReturnOnEquity        DECIMAL(19,10) NULL,
    EquityMultiple        DECIMAL(19,10) NULL,
    PropertyIRR           DECIMAL(19,10) NULL,
    EffectiveLoanRate     DECIMAL(19,10) NULL,
    EquityIRR             DECIMAL(19,10) NULL,
    LeverageImpact        DECIMAL(19,10) NULL,
    CONSTRAINT PK_InvestmentVersionAnnualResults PRIMARY KEY (Id),
    CONSTRAINT FK_InvestmentVersionAnnualResults_Version FOREIGN KEY (AnalysisVersionId)
      REFERENCES dbo.InvestmentAnalysisVersions (Id) ON DELETE CASCADE,
    CONSTRAINT UQ_InvestmentVersionAnnualResults_Year UNIQUE (AnalysisVersionId, AnalysisYear)
);
