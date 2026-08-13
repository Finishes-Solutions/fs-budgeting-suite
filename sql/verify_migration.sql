-- Finishes Solutions — BD Budgeting
-- Consolidated post-migration verification. READ-ONLY: creates nothing,
-- changes nothing, safe to run any number of times.
--
-- The verification section inside migrate_budget_history_and_templates.sql
-- returns thirteen separate result sets, and the Azure portal Query Editor
-- only exports one of them. This file collapses the same checks into a SINGLE
-- result set: one row per check with a PASS / FAIL / INFO verdict.
--
-- Run it after the migration and views.sql. Every row must read PASS; rows
-- marked INFO are values to eyeball, not pass/fail assertions.

SET NOCOUNT ON;

DECLARE @pricingDoc NVARCHAR(MAX) = (
  SELECT TOP 1 Doc FROM dbo.PricingLibrary ORDER BY IsCurrent DESC, Effective DESC, CreatedAt DESC);
DECLARE @tplDoc NVARCHAR(MAX) = (
  SELECT Doc FROM dbo.BudgetTemplateVersions WHERE TemplateKey = 'multifamily' AND IsCurrent = 1);

DECLARE @pricingLines INT = (SELECT COUNT(*) FROM OPENJSON(@pricingDoc, '$.lines'));
DECLARE @tplLines     INT = (SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc, N'{}'), '$.lines'));

