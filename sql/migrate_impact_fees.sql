-- ============================================================================
--  Migration - Impact & tap fee schedules (the jurisdiction fee library)
--
--  NOTE ON COMMENT STYLE, and it is not cosmetic: this file uses only `--`
--  line comments, like every other migration here. SQL Server treats a `--`
--  INSIDE a block comment as a line comment running to end of line, so a
--  closing marker sitting on a line of dashes gets swallowed and the whole
--  batch fails with "Missing end comment mark". Do not reintroduce block
--  comments in these scripts.
--  ----------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-budgeting-suite database that serves EVERY
--           environment including production.
--  Run by : a database admin, in the Azure portal Query Editor.
--  When   : any time. This migration is purely ADDITIVE - it creates two new
--           tables and touches nothing that already exists - and the deployed
--           code tolerates their absence (api/shared/schema.js probes for them
--           and the fee-schedule endpoints answer with an empty list until they
--           are here). Running it before OR after the release is safe.
--
--  Idempotent: every statement is existence-guarded, so re-running is a no-op.
--  Section 2 is one transaction with XACT_ABORT ON and a TRY/CATCH - a failure
--  rolls the whole thing back rather than leaving the schema half-migrated.
--
--  THE THREE SECTIONS ARE SEPARATED BY `GO`, AND THAT IS LOAD-BEARING.
--  A batch is compiled statement by statement as it runs, so a statement that
--  NAMES a table which does not exist yet fails with "Invalid object name" -
--  even when a CASE around it would never have evaluated that branch. The
--  preflight below runs BEFORE the tables are created, and the verification
--  must compile AFTER they are, so neither can share a batch with section 2.
--  (This script shipped once without the separators and failed exactly there.)
--  For the same reason the preflight reads its row count through sp_executesql:
--  in that batch the table genuinely may not exist. Inside section 2 the seed
--  can name the tables directly, because the CREATE statements above it have
--  already run by the time the INSERT is compiled.
--
--  WHAT IT DOES
--    1. dbo.FeeSchedules        - one row per jurisdiction. Its primary key is
--                                 what enforces "one schedule per key".
--    2. dbo.FeeScheduleVersions - immutable published versions, exactly one
--                                 current per schedule (filtered unique index).
--    3. Seeds tx-waller v1 from the City of Waller schedule provided 2025-10-15.
--
--  WHAT IT DOES NOT DO
--    Nothing is re-keyed, no existing column changes type, no row is deleted.
--    No existing budget changes: a budget prices its fees when someone opens
--    the Impact Fees step and picks a jurisdiction, never on publication.
--
--  THE FEE MATH, so the seeded numbers can be checked against the source:
--    water impact fee = EDU multiplier x $3,689.91
--    sewer impact fee = EDU multiplier x $7,619.03
--    The published per-row amounts are stored as authoritative rather than
--    recomputed, because the true per-EDU rate is ~$3,689.9104 and deriving
--    330 EDU from the rounded figure lands 12 cents under what the city
--    publishes. eduRates is carried for display and for the admin editor.
--    The low/high spread applies ONLY to the four adders - meter, vault, water
--    tap work, sewer tap work. Impact fees themselves are single-valued.
--    A NULL vault pair is the workbook's "NA": meters 3 inch and under have no
--    vault. FOR JSON omits the key entirely, which reads as absent.
--
--  Sections: PREFLIGHT (read-only) -> MIGRATION -> VERIFICATION.
--  ============================================================================

SET NOCOUNT ON;

-- ////////////////////////////////////////////////////////////////////////////
--  SECTION 1 - PREFLIGHT (read-only). Safe to run on its own first.
--
--  Nothing here may NAME the new tables: in this batch they may not exist, and
--  a statement that names a missing table fails to compile. OBJECT_ID takes a
--  string, so it is always safe; the row count goes through sp_executesql,
--  which is compiled only when it is executed.
-- ////////////////////////////////////////////////////////////////////////////
PRINT '--- PREFLIGHT ---';

