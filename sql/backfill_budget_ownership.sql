-- ============================================================================
-- Backfill: attribute existing budgets to whoever created them
--
-- Run in Azure Portal Query Editor as the database admin, after
-- sql/migrate_roles_and_ownership.sql. Safe to run twice: it only ever fills
-- a NULL, and never overwrites an owner that is already recorded.
--
-- Why this is needed: the ownership columns were added empty, so budgets that
-- existed before the migration have no creator and therefore show no avatar in
-- the User column. The information is not lost though — every save writes a
-- dbo.BudgetVersions row stamped with the signed-in account, so a budget's
-- FIRST version tells us who created it. That is what this copies up.
--
-- Budgets whose versions predate identity stamping (local development, or
-- anything saved without a principal) keep CreatedById = NULL, which the
-- listing API reads as "no owner recorded" and keeps visible to everyone.
-- ============================================================================

-- ============ SECTION 1 — preflight (read-only) ============
-- What will change, before anything changes. Run this first.
SET NOCOUNT ON;
WITH FirstAuthor AS (
  SELECT bv.ProjectId, bv.CreatedById, bv.CreatedByName,
         ROW_NUMBER() OVER (PARTITION BY bv.ProjectId ORDER BY bv.VersionNumber) AS rn
  FROM dbo.BudgetVersions AS bv
  WHERE bv.CreatedById IS NOT NULL
)
SELECT b.ProjectId,
       b.Name,
       IIF(b.CreatedById IS NULL, 'unowned', 'already owned') AS CurrentState,
       fa.CreatedByName AS WillBeAttributedTo,
       IIF(b.CreatedById IS NOT NULL, 'left alone',
           IIF(fa.CreatedById IS NULL, 'no stamped version — stays unowned', 'will update')) AS Action
FROM dbo.Budgets AS b
LEFT JOIN FirstAuthor AS fa ON fa.ProjectId = b.ProjectId AND fa.rn = 1
WHERE b.IsDeleted = 0
ORDER BY b.ProjectId;
GO

-- ============ SECTION 2 — backfill ============
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF COL_LENGTH('dbo.Budgets','CreatedById') IS NULL
  THROW 50003, 'dbo.Budgets.CreatedById is missing. Run sql/migrate_roles_and_ownership.sql first.', 1;

BEGIN TRANSACTION;

WITH FirstAuthor AS (
  SELECT bv.ProjectId, bv.CreatedById, bv.CreatedByName,
         ROW_NUMBER() OVER (PARTITION BY bv.ProjectId ORDER BY bv.VersionNumber) AS rn
  FROM dbo.BudgetVersions AS bv
  WHERE bv.CreatedById IS NOT NULL
)
UPDATE b
   SET b.CreatedById   = fa.CreatedById,
       b.CreatedByName = fa.CreatedByName
FROM dbo.Budgets AS b
JOIN FirstAuthor AS fa
  ON fa.ProjectId = b.ProjectId
 AND fa.rn = 1
-- Only ever fills a gap. An owner already recorded is authoritative.
WHERE b.CreatedById IS NULL;

DECLARE @n INT = @@ROWCOUNT;
COMMIT TRANSACTION;
PRINT CONCAT('Budget ownership backfill complete. Rows attributed: ', @n);
GO

-- ============ SECTION 3 — verification (read-only) ============
-- One result set: the portal exports only the first.
SET NOCOUNT ON;
SELECT
  COUNT(*)                                                      AS Budgets_Total,
  SUM(IIF(CreatedById IS NOT NULL, 1, 0))                       AS Budgets_WithOwner,
  SUM(IIF(CreatedById IS NULL, 1, 0))                           AS Budgets_StillUnowned,
  (SELECT COUNT(DISTINCT CreatedById) FROM dbo.Budgets
    WHERE IsDeleted = 0 AND CreatedById IS NOT NULL)            AS DistinctOwners
FROM dbo.Budgets
WHERE IsDeleted = 0;
