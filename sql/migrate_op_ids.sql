-- Migrate legacy three-digit Operations IDs (OP-###) to four digits (OP-####).
--
-- WHY THIS EXISTS: the app and the API now validate OP IDs as four digits. Any budget
-- saved earlier as OP-001 fails that check, which means GET /api/budget/OP-001 returns
-- 400 and the record can no longer be opened, saved or deleted from the UI. Renaming the
-- key is the fix.
--
-- ProjectId is the primary key and SovLines references it, so the update has to touch
-- both tables inside one transaction. Run against the fs-budgeting-suite database.

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- 1. What would change. Review this before running anything below.
SELECT ProjectId AS OldId,
       'OP-0' + RIGHT(ProjectId, 3) AS NewId,
       Name, Status, ContractSum, UpdatedAt
FROM dbo.Budgets
WHERE ProjectId LIKE 'OP-[0-9][0-9][0-9]'
  AND LEN(ProjectId) = 6
ORDER BY ProjectId;

-- 2. Guard: a four-digit ID must not already exist, or the rename would collide.
IF EXISTS (
    SELECT 1 FROM dbo.Budgets b
    WHERE b.ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(b.ProjectId) = 6
      AND EXISTS (SELECT 1 FROM dbo.Budgets t WHERE t.ProjectId = 'OP-0' + RIGHT(b.ProjectId, 3))
)
BEGIN
    RAISERROR('Collision: a four-digit ID already exists for one of the legacy IDs. Resolve by hand.', 16, 1);
    RETURN;
END

BEGIN TRANSACTION;

    -- SovLines first: it has a foreign key onto Budgets.ProjectId, so the child rows are
    -- repointed before the parent key changes.
    UPDATE s
       SET s.ProjectId = 'OP-0' + RIGHT(s.ProjectId, 3)
      FROM dbo.SovLines s
     WHERE s.ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(s.ProjectId) = 6;
    PRINT CONCAT('SovLines repointed: ', @@ROWCOUNT);

    UPDATE b
       SET b.ProjectId = 'OP-0' + RIGHT(b.ProjectId, 3)
      FROM dbo.Budgets b
     WHERE b.ProjectId LIKE 'OP-[0-9][0-9][0-9]' AND LEN(b.ProjectId) = 6;
    PRINT CONCAT('Budgets renamed: ', @@ROWCOUNT);

    -- The budget document carries its own copy of the ID; keep it in step or the app will
    -- refuse to save the record ("Body projectId must match route").
    UPDATE dbo.Budgets
       SET Doc = JSON_MODIFY(Doc, '$.projectId', ProjectId)
     WHERE ProjectId LIKE 'OP-0[0-9][0-9][0-9]'
       AND JSON_VALUE(Doc, '$.projectId') <> ProjectId;
    PRINT CONCAT('Doc projectId synced: ', @@ROWCOUNT);

-- Inspect the printed counts, then:
COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;

-- 3. Verify nothing legacy remains.
SELECT ProjectId, JSON_VALUE(Doc, '$.projectId') AS DocId
FROM dbo.Budgets
WHERE ProjectId LIKE 'OP-%'
ORDER BY ProjectId;