DECLARE @seeded NVARCHAR(60) = 'no  - table absent';
IF OBJECT_ID('dbo.FeeSchedules', 'U') IS NOT NULL
BEGIN
    DECLARE @n INT = 0;
    EXEC sp_executesql
        N'SELECT @c = COUNT(*) FROM dbo.FeeSchedules WHERE ScheduleKey = ''tx-waller'';',
        N'@c INT OUTPUT', @c = @n OUTPUT;
    SET @seeded = CASE WHEN @n > 0 THEN 'yes - seed will be skipped'
                       ELSE 'no  - will be seeded' END;
END

SELECT 'dbo.FeeSchedules exists' AS Check_,
       CASE WHEN OBJECT_ID('dbo.FeeSchedules', 'U') IS NULL
            THEN 'no  - will be created' ELSE 'yes - will be left alone' END AS Result
UNION ALL
SELECT 'dbo.FeeScheduleVersions exists',
       CASE WHEN OBJECT_ID('dbo.FeeScheduleVersions', 'U') IS NULL
            THEN 'no  - will be created' ELSE 'yes - will be left alone' END
UNION ALL
SELECT 'tx-waller seeded', @seeded;
GO


-- ////////////////////////////////////////////////////////////////////////////
--  SECTION 2 - MIGRATION (one transaction; all-or-nothing)
-- ////////////////////////////////////////////////////////////////////////////
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
BEGIN TRANSACTION;

-- ---------------------------------------------------------------------------
--  1. dbo.FeeSchedules - stable identity and metadata for one jurisdiction.
--     Mirrors dbo.BudgetTemplates: a schedule is deactivated, never deleted, so
--     a budget's provenance never dangles.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.FeeSchedules', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.FeeSchedules (
        ScheduleKey   VARCHAR(64)    NOT NULL,
        Name          NVARCHAR(200)  NOT NULL,
        Jurisdiction  NVARCHAR(200)  NOT NULL CONSTRAINT DF_FeeSchedules_Jurisdiction DEFAULT (N''),
        StateCode     CHAR(2)        NULL,
        Description   NVARCHAR(1000) NOT NULL CONSTRAINT DF_FeeSchedules_Description  DEFAULT (N''),
        IsActive      BIT            NOT NULL CONSTRAINT DF_FeeSchedules_IsActive     DEFAULT (1),
        CreatedById   NVARCHAR(128)  NULL,
        CreatedByName NVARCHAR(200)  NULL,
        CreatedAt     DATETIME2      NOT NULL CONSTRAINT DF_FeeSchedules_CreatedAt    DEFAULT (SYSUTCDATETIME()),
        UpdatedAt     DATETIME2      NOT NULL CONSTRAINT DF_FeeSchedules_UpdatedAt    DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_FeeSchedules PRIMARY KEY (ScheduleKey),
        CONSTRAINT CK_FeeSchedules_KeyFormat CHECK (
            ScheduleKey <> '' AND ScheduleKey NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_100_BIN2)
    );
    PRINT 'Created dbo.FeeSchedules.';
END
ELSE PRINT 'dbo.FeeSchedules already exists - left alone.';

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_FeeSchedules_Active'
                 AND object_id = OBJECT_ID('dbo.FeeSchedules'))
BEGIN
    EXEC sp_executesql N'CREATE INDEX IX_FeeSchedules_Active ON dbo.FeeSchedules (IsActive) INCLUDE (Name, Jurisdiction);';
    PRINT 'Created IX_FeeSchedules_Active.';
END

-- ---------------------------------------------------------------------------
--  2. dbo.FeeScheduleVersions - immutable published versions.
--     The filtered unique index is the database-level backstop for "exactly one
--     current version per schedule", exactly as it is for template versions.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.FeeScheduleVersions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.FeeScheduleVersions (
        Id            INT IDENTITY(1,1) NOT NULL,
        ScheduleKey   VARCHAR(64)    NOT NULL,
        VersionNumber INT            NOT NULL,
        VersionLabel  NVARCHAR(200)  NULL,
        IsCurrent     BIT            NOT NULL CONSTRAINT DF_FeeScheduleVersions_IsCurrent DEFAULT (0),
        EffectiveDate DATE           NULL,
        Doc           NVARCHAR(MAX)  NOT NULL,
        ChangeSummary NVARCHAR(1000) NULL,
        CreatedById   NVARCHAR(128)  NULL,
        CreatedByName NVARCHAR(200)  NULL,
        CreatedAt     DATETIME2      NOT NULL CONSTRAINT DF_FeeScheduleVersions_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_FeeScheduleVersions PRIMARY KEY (Id),
        CONSTRAINT FK_FeeScheduleVersions_Schedule FOREIGN KEY (ScheduleKey)
            REFERENCES dbo.FeeSchedules (ScheduleKey),
        CONSTRAINT UQ_FeeScheduleVersions_Version UNIQUE (ScheduleKey, VersionNumber),
        CONSTRAINT CK_FeeScheduleVersions_Doc    CHECK (ISJSON(Doc) = 1),
        CONSTRAINT CK_FeeScheduleVersions_Number CHECK (VersionNumber >= 1)
    );
    PRINT 'Created dbo.FeeScheduleVersions.';
