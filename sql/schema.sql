-- Finishes Solutions — BD Budgeting schema
-- Target: Azure SQL Database. Run once against the fs-bd-budget database.

CREATE TABLE dbo.PricingLibrary (
    Version      NVARCHAR(32)  NOT NULL PRIMARY KEY,
    Effective    DATE          NOT NULL,
    IsCurrent    BIT           NOT NULL DEFAULT 0,
    Doc          NVARCHAR(MAX) NOT NULL CHECK (ISJSON(Doc) = 1),
    CreatedAt    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_PricingLibrary_Current ON dbo.PricingLibrary (IsCurrent) INCLUDE (Version);

CREATE TABLE dbo.Budgets (
    ProjectId      VARCHAR(16)   NOT NULL PRIMARY KEY,  -- OP-### / BD-#### / AS-####
    Name           NVARCHAR(200) NOT NULL DEFAULT '',
    Type           NVARCHAR(50)  NOT NULL DEFAULT 'Multifamily',
    Status         NVARCHAR(30)  NOT NULL DEFAULT 'Draft',
    ContractSum    DECIMAL(18,2) NOT NULL DEFAULT 0,   -- construction contract (lender package number)
    ProjectCost    DECIMAL(18,2) NOT NULL DEFAULT 0,   -- total project incl. land/soft/fees
    PricingVersion NVARCHAR(32)  NULL,                 -- pricing library snapshot the doc carries
    Doc            NVARCHAR(MAX) NOT NULL CHECK (ISJSON(Doc) = 1),
    CreatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

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
    UpdatedAt  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_SovLines_Project ON dbo.SovLines (ProjectId) INCLUDE (Scope, Total);
