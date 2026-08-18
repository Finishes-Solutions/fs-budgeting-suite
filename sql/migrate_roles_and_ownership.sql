-- migrate_roles_and_ownership.sql
-- Adds ownership tracking to Budgets and app-level roles to Users.
-- Idempotent: safe to re-run.
--
-- Run order: after migrate_users.sql (dbo.Users must exist).

SET NOCOUNT ON;

-- 1. Add CreatedById / CreatedByName to dbo.Budgets so the listing API can
--    filter by owner. Existing rows get NULL (= "predates ownership tracking").
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Budgets') AND name = 'CreatedById')
  ALTER TABLE dbo.Budgets ADD CreatedById NVARCHAR(128) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Budgets') AND name = 'CreatedByName')
  ALTER TABLE dbo.Budgets ADD CreatedByName NVARCHAR(200) NULL;
GO

-- Index so the ownership-filtered listing is fast.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_CreatedById' AND object_id = OBJECT_ID('dbo.Budgets'))
  CREATE INDEX IX_Budgets_CreatedById ON dbo.Budgets (CreatedById) WHERE IsDeleted = 0;
GO

-- 2. Add AppRole to dbo.Users. Default is 'user' — the most restrictive level.
--    Valid values: user, manager, director, super_admin.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name = 'AppRole')
  ALTER TABLE dbo.Users ADD AppRole NVARCHAR(50) NOT NULL CONSTRAINT DF_Users_AppRole DEFAULT 'user';
GO

-- Backfill: existing rows that predate the column get the default automatically
-- via the constraint. No explicit UPDATE needed.

PRINT 'migrate_roles_and_ownership: done';