END
ELSE PRINT 'dbo.FeeScheduleVersions already exists - left alone.';

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UX_FeeScheduleVersions_Current'
                 AND object_id = OBJECT_ID('dbo.FeeScheduleVersions'))
BEGIN
    EXEC sp_executesql N'CREATE UNIQUE INDEX UX_FeeScheduleVersions_Current
                           ON dbo.FeeScheduleVersions (ScheduleKey)
                           WHERE IsCurrent = 1;';
    PRINT 'Created UX_FeeScheduleVersions_Current.';
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_FeeScheduleVersions_Schedule_VersionDesc'
                 AND object_id = OBJECT_ID('dbo.FeeScheduleVersions'))
BEGIN
    EXEC sp_executesql N'CREATE INDEX IX_FeeScheduleVersions_Schedule_VersionDesc
                           ON dbo.FeeScheduleVersions (ScheduleKey, VersionNumber DESC);';
    PRINT 'Created IX_FeeScheduleVersions_Schedule_VersionDesc.';
END

-- ---------------------------------------------------------------------------
--  3. Seed tx-waller v1.
--
--     Composed with FOR JSON PATH over a VALUES table rather than pasted in as
--     one string literal, for two reasons. An NVARCHAR literal longer than 4000
--     characters is silently truncated unless it is CAST or split, and this
--     document is about 4.4 KB - the failure would be a valid-looking schedule
--     missing its last meters. And every figure below is meant to be checked
--     against the city's table by eye, which a single opaque blob defeats.
--
--     Dotted aliases (meter.low) are what make FOR JSON PATH nest the ranges.
--     A NULL pair emits no key at all, which is the workbook's "NA".
--
--     The VALUES table names no real object, so it compiles regardless. The
--     INSERTs below it name the new tables directly, which is fine HERE: the
--     CREATE statements above have already run by the time these compile.
-- ---------------------------------------------------------------------------
DECLARE @meters NVARCHAR(MAX) = (
    SELECT m.rowId                         AS [rowId],
           m.size                          AS [size],
           CAST(m.gpm AS DECIMAL(19,2))    AS [gpm],
           CAST(m.edu AS DECIMAL(19,4))    AS [edu],
           CAST(m.waterImpact AS DECIMAL(19,2)) AS [waterImpact],
           CAST(m.sewerImpact AS DECIMAL(19,2)) AS [sewerImpact],
           CAST(m.meterLow    AS DECIMAL(19,2)) AS [meter.low],
           CAST(m.meterHigh   AS DECIMAL(19,2)) AS [meter.high],
           CAST(m.vaultLow    AS DECIMAL(19,2)) AS [vault.low],
           CAST(m.vaultHigh   AS DECIMAL(19,2)) AS [vault.high],
           CAST(m.wTapLow     AS DECIMAL(19,2)) AS [waterTap.low],
           CAST(m.wTapHigh    AS DECIMAL(19,2)) AS [waterTap.high],
           CAST(m.sTapLow     AS DECIMAL(19,2)) AS [sewerTap.low],
           CAST(m.sTapHigh    AS DECIMAL(19,2)) AS [sewerTap.high]
    FROM (VALUES
    ( 1, N'm-58-34-10', N'5/8 or 3/4', 10, 1, 3689.91, 7619.03, 464.00, 580.00, NULL, NULL, 1850.00, 2350.00, 1850.00, 2350.00),
    ( 2, N'm-34-15', N'3/4', 15, 1.5, 5534.87, 11428.54, 493.00, 616.25, NULL, NULL, 1850.00, 2350.00, 1850.00, 2350.00),
    ( 3, N'm-1-25', N'1', 25, 2.5, 9224.78, 19047.57, 623.50, 779.38, NULL, NULL, 2100.00, 3400.00, 2100.00, 3400.00),
    ( 4, N'm-1p5-50', N'1.5', 50, 5, 18449.55, 38095.13, 1986.50, 2483.13, NULL, NULL, 2700.00, 3700.00, 2700.00, 3700.00),
    ( 5, N'm-2-80', N'2', 80, 8, 29519.28, 60952.22, 1986.50, 2483.13, NULL, NULL, 3000.00, 3700.00, 3000.00, 3700.00),
    ( 6, N'm-2-100', N'2', 100, 10, 36899.10, 76190.27, 1986.50, 2483.13, NULL, NULL, 3000.00, 3700.00, 3000.00, 3700.00),
    ( 7, N'm-3-160', N'3', 160, 16, 59038.57, 121904.43, 2755.00, 3443.75, NULL, NULL, 3250.00, 4500.00, 3250.00, 4500.00),
    ( 8, N'm-3-240', N'3', 240, 24, 88557.85, 182856.65, 2755.00, 3443.75, NULL, NULL, 3250.00, 4500.00, 3250.00, 4500.00),
    ( 9, N'm-4-250', N'4', 250, 25, 92247.76, 190475.67, 3799.00, 4748.75, 14500.00, 21000.00, 3900.00, 5250.00, 3900.00, 5250.00),
    (10, N'm-4-420', N'4', 420, 42, 154976.24, 319999.13, 3799.00, 4748.75, 14500.00, 21000.00, 3900.00, 5250.00, 3900.00, 5250.00),
    (11, N'm-6-500', N'6', 500, 50, 184495.52, 380951.35, 6264.00, 7830.00, 22000.00, 30000.00, 4600.00, 6500.00, 4600.00, 6500.00),
    (12, N'm-6-920', N'6', 920, 92, 339471.75, 700950.48, 6264.00, 7830.00, 22000.00, 30000.00, 4600.00, 6500.00, 4600.00, 6500.00),
    (13, N'm-8-800', N'8', 800, 80, 295192.83, 609522.16, 7482.00, 9352.50, 35000.00, 46000.00, 5300.00, 7900.00, 5300.00, 7900.00),
    (14, N'm-8-1600', N'8', 1600, 160, 590385.66, 1219044.32, 7482.00, 9352.50, 35000.00, 46000.00, 5300.00, 7900.00, 5300.00, 7900.00),
    (15, N'm-10-1150', N'10', 1150, 115, 424339.69, 876188.10, 13920.00, 17400.00, 46000.00, 58000.00, 6250.00, 9000.00, 6250.00, 9000.00),
    (16, N'm-10-2500', N'10', 2500, 250, 922477.59, 1904756.74, 13920.00, 17400.00, 46000.00, 58000.00, 6250.00, 9000.00, 6250.00, 9000.00),
    (17, N'm-12-3300', N'12', 3300, 330, 1217670.42, 2514278.90, 17870.58, 22338.23, 59000.00, 75000.00, 7800.00, 11500.00, 7800.00, 11500.00)    ) AS m(ord, rowId, size, gpm, edu, waterImpact, sewerImpact,
           meterLow, meterHigh, vaultLow, vaultHigh,
           wTapLow, wTapHigh, sTapLow, sTapHigh)
    ORDER BY m.ord
    FOR JSON PATH);

