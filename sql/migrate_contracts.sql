-- ============================================================================
--  Migration — Contract records
--
--  NOTE ON COMMENT STYLE: only `--` line comments. A `--` inside a block
--  comment swallows the closing marker and fails the whole batch.
--  ----------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-bd-budget database (all environments).
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : any time. The deploy tolerates the table's absence
--           (api/shared/schema.js probes contractsTable), so before OR after
--           the release is safe. Nothing here is destructive.
--
--  Idempotent, one transaction, XACT_ABORT ON.
--
--  WHAT IT DOES
--    Creates dbo.Contracts — structured records generated from an APPROVED
--    budget version's allocation. A contract stores who contracts whom, for how
--    much, from which budget version, and its status. Amounts trace back to the
--    budget allocation and never move on their own: if an approved version
--    changes, its contracts are flagged 'Requires Review', not rewritten.
--
--  WHAT IT DOES NOT DO
--    No contract templates, no generated documents, no e-signature, no
--    amendments or change orders — deliberately out of scope. Requires
--    dbo.Entities (migrate_entities.sql), dbo.Projects and dbo.BudgetVersions.
--
--  Sections: PREFLIGHT (read-only) → MIGRATION → VERIFICATION.
--  ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- ---------------------------------------------------------------------------
--  1 · PREFLIGHT
--  ---------------------------------------------------------------------------
PRINT '=== PREFLIGHT ===';
SELECT 'dbo.Contracts already exists' AS Item,
       CASE WHEN OBJECT_ID('dbo.Contracts','U') IS NULL THEN 0 ELSE 1 END AS N
UNION ALL SELECT 'dbo.Entities exists (required)',
       CASE WHEN OBJECT_ID('dbo.Entities','U') IS NULL THEN 0 ELSE 1 END
UNION ALL SELECT 'dbo.BudgetVersions exists (required)',
       CASE WHEN OBJECT_ID('dbo.BudgetVersions','U') IS NULL THEN 0 ELSE 1 END;

IF OBJECT_ID('dbo.Entities','U') IS NULL
  THROW 50030, 'dbo.Entities is missing — run migrate_entities.sql first.', 1;
IF OBJECT_ID('dbo.BudgetVersions','U') IS NULL
  THROW 50031, 'dbo.BudgetVersions is missing — run migrate_budget_history_and_templates.sql first.', 1;

-- ---------------------------------------------------------------------------
--  2 · MIGRATION
--  ---------------------------------------------------------------------------
BEGIN TRANSACTION;
BEGIN TRY

  IF OBJECT_ID('dbo.Contracts', 'U') IS NULL
  BEGIN
    PRINT 'Creating dbo.Contracts';
    CREATE TABLE dbo.Contracts (
        ContractId          INT IDENTITY(1,1) NOT NULL,
        BudgetId            VARCHAR(16)   NOT NULL,   -- the budget it was generated from
        ProjectKey          VARCHAR(16)   NOT NULL,   -- the owning project
        BudgetVersionId     BIGINT        NOT NULL,   -- the immutable version pinned at generation
        ProjectEntityId     INT           NOT NULL,   -- the project's legal entity
        ContractingEntityId INT           NOT NULL,   -- who pays
        PerformingEntityId  INT           NOT NULL,   -- who performs / receives
        -- '<entityKey>:<stream>' — the allocation row this contract reifies, so
        -- reconciliation can match a contract back to the budget allocation.
        AllocationKey       VARCHAR(80)   NOT NULL,
        OriginalAmount      DECIMAL(18,2) NOT NULL,   -- amount at generation; never moves
        CurrentAmount       DECIMAL(18,2) NOT NULL,   -- current amount (accepting review re-pins it)
        ProfitAmount        DECIMAL(18,2) NULL,
        Scope               NVARCHAR(1000) NOT NULL CONSTRAINT DF_Contracts_Scope  DEFAULT (N''),
        EffectiveDate       DATE          NULL,
        -- Generated | Requires Review | Superseded | Void
        Status              NVARCHAR(30)  NOT NULL CONSTRAINT DF_Contracts_Status DEFAULT (N'Generated'),
        ReviewNote          NVARCHAR(1000) NULL,
        CreatedById         NVARCHAR(128) NULL,
        CreatedByName       NVARCHAR(200) NULL,
        CreatedAt           DATETIME2     NOT NULL CONSTRAINT DF_Contracts_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt           DATETIME2     NOT NULL CONSTRAINT DF_Contracts_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        IsDeleted           BIT           NOT NULL CONSTRAINT DF_Contracts_IsDeleted DEFAULT (0),
        DeletedAt           DATETIME2     NULL,
        CONSTRAINT PK_Contracts PRIMARY KEY (ContractId),
        CONSTRAINT FK_Contracts_Budget    FOREIGN KEY (BudgetId)        REFERENCES dbo.Budgets (ProjectId),
        CONSTRAINT FK_Contracts_Project   FOREIGN KEY (ProjectKey)      REFERENCES dbo.Projects (ProjectId),
        CONSTRAINT FK_Contracts_Version   FOREIGN KEY (BudgetVersionId) REFERENCES dbo.BudgetVersions (Id),
        CONSTRAINT FK_Contracts_ProjEnt   FOREIGN KEY (ProjectEntityId)     REFERENCES dbo.Entities (EntityId),
        CONSTRAINT FK_Contracts_FromEnt   FOREIGN KEY (ContractingEntityId) REFERENCES dbo.Entities (EntityId),
        CONSTRAINT FK_Contracts_ToEnt     FOREIGN KEY (PerformingEntityId)  REFERENCES dbo.Entities (EntityId)
    );
    CREATE INDEX IX_Contracts_Budget  ON dbo.Contracts (BudgetId)   WHERE IsDeleted = 0;
    CREATE INDEX IX_Contracts_Project ON dbo.Contracts (ProjectKey) WHERE IsDeleted = 0;
  END
  ELSE PRINT 'dbo.Contracts already present — skipped';

  COMMIT TRANSACTION;
  PRINT '=== MIGRATION COMMITTED ===';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== MIGRATION ROLLED BACK ===';
  THROW;
END CATCH;

-- ---------------------------------------------------------------------------
--  3 · VERIFICATION — one result set. Every row must read PASS.
--  ---------------------------------------------------------------------------
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'dbo.Contracts exists' AS Check_,
         CAST(COUNT(*) AS NVARCHAR(50)) + ' contract rows' AS Detail,
         CASE WHEN OBJECT_ID('dbo.Contracts','U') IS NOT NULL THEN 1 ELSE 0 END AS Pass
  FROM dbo.Contracts
  UNION ALL
  SELECT 2, 'Foreign keys in place', 'budget / project / version / three entities',
         CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_Contracts_Version')
               AND EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_Contracts_ToEnt') THEN 1 ELSE 0 END
) AS v
ORDER BY Ord;
