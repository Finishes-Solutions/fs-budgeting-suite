-- ============================================================================
-- READ-ONLY preflight for the Investment Analysis build.
-- Run in Azure Portal Query Editor against the application database (NOT
-- master), signed in as the database admin. Export the single result grid
-- and provide it before the build starts. This script changes nothing.
--
-- It consolidates pre-plan Queries A-I into one result set because the
-- portal exports only the first result set of a run. Then run the existing
-- sql/verify_migration.sql as the final step (pre-plan Query J).
--
-- Reading the output:
--   FAIL  -> stop; the build must not start until it is explained/repaired.
--   PASS  -> the check holds.
--   INFO  -> evidence to record (identity, counts, column/index inventory).
-- ============================================================================
SET NOCOUNT ON;

SELECT Section, Item, Status, Detail FROM (

-- ---- A · Identity: where this is running and as whom ----------------------
SELECT 10 AS SortKey, 'A Identity' AS Section, 'Database' AS Item,
       CASE WHEN DB_NAME() IN ('master','model','msdb','tempdb') THEN 'FAIL' ELSE 'INFO' END AS Status,
       CONCAT(DB_NAME(), ' on ', CAST(SERVERPROPERTY('ServerName') AS NVARCHAR(256)),
              ' · ', CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)),
              ' · v', CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64))) AS Detail
UNION ALL
SELECT 11, 'A Identity', 'Login / database user', 'INFO',
       CONCAT(ORIGINAL_LOGIN(), ' -> ', USER_NAME(), ' · checked ',
              CONVERT(NVARCHAR(32), SYSUTCDATETIME(), 126), 'Z')
UNION ALL
SELECT 12, 'A Identity', 'Database state',
       CASE WHEN d.state_desc = 'ONLINE' AND d.user_access_desc = 'MULTI_USER' THEN 'PASS' ELSE 'FAIL' END,
       CONCAT(d.state_desc, ' · ', d.user_access_desc, ' · compat ', d.compatibility_level,
              ' · ', d.collation_name COLLATE DATABASE_DEFAULT)
  FROM sys.databases AS d WHERE d.name = DB_NAME()

-- ---- B · Permission to run the eventual migration -------------------------
UNION ALL
SELECT 20, 'B Permissions', 'CREATE TABLE',
       CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE TABLE') = 1 THEN 'PASS' ELSE 'FAIL' END,
       'Required for the investment migration'
UNION ALL
SELECT 21, 'B Permissions', 'CREATE VIEW',
       CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE VIEW') = 1 THEN 'PASS' ELSE 'FAIL' END,
       'Required for views.sql updates'
UNION ALL
SELECT 22, 'B Permissions', 'ALTER dbo schema',
       CASE WHEN HAS_PERMS_BY_NAME('dbo','SCHEMA','ALTER') = 1 THEN 'PASS' ELSE 'FAIL' END,
       'Required to add tables/constraints in dbo'
UNION ALL
SELECT 23, 'B Permissions', 'Role membership', 'INFO',
       CONCAT('db_owner=', ISNULL(IS_MEMBER('db_owner'), 0),
              ' · db_ddladmin=', ISNULL(IS_MEMBER('db_ddladmin'), 0),
              ' · datareader=', ISNULL(IS_MEMBER('db_datareader'), 0),
              ' · datawriter=', ISNULL(IS_MEMBER('db_datawriter'), 0))

-- ---- C · Required current objects all exist -------------------------------
UNION ALL
SELECT 30, 'C Required objects', req.ObjectName,
       CASE WHEN (req.ObjectType = 'TABLE' AND OBJECT_ID(req.ObjectName, 'U') IS NOT NULL)
              OR (req.ObjectType = 'VIEW'  AND OBJECT_ID(req.ObjectName, 'V') IS NOT NULL)
            THEN 'PASS' ELSE 'FAIL' END,
       CONCAT(req.ObjectType, CASE WHEN (req.ObjectType = 'TABLE' AND OBJECT_ID(req.ObjectName, 'U') IS NULL)
                                     OR (req.ObjectType = 'VIEW'  AND OBJECT_ID(req.ObjectName, 'V') IS NULL)
                                   THEN ' — MISSING: run/repair the budget migration first' ELSE '' END)
  FROM (VALUES
    ('dbo.PricingLibrary','TABLE'), ('dbo.BudgetTemplates','TABLE'),
    ('dbo.BudgetTemplateVersions','TABLE'), ('dbo.Budgets','TABLE'),
    ('dbo.SovLines','TABLE'), ('dbo.BudgetVersions','TABLE'),
    ('dbo.BudgetVersionSovLines','TABLE'),
    ('dbo.vw_Budgets','VIEW'), ('dbo.vw_SovScopeRollup','VIEW'),
    ('dbo.vw_PricingVersions','VIEW'), ('dbo.vw_DeletedBudgets','VIEW')
  ) AS req(ObjectName, ObjectType)

