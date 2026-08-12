-- Finishes Solutions — BD Budgeting: reporting/admin views
-- Idempotent (CREATE OR ALTER). Run against the fs-budgeting-suite database as admin.
-- Keep every view in this file; do not create views ad hoc in the portal without
-- adding them here, or the database stops being rebuildable from source.
--
-- ORDER OF OPERATIONS: Section 2 references soft-delete columns and will FAIL
-- until migration_soft_delete.sql has been run. Until then, run Section 1 only.

------------------------------------------------------------------------------
-- SECTION 1 — safe against the base schema (schema.sql as shipped)
------------------------------------------------------------------------------

-- Budget index: everything the app's list shows, plus timestamps and pricing version.
CREATE OR ALTER VIEW dbo.vw_Budgets AS
SELECT ProjectId, Name, Type, Status, ContractSum, ProjectCost,
       PricingVersion, CreatedAt, UpdatedAt
FROM dbo.Budgets;
GO

-- SOV rollup per project and scope. res + amen = hard cost; soft is excluded
-- from the construction contract by design (DATA_CONTRACT.md).
CREATE OR ALTER VIEW dbo.vw_SovScopeRollup AS
SELECT ProjectId, Scope, COUNT(*) AS Lines, SUM(Total) AS ScopeTotal
FROM dbo.SovLines
GROUP BY ProjectId, Scope;
GO

-- Pricing library history: which versions exist and which one is live.
CREATE OR ALTER VIEW dbo.vw_PricingVersions AS
SELECT Version, Effective, IsCurrent, CreatedAt, LEN(Doc) AS DocBytes
FROM dbo.PricingLibrary;
GO

------------------------------------------------------------------------------
-- SECTION 2 — run ONLY AFTER migration_soft_delete.sql
-- (references IsDeleted / DeletedAt; fails harmlessly before the migration)
------------------------------------------------------------------------------

-- Redefine the budget index to expose deletion state. Admin views show
-- everything; filter with WHERE IsDeleted = 0 at query time when needed.
CREATE OR ALTER VIEW dbo.vw_Budgets AS
SELECT ProjectId, Name, Type, Status, ContractSum, ProjectCost,
       PricingVersion, CreatedAt, UpdatedAt, IsDeleted, DeletedAt
FROM dbo.Budgets;
GO

-- Recycle bin: what is recoverable and since when.
-- Recover with: UPDATE dbo.Budgets SET IsDeleted = 0, DeletedAt = NULL WHERE ProjectId = '...';
CREATE OR ALTER VIEW dbo.vw_DeletedBudgets AS
SELECT ProjectId, Name, Type, ContractSum, ProjectCost, DeletedAt
FROM dbo.Budgets
WHERE IsDeleted = 1;
GO
