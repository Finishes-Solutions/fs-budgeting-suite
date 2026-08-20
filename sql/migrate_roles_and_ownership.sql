-- ============================================================================
-- Migration: application roles + budget ownership (additive, idempotent)
--
-- Run in Azure Portal Query Editor as the database admin. Safe to run twice:
-- every column and index is existence-guarded, and a re-run changes nothing.
--
-- Purely additive: no existing table, column, constraint, or row is modified.
--
-- Run order: after migrate_users.sql (dbo.Users must already exist).
--
-- What it adds:
--   dbo.Budgets.CreatedById    — the SWA principal userId of whoever created
--   dbo.Budgets.CreatedByName    the budget. Rows that predate this stay NULL,
--                                which the listing API reads as "no owner
--                                recorded" and keeps visible to everyone, so
--                                nothing disappears from anyone's Home page.
--   dbo.Users.AppRole          — application role: user | manager | director |
--                                super_admin. Defaults to 'user', the most
--                                restrictive level. This is separate from the
--                                platform (Entra/SWA) roles: SWA roles gate
--                                routes, AppRole decides what a signed-in user
--                                can see.
--
-- The app runs correctly whether or not this has been applied — api/shared/
-- schema.js probes for these columns and falls back — so there is no outage
-- window either side of running it. Roles, per-user visibility, and the
-- created-by avatars start working within a minute of the commit below.
-- ============================================================================

-- ============ SECTION 1 — preflight (read-only) ============
SET NOCOUNT ON;
SELECT 'Preflight' AS Step,
       DB_NAME() AS DatabaseName,
       IIF(OBJECT_ID('dbo.Users','U')   IS NULL, 'MISSING — run migrate_users.sql first', 'ok') AS UsersTable,
       IIF(OBJECT_ID('dbo.Budgets','U') IS NULL, 'MISSING', 'ok') AS BudgetsTable,
       IIF(COL_LENGTH('dbo.Budgets','CreatedById')   IS NULL, 'will add', 'already exists') AS Budgets_CreatedById,
       IIF(COL_LENGTH('dbo.Budgets','CreatedByName') IS NULL, 'will add', 'already exists') AS Budgets_CreatedByName,
       IIF(COL_LENGTH('dbo.Users','AppRole')         IS NULL, 'will add', 'already exists') AS Users_AppRole,
       IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_CreatedById'
                     AND object_id = OBJECT_ID('dbo.Budgets')), 'already exists', 'will add') AS OwnerIndex;
GO

-- ============ SECTION 2 — migration ============
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID('dbo.Users','U') IS NULL
  THROW 50001, 'dbo.Users is missing. Run sql/migrate_users.sql before this migration.', 1;
IF OBJECT_ID('dbo.Budgets','U') IS NULL
  THROW 50002, 'dbo.Budgets is missing. This database is not provisioned.', 1;

BEGIN TRANSACTION;

-- Ownership stamps. Nullable on purpose: existing budgets have no recorded
-- creator, and NULL is what the listing API treats as "visible to everyone".
IF COL_LENGTH('dbo.Budgets','CreatedById') IS NULL
  ALTER TABLE dbo.Budgets ADD CreatedById NVARCHAR(128) NULL;

IF COL_LENGTH('dbo.Budgets','CreatedByName') IS NULL
  ALTER TABLE dbo.Budgets ADD CreatedByName NVARCHAR(200) NULL;

-- Application role. NOT NULL with a default, so every existing row becomes
-- 'user' as the column is added — no separate backfill needed.
IF COL_LENGTH('dbo.Users','AppRole') IS NULL
  ALTER TABLE dbo.Users ADD AppRole NVARCHAR(50) NOT NULL
    CONSTRAINT DF_Users_AppRole DEFAULT 'user';

-- Keeps the ownership-filtered listing cheap. Deferred through sp_executesql:
-- the column may have been added by this same batch, and a batch is compiled
-- before it runs, so naming it directly would fail to bind.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_CreatedById'
                 AND object_id = OBJECT_ID('dbo.Budgets'))
  EXEC sp_executesql N'CREATE INDEX IX_Budgets_CreatedById
                         ON dbo.Budgets (CreatedById) WHERE IsDeleted = 0;';

COMMIT TRANSACTION;
PRINT 'Roles and ownership migration complete.';
GO

-- ============ SECTION 3 — verification (read-only) ============
-- One result set: the portal exports only the first.
SET NOCOUNT ON;
SELECT
  IIF(COL_LENGTH('dbo.Budgets','CreatedById')   IS NOT NULL, 'ok', 'MISSING') AS Budgets_CreatedById,
  IIF(COL_LENGTH('dbo.Budgets','CreatedByName') IS NOT NULL, 'ok', 'MISSING') AS Budgets_CreatedByName,
  IIF(COL_LENGTH('dbo.Users','AppRole')         IS NOT NULL, 'ok', 'MISSING') AS Users_AppRole,
  IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Budgets_CreatedById'
                AND object_id = OBJECT_ID('dbo.Budgets')), 'ok', 'MISSING') AS OwnerIndex,
  IIF(EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_Users_AppRole'), 'ok', 'MISSING') AS RoleDefault,
  (SELECT COUNT(*) FROM dbo.Users)   AS Users_Rows,
  (SELECT COUNT(*) FROM dbo.Budgets) AS Budget_Rows;