-- ---- D · No conflicting investment/underwriting schema --------------------
UNION ALL
SELECT 40, 'D Collision check', 'Existing Investment*/Underwriting objects',
       CASE WHEN EXISTS (
              SELECT 1 FROM sys.objects AS o
              WHERE o.name LIKE '%Investment%' OR o.name LIKE '%Underwriting%')
            THEN 'FAIL' ELSE 'PASS' END,
       ISNULL(STUFF((SELECT ', ' + s.name COLLATE DATABASE_DEFAULT + '.'
                            + o.name COLLATE DATABASE_DEFAULT + ' ('
                            + o.type_desc COLLATE DATABASE_DEFAULT + ')'
                       FROM sys.objects AS o
                       JOIN sys.schemas AS s ON s.schema_id = o.schema_id
                      WHERE o.name LIKE '%Investment%' OR o.name LIKE '%Underwriting%'
                      ORDER BY o.name FOR XML PATH(''), TYPE).value('.','NVARCHAR(MAX)'), 1, 2, ''),
              'None found — clean slate for the new tables')

-- ---- E · Column inventory of the tables the migration references ----------
-- Compare against sql/schema.sql; drift must be resolved before FKs are added.
UNION ALL
SELECT 50, 'E Columns',
       CONCAT(t.name COLLATE DATABASE_DEFAULT, '.',
              RIGHT('00' + CAST(c.column_id AS VARCHAR(3)), 3), ' ',
              c.name COLLATE DATABASE_DEFAULT),
       'INFO',
       CONCAT(ty.name COLLATE DATABASE_DEFAULT,
              CASE WHEN ty.name IN ('nvarchar','nchar','varchar','char') THEN
                CONCAT('(', CASE WHEN c.max_length = -1 THEN 'MAX'
                                 WHEN ty.name IN ('nvarchar','nchar') THEN CAST(c.max_length / 2 AS VARCHAR(8))
                                 ELSE CAST(c.max_length AS VARCHAR(8)) END, ')')
                   WHEN ty.name IN ('decimal','numeric') THEN CONCAT('(', c.precision, ',', c.scale, ')')
                   ELSE '' END,
              CASE WHEN c.is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END,
              CASE WHEN c.is_identity = 1 THEN ' IDENTITY' ELSE '' END)
  FROM sys.tables  AS t
  JOIN sys.schemas AS s  ON s.schema_id = t.schema_id
  JOIN sys.columns AS c  ON c.object_id = t.object_id
  JOIN sys.types   AS ty ON ty.user_type_id = c.user_type_id
 WHERE s.name = 'dbo'
   AND t.name IN ('Budgets','BudgetVersions','SovLines','BudgetVersionSovLines',
                  'BudgetTemplates','BudgetTemplateVersions','PricingLibrary')

-- ---- F · Foreign keys and indexes on those tables -------------------------
UNION ALL
SELECT 60, 'F Foreign keys', fk.name COLLATE DATABASE_DEFAULT,
       CASE WHEN fk.is_disabled = 1 OR fk.is_not_trusted = 1 THEN 'FAIL' ELSE 'INFO' END,
       CONCAT(OBJECT_NAME(fk.parent_object_id) COLLATE DATABASE_DEFAULT, ' -> ',
              OBJECT_NAME(fk.referenced_object_id) COLLATE DATABASE_DEFAULT,
              ' · ON DELETE ', fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT,
              CASE WHEN fk.is_disabled = 1 THEN ' · DISABLED' ELSE '' END,
              CASE WHEN fk.is_not_trusted = 1 THEN ' · NOT TRUSTED' ELSE '' END)
  FROM sys.foreign_keys AS fk
 WHERE OBJECT_NAME(fk.parent_object_id) IN
       ('Budgets','BudgetVersions','SovLines','BudgetVersionSovLines',
        'BudgetTemplates','BudgetTemplateVersions')
UNION ALL
SELECT 65, 'F Indexes',
       CONCAT(OBJECT_NAME(i.object_id) COLLATE DATABASE_DEFAULT, '.',
              i.name COLLATE DATABASE_DEFAULT),
       CASE WHEN i.is_disabled = 1 THEN 'FAIL' ELSE 'INFO' END,
       CONCAT(CASE WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE 'nonunique' END,
              CASE WHEN i.has_filter = 1
                   THEN CONCAT(' · filtered: ', i.filter_definition COLLATE DATABASE_DEFAULT)
                   ELSE '' END,
              CASE WHEN i.is_disabled = 1 THEN ' · DISABLED' ELSE '' END)
  FROM sys.indexes AS i
 WHERE OBJECT_NAME(i.object_id) IN
       ('Budgets','BudgetVersions','SovLines','BudgetVersionSovLines',
        'BudgetTemplates','BudgetTemplateVersions','PricingLibrary')
   AND i.name IS NOT NULL

