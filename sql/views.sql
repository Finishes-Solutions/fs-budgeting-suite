-- Finishes Solutions — BD Budgeting: reporting/admin views
-- Idempotent (CREATE OR ALTER). Run against the fs-budgeting-suite database as
-- admin, AFTER sql/migrate_budget_history_and_templates.sql — the views read
-- the soft-delete columns that migration adds.
-- Keep every view in this file; do not create views ad hoc in the portal without
-- adding them here, or the database stops being rebuildable from source.

-- Budget index: everything the app's list shows, plus timestamps, pricing
-- version, template provenance and deletion state. TST-#### test budgets share
-- the production database, so reporting views exclude them here rather than
-- trusting every consumer to filter. Soft-deleted budgets stay visible with
-- their flags — filter WHERE IsDeleted = 0 at query time when needed.
CREATE OR ALTER VIEW dbo.vw_Budgets AS
SELECT ProjectId, Name, Type, Status, ContractSum, ProjectCost,
       PricingVersion, CreatedAt, UpdatedAt,
       IsDeleted, DeletedAt, TemplateKey, TemplateVersionId
FROM dbo.Budgets
WHERE ProjectId NOT LIKE 'TST-%';
GO

-- SOV rollup per project and scope. res + amen = hard cost; soft is excluded
-- from the construction contract by design (DATA_CONTRACT.md).
-- Excludes TST-#### test budgets and soft-deleted budgets: this is the
-- reporting surface, and a deleted budget's current SOV must not roll up.
CREATE OR ALTER VIEW dbo.vw_SovScopeRollup AS
SELECT s.ProjectId, s.Scope, COUNT(*) AS Lines, SUM(s.Total) AS ScopeTotal
FROM dbo.SovLines AS s
JOIN dbo.Budgets  AS b ON b.ProjectId = s.ProjectId
WHERE s.ProjectId NOT LIKE 'TST-%' AND b.IsDeleted = 0
GROUP BY s.ProjectId, s.Scope;
GO

-- Pricing library history: which versions exist and which one is live.
CREATE OR ALTER VIEW dbo.vw_PricingVersions AS
SELECT Version, Effective, IsCurrent, CreatedAt, LEN(Doc) AS DocBytes
FROM dbo.PricingLibrary;
GO

-- Recycle bin: what is recoverable and since when. Deliberately NOT filtered
-- to exclude TST-#### — recovery tooling should see everything that is soft-
-- deleted. Recover with:
--   UPDATE dbo.Budgets SET IsDeleted = 0, DeletedAt = NULL WHERE ProjectId = '...';
-- (or re-save the budget: PUT on a soft-deleted ProjectId restores it).
-- Hard removal is sql/purge_deleted_budgets.sql, admin-run only.
CREATE OR ALTER VIEW dbo.vw_DeletedBudgets AS
SELECT ProjectId, Name, Type, ContractSum, ProjectCost, DeletedAt
FROM dbo.Budgets
WHERE IsDeleted = 1;
GO
