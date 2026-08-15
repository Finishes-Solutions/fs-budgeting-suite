-- ============================================================================
-- READ-ONLY verification for the investment-analysis schema. Run after
-- sql/migrate_investment_analyses.sql and the updated sql/views.sql.
-- One result set (the portal exports only the first): PASS / FAIL / INFO.
-- Every FAIL must be explained before the feature code ships.
-- ============================================================================
SET NOCOUNT ON;

SELECT Seq, CheckName, Detail, Result FROM (

SELECT 1 AS Seq, 'Required tables exist' AS CheckName,
  CONCAT('InvestmentAnalyses=', IIF(OBJECT_ID('dbo.InvestmentAnalyses','U') IS NULL,'no','yes'),
         ', Versions=', IIF(OBJECT_ID('dbo.InvestmentAnalysisVersions','U') IS NULL,'no','yes'),
         ', AnnualResults=', IIF(OBJECT_ID('dbo.InvestmentAnnualResults','U') IS NULL,'no','yes'),
         ', VersionAnnualResults=', IIF(OBJECT_ID('dbo.InvestmentVersionAnnualResults','U') IS NULL,'no','yes')) AS Detail,
  IIF(OBJECT_ID('dbo.InvestmentAnalyses','U') IS NOT NULL
      AND OBJECT_ID('dbo.InvestmentAnalysisVersions','U') IS NOT NULL
      AND OBJECT_ID('dbo.InvestmentAnnualResults','U') IS NOT NULL
      AND OBJECT_ID('dbo.InvestmentVersionAnnualResults','U') IS NOT NULL, 'PASS', 'FAIL') AS Result

UNION ALL SELECT 2, 'Reporting view exists',
  IIF(OBJECT_ID('dbo.vw_InvestmentAnalyses','V') IS NULL, 'vw_InvestmentAnalyses missing — run views.sql', 'vw_InvestmentAnalyses present'),
  IIF(OBJECT_ID('dbo.vw_InvestmentAnalyses','V') IS NULL, 'FAIL', 'PASS')

UNION ALL SELECT 3, 'Foreign keys with expected delete actions',
  (SELECT CONCAT('Analyses->Budgets=', MAX(CASE WHEN fk.name='FK_InvestmentAnalyses_Budget' THEN fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT END),
          ', Analyses->BudgetVersions=', MAX(CASE WHEN fk.name='FK_InvestmentAnalyses_BudgetVersion' THEN fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT END),
          ', Versions->Analyses=', MAX(CASE WHEN fk.name='FK_InvestmentAnalysisVersions_Analysis' THEN fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT END),
          ', AnnualRows->Analyses=', MAX(CASE WHEN fk.name='FK_InvestmentAnnualResults_Analysis' THEN fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT END),
          ', VersionRows->Versions=', MAX(CASE WHEN fk.name='FK_InvestmentVersionAnnualResults_Version' THEN fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT END))
     FROM sys.foreign_keys fk
    WHERE fk.name IN ('FK_InvestmentAnalyses_Budget','FK_InvestmentAnalyses_BudgetVersion',
                      'FK_InvestmentAnalysisVersions_Analysis','FK_InvestmentAnnualResults_Analysis',
                      'FK_InvestmentVersionAnnualResults_Version')),
  IIF((SELECT COUNT(*) FROM sys.foreign_keys fk
        WHERE (fk.name IN ('FK_InvestmentAnalyses_Budget','FK_InvestmentAnalyses_BudgetVersion',
                           'FK_InvestmentAnalysisVersions_Analysis','FK_InvestmentAnnualResults_Analysis')
               AND fk.delete_referential_action_desc = 'NO_ACTION' AND fk.is_disabled = 0)
           OR (fk.name = 'FK_InvestmentVersionAnnualResults_Version'
               AND fk.delete_referential_action_desc = 'CASCADE' AND fk.is_disabled = 0)) = 5, 'PASS', 'FAIL')

UNION ALL SELECT 4, 'Unique constraints present',
  CONCAT('UQ version per analysis=', IIF(EXISTS(SELECT 1 FROM sys.indexes WHERE name='UQ_InvestmentAnalysisVersions_Version' AND is_unique=1),'yes','no'),
         ', UQ annual year=', IIF(EXISTS(SELECT 1 FROM sys.indexes WHERE name='UQ_InvestmentAnnualResults_Year' AND is_unique=1),'yes','no'),
         ', UQ version annual year=', IIF(EXISTS(SELECT 1 FROM sys.indexes WHERE name='UQ_InvestmentVersionAnnualResults_Year' AND is_unique=1),'yes','no')),
  IIF(EXISTS(SELECT 1 FROM sys.indexes WHERE name='UQ_InvestmentAnalysisVersions_Version' AND is_unique=1)
      AND EXISTS(SELECT 1 FROM sys.indexes WHERE name='UQ_InvestmentAnnualResults_Year' AND is_unique=1)
      AND EXISTS(SELECT 1 FROM sys.indexes WHERE name='UQ_InvestmentVersionAnnualResults_Year' AND is_unique=1), 'PASS', 'FAIL')

UNION ALL SELECT 5, 'JSON checks enforced',
  CONCAT((SELECT COUNT(*) FROM sys.check_constraints
           WHERE parent_object_id IN (OBJECT_ID('dbo.InvestmentAnalyses'), OBJECT_ID('dbo.InvestmentAnalysisVersions'))
             AND definition LIKE '%isjson%'), ' ISJSON constraints across current + version tables (expect 6)'),
  IIF((SELECT COUNT(*) FROM sys.check_constraints
        WHERE parent_object_id IN (OBJECT_ID('dbo.InvestmentAnalyses'), OBJECT_ID('dbo.InvestmentAnalysisVersions'))
          AND definition LIKE '%isjson%') = 6, 'PASS', 'FAIL')

UNION ALL SELECT 6, 'All stored documents are valid JSON',
  CONCAT('invalid docs: ',
    (SELECT COUNT(*) FROM dbo.InvestmentAnalyses WHERE ISJSON(InputDoc) <> 1 OR ISJSON(NormalizedInputDoc) <> 1 OR ISJSON(ResultDoc) <> 1)
    + (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions WHERE ISJSON(InputDoc) <> 1 OR ISJSON(NormalizedInputDoc) <> 1 OR ISJSON(ResultDoc) <> 1)),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnalyses WHERE ISJSON(InputDoc) <> 1 OR ISJSON(NormalizedInputDoc) <> 1 OR ISJSON(ResultDoc) <> 1)
      + (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions WHERE ISJSON(InputDoc) <> 1 OR ISJSON(NormalizedInputDoc) <> 1 OR ISJSON(ResultDoc) <> 1) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 7, 'No orphan versions',
  CONCAT('versions without a parent analysis: ',
    (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions v
      LEFT JOIN dbo.InvestmentAnalyses a ON a.AnalysisId = v.AnalysisId WHERE a.AnalysisId IS NULL)),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions v
        LEFT JOIN dbo.InvestmentAnalyses a ON a.AnalysisId = v.AnalysisId WHERE a.AnalysisId IS NULL) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 8, 'No orphan annual rows',
  CONCAT('current: ', (SELECT COUNT(*) FROM dbo.InvestmentAnnualResults r
                        LEFT JOIN dbo.InvestmentAnalyses a ON a.AnalysisId = r.AnalysisId WHERE a.AnalysisId IS NULL),
         ', version: ', (SELECT COUNT(*) FROM dbo.InvestmentVersionAnnualResults r
                          LEFT JOIN dbo.InvestmentAnalysisVersions v ON v.Id = r.AnalysisVersionId WHERE v.Id IS NULL)),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnnualResults r
        LEFT JOIN dbo.InvestmentAnalyses a ON a.AnalysisId = r.AnalysisId WHERE a.AnalysisId IS NULL)
      + (SELECT COUNT(*) FROM dbo.InvestmentVersionAnnualResults r
          LEFT JOIN dbo.InvestmentAnalysisVersions v ON v.Id = r.AnalysisVersionId WHERE v.Id IS NULL) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 9, 'No duplicate version numbers',
  CONCAT('duplicates: ', (SELECT COUNT(*) FROM (
    SELECT AnalysisId, VersionNumber FROM dbo.InvestmentAnalysisVersions
    GROUP BY AnalysisId, VersionNumber HAVING COUNT(*) > 1) d)),
  IIF((SELECT COUNT(*) FROM (
    SELECT AnalysisId, VersionNumber FROM dbo.InvestmentAnalysisVersions
    GROUP BY AnalysisId, VersionNumber HAVING COUNT(*) > 1) d) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 10, 'Five current annual rows per calculated analysis',
  CONCAT('analyses with wrong row count: ',
    (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a
      WHERE a.CurrentVersionNumber >= 1
        AND (SELECT COUNT(*) FROM dbo.InvestmentAnnualResults r WHERE r.AnalysisId = a.AnalysisId) <> a.ProjectionYears)),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnalyses a
        WHERE a.CurrentVersionNumber >= 1
          AND (SELECT COUNT(*) FROM dbo.InvestmentAnnualResults r WHERE r.AnalysisId = a.AnalysisId) <> a.ProjectionYears) = 0, 'PASS', 'FAIL')

