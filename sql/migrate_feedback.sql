-- ============================================================================
-- Migration: in-app bug reports and feature requests (additive, idempotent)
--
-- Run in Azure Portal Query Editor as the database admin. Safe to run twice:
-- the table, its index and its constraints are existence-guarded, and a re-run
-- changes nothing.
--
-- Purely additive: no existing table, column, constraint, or row is touched.
--
-- Run order: after migrate_users.sql (dbo.Users must already exist — the
-- reporter's UserId points at it). Nothing else depends on this table.
--
-- What it adds:
--   dbo.Feedback — one row per report submitted from the bug button in the
--                  bottom-left corner of the app. The row is the record of
--                  record: it is written first, and only then is the email to
--                  matthews@finishessolutions.com attempted. If mail is
--                  misconfigured or Graph is down the report is still safely
--                  stored and visible on the Admin page, and EmailStatus says
--                  what happened.
--
-- The app runs correctly whether or not this has been applied — api/shared/
-- schema.js probes for the table and the feedback endpoint answers 503 with a
-- plain explanation until it exists — so there is no outage window either side
-- of running it. The bug button starts working within a minute of the commit.
-- ============================================================================

-- ============ SECTION 1 — preflight (read-only) ============
SET NOCOUNT ON;
SELECT 'Preflight' AS Step,
       DB_NAME() AS DatabaseName,
       IIF(OBJECT_ID('dbo.Users','U')    IS NULL, 'MISSING — run migrate_users.sql first', 'ok') AS UsersTable,
       IIF(OBJECT_ID('dbo.Feedback','U') IS NULL, 'will create', 'already exists') AS FeedbackTable,
       IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Feedback_Status_Created'
                     AND object_id = OBJECT_ID('dbo.Feedback')), 'already exists', 'will add') AS BoardIndex;
GO

-- ============ SECTION 2 — migration ============
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID('dbo.Users','U') IS NULL
  THROW 50001, 'dbo.Users is missing. Run sql/migrate_users.sql before this migration.', 1;

BEGIN TRANSACTION;

IF OBJECT_ID('dbo.Feedback','U') IS NULL
  CREATE TABLE dbo.Feedback (
      FeedbackId    INT             IDENTITY(1,1) NOT NULL,
      -- 'bug' or 'feature'. Kept as a short code, not a display string, so the
      -- wording on the button can change without touching stored rows.
      Kind          VARCHAR(20)     NOT NULL,
      -- What the reporter wrote. Title is the subject line of the email.
      Title         NVARCHAR(200)   NOT NULL,
      Body          NVARCHAR(MAX)   NOT NULL CONSTRAINT DF_Feedback_Body DEFAULT (N''),
      -- Bugs only: how badly it is hurting. NULL on feature requests.
      Severity      VARCHAR(20)     NULL,
      -- Who reported it. UserId is the SWA principal id, the same value used
      -- for CreatedById on budgets; the name and email are copied in so the
      -- board still reads correctly if the account is later removed.
      UserId        NVARCHAR(128)   NULL,
      UserName      NVARCHAR(200)   NULL,
      UserEmail     NVARCHAR(320)   NULL,
      -- Where they were and what they were running. This is the difference
      -- between a report you can act on and "it broke".
      PageRoute     NVARCHAR(200)   NULL,
      Environment   NVARCHAR(40)    NULL,
      AppVersion    NVARCHAR(120)   NULL,
      UserAgent     NVARCHAR(500)   NULL,
      Viewport      VARCHAR(40)     NULL,
      -- The full diagnostics block as JSON — the same rows the Version page
      -- shows. Stored whole so a later question can be answered without
      -- having guessed the right column today.
      ContextDoc    NVARCHAR(MAX)   NULL,
      -- Triage state, driven from the Admin board.
      Status        VARCHAR(20)     NOT NULL CONSTRAINT DF_Feedback_Status DEFAULT ('New'),
      AdminNotes    NVARCHAR(MAX)   NULL,
      -- Delivery bookkeeping for the notification email. 'pending' means the
      -- row was written but the send has not finished or was not configured.
      EmailStatus   VARCHAR(20)     NOT NULL CONSTRAINT DF_Feedback_Email DEFAULT ('pending'),
      EmailError    NVARCHAR(400)   NULL,
      EmailedAt     DATETIME2       NULL,
      CreatedAt     DATETIME2       NOT NULL CONSTRAINT DF_Feedback_Created DEFAULT (SYSUTCDATETIME()),
      UpdatedAt     DATETIME2       NOT NULL CONSTRAINT DF_Feedback_Updated DEFAULT (SYSUTCDATETIME()),
      CONSTRAINT PK_Feedback PRIMARY KEY (FeedbackId),
      -- The API validates all three of these as well; the constraints are here
      -- so a stray script cannot write a value the board cannot render.
      CONSTRAINT CK_Feedback_Kind   CHECK (Kind IN ('bug','feature')),
      CONSTRAINT CK_Feedback_Status CHECK (Status IN ('New','Triaged','In Progress','Done','Declined')),
      CONSTRAINT CK_Feedback_Email  CHECK (EmailStatus IN ('pending','sent','failed','disabled'))
  );

-- The board reads newest-first within a status, and counts by status for the
-- tab badges. Deferred through sp_executesql because the table may have been
-- created by this same batch, and a batch binds before it runs.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Feedback_Status_Created'
                 AND object_id = OBJECT_ID('dbo.Feedback'))
  EXEC sp_executesql N'CREATE INDEX IX_Feedback_Status_Created
                         ON dbo.Feedback (Status, CreatedAt DESC);';

-- Rate limiting counts recent rows for one reporter.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Feedback_User_Created'
                 AND object_id = OBJECT_ID('dbo.Feedback'))
  EXEC sp_executesql N'CREATE INDEX IX_Feedback_User_Created
                         ON dbo.Feedback (UserId, CreatedAt DESC);';

COMMIT TRANSACTION;
PRINT 'Feedback migration complete.';
GO

-- ============ SECTION 3 — verification (read-only) ============
-- One result set: the portal exports only the first.
SET NOCOUNT ON;
SELECT
  IIF(OBJECT_ID('dbo.Feedback','U') IS NOT NULL, 'ok', 'MISSING') AS FeedbackTable,
  IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Feedback_Status_Created'
                AND object_id = OBJECT_ID('dbo.Feedback')), 'ok', 'MISSING') AS BoardIndex,
  IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Feedback_User_Created'
                AND object_id = OBJECT_ID('dbo.Feedback')), 'ok', 'MISSING') AS ReporterIndex,
  IIF(EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Feedback_Kind'),   'ok', 'MISSING') AS KindCheck,
  IIF(EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Feedback_Status'), 'ok', 'MISSING') AS StatusCheck,
  IIF(EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Feedback_Email'),  'ok', 'MISSING') AS EmailCheck,
  (SELECT COUNT(*) FROM dbo.Feedback) AS Feedback_Rows;