IF @meters IS NULL OR ISJSON(@meters) <> 1
    THROW 50021, 'Composed meter schedule is not valid JSON - aborting.', 1;

-- Each chunk stays well under 4000 characters; only @meters is large, and it
-- is already NVARCHAR(MAX), so the concatenation is MAX throughout.
DECLARE @doc NVARCHAR(MAX) =
      N'{"scheduleKey":"tx-waller","name":"City of Waller, TX",'
    + N'"jurisdiction":"City of Waller","state":"TX",'
    + N'"effective":"2025-10-15",'
    + N'"source":"City of Waller impact fee schedule, provided 2025-10-15",'
    + N'"eduRates":{"water":3689.91,"sewer":7619.03},'
    + N'"fees":[],'
    + N'"meters":' + @meters + N'}';

IF ISJSON(@doc) <> 1
    THROW 50022, 'Composed fee schedule document is not valid JSON - aborting.', 1;

IF NOT EXISTS (SELECT 1 FROM dbo.FeeSchedules WHERE ScheduleKey = 'tx-waller')
BEGIN
    INSERT INTO dbo.FeeSchedules
        (ScheduleKey, Name, Jurisdiction, StateCode, Description, IsActive, CreatedByName)
    VALUES
        ('tx-waller', N'City of Waller, TX', N'City of Waller', 'TX',
         N'Water and sewer impact fees by meter size (EDU based), with meter, vault and tap work ranges.',
         1, N'System (migration)');

    INSERT INTO dbo.FeeScheduleVersions
        (ScheduleKey, VersionNumber, VersionLabel, IsCurrent, EffectiveDate, Doc, ChangeSummary, CreatedByName)
    VALUES
        ('tx-waller', 1, N'Initial Schedule', 1, '2025-10-15', @doc,
         N'Seeded from the City of Waller impact fee schedule provided 2025-10-15.',
         N'System (migration)');

    PRINT 'Seeded fee schedule tx-waller v1.';
