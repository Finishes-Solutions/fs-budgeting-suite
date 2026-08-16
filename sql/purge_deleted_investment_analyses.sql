-- Purge soft-deleted investment analyses — ADMIN-RUN ONLY, never deployed.
--
-- The app has no hard delete: DELETE /api/investment-analysis/{id} soft-flags
-- the analysis and its history survives (saving again restores it). This
-- script is the one place a soft-deleted analysis and its version history are
-- physically removed.
--
-- Deletes child-first inside one transaction (the FK from versions to
-- analyses is NO ACTION by design; version annual rows cascade from their
-- version row but are deleted explicitly anyway so the counts print):
--   version annual rows → versions → current annual rows → analysis row.
--
-- Review the preview result set, then run the transaction block and COMMIT.

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- Preview: what would be purged. Review before deleting.
SELECT a.AnalysisId, a.ProjectId, a.Name, a.Status, a.PurchasePrice, a.DeletedAt,
       (SELECT COUNT(*) FROM dbo.InvestmentAnalysisVersions v WHERE v.AnalysisId = a.AnalysisId) AS Versions,
       (SELECT COUNT(*) FROM dbo.InvestmentAnnualResults r WHERE r.AnalysisId = a.AnalysisId)    AS CurrentAnnualRows
FROM dbo.InvestmentAnalyses AS a
WHERE a.IsDeleted = 1
ORDER BY a.DeletedAt DESC;

BEGIN TRANSACTION;

DELETE vr
FROM dbo.InvestmentVersionAnnualResults AS vr
JOIN dbo.InvestmentAnalysisVersions AS v ON v.Id = vr.AnalysisVersionId
JOIN dbo.InvestmentAnalyses         AS a ON a.AnalysisId = v.AnalysisId
WHERE a.IsDeleted = 1;
PRINT CONCAT('Version annual rows deleted: ', @@ROWCOUNT);

DELETE v
FROM dbo.InvestmentAnalysisVersions AS v
JOIN dbo.InvestmentAnalyses AS a ON a.AnalysisId = v.AnalysisId
WHERE a.IsDeleted = 1;
PRINT CONCAT('Versions deleted: ', @@ROWCOUNT);

DELETE r
FROM dbo.InvestmentAnnualResults AS r
JOIN dbo.InvestmentAnalyses AS a ON a.AnalysisId = r.AnalysisId
WHERE a.IsDeleted = 1;
PRINT CONCAT('Current annual rows deleted: ', @@ROWCOUNT);

DELETE FROM dbo.InvestmentAnalyses WHERE IsDeleted = 1;
PRINT CONCAT('Analyses purged: ', @@ROWCOUNT);

-- Inspect the printed counts, then:
COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
