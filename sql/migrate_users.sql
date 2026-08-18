-- ============================================================================
-- Migration: per-user accounts, settings, and activity (additive, idempotent)
--
-- Run in Azure Portal Query Editor as the database admin. Safe to run twice:
-- every object is existence-guarded, and a re-run changes nothing.
--
-- Purely additive: no existing table, column, constraint, or row is touched.
-- Deployed code that predates these tables never reads them, so running this
-- before the app update ships is safe (and is the intended order).
--
-- What it creates:
--   dbo.Users        — one row per signed-in account, keyed by the stable
--                      Static Web Apps principal userId. Carries the user's
--                      profile fields (display name, contact email, phone)
--                      as real columns, the presentation preferences (theme,
--                      time format, accent color, table density, list vs
--                      card view, remembered export options...) as ONE JSON
--                      document — additive settings never need another
--                      migration — plus first/last-seen login bookkeeping.
--   dbo.UserActivity — append-only event log (logins, saves, exports,
--                      settings changes...), indexed for per-user timelines.
-- ============================================================================

-- ============ SECTION 1 — preflight (read-only) ============
SET NOCOUNT ON;
SELECT 'Preflight' AS Step,
       DB_NAME() AS DatabaseName,
       IIF(OBJECT_ID('dbo.Users','U')        IS NULL, 'will create', 'already exists') AS Users,
       IIF(OBJECT_ID('dbo.UserActivity','U') IS NULL, 'will create', 'already exists') AS UserActivity;
GO

-- ============ SECTION 2 — migration ============
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.Users','U') IS NULL
BEGIN
  CREATE TABLE dbo.Users (
      -- The SWA/Entra clientPrincipal.userId — stable per account, and the
      -- same value already written to CreatedById on budgets and analyses.
      UserId            NVARCHAR(128)  NOT NULL,
      -- Sign-in identity as reported by the platform (userDetails / UPN).
      UserDetails       NVARCHAR(200)  NULL,
      -- Profile fields the user edits in Settings. DisplayName overrides the
      -- platform name in "created by" lines; Email/Phone are contact info
      -- (Email may differ from the sign-in address; used by future
      -- notifications and email export).
      DisplayName       NVARCHAR(200)  NULL,
      Email             NVARCHAR(320)  NULL,
      Phone             NVARCHAR(40)   NULL,
      -- Presentation preferences as one JSON document: theme, timeFormat,
      -- accentColor, avatarColor (profile-icon background), tableDensity,
      -- homeView ('list' | 'cards' — Home only for now), exportOptions, and
      -- whatever arrives later — additive keys only, no further migrations.
      SettingsDoc       NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_Users_Settings DEFAULT (N'{}'),
      SettingsUpdatedAt DATETIME2      NULL,
      -- Login bookkeeping, maintained by the API on session bootstrap.
      FirstSeenAt       DATETIME2      NOT NULL CONSTRAINT DF_Users_FirstSeen DEFAULT (SYSUTCDATETIME()),
      LastSeenAt        DATETIME2      NOT NULL CONSTRAINT DF_Users_LastSeen  DEFAULT (SYSUTCDATETIME()),
      LoginCount        INT            NOT NULL CONSTRAINT DF_Users_Logins    DEFAULT (0),
      CreatedAt         DATETIME2      NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSUTCDATETIME()),
      UpdatedAt         DATETIME2      NOT NULL CONSTRAINT DF_Users_UpdatedAt DEFAULT (SYSUTCDATETIME()),
      CONSTRAINT PK_Users PRIMARY KEY (UserId),
      CONSTRAINT CK_Users_Settings CHECK (ISJSON(SettingsDoc) = 1)
  );
  PRINT 'Created dbo.Users';
END
ELSE PRINT 'dbo.Users already exists — skipped';

IF OBJECT_ID('dbo.UserActivity','U') IS NULL
BEGIN
  CREATE TABLE dbo.UserActivity (
      Id         BIGINT         IDENTITY(1,1) NOT NULL,
      UserId     NVARCHAR(128)  NOT NULL,
      -- 'login', 'budget_save', 'analysis_save', 'export_pdf', 'export_xlsx',
      -- 'settings_update', ... — a short machine keyword, never free text.
      EventType  VARCHAR(40)    NOT NULL,
      -- What the event touched, when it touched something: e.g.
      -- ('budget','BD-4821') or ('analysis','<guid>'). NULL for logins.
      EntityType VARCHAR(30)    NULL,
      EntityId   NVARCHAR(64)   NULL,
      -- Optional structured context (version number, export format...).
      DetailDoc  NVARCHAR(MAX)  NULL,
      CreatedAt  DATETIME2      NOT NULL CONSTRAINT DF_UserActivity_CreatedAt DEFAULT (SYSUTCDATETIME()),
      CONSTRAINT PK_UserActivity PRIMARY KEY (Id),
      CONSTRAINT FK_UserActivity_User FOREIGN KEY (UserId) REFERENCES dbo.Users (UserId),
      CONSTRAINT CK_UserActivity_Detail CHECK (DetailDoc IS NULL OR ISJSON(DetailDoc) = 1)
  );
  PRINT 'Created dbo.UserActivity';
END
ELSE PRINT 'dbo.UserActivity already exists — skipped';

-- Per-user timeline, newest first — the shape every activity view reads.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UserActivity_User_Created'
                 AND object_id = OBJECT_ID('dbo.UserActivity'))
  CREATE INDEX IX_UserActivity_User_Created
    ON dbo.UserActivity (UserId, CreatedAt DESC);

-- Event-type slices across users ("all exports this week", login history).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UserActivity_Type_Created'
                 AND object_id = OBJECT_ID('dbo.UserActivity'))
  CREATE INDEX IX_UserActivity_Type_Created
    ON dbo.UserActivity (EventType, CreatedAt DESC);

COMMIT TRANSACTION;
PRINT 'User settings migration complete.';
GO

-- ============ SECTION 3 — quick verification (read-only) ============
SET NOCOUNT ON;
SELECT
  IIF(OBJECT_ID('dbo.Users','U')        IS NOT NULL, 'ok', 'MISSING') AS Users,
  IIF(OBJECT_ID('dbo.UserActivity','U') IS NOT NULL, 'ok', 'MISSING') AS UserActivity,
  IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UserActivity_User_Created'
                AND object_id = OBJECT_ID('dbo.UserActivity')), 'ok', 'MISSING') AS TimelineIndex,
  IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UserActivity_Type_Created'
                AND object_id = OBJECT_ID('dbo.UserActivity')), 'ok', 'MISSING') AS TypeIndex,
  (SELECT COUNT(*) FROM dbo.Users)        AS Users_Rows,
  (SELECT COUNT(*) FROM dbo.UserActivity) AS Activity_Rows;
