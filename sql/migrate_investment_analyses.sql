-- ============================================================================
-- Migration: investment-analysis tables (additive, idempotent, transactional)
--
-- Run in Azure Portal Query Editor as the database admin, AFTER
-- sql/preflight_investment_analysis.sql has come back clean. Safe to run
-- twice: every object is existence-guarded, and a re-run changes nothing.
--
-- Purely additive: no existing table, column, constraint, or row is touched.
-- Old production code never reads these tables, so deploying it against the
-- migrated database is unaffected.
--
-- Order for the full rollout:
--   1. this file          3. sql/verify_investment_analyses.sql (all PASS)
--   2. sql/views.sql      4. sql/verify_migration.sql (still all PASS)
-- then re-run the preflight's Section G row counts — they must be unchanged.
--
-- Constraint and index names are kept in parity with sql/schema.sql.
-- ============================================================================

-- ============ SECTION 1 — preflight (read-only) ============
SET NOCOUNT ON;
SELECT 'Preflight' AS Step,
       DB_NAME() AS DatabaseName,
       IIF(OBJECT_ID('dbo.Budgets','U')        IS NULL, 'MISSING', 'ok') AS Budgets,
       IIF(OBJECT_ID('dbo.BudgetVersions','U') IS NULL, 'MISSING', 'ok') AS BudgetVersions,
       IIF(OBJECT_ID('dbo.InvestmentAnalyses','U') IS NULL, 'will create', 'already exists') AS InvestmentAnalyses,
       IIF(OBJECT_ID('dbo.InvestmentAnalysisVersions','U') IS NULL, 'will create', 'already exists') AS AnalysisVersions,
       IIF(OBJECT_ID('dbo.InvestmentAnnualResults','U') IS NULL, 'will create', 'already exists') AS AnnualResults,
       IIF(OBJECT_ID('dbo.InvestmentVersionAnnualResults','U') IS NULL, 'will create', 'already exists') AS VersionAnnualResults;

IF OBJECT_ID('dbo.Budgets','U') IS NULL OR OBJECT_ID('dbo.BudgetVersions','U') IS NULL
  THROW 50010, 'dbo.Budgets / dbo.BudgetVersions missing — run the budget migration first.', 1;
GO

-- ============ SECTION 2 — migration ============
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.InvestmentAnalyses','U') IS NULL
BEGIN
  CREATE TABLE dbo.InvestmentAnalyses (
      AnalysisId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_InvestmentAnalyses_Id DEFAULT (NEWSEQUENTIALID()),
      ProjectId             VARCHAR(16)    NULL,
      Name                  NVARCHAR(200)  NOT NULL,
      Status                NVARCHAR(30)   NOT NULL CONSTRAINT DF_InvestmentAnalyses_Status DEFAULT (N'Draft'),
      ProjectionYears       TINYINT        NOT NULL CONSTRAINT DF_InvestmentAnalyses_Years  DEFAULT (5),
      TaxMode               VARCHAR(20)    NOT NULL CONSTRAINT DF_InvestmentAnalyses_Tax    DEFAULT ('beforeTax'),
      CurrentVersionNumber  INT            NOT NULL CONSTRAINT DF_InvestmentAnalyses_CurVer DEFAULT (0),
      SourceBudgetVersionId BIGINT         NULL,
      InputDoc              NVARCHAR(MAX)  NOT NULL,
      NormalizedInputDoc    NVARCHAR(MAX)  NOT NULL,
      ResultDoc             NVARCHAR(MAX)  NOT NULL,
      ContentHash           CHAR(64)       NOT NULL,
      InputSchemaVersion    INT            NOT NULL CONSTRAINT DF_InvestmentAnalyses_Schema DEFAULT (1),
      CalculationVersion    VARCHAR(40)    NOT NULL,
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
      CONSTRAINT FK_InvestmentAnalyses_Budget        FOREIGN KEY (ProjectId)             REFERENCES dbo.Budgets (ProjectId),
      CONSTRAINT FK_InvestmentAnalyses_BudgetVersion FOREIGN KEY (SourceBudgetVersionId) REFERENCES dbo.BudgetVersions (Id),
      CONSTRAINT CK_InvestmentAnalyses_Input      CHECK (ISJSON(InputDoc) = 1),
      CONSTRAINT CK_InvestmentAnalyses_Normalized CHECK (ISJSON(NormalizedInputDoc) = 1),
      CONSTRAINT CK_InvestmentAnalyses_Result     CHECK (ISJSON(ResultDoc) = 1)
  );
  PRINT 'Created dbo.InvestmentAnalyses';