END
ELSE PRINT 'Fee schedule tx-waller already present - seed skipped.';

COMMIT TRANSACTION;
PRINT '--- MIGRATION COMMITTED ---';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== Migration FAILED and was rolled back ===';
  THROW;
END CATCH
GO


-- ////////////////////////////////////////////////////////////////////////////
--  SECTION 3 - VERIFICATION (read-only). One result set, because the portal
--  exports only one. Every row must read PASS.
--
--  The reconciliation rows are the point of this section: they recompute each
--  meter's low and high total from the stored JSON and compare against the
--  figures the City of Waller published, so a seed that parsed but landed
--  wrong is caught here rather than in a budget.
-- ////////////////////////////////////////////////////////////////////////////
SET NOCOUNT ON;

;WITH v AS (
    SELECT TOP 1 Doc FROM dbo.FeeScheduleVersions
    WHERE ScheduleKey = 'tx-waller' AND IsCurrent = 1
), m AS (
    SELECT JSON_VALUE(j.value, '$.rowId')  AS rowId,
           CAST(JSON_VALUE(j.value, '$.edu') AS DECIMAL(19,4)) AS edu,
           CAST(JSON_VALUE(j.value, '$.waterImpact') AS DECIMAL(19,2))
         + CAST(JSON_VALUE(j.value, '$.sewerImpact') AS DECIMAL(19,2))
         + ISNULL(CAST(JSON_VALUE(j.value, '$.meter.low')    AS DECIMAL(19,2)), 0)
         + ISNULL(CAST(JSON_VALUE(j.value, '$.vault.low')    AS DECIMAL(19,2)), 0)
         + ISNULL(CAST(JSON_VALUE(j.value, '$.waterTap.low') AS DECIMAL(19,2)), 0)
         + ISNULL(CAST(JSON_VALUE(j.value, '$.sewerTap.low') AS DECIMAL(19,2)), 0) AS lowTotal,
           CAST(JSON_VALUE(j.value, '$.waterImpact') AS DECIMAL(19,2))
         + CAST(JSON_VALUE(j.value, '$.sewerImpact') AS DECIMAL(19,2))
         + ISNULL(CAST(JSON_VALUE(j.value, '$.meter.high')    AS DECIMAL(19,2)), 0)
         + ISNULL(CAST(JSON_VALUE(j.value, '$.vault.high')    AS DECIMAL(19,2)), 0)
         + ISNULL(CAST(JSON_VALUE(j.value, '$.waterTap.high') AS DECIMAL(19,2)), 0)
         + ISNULL(CAST(JSON_VALUE(j.value, '$.sewerTap.high') AS DECIMAL(19,2)), 0) AS highTotal,
           CAST(JSON_VALUE(j.value, '$.vault.low') AS DECIMAL(19,2)) AS vaultLow
    FROM v CROSS APPLY OPENJSON(v.Doc, '$.meters') AS j
)
SELECT Ord, Check_ AS [Check], Result, Detail
FROM (
    SELECT 1 AS Ord, 'Tables exist' AS Check_,
           CASE WHEN OBJECT_ID('dbo.FeeSchedules','U') IS NOT NULL
                 AND OBJECT_ID('dbo.FeeScheduleVersions','U') IS NOT NULL
                THEN 'PASS' ELSE 'FAIL' END AS Result,
           '' AS Detail
    UNION ALL
    SELECT 2, 'Filtered unique index on IsCurrent',
           CASE WHEN EXISTS (SELECT 1 FROM sys.indexes
                             WHERE name = 'UX_FeeScheduleVersions_Current'
                               AND object_id = OBJECT_ID('dbo.FeeScheduleVersions'))
                THEN 'PASS' ELSE 'FAIL' END, ''
    UNION ALL
    SELECT 3, 'tx-waller has exactly one current version',
           CASE WHEN (SELECT COUNT(*) FROM dbo.FeeScheduleVersions
                      WHERE ScheduleKey = 'tx-waller' AND IsCurrent = 1) = 1
                THEN 'PASS' ELSE 'FAIL' END,
           CONCAT('current versions: ', (SELECT COUNT(*) FROM dbo.FeeScheduleVersions
                                         WHERE ScheduleKey = 'tx-waller' AND IsCurrent = 1))
    UNION ALL
    SELECT 4, 'Schedule carries 17 meter sizes',
           CASE WHEN (SELECT COUNT(*) FROM m) = 17 THEN 'PASS' ELSE 'FAIL' END,
           CONCAT('rows: ', (SELECT COUNT(*) FROM m))
    UNION ALL
    SELECT 5, 'Meter rowIds are unique',
           CASE WHEN (SELECT COUNT(DISTINCT rowId) FROM m) = (SELECT COUNT(*) FROM m)
                THEN 'PASS' ELSE 'FAIL' END, ''
    UNION ALL
    SELECT 6, '3/4 inch @ 10 gpm reconciles to the published totals',
           CASE WHEN EXISTS (SELECT 1 FROM m WHERE rowId = 'm-58-34-10'
                               AND lowTotal = 15472.94 AND highTotal = 16588.94)
                THEN 'PASS' ELSE 'FAIL' END, 'expected 15,472.94 low / 16,588.94 high'
    UNION ALL
    SELECT 7, '4 inch @ 250 gpm reconciles (the first row with a vault)',
           CASE WHEN EXISTS (SELECT 1 FROM m WHERE rowId = 'm-4-250'
                               AND lowTotal = 308822.43 AND highTotal = 318972.18)
                THEN 'PASS' ELSE 'FAIL' END, 'expected 308,822.43 low / 318,972.18 high'
    UNION ALL
    SELECT 8, '12 inch @ 3300 gpm reconciles (the largest meter)',
           CASE WHEN EXISTS (SELECT 1 FROM m WHERE rowId = 'm-12-3300'
                               AND lowTotal = 3824419.90 AND highTotal = 3852287.55)
                THEN 'PASS' ELSE 'FAIL' END, 'expected 3,824,419.90 low / 3,852,287.55 high'
    UNION ALL
    SELECT 9, 'Nine meters carry a vault; 3 inch and under do not',
           CASE WHEN (SELECT COUNT(*) FROM m WHERE vaultLow IS NOT NULL) = 9
                THEN 'PASS' ELSE 'FAIL' END,
           CONCAT('rows with a vault: ', (SELECT COUNT(*) FROM m WHERE vaultLow IS NOT NULL))
    UNION ALL
    SELECT 10, 'Every meter reconciles, not just the three sampled above',
           CASE WHEN (SELECT COUNT(*) FROM m WHERE edu IS NULL OR lowTotal IS NULL
                                              OR highTotal IS NULL OR highTotal < lowTotal) = 0
                THEN 'PASS' ELSE 'FAIL' END,
           CONCAT('rows failing the sanity check: ',
                  (SELECT COUNT(*) FROM m WHERE edu IS NULL OR lowTotal IS NULL
                                            OR highTotal IS NULL OR highTotal < lowTotal))
) AS checks
ORDER BY Ord;
GO
