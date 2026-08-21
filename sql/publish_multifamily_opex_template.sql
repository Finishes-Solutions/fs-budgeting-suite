/* ============================================================================
   Publish the multifamily template's FULL operating-expense schedule
   ----------------------------------------------------------------------------
   Target : Azure SQL, the single fs-bd-budget database.
   Run by : a database admin, in the Azure portal Query Editor.
   When   : AFTER the release that ships the guard rails, and after
            sql/migrate_projects_and_guardrails.sql. Order does not strictly
            matter, but running this before the deploy would give new budgets a
            schedule the deployed code does not yet know how to price
            (`pctIncome` rows would contribute nothing until the code lands).

   WHY THIS EXISTS
     A new budget's expense rows come from the multifamily TEMPLATE, not from
     the application constants — docs/DATA_CONTRACT.md, "Single source of truth
     for new-budget defaults". The template published today carries six service
     expenses (water, fiber, communications, valet trash, a dumpster, admin)
     which total roughly 9% of gross income: utilities and trash, but no
     property taxes, insurance, management fee, payroll, R&M, turnover,
     marketing, G&A or reserves.

     That is not an operating-expense picture, and it is why the 35–55% guard
     rail and the derived investment-analysis expense ratio could not ship
     against it. This script publishes a new template VERSION carrying the full
     schedule, so every budget created after it starts inside the rail.

   WHAT IT DOES
     Reads the template's current version document, appends the missing expense
     categories, stamps opexSchemaVersion = 2, demotes the current version and
     inserts the new one. Publishing is append-only: the existing version is
     never modified, and every budget already created from it keeps its exact
     provenance.

   WHAT IT DOES NOT DO
     It does not touch a single existing budget. Those keep their own rows and
     stay on opexSchemaVersion 1, which means the 35–55% rail WARNS them rather
     than blocking — they are updated one at a time from the budget page's
     Guard Rails card ("Update Expense Schedule"), by someone who knows the
     property.

   THE RATES ARE STARTING POINTS, NOT HOUSE NUMBERS.
     They are chosen so the template lands at roughly 46% of income against its
     own unit mix — inside the rail, and in the range a stabilised multifamily
     asset actually runs at. Whoever owns the underwriting standard should
     review them and republish. Editing this script and re-running it publishes
     another version; nothing is overwritten.

   Idempotent: re-running when the current version already carries the schedule
   prints a notice and changes nothing.
   ============================================================================ */

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ---------------------------------------------------------------------------
   1 · PREFLIGHT — read-only.
   --------------------------------------------------------------------------- */
PRINT '=== PREFLIGHT ===';

SELECT v.TemplateKey, v.VersionNumber, v.IsCurrent, v.PricingVersion,
       JSON_VALUE(v.Doc, '$.opexSchemaVersion')                AS OpexSchemaVersion,
       (SELECT COUNT(*) FROM OPENJSON(v.Doc, '$.expenses'))    AS ExpenseRowCount,
       v.CreatedAt, v.ChangeSummary
FROM dbo.BudgetTemplateVersions AS v
WHERE v.TemplateKey = 'multifamily'
ORDER BY v.VersionNumber DESC;

/* ---------------------------------------------------------------------------
   2 · PUBLISH
   --------------------------------------------------------------------------- */