-- A version's annual-row count must equal ITS OWN projection horizon (5 or 10):
-- versions are immutable, so the horizon is read from the stored result, never
-- from the parent analysis (which may have switched horizons since).
UNION ALL SELECT 11, 'Annual rows per immutable version match its horizon',
  CONCAT('versions with wrong row count: ',
    (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions v
      WHERE (SELECT COUNT(*) FROM dbo.InvestmentVersionAnnualResults r WHERE r.AnalysisVersionId = v.Id)
            <> ISNULL(TRY_CAST(JSON_VALUE(v.ResultDoc, '$.normalizedInput.projection.years') AS INT), 5))),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions v
        WHERE (SELECT COUNT(*) FROM dbo.InvestmentVersionAnnualResults r WHERE r.AnalysisVersionId = v.Id)
              <> ISNULL(TRY_CAST(JSON_VALUE(v.ResultDoc, '$.normalizedInput.projection.years') AS INT), 5)) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 12, 'Current version number reconciles',
  CONCAT('analyses whose CurrentVersionNumber <> max version: ',
    (SELECT COUNT(*) FROM dbo.InvestmentAnalyses a
      WHERE a.CurrentVersionNumber <> ISNULL((SELECT MAX(v.VersionNumber)
        FROM dbo.InvestmentAnalysisVersions v WHERE v.AnalysisId = a.AnalysisId), 0))),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnalyses a
        WHERE a.CurrentVersionNumber <> ISNULL((SELECT MAX(v.VersionNumber)
          FROM dbo.InvestmentAnalysisVersions v WHERE v.AnalysisId = a.AnalysisId), 0)) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 13, 'Summary values reconcile with ResultDoc',
  CONCAT('mismatches: ', (SELECT COUNT(*) FROM dbo.InvestmentAnalyses
     WHERE CurrentVersionNumber >= 1
       AND (ABS(ISNULL(PurchasePrice,0) - ISNULL(TRY_CAST(JSON_VALUE(ResultDoc,'$.summary.purchasePrice') AS DECIMAL(19,4)),0)) > 0.01
         OR ABS(ISNULL(Year1NOI,0) - ISNULL(TRY_CAST(JSON_VALUE(ResultDoc,'$.summary.year1NOI') AS DECIMAL(19,4)),0)) > 0.01))),
  IIF((SELECT COUNT(*) FROM dbo.InvestmentAnalyses
        WHERE CurrentVersionNumber >= 1
          AND (ABS(ISNULL(PurchasePrice,0) - ISNULL(TRY_CAST(JSON_VALUE(ResultDoc,'$.summary.purchasePrice') AS DECIMAL(19,4)),0)) > 0.01
            OR ABS(ISNULL(Year1NOI,0) - ISNULL(TRY_CAST(JSON_VALUE(ResultDoc,'$.summary.year1NOI') AS DECIMAL(19,4)),0)) > 0.01)) = 0, 'PASS', 'FAIL')

UNION ALL SELECT 14, 'Reporting view excludes TST-linked analyses',
  CONCAT('TST rows visible in view: ',
    (SELECT COUNT(*) FROM dbo.vw_InvestmentAnalyses WHERE ProjectId LIKE 'TST-%')),
  IIF((SELECT COUNT(*) FROM dbo.vw_InvestmentAnalyses WHERE ProjectId LIKE 'TST-%') = 0, 'PASS', 'FAIL')

UNION ALL SELECT 15, 'Inventory',
  CONCAT('analyses=', (SELECT COUNT(*) FROM dbo.InvestmentAnalyses),
         ' (deleted=', (SELECT COUNT(*) FROM dbo.InvestmentAnalyses WHERE IsDeleted = 1),
         '), versions=', (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions),
         ', annual rows=', (SELECT COUNT(*) FROM dbo.InvestmentAnnualResults),
         ', version annual rows=', (SELECT COUNT(*) FROM dbo.InvestmentVersionAnnualResults)),
  'INFO'

) AS checks
ORDER BY Seq;