-- ---- G · Row counts: the "before" snapshot for the additive migration -----
UNION ALL
SELECT 70, 'G Row counts', v.ObjectName, 'INFO', CONCAT(v.Rows, ' rows')
  FROM (SELECT 'dbo.PricingLibrary' AS ObjectName, COUNT_BIG(*) AS Rows FROM dbo.PricingLibrary
        UNION ALL SELECT 'dbo.BudgetTemplates', COUNT_BIG(*) FROM dbo.BudgetTemplates
        UNION ALL SELECT 'dbo.BudgetTemplateVersions', COUNT_BIG(*) FROM dbo.BudgetTemplateVersions
        UNION ALL SELECT 'dbo.Budgets', COUNT_BIG(*) FROM dbo.Budgets
        UNION ALL SELECT 'dbo.SovLines', COUNT_BIG(*) FROM dbo.SovLines
        UNION ALL SELECT 'dbo.BudgetVersions', COUNT_BIG(*) FROM dbo.BudgetVersions
        UNION ALL SELECT 'dbo.BudgetVersionSovLines', COUNT_BIG(*) FROM dbo.BudgetVersionSovLines) AS v
UNION ALL
SELECT 75, 'G Row counts', 'Budgets breakdown', 'INFO',
       CONCAT('total=', COUNT_BIG(*),
              ' · active=', ISNULL(SUM(CASE WHEN IsDeleted = 0 THEN 1 ELSE 0 END), 0),
              ' · deleted=', ISNULL(SUM(CASE WHEN IsDeleted = 1 THEN 1 ELSE 0 END), 0),
              ' · TST=', ISNULL(SUM(CASE WHEN ProjectId LIKE 'TST-%' THEN 1 ELSE 0 END), 0))
  FROM dbo.Budgets

-- ---- H · Data health: all counts must be zero -----------------------------
UNION ALL
SELECT 80, 'H Data health', h.CheckName,
       CASE WHEN h.ProblemCount = 0 THEN 'PASS' ELSE 'FAIL' END,
       CONCAT(h.ProblemCount, ' problem row(s)')
  FROM (SELECT 'Budgets invalid JSON' AS CheckName, COUNT_BIG(*) AS ProblemCount
          FROM dbo.Budgets WHERE ISJSON(Doc) <> 1
        UNION ALL SELECT 'BudgetVersions invalid JSON', COUNT_BIG(*)
          FROM dbo.BudgetVersions WHERE ISJSON(Doc) <> 1
        UNION ALL SELECT 'PricingLibrary invalid JSON', COUNT_BIG(*)
          FROM dbo.PricingLibrary WHERE ISJSON(Doc) <> 1
        UNION ALL SELECT 'BudgetTemplateVersions invalid JSON', COUNT_BIG(*)
          FROM dbo.BudgetTemplateVersions WHERE ISJSON(Doc) <> 1
        UNION ALL SELECT 'Budgets without a version', COUNT_BIG(*)
          FROM dbo.Budgets AS b
         WHERE NOT EXISTS (SELECT 1 FROM dbo.BudgetVersions AS v WHERE v.ProjectId = b.ProjectId)
        UNION ALL SELECT 'Orphan budget versions', COUNT_BIG(*)
          FROM dbo.BudgetVersions AS v
          LEFT JOIN dbo.Budgets AS b ON b.ProjectId = v.ProjectId
         WHERE b.ProjectId IS NULL
        UNION ALL SELECT 'Orphan version SOV rows', COUNT_BIG(*)
          FROM dbo.BudgetVersionSovLines AS sv
          LEFT JOIN dbo.BudgetVersions AS v ON v.Id = sv.BudgetVersionId
         WHERE v.Id IS NULL
        UNION ALL SELECT 'Duplicate budget version numbers', COUNT_BIG(*)
          FROM (SELECT ProjectId, VersionNumber
                  FROM dbo.BudgetVersions
                 GROUP BY ProjectId, VersionNumber
                HAVING COUNT_BIG(*) > 1) AS dup
        UNION ALL SELECT 'SOV rows with missing LineOrder', COUNT_BIG(*)
          FROM dbo.SovLines WHERE LineOrder IS NULL) AS h

-- ---- I · Pricing and template state ---------------------------------------
UNION ALL
SELECT 90, 'I Pricing/templates', 'Exactly one current pricing version',
       CASE WHEN (SELECT COUNT_BIG(*) FROM dbo.PricingLibrary WHERE IsCurrent = 1) = 1
            THEN 'PASS' ELSE 'FAIL' END,
       CONCAT((SELECT COUNT_BIG(*) FROM dbo.PricingLibrary WHERE IsCurrent = 1),
              ' current of ', (SELECT COUNT_BIG(*) FROM dbo.PricingLibrary), ' total')
UNION ALL
SELECT 91, 'I Pricing/templates', CONCAT('Template ', t.TemplateKey),
       CASE WHEN SUM(CASE WHEN v.IsCurrent = 1 THEN 1 ELSE 0 END) = 1 THEN 'PASS' ELSE 'FAIL' END,
       CONCAT(SUM(CASE WHEN v.IsCurrent = 1 THEN 1 ELSE 0 END), ' current of ',
              COUNT(v.Id), ' version(s)',
              MAX(CASE WHEN t.IsActive = 1 THEN ' · active' ELSE ' · inactive' END))
  FROM dbo.BudgetTemplates AS t
  LEFT JOIN dbo.BudgetTemplateVersions AS v ON v.TemplateKey = t.TemplateKey
 GROUP BY t.TemplateKey

) AS preflight
ORDER BY SortKey, Item;