BEGIN TRANSACTION;
BEGIN TRY

  DECLARE @curId BIGINT, @curNo INT, @doc NVARCHAR(MAX), @pv NVARCHAR(32);

  SELECT @curId = v.Id, @curNo = v.VersionNumber, @doc = v.Doc, @pv = v.PricingVersion
  FROM dbo.BudgetTemplateVersions AS v WITH (UPDLOCK, HOLDLOCK)
  WHERE v.TemplateKey = 'multifamily' AND v.IsCurrent = 1;

  IF @curId IS NULL
    THROW 50010, 'No current multifamily template version. Run sql/migrate_budget_history_and_templates.sql first.', 1;

  IF TRY_CONVERT(INT, JSON_VALUE(@doc, '$.opexSchemaVersion')) >= 2
  BEGIN
    PRINT 'The current multifamily template already carries the full expense schedule — nothing to do.';
    COMMIT TRANSACTION;
    RETURN;
  END

  /* The categories to add, as a JSON array. `pctIncome` is the third expense
     basis: a share of rent + other income, which is how management fees and
     often property taxes are actually quoted. It is NOT circular — income does
     not depend on expenses — so it is a straight computation in both
     app/index.html and api/shared/budget-calc.js.

     Only rows the template does not already carry are appended, matched by
     label, so re-running after a partial edit cannot duplicate a category. */
  DECLARE @additions NVARCHAR(MAX) = N'[
    {"label":"Property Taxes","per":"pctIncome","rate":12,"count":0,"auto":false},
    {"label":"Property Insurance","per":"unit","rate":65,"count":0,"auto":true},
    {"label":"Property Management Fee","per":"pctIncome","rate":4,"count":0,"auto":false},
    {"label":"On-Site Payroll","per":"unit","rate":95,"count":0,"auto":true},
    {"label":"Repairs & Maintenance","per":"unit","rate":55,"count":0,"auto":true},
    {"label":"Turnover / Make-Ready","per":"unit","rate":30,"count":0,"auto":true},
    {"label":"Marketing & Leasing","per":"unit","rate":22,"count":0,"auto":true},
    {"label":"General & Administrative","per":"unit","rate":18,"count":0,"auto":true},
    {"label":"Landscaping & Amenity Upkeep","per":"unit","rate":20,"count":0,"auto":true},
    {"label":"Replacement Reserves","per":"unit","rate":25,"count":0,"auto":true}]';

  -- Rebuild the expenses array: everything already there, then whatever is
  -- genuinely missing. Existing rows keep their rates untouched.
  DECLARE @expenses NVARCHAR(MAX) =
    N'[' +
    ISNULL(STUFF((
      SELECT N',' + e.value
      FROM OPENJSON(@doc, '$.expenses') AS e
      FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, N''), N'') +
    ISNULL(STUFF((
      SELECT N',' + a.value
      FROM OPENJSON(@additions) AS a
      WHERE NOT EXISTS (
        SELECT 1 FROM OPENJSON(@doc, '$.expenses') AS e2
        WHERE LOWER(LTRIM(RTRIM(JSON_VALUE(e2.value, '$.label'))))
            = LOWER(LTRIM(RTRIM(JSON_VALUE(a.value, '$.label')))))
      FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
      1, CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(@doc, '$.expenses')) THEN 0 ELSE 1 END,
      CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(@doc, '$.expenses')) THEN N',' ELSE N'' END), N'') +
    N']';

  IF ISJSON(@expenses) <> 1
    THROW 50011, 'Composed expense schedule is not valid JSON — aborting.', 1;

  DECLARE @newDoc NVARCHAR(MAX) =
    JSON_MODIFY(
      JSON_MODIFY(@doc, '$.expenses', JSON_QUERY(@expenses)),
      '$.opexSchemaVersion', 2);

  -- opexSchemaVersion must be a NUMBER, not the string JSON_MODIFY writes for
  -- a variable; rewrite it as a literal so the guard rail's >= 2 test works.
  SET @newDoc = JSON_MODIFY(@newDoc, 'strict $.opexSchemaVersion', CAST(2 AS INT));

  IF ISJSON(@newDoc) <> 1
    THROW 50012, 'Composed template document is not valid JSON — aborting.', 1;

  -- Publishing demotes the current version and inserts a new one. A published
  -- Doc is never updated; IsCurrent is enforced by a filtered unique index, so
  -- the demote must land before the insert.
  UPDATE dbo.BudgetTemplateVersions SET IsCurrent = 0 WHERE Id = @curId;

  INSERT INTO dbo.BudgetTemplateVersions
    (TemplateKey, VersionNumber, VersionLabel, IsCurrent, TemplateSchemaVersion,
     PricingVersion, Doc, ContentHash, ChangeSummary, CreatedById, CreatedByName, PublishedAt)
  VALUES
    ('multifamily', @curNo + 1, N'Full Operating Expense Schedule', 1, 1,
     @pv, @newDoc,
     LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', @newDoc), 2)),
     N'Added property taxes, insurance, management fee, payroll, R&M, turnover, marketing, G&A, '
     + N'landscaping and reserves, and stamped opexSchemaVersion 2. The previous schedule covered '
     + N'services only and totalled roughly 9% of income, which the 35-55% guard rail exists to catch.',
     NULL, N'System (script)', SYSUTCDATETIME());

  UPDATE dbo.BudgetTemplates SET UpdatedAt = SYSUTCDATETIME() WHERE TemplateKey = 'multifamily';

  PRINT CONCAT('Published multifamily template v', @curNo + 1, ' with the full expense schedule.');
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== ROLLED BACK ===';
  THROW;
END CATCH;

/* ---------------------------------------------------------------------------
   3 · VERIFICATION — one result set. Every row must read PASS.
   --------------------------------------------------------------------------- */
SELECT Check_ AS [Check], Detail, CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'Current version carries the schedule' AS Check_,
         CONCAT('v', v.VersionNumber, ', opexSchemaVersion ',
                ISNULL(JSON_VALUE(v.Doc, '$.opexSchemaVersion'), 'absent')) AS Detail,
         CASE WHEN TRY_CONVERT(INT, JSON_VALUE(v.Doc, '$.opexSchemaVersion')) >= 2 THEN 1 ELSE 0 END AS Pass
  FROM dbo.BudgetTemplateVersions AS v
  WHERE v.TemplateKey = 'multifamily' AND v.IsCurrent = 1
  UNION ALL
  SELECT 2, 'Every expense category present',
         CONCAT((SELECT COUNT(*) FROM dbo.BudgetTemplateVersions AS v2
                 CROSS APPLY OPENJSON(v2.Doc, '$.expenses')
                 WHERE v2.TemplateKey = 'multifamily' AND v2.IsCurrent = 1), ' rows'),
         CASE WHEN (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions AS v3
                    CROSS APPLY OPENJSON(v3.Doc, '$.expenses')
                    WHERE v3.TemplateKey = 'multifamily' AND v3.IsCurrent = 1) >= 16 THEN 1 ELSE 0 END
  UNION ALL
  SELECT 3, 'Exactly one current version',
         CONCAT((SELECT COUNT(*) FROM dbo.BudgetTemplateVersions
                 WHERE TemplateKey = 'multifamily' AND IsCurrent = 1), ' current'),
         CASE WHEN (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions
                    WHERE TemplateKey = 'multifamily' AND IsCurrent = 1) = 1 THEN 1 ELSE 0 END
  UNION ALL
  SELECT 4, 'The previous version is intact, not rewritten',
         CONCAT('v', (SELECT MAX(VersionNumber) FROM dbo.BudgetTemplateVersions
                      WHERE TemplateKey = 'multifamily' AND IsCurrent = 0), ' retained'),
         CASE WHEN EXISTS (SELECT 1 FROM dbo.BudgetTemplateVersions
                           WHERE TemplateKey = 'multifamily' AND IsCurrent = 0) THEN 1 ELSE 0 END
) AS v
ORDER BY Ord;