SELECT Seq, CheckName, Detail, Result
FROM (
  ---------------------------------------------------------------- structure
  SELECT 1 AS Seq, 'Required tables exist' AS CheckName,
    CAST(CONCAT('BudgetTemplates=',        IIF(OBJECT_ID('dbo.BudgetTemplates','U')        IS NULL,'no','yes'),
                ', BudgetTemplateVersions=',IIF(OBJECT_ID('dbo.BudgetTemplateVersions','U') IS NULL,'no','yes'),
                ', BudgetVersions=',        IIF(OBJECT_ID('dbo.BudgetVersions','U')         IS NULL,'no','yes'),
                ', BudgetVersionSovLines=', IIF(OBJECT_ID('dbo.BudgetVersionSovLines','U')  IS NULL,'no','yes')) AS NVARCHAR(300)) AS Detail,
    IIF(OBJECT_ID('dbo.BudgetTemplates','U')        IS NOT NULL
    AND OBJECT_ID('dbo.BudgetTemplateVersions','U') IS NOT NULL
    AND OBJECT_ID('dbo.BudgetVersions','U')         IS NOT NULL
    AND OBJECT_ID('dbo.BudgetVersionSovLines','U')  IS NOT NULL, 'PASS','FAIL') AS Result

  UNION ALL SELECT 2, 'Required columns exist',
    CAST(CONCAT('Budgets.IsDeleted=',    IIF(COL_LENGTH('dbo.Budgets','IsDeleted')        IS NULL,'no','yes'),
                ', DeletedAt=',          IIF(COL_LENGTH('dbo.Budgets','DeletedAt')        IS NULL,'no','yes'),
                ', TemplateKey=',        IIF(COL_LENGTH('dbo.Budgets','TemplateKey')      IS NULL,'no','yes'),
                ', TemplateVersionId=',  IIF(COL_LENGTH('dbo.Budgets','TemplateVersionId')IS NULL,'no','yes'),
                ', SovLines.LineKey=',   IIF(COL_LENGTH('dbo.SovLines','LineKey')         IS NULL,'no','yes'),
                ', LineOrder=',          IIF(COL_LENGTH('dbo.SovLines','LineOrder')       IS NULL,'no','yes')) AS NVARCHAR(300)),
    IIF(COL_LENGTH('dbo.Budgets','IsDeleted')         IS NOT NULL
    AND COL_LENGTH('dbo.Budgets','DeletedAt')         IS NOT NULL
    AND COL_LENGTH('dbo.Budgets','TemplateKey')       IS NOT NULL
    AND COL_LENGTH('dbo.Budgets','TemplateVersionId') IS NOT NULL
    AND COL_LENGTH('dbo.SovLines','LineKey')          IS NOT NULL
    AND COL_LENGTH('dbo.SovLines','LineOrder')        IS NOT NULL, 'PASS','FAIL')

  UNION ALL SELECT 3, 'Reporting views exist',
    CAST(CONCAT('vw_Budgets=',      IIF(OBJECT_ID('dbo.vw_Budgets','V')       IS NULL,'no','yes'),
                ', vw_DeletedBudgets=',IIF(OBJECT_ID('dbo.vw_DeletedBudgets','V') IS NULL,'no','yes'),
                ', vw_SovScopeRollup=',IIF(OBJECT_ID('dbo.vw_SovScopeRollup','V') IS NULL,'no','yes'),
                ', vw_PricingVersions=',IIF(OBJECT_ID('dbo.vw_PricingVersions','V')IS NULL,'no','yes')) AS NVARCHAR(300)),
    IIF(OBJECT_ID('dbo.vw_Budgets','V')        IS NOT NULL
    AND OBJECT_ID('dbo.vw_DeletedBudgets','V') IS NOT NULL
    AND OBJECT_ID('dbo.vw_SovScopeRollup','V') IS NOT NULL
    AND OBJECT_ID('dbo.vw_PricingVersions','V')IS NOT NULL, 'PASS','FAIL')

  ---------------------------------------------------------------- history
  UNION ALL SELECT 4, 'Every budget has at least one version',
    CAST(CONCAT('budgets without a version: ',
      (SELECT COUNT(*) FROM dbo.Budgets b
        WHERE NOT EXISTS (SELECT 1 FROM dbo.BudgetVersions v WHERE v.ProjectId = b.ProjectId))) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM dbo.Budgets b
          WHERE NOT EXISTS (SELECT 1 FROM dbo.BudgetVersions v WHERE v.ProjectId = b.ProjectId)) = 0, 'PASS','FAIL')

  UNION ALL SELECT 5, 'Baseline SOV row counts reconcile',
    CAST(CONCAT('budgets whose v1 line count <> current SovLines: ',
      (SELECT COUNT(*) FROM dbo.BudgetVersions v
         JOIN (SELECT ProjectId, COUNT(*) n FROM dbo.SovLines GROUP BY ProjectId) cur ON cur.ProjectId = v.ProjectId
         LEFT JOIN (SELECT BudgetVersionId, COUNT(*) n FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) ver
           ON ver.BudgetVersionId = v.Id
        WHERE v.VersionNumber = 1 AND ISNULL(ver.n,0) <> cur.n)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM dbo.BudgetVersions v
           JOIN (SELECT ProjectId, COUNT(*) n FROM dbo.SovLines GROUP BY ProjectId) cur ON cur.ProjectId = v.ProjectId
           LEFT JOIN (SELECT BudgetVersionId, COUNT(*) n FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) ver
             ON ver.BudgetVersionId = v.Id
          WHERE v.VersionNumber = 1 AND ISNULL(ver.n,0) <> cur.n) = 0, 'PASS','FAIL')

  UNION ALL SELECT 6, 'Baseline SOV dollar totals reconcile',
    CAST(CONCAT('budgets whose v1 total <> current SovLines total: ',
      (SELECT COUNT(*) FROM dbo.BudgetVersions v
         JOIN (SELECT ProjectId, SUM(Total) t FROM dbo.SovLines GROUP BY ProjectId) cur ON cur.ProjectId = v.ProjectId
         LEFT JOIN (SELECT BudgetVersionId, SUM(Total) t FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) ver
           ON ver.BudgetVersionId = v.Id
        WHERE v.VersionNumber = 1 AND ISNULL(ver.t,0) <> cur.t)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM dbo.BudgetVersions v
           JOIN (SELECT ProjectId, SUM(Total) t FROM dbo.SovLines GROUP BY ProjectId) cur ON cur.ProjectId = v.ProjectId
           LEFT JOIN (SELECT BudgetVersionId, SUM(Total) t FROM dbo.BudgetVersionSovLines GROUP BY BudgetVersionId) ver
             ON ver.BudgetVersionId = v.Id
          WHERE v.VersionNumber = 1 AND ISNULL(ver.t,0) <> cur.t) = 0, 'PASS','FAIL')

  UNION ALL SELECT 7, 'No duplicate budget version numbers',
    CAST(CONCAT('duplicate (ProjectId, VersionNumber) groups: ',
      (SELECT COUNT(*) FROM (SELECT ProjectId, VersionNumber FROM dbo.BudgetVersions
                              GROUP BY ProjectId, VersionNumber HAVING COUNT(*) > 1) d)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM (SELECT ProjectId, VersionNumber FROM dbo.BudgetVersions
                                GROUP BY ProjectId, VersionNumber HAVING COUNT(*) > 1) d) = 0, 'PASS','FAIL')

  UNION ALL SELECT 8, 'No orphaned version or version-SOV rows',
    CAST(CONCAT('orphan versions: ',
      (SELECT COUNT(*) FROM dbo.BudgetVersions v LEFT JOIN dbo.Budgets b ON b.ProjectId = v.ProjectId WHERE b.ProjectId IS NULL),
      ', orphan version SOV rows: ',
      (SELECT COUNT(*) FROM dbo.BudgetVersionSovLines s LEFT JOIN dbo.BudgetVersions v ON v.Id = s.BudgetVersionId WHERE v.Id IS NULL)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM dbo.BudgetVersions v LEFT JOIN dbo.Budgets b ON b.ProjectId = v.ProjectId WHERE b.ProjectId IS NULL) = 0
    AND (SELECT COUNT(*) FROM dbo.BudgetVersionSovLines s LEFT JOIN dbo.BudgetVersions v ON v.Id = s.BudgetVersionId WHERE v.Id IS NULL) = 0, 'PASS','FAIL')

  UNION ALL SELECT 9, 'SovLines.LineOrder fully backfilled',
    CAST(CONCAT('rows still NULL: ', (SELECT COUNT(*) FROM dbo.SovLines WHERE LineOrder IS NULL)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM dbo.SovLines WHERE LineOrder IS NULL) = 0, 'PASS','FAIL')

  ---------------------------------------------------------------- templates
  UNION ALL SELECT 10, 'No duplicate template version numbers',
    CAST(CONCAT('duplicate (TemplateKey, VersionNumber) groups: ',
      (SELECT COUNT(*) FROM (SELECT TemplateKey, VersionNumber FROM dbo.BudgetTemplateVersions
                              GROUP BY TemplateKey, VersionNumber HAVING COUNT(*) > 1) d)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM (SELECT TemplateKey, VersionNumber FROM dbo.BudgetTemplateVersions
                                GROUP BY TemplateKey, VersionNumber HAVING COUNT(*) > 1) d) = 0, 'PASS','FAIL')

  UNION ALL SELECT 11, 'Exactly one current version per template',
    CAST(CONCAT('templates not having exactly one current version: ',
      (SELECT COUNT(*) FROM (SELECT t.TemplateKey FROM dbo.BudgetTemplates t
         LEFT JOIN dbo.BudgetTemplateVersions v ON v.TemplateKey = t.TemplateKey
         GROUP BY t.TemplateKey HAVING SUM(CASE WHEN v.IsCurrent = 1 THEN 1 ELSE 0 END) <> 1) d)) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM (SELECT t.TemplateKey FROM dbo.BudgetTemplates t
           LEFT JOIN dbo.BudgetTemplateVersions v ON v.TemplateKey = t.TemplateKey
           GROUP BY t.TemplateKey HAVING SUM(CASE WHEN v.IsCurrent = 1 THEN 1 ELSE 0 END) <> 1) d) = 0, 'PASS','FAIL')

  UNION ALL SELECT 12, 'Multifamily template seeded, current and valid JSON',
    CAST(CONCAT('current version rows: ',
      (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions WHERE TemplateKey = 'multifamily' AND IsCurrent = 1),
      ', ISJSON(Doc): ', ISNULL(CAST(ISJSON(@tplDoc) AS VARCHAR(4)), 'null')) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM dbo.BudgetTemplateVersions WHERE TemplateKey = 'multifamily' AND IsCurrent = 1) = 1
        AND ISJSON(@tplDoc) = 1, 'PASS','FAIL')

  -- The bug that failed the first two runs truncated this array, so this check
  -- is the one that proves the template seed is complete.
  UNION ALL SELECT 13, 'Template line count matches the pricing library',
    CAST(CONCAT('template lines: ', @tplLines, ', pricing library lines: ', @pricingLines) AS NVARCHAR(300)),
    IIF(@tplLines = @pricingLines AND @tplLines > 0, 'PASS','FAIL')

  UNION ALL SELECT 14, 'Template carries the full new-budget defaults',
    CAST(CONCAT('units: ',    (SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.units')),
                ', other: ',  (SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.other')),
                ', expenses: ',(SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.expenses')),
                ', companies: ',(SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.companies')),
                ', resSF: ',  ISNULL(JSON_VALUE(@tplDoc,'$.resSF'),'-'),
                ', amenSF: ', ISNULL(JSON_VALUE(@tplDoc,'$.amenSF'),'-'),
                ', contingency: ', ISNULL(JSON_VALUE(@tplDoc,'$.contingency.mode'),'-'),
                ' ', ISNULL(JSON_VALUE(@tplDoc,'$.contingency.val'),'-')) AS NVARCHAR(300)),
    IIF((SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.units'))     = 4
    AND (SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.other'))     = 8
    AND (SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.expenses'))  = 6
    AND (SELECT COUNT(*) FROM OPENJSON(ISNULL(@tplDoc,N'{}'), '$.companies')) = 1
    AND JSON_VALUE(@tplDoc,'$.resSF')  = '51365'
    AND JSON_VALUE(@tplDoc,'$.amenSF') = '1200', 'PASS','FAIL')

  ---------------------------------------------------------------- informational
  UNION ALL SELECT 15, 'Current data snapshot (compare with preflight)',
    CAST(CONCAT('budgets: ',   (SELECT COUNT(*) FROM dbo.Budgets),
                ', SovLines: ',(SELECT COUNT(*) FROM dbo.SovLines),
                ', SovLines total: ', (SELECT CAST(ISNULL(SUM(Total),0) AS DECIMAL(18,2)) FROM dbo.SovLines),
                ', pricing versions: ', (SELECT COUNT(*) FROM dbo.PricingLibrary)) AS NVARCHAR(300)), 'INFO'

  UNION ALL SELECT 16, 'Deletion state',
    CAST(CONCAT('soft-deleted budgets: ', (SELECT COUNT(*) FROM dbo.Budgets WHERE IsDeleted = 1),
                ', visible in vw_Budgets: ', (SELECT COUNT(*) FROM dbo.vw_Budgets)) AS NVARCHAR(300)), 'INFO'

  UNION ALL SELECT 17, 'Version history',
    CAST(CONCAT('budget versions: ', (SELECT COUNT(*) FROM dbo.BudgetVersions),
                ', version SOV rows: ', (SELECT COUNT(*) FROM dbo.BudgetVersionSovLines)) AS NVARCHAR(300)), 'INFO'
) AS checks
ORDER BY Seq;