END
ELSE PRINT 'dbo.InvestmentAnalyses already exists — skipped';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvestmentAnalyses_Project_Updated'
                 AND object_id = OBJECT_ID('dbo.InvestmentAnalyses'))
  CREATE INDEX IX_InvestmentAnalyses_Project_Updated
    ON dbo.InvestmentAnalyses (ProjectId, UpdatedAt DESC) WHERE IsDeleted = 0;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvestmentAnalyses_Updated'
                 AND object_id = OBJECT_ID('dbo.InvestmentAnalyses'))
  CREATE INDEX IX_InvestmentAnalyses_Updated
    ON dbo.InvestmentAnalyses (UpdatedAt DESC) WHERE IsDeleted = 0;

IF OBJECT_ID('dbo.InvestmentAnalysisVersions','U') IS NULL
BEGIN
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
  PRINT 'Created dbo.InvestmentAnalysisVersions';
END
ELSE PRINT 'dbo.InvestmentAnalysisVersions already exists — skipped';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvestmentAnalysisVersions_Analysis_VersionDesc'
                 AND object_id = OBJECT_ID('dbo.InvestmentAnalysisVersions'))
  CREATE INDEX IX_InvestmentAnalysisVersions_Analysis_VersionDesc
    ON dbo.InvestmentAnalysisVersions (AnalysisId, VersionNumber DESC);

IF OBJECT_ID('dbo.InvestmentAnnualResults','U') IS NULL
BEGIN
  CREATE TABLE dbo.InvestmentAnnualResults (
      Id                    BIGINT         IDENTITY(1,1) NOT NULL,
      AnalysisId            UNIQUEIDENTIFIER NOT NULL,
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
      CONSTRAINT PK_InvestmentAnnualResults PRIMARY KEY (Id),
      CONSTRAINT FK_InvestmentAnnualResults_Analysis FOREIGN KEY (AnalysisId) REFERENCES dbo.InvestmentAnalyses (AnalysisId),
      CONSTRAINT UQ_InvestmentAnnualResults_Year UNIQUE (AnalysisId, AnalysisYear),
      CONSTRAINT CK_InvestmentAnnualResults_Year CHECK (AnalysisYear BETWEEN 1 AND 10)
  );
  PRINT 'Created dbo.InvestmentAnnualResults';
END
ELSE PRINT 'dbo.InvestmentAnnualResults already exists — skipped';

IF OBJECT_ID('dbo.InvestmentVersionAnnualResults','U') IS NULL
BEGIN
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
  PRINT 'Created dbo.InvestmentVersionAnnualResults';
END
ELSE PRINT 'dbo.InvestmentVersionAnnualResults already exists — skipped';

COMMIT TRANSACTION;
PRINT 'Investment-analysis migration complete.';
GO

-- ============ SECTION 3 — quick verification (read-only) ============
SET NOCOUNT ON;
SELECT
  IIF(OBJECT_ID('dbo.InvestmentAnalyses','U')              IS NOT NULL, 'ok', 'MISSING') AS InvestmentAnalyses,
  IIF(OBJECT_ID('dbo.InvestmentAnalysisVersions','U')      IS NOT NULL, 'ok', 'MISSING') AS AnalysisVersions,
  IIF(OBJECT_ID('dbo.InvestmentAnnualResults','U')         IS NOT NULL, 'ok', 'MISSING') AS AnnualResults,
  IIF(OBJECT_ID('dbo.InvestmentVersionAnnualResults','U')  IS NOT NULL, 'ok', 'MISSING') AS VersionAnnualResults,
  (SELECT COUNT(*) FROM dbo.InvestmentAnalyses)            AS Analyses,
  (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions)    AS Versions;
-- Run sql/verify_investment_analyses.sql for the full structural check.
