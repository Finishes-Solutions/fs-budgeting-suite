-- ============================================================================
--  Publish multifamily defaults that follow the inputs
--  (a new PRICING LIBRARY version + a new multifamily TEMPLATE version)
--  ----------------------------------------------------------------------------
--  Target : Azure SQL, the single fs-bd-budget database (staging AND production).
--  Run by : a database admin, in the Azure portal Query Editor. One batch, no GO.
--  When   : any time. It uses only what the code deployed today already
--           understands — scopes res/amen/soft, bases sf/asf/unit/ls, and
--           {mode:'pct'} project costs — so it is safe to run before, after or
--           without any release. Nothing here needs a code change to work.
--
--  WHY THIS EXISTS
--    A new budget is cloned from the multifamily TEMPLATE, and every line's
--    rate is refreshed from the PRICING LIBRARY at creation by matching
--    scope|code|desc (stampCurrentPricing in app/index.html). Three defaults
--    did not follow what the user enters on the Inputs page:
--      1. "13 11 00 Swimming Pool w/ Pool Deck" was a RESIDENTIAL per-SF line,
--         so a project with no clubhouse (Amenity SF = 0) still carried a
--         ~$165k pool. Amenity lines already drop out at Amenity SF 0
--         (scopeActive); the pool simply was not one.
--      2. No line responded to the unit count. Appliances, cabinets and
--         countertops are bought per apartment, not per square foot: tripling
--         the units of the same building changed nothing.
--      3. The developer fee was a fixed $200,000 whatever the project cost.
--
--  WHAT IT DOES (one transaction, append-only — nothing is overwritten)
--    Reads the CURRENT pricing library and the CURRENT template version and
--    publishes a new version of each:
--      * Pool -> scope amen, group "Amenity Site & Pool", basis ls (lump sum),
--        qty 1 / auto false in the template. Moved to the end of the amenity
--        lines so its group heading sits with the other amenity groups.
--      * Nine residential finish lines -> basis unit, with " (per Unit)"
--        appended to the description (see THE DESCRIPTION CHANGE below):
--        11 31 00 Residential Appliances, 12 30 00 Casework / Stock Cabinets,
--        12 36 00 Countertops, 08 11 00 Interior Doors & Frames,
--        08 71 00 Interior Door Hardware, 08 83 00 Mirrors,
--        10 28 00 Toilet, Bath & Laundry Accessories, 12 21 00 Window Blinds,
--        10 55 00 Mailboxes.
--      * Template developer fee -> {mode:'pct'}: the same dollars expressed
--        as a share of total project cost (only if it is a positive dollar
--        amount today; a fee already on a percentage is left alone).
--      * Template pricingVersion (column and document) -> the new library.
--    Lines are matched by scope + code + description, exactly (binary
--    collation, like the app's JavaScript key), and every one must be found
--    exactly once in BOTH documents or the script THROWs and changes nothing.
--
--  THE RATES ARE BACK-SOLVED STARTING POINTS, NOT HOUSE NUMBERS.
--    Each new rate is calibrated so the template's OWN default budget totals
--    the same as before, using the template's own Residential SF (S) and total
--    unit count (U), read from the current template document:
--        per-unit rate = per-SF rate x S / U, to the cent (half up)
--        pool lump sum = per-SF rate x S, to the cent (half up)
--        developer fee = fee $ / total project cost x 100, to 4 places
--    The same formula is applied to the library rate, the template's unit and
--    the template's baseUnit, so a line that was at its library rate stays at
--    it. On the shipped template (S = 51,365, U = 16+14+14+14 = 58, 2026.08-v2
--    rates) that is:
--        Appliances           3.48 x 51,365 / 58 = 3,081.90
--        Cabinets             2.01 x 51,365 / 58 = 1,780.06
--        Countertops          1.13 x 51,365 / 58 = 1,000.73
--        Interior Doors       1.31 x 51,365 / 58 = 1,160.14
--        Door Hardware        0.20 x 51,365 / 58 =   177.12
--        Mirrors              0.29 x 51,365 / 58 =   256.83  (256.825, rounded up)
--        Bath Accessories     0.62 x 51,365 / 58 =   549.07
--        Window Blinds        0.33 x 51,365 / 58 =   292.25
--        Mailboxes            0.25 x 51,365 / 58 =   221.40
--        Pool (lump sum)      3.22 x 51,365      = 165,395.30
--        Developer fee        200,000 / 9,977,137.28 = 2.0046% of project cost
--    Cent rounding moves that template's contract sum by -$0.34, and the
--    4-place fee percentage moves its total project cost by +$1.39
--    (9,977,137.61 -> 9,977,139.01; the fee itself reads $200,001.73).
--    The devFee guard rail measures fee $ / project cost whatever the mode,
--    so its verdict cannot change: 2.0046% sits inside the 2-5% rail on the
--    shipped template. A template whose fixed fee is already outside the rail
--    stays outside (verification row 10 reports INFO) — that fee needs a
--    person, not a script.
--    The live numbers are recomputed from whatever the current versions hold,
--    and the preflight prints every one of them before anything is written.
--    Whoever owns pricing should review these and republish round numbers —
--    from the Pricing page, or by re-running a copy of this script. Nothing
--    is overwritten either way; publishing is append-only.
--
--  THE DESCRIPTION CHANGE IS LOAD-BEARING — DO NOT "TIDY" IT AWAY.
--    Repricing (Update Pricing, repriceBudget) and stampCurrentPricing copy a
--    library line's RATE onto every budget line with the same scope|code|desc,
--    and they do NOT copy its basis. If "res|11 31 00|Residential Appliances"
--    kept its key, an EXISTING budget that still prices it per SF would take
--    the new per-unit rate ($3,081.90) per square foot — a $158M appliance
--    line. A new description gives the per-unit line a new key, so an old
--    per-SF line simply finds no library match. The pool is safe for the same
--    reason: its key changes with its scope (res -> amen).
--
--  WHAT IT DOES NOT DO
--    It does not touch a single existing budget, budget version or SOV row
--    (docs/DATA_CONTRACT.md: a template or pricing publish never silently
--    reprices existing work). Existing budgets keep their residential per-SF
--    pool and per-SF finish lines. They will show the usual "newer pricing
--    library" banner; if someone runs Update Pricing, those ten lines find no
--    matching library key and keep the rates they have (the same thing that
--    happens to a hand-added line), and every other line reprices as usual.
--    Budgets created from the new template get the new lines.
--
--  RUN ORDER
--    Standalone. The opex template script (sql/publish_multifamily_opex_template.sql)
--    has already run; this builds on whatever version is current.
--
--  IDEMPOTENT
--    Re-running when the current pricing library AND the current template
--    already carry the restructured lines prints a notice and changes nothing.
--    A database where only ONE of them does is a state this script did not
--    produce; it THROWs (and the preflight shows which lines are where)
--    rather than guess.
--
--  KEEP IN SYNC WITH tools/input-driven-defaults.js — a line-for-line
--  JavaScript mirror of this transformation, exercised by
--  test/input-defaults.test.js against the seed template (default totals
--  unchanged, the pool leaves with Amenity SF 0, per-unit lines follow the
--  unit count, only deployed scopes/bases used). Change one, change both.
--  ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- The new pricing-library version name. It must not exist yet; if a pricing
-- admin has already published a version with this name, the script stops —
-- change it here and re-run.
DECLARE @newPricingVersion NVARCHAR(32) = N'2026.10-v1';
DECLARE @templateKey       VARCHAR(64)  = 'multifamily';
DECLARE @versionLabel      NVARCHAR(100) = N'Defaults Follow the Inputs';

-- ---------------------------------------------------------------------------
--  The ten lines this script restructures. Every one is a residential per-SF
--  line today (Scope res, Basis sf). Kind 'pool' moves to the amenity scope as
--  a lump sum; kind 'unit' becomes per-unit under a new description.
--  MIRROR: TARGETS in tools/input-driven-defaults.js.
-- ---------------------------------------------------------------------------
DECLARE @targets TABLE (
  Ord      INT           NOT NULL PRIMARY KEY,
  Kind     VARCHAR(8)    NOT NULL,
  Code     NVARCHAR(20)  NOT NULL,
  OldDesc  NVARCHAR(300) NOT NULL,
  NewScope VARCHAR(10)   NOT NULL,
  NewGrp   NVARCHAR(120) NULL,      -- NULL = keep the line's group
  NewDesc  NVARCHAR(300) NOT NULL,
  NewBasis VARCHAR(10)   NOT NULL);
INSERT INTO @targets VALUES
  ( 1, 'pool', N'13 11 00', N'Swimming Pool w/ Pool Deck',          'amen', N'Amenity Site & Pool', N'Swimming Pool w/ Pool Deck',                    'ls'),
  ( 2, 'unit', N'11 31 00', N'Residential Appliances',              'res',  NULL, N'Residential Appliances (per Unit)',              'unit'),
  ( 3, 'unit', N'12 30 00', N'Casework / Stock Cabinets',           'res',  NULL, N'Casework / Stock Cabinets (per Unit)',           'unit'),
  ( 4, 'unit', N'12 36 00', N'Countertops',                         'res',  NULL, N'Countertops (per Unit)',                         'unit'),
  ( 5, 'unit', N'08 11 00', N'Interior Doors & Frames',             'res',  NULL, N'Interior Doors & Frames (per Unit)',             'unit'),
  ( 6, 'unit', N'08 71 00', N'Interior Door Hardware',              'res',  NULL, N'Interior Door Hardware (per Unit)',              'unit'),
  ( 7, 'unit', N'08 83 00', N'Mirrors',                             'res',  NULL, N'Mirrors (per Unit)',                             'unit'),
  ( 8, 'unit', N'10 28 00', N'Toilet, Bath & Laundry Accessories',  'res',  NULL, N'Toilet, Bath & Laundry Accessories (per Unit)',  'unit'),
  ( 9, 'unit', N'12 21 00', N'Window Blinds',                       'res',  NULL, N'Window Blinds (per Unit)',                       'unit'),
  (10, 'unit', N'10 55 00', N'Mailboxes',                           'res',  NULL, N'Mailboxes (per Unit)',                           'unit');

-- ---------------------------------------------------------------------------
--  parts() — a port of api/shared/budget-calc.js parts(), used to prove the
--  default totals do not move and to express the developer fee as a
--  percentage. Kept as one sp_executesql body so the preflight, the publish
--  and the verification all run the SAME arithmetic (no GO, no temp proc).
--  FLOAT is IEEE double, the same number type the app computes in.
--    lineQty  : auto -> sf: resSF, asf: amenSF, unit: total units, else 1;
--               not auto -> qty
--    scopeSum : amen counts only while amenSF > 0 (scopeActive)
--    profit   : hard x sum(companies.pct) / 100
--    cont     : pct -> hard x val / 100; psf -> (resSF + amenSF) x val; else val
--    project  : (contract + soft + land + fixed fees) / max(1 - pct rates, 0.05)
-- ---------------------------------------------------------------------------
DECLARE @partsSql NVARCHAR(MAX) = N'
  DECLARE @resSF  FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@doc, ''$.resSF'')), 0);
  DECLARE @amenSF FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@doc, ''$.amenSF'')), 0);
  DECLARE @units  FLOAT = ISNULL((SELECT SUM(ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(u.value, ''$.count'')), 0))
                                  FROM OPENJSON(@doc, ''$.units'') AS u), 0);
  DECLARE @res FLOAT, @amen FLOAT, @soft FLOAT;
  SELECT @res  = ISNULL(SUM(CASE WHEN s.scope = ''res''  THEN s.amt ELSE 0 END), 0),
         @amen = ISNULL(SUM(CASE WHEN s.scope = ''amen'' AND @amenSF > 0 THEN s.amt ELSE 0 END), 0),
         @soft = ISNULL(SUM(CASE WHEN s.scope = ''soft'' THEN s.amt ELSE 0 END), 0)
  FROM (
    SELECT JSON_VALUE(l.value, ''$.scope'') COLLATE Latin1_General_100_BIN2 AS scope,
           (CASE WHEN JSON_VALUE(l.value, ''$.auto'') COLLATE Latin1_General_100_BIN2 = ''true''
                 THEN CASE JSON_VALUE(l.value, ''$.basis'') COLLATE Latin1_General_100_BIN2
                        WHEN ''sf'' THEN @resSF WHEN ''asf'' THEN @amenSF WHEN ''unit'' THEN @units ELSE 1 END
                 ELSE ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(l.value, ''$.qty'')), 0) END)
           * ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(l.value, ''$.unit'')), 0) AS amt
    FROM OPENJSON(@doc, ''$.lines'') AS l) AS s;

  DECLARE @hard   FLOAT = @res + @amen;
  DECLARE @profit FLOAT = @hard * ISNULL((SELECT SUM(ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(c.value, ''$.pct'')), 0))
                                          FROM OPENJSON(@doc, ''$.companies'') AS c), 0) / 100;
  DECLARE @cMode NVARCHAR(20) = JSON_VALUE(@doc, ''$.contingency.mode'') COLLATE Latin1_General_100_BIN2;
  DECLARE @cVal  FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@doc, ''$.contingency.val'')), 0);
  DECLARE @cont  FLOAT = CASE @cMode WHEN ''pct'' THEN @hard * @cVal / 100
                                     WHEN ''psf'' THEN (@resSF + @amenSF) * @cVal ELSE @cVal END;
  SET @contract = @hard + @profit + @cont;

  -- Each fee is {mode,val} or, on an older document, a bare number of dollars.
  DECLARE @fees TABLE (k NVARCHAR(8) NOT NULL, isPct BIT NOT NULL, val FLOAT NOT NULL);
  INSERT INTO @fees (k, isPct, val)
  SELECT p.[key],
         CASE WHEN p.[type] = 5 AND JSON_VALUE(p.value, ''$.mode'') COLLATE Latin1_General_100_BIN2 = ''pct'' THEN 1 ELSE 0 END,
         ISNULL(TRY_CONVERT(FLOAT, CASE WHEN p.[type] = 5 THEN JSON_VALUE(p.value, ''$.val'') ELSE p.value END), 0)
  FROM OPENJSON(@doc, ''$.projectCosts'') AS p
  WHERE p.[key] IN (N''dev'', N''mkt'', N''cls'');
  DECLARE @land  FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@doc, ''$.projectCosts.land'')), 0);
  DECLARE @rate  FLOAT = ISNULL((SELECT SUM(val) FROM @fees WHERE isPct = 1), 0) / 100;
  DECLARE @fixed FLOAT = ISNULL((SELECT SUM(val) FROM @fees WHERE isPct = 0), 0);
  SET @project = (@contract + @soft + @land + @fixed)
               / (CASE WHEN 1 - @rate > 0.05 THEN 1 - @rate ELSE 0.05 END);
  SET @devFee  = ISNULL((SELECT CASE WHEN isPct = 1 THEN val / 100 * @project ELSE val END
                         FROM @fees WHERE k = N''dev''), 0);
  SET @feePct  = @rate;';
DECLARE @partsParams NVARCHAR(400) =
  N'@doc NVARCHAR(MAX), @contract FLOAT OUTPUT, @project FLOAT OUTPUT, @devFee FLOAT OUTPUT, @feePct FLOAT OUTPUT';

-- ---------------------------------------------------------------------------
--  1 · PREFLIGHT — read-only. Keep this output: it is the "before".
-- ---------------------------------------------------------------------------
PRINT '=== PREFLIGHT ===';

SELECT p.Version, p.Effective, p.IsCurrent, p.CreatedAt,
       (SELECT COUNT(*) FROM OPENJSON(p.Doc, '$.lines')) AS LineCount
FROM dbo.PricingLibrary AS p
ORDER BY p.IsCurrent DESC, p.Effective DESC, p.CreatedAt DESC;

SELECT v.TemplateKey, v.VersionNumber, v.VersionLabel, v.IsCurrent, v.PricingVersion,
       JSON_VALUE(v.Doc, '$.pricingVersion') AS DocPricingVersion,
       JSON_VALUE(v.Doc, '$.resSF') AS ResSF, JSON_VALUE(v.Doc, '$.amenSF') AS AmenSF,
       (SELECT SUM(TRY_CONVERT(DECIMAL(19,4), JSON_VALUE(u.value, '$.count')))
        FROM OPENJSON(v.Doc, '$.units') AS u) AS Units,
       JSON_QUERY(v.Doc, '$.projectCosts') AS ProjectCosts,
       v.CreatedAt
FROM dbo.BudgetTemplateVersions AS v
WHERE v.TemplateKey = @templateKey
ORDER BY v.VersionNumber DESC;

-- Where every target line is, in the current library and the current
-- template, under its OLD key and its NEW key. A clean first run reads
-- 1/0 in every Old/New pair; a completed run reads 0/1.
SELECT t.Ord, t.Kind, t.Code, t.OldDesc,
       (SELECT COUNT(*) FROM dbo.PricingLibrary AS p CROSS APPLY OPENJSON(p.Doc, '$.lines') AS l
         WHERE p.IsCurrent = 1
           AND JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = N'res'
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.OldDesc) AS PricingOld,
       (SELECT COUNT(*) FROM dbo.PricingLibrary AS p CROSS APPLY OPENJSON(p.Doc, '$.lines') AS l
         WHERE p.IsCurrent = 1
           AND JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = t.NewScope
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.NewDesc) AS PricingNew,
       (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions AS v CROSS APPLY OPENJSON(v.Doc, '$.lines') AS l
         WHERE v.TemplateKey = @templateKey AND v.IsCurrent = 1
           AND JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = N'res'
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.OldDesc) AS TemplateOld,
       (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions AS v CROSS APPLY OPENJSON(v.Doc, '$.lines') AS l
         WHERE v.TemplateKey = @templateKey AND v.IsCurrent = 1
           AND JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = t.NewScope
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.NewDesc) AS TemplateNew
FROM @targets AS t
ORDER BY t.Ord;

-- Existing budgets are not touched; this is how many still carry the old
-- residential pool line (and will keep it). For the record, not a problem.
SELECT COUNT(*) AS LiveBudgetsWithResidentialPool
FROM dbo.Budgets AS b
WHERE b.IsDeleted = 0 AND ISJSON(b.Doc) = 1
  AND EXISTS (SELECT 1 FROM OPENJSON(b.Doc, '$.lines') AS l
              WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = N'res'
                AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = N'13 11 00');

-- ---------------------------------------------------------------------------
--  2 · PUBLISH
-- ---------------------------------------------------------------------------
BEGIN TRANSACTION;
BEGIN TRY

  -- Read and lock both current rows. HOLDLOCK keeps a concurrent publish from
  -- the app (Pricing page / template editor) out until this commits.
  DECLARE @pCount INT, @pVersion NVARCHAR(32), @pDoc NVARCHAR(MAX);
  SELECT @pCount = COUNT(*) FROM dbo.PricingLibrary WITH (UPDLOCK, HOLDLOCK) WHERE IsCurrent = 1;
  IF @pCount <> 1
    THROW 50060, 'Expected exactly one current dbo.PricingLibrary row (IsCurrent = 1). Resolve that first — see UX_PricingLibrary_Current in sql/migrate_project_op_ids.sql.', 1;
  SELECT @pVersion = Version, @pDoc = Doc FROM dbo.PricingLibrary WHERE IsCurrent = 1;

  DECLARE @tId BIGINT, @tNo INT, @tDoc NVARCHAR(MAX);
  SELECT @tId = v.Id, @tNo = v.VersionNumber, @tDoc = v.Doc
  FROM dbo.BudgetTemplateVersions AS v WITH (UPDLOCK, HOLDLOCK)
  WHERE v.TemplateKey = @templateKey AND v.IsCurrent = 1;
  IF @tId IS NULL
    THROW 50061, 'No current multifamily template version. Run sql/migrate_budget_history_and_templates.sql first.', 1;

  -- Every line of both documents, keyed exactly as the app keys them.
  DECLARE @lk TABLE (
    Src      VARCHAR(8)     NOT NULL,   -- 'pricing' | 'template'
    Idx      INT            NOT NULL,
    Scope    NVARCHAR(4000) NULL,
    Code     NVARCHAR(4000) NULL,
    Descr    NVARCHAR(4000) NULL,
    Basis    NVARCHAR(4000) NULL,
    Unit     NVARCHAR(4000) NULL,
    BaseUnit NVARCHAR(4000) NULL,
    Auto     NVARCHAR(4000) NULL,
    PRIMARY KEY (Src, Idx));
  INSERT INTO @lk
  SELECT 'pricing', CAST(l.[key] AS INT),
         JSON_VALUE(l.value, '$.scope'), JSON_VALUE(l.value, '$.code'), JSON_VALUE(l.value, '$.desc'),
         JSON_VALUE(l.value, '$.basis'), JSON_VALUE(l.value, '$.unit'), JSON_VALUE(l.value, '$.baseUnit'),
         JSON_VALUE(l.value, '$.auto')
  FROM OPENJSON(@pDoc, '$.lines') AS l;
  INSERT INTO @lk
  SELECT 'template', CAST(l.[key] AS INT),
         JSON_VALUE(l.value, '$.scope'), JSON_VALUE(l.value, '$.code'), JSON_VALUE(l.value, '$.desc'),
         JSON_VALUE(l.value, '$.basis'), JSON_VALUE(l.value, '$.unit'), JSON_VALUE(l.value, '$.baseUnit'),
         JSON_VALUE(l.value, '$.auto')
  FROM OPENJSON(@tDoc, '$.lines') AS l;

  -- Per document: how many targets are present under the old key, and how
  -- many under the new key. 'old' = all ten old keys exactly once and no new
  -- key; 'new' = the reverse. Anything else is a state this script did not
  -- produce, and it will not guess.
  DECLARE @state TABLE (Src VARCHAR(8) NOT NULL PRIMARY KEY, OldOnce INT, OldAny INT, NewOnce INT, NewAny INT);
  INSERT INTO @state
  SELECT s.Src,
         SUM(CASE WHEN o.n = 1 THEN 1 ELSE 0 END), SUM(CASE WHEN o.n > 0 THEN 1 ELSE 0 END),
         SUM(CASE WHEN w.n = 1 THEN 1 ELSE 0 END), SUM(CASE WHEN w.n > 0 THEN 1 ELSE 0 END)
  FROM (VALUES ('pricing'), ('template')) AS s(Src)
  CROSS JOIN @targets AS t
  CROSS APPLY (SELECT COUNT(*) AS n FROM @lk AS k
               WHERE k.Src = s.Src
                 AND k.Scope COLLATE Latin1_General_100_BIN2 = N'res'
                 AND k.Code  COLLATE Latin1_General_100_BIN2 = t.Code
                 AND k.Descr COLLATE Latin1_General_100_BIN2 = t.OldDesc) AS o
  CROSS APPLY (SELECT COUNT(*) AS n FROM @lk AS k
               WHERE k.Src = s.Src
                 AND k.Scope COLLATE Latin1_General_100_BIN2 = t.NewScope
                 AND k.Code  COLLATE Latin1_General_100_BIN2 = t.Code
                 AND k.Descr COLLATE Latin1_General_100_BIN2 = t.NewDesc) AS w
  GROUP BY s.Src;

  DECLARE @nTargets INT = (SELECT COUNT(*) FROM @targets);
  DECLARE @pState VARCHAR(8) = (SELECT CASE WHEN OldOnce = @nTargets AND NewAny = 0 THEN 'old'
                                            WHEN NewOnce = @nTargets AND OldAny = 0 THEN 'new' ELSE 'mixed' END
                                FROM @state WHERE Src = 'pricing');
  DECLARE @tState VARCHAR(8) = (SELECT CASE WHEN OldOnce = @nTargets AND NewAny = 0 THEN 'old'
                                            WHEN NewOnce = @nTargets AND OldAny = 0 THEN 'new' ELSE 'mixed' END
                                FROM @state WHERE Src = 'template');

  -- A flag rather than RETURN: RETURN would skip the verification section,
  -- and on a re-run that section is the only output worth reading.
  DECLARE @alreadyDone BIT = 0;
  IF @pState = 'new' AND @tState = 'new'
  BEGIN
    PRINT CONCAT('Pricing library ', @pVersion, ' and template v', @tNo,
                 ' already carry the input-driven defaults — nothing to do.');
    SET @alreadyDone = 1;
  END
  ELSE IF NOT (@pState = 'old' AND @tState = 'old')
  BEGIN
    DECLARE @mixedMsg NVARCHAR(2048) = CONCAT(
      'Refusing to publish: the current pricing library (', @pVersion, ') is "', @pState,
      '" and the current template (v', @tNo, ') is "', @tState,
      '". Both must be "old" (every target line found exactly once under its old key, none under ',
      'its new key) to publish, or both "new" for a no-op re-run. The preflight result set ',
      'shows which lines are where. Nothing was changed.');
    THROW 50062, @mixedMsg, 1;
  END

  IF @alreadyDone = 0
  BEGIN

  IF EXISTS (SELECT 1 FROM dbo.PricingLibrary WHERE Version = @newPricingVersion)
  BEGIN
    DECLARE @pvMsg NVARCHAR(2048) = CONCAT('A pricing library version named ', @newPricingVersion,
      ' already exists. Edit @newPricingVersion at the top of this script and re-run. Nothing was changed.');
    THROW 50063, @pvMsg, 1;
  END

  -- Every target, in BOTH documents, must still be a residential per-SF line
  -- with plain-decimal rates; in the template it must also be an auto line
  -- (quantity derived from Residential SF). A line someone has customized
  -- (manual quantity, another basis) is a decision for a person, not a script.
  DECLARE @bad NVARCHAR(2048) = (
    SELECT STRING_AGG(CAST(CONCAT(k.Src, ' ', t.Code, ' ', t.OldDesc, ' (basis ', ISNULL(k.Basis, 'none'),
                                  ', unit ', ISNULL(k.Unit, 'none'),
                                  CASE WHEN k.Src = 'template' THEN CONCAT(', baseUnit ', ISNULL(k.BaseUnit, 'none'),
                                                                           ', auto ', ISNULL(k.Auto, 'none')) ELSE '' END,
                                  ')') AS NVARCHAR(MAX)), '; ')
    FROM @targets AS t
    JOIN @lk AS k
      ON k.Scope COLLATE Latin1_General_100_BIN2 = N'res'
     AND k.Code  COLLATE Latin1_General_100_BIN2 = t.Code
     AND k.Descr COLLATE Latin1_General_100_BIN2 = t.OldDesc
    WHERE ISNULL(k.Basis, '') COLLATE Latin1_General_100_BIN2 <> N'sf'
       -- rates must be plain decimals with at most 4 places, so the
       -- arithmetic below is exact (and matches the JavaScript mirror)
       OR TRY_CONVERT(DECIMAL(38,10), k.Unit) IS NULL
       OR TRY_CONVERT(DECIMAL(38,10), k.Unit) <> TRY_CONVERT(DECIMAL(19,4), k.Unit)
       OR TRY_CONVERT(DECIMAL(38,10), k.Unit) < 0
       OR (k.Src = 'template' AND (
              ISNULL(k.Auto, '') COLLATE Latin1_General_100_BIN2 <> N'true'
           OR TRY_CONVERT(DECIMAL(38,10), k.BaseUnit) IS NULL
           OR TRY_CONVERT(DECIMAL(38,10), k.BaseUnit) <> TRY_CONVERT(DECIMAL(19,4), k.BaseUnit)
           OR TRY_CONVERT(DECIMAL(38,10), k.BaseUnit) < 0)));
  IF @bad IS NOT NULL
  BEGIN
    DECLARE @badMsg NVARCHAR(2048) = LEFT(CONCAT(
      'Refusing to publish: these target lines are not plain residential per-SF auto lines with ',
      'plain-decimal rates: ', @bad, '. Nothing was changed.'), 2048);
    THROW 50064, @badMsg, 1;
  END

  -- The calibration point: the template's own Residential SF and unit count.
  DECLARE @sfText NVARCHAR(4000) = JSON_VALUE(@tDoc, '$.resSF');
  DECLARE @S DECIMAL(19,2) = TRY_CONVERT(DECIMAL(19,2), @sfText);
  DECLARE @U DECIMAL(19,4) = (SELECT SUM(TRY_CONVERT(DECIMAL(19,4), JSON_VALUE(u.value, '$.count')))
                              FROM OPENJSON(@tDoc, '$.units') AS u);
  DECLARE @A FLOAT = TRY_CONVERT(FLOAT, JSON_VALUE(@tDoc, '$.amenSF'));
  IF @S IS NULL OR @S <= 0 OR TRY_CONVERT(DECIMAL(38,10), @sfText) <> @S
    THROW 50065, 'The template''s resSF is missing, zero, or not a plain decimal with at most 2 places — cannot back-solve per-unit rates from it.', 1;
  IF @U IS NULL OR @U <= 0
     OR EXISTS (SELECT 1 FROM OPENJSON(@tDoc, '$.units') AS u
                WHERE TRY_CONVERT(DECIMAL(38,10), JSON_VALUE(u.value, '$.count')) IS NULL
                   OR TRY_CONVERT(DECIMAL(38,10), JSON_VALUE(u.value, '$.count'))
                      <> TRY_CONVERT(DECIMAL(19,4), JSON_VALUE(u.value, '$.count')))
    THROW 50066, 'The template''s unit mix is empty or has a non-numeric count — cannot back-solve per-unit rates from it.', 1;
  IF ISNULL(@A, 0) <= 0
    THROW 50067, 'The template''s amenSF is 0, so its amenity scope is off: moving the pool there would drop it from the template''s default total. Review the template first.', 1;

  -- Where the pool goes: just after the last amenity line, so its new group
  -- heading sits with the other amenity groups. (Order only — renderBudget
  -- draws each scope from its own lines in document order.)
  DECLARE @pAmenLast INT = (SELECT MAX(Idx) FROM @lk WHERE Src = 'pricing'
                             AND Scope COLLATE Latin1_General_100_BIN2 = N'amen');
  DECLARE @tAmenLast INT = (SELECT MAX(Idx) FROM @lk WHERE Src = 'template'
                             AND Scope COLLATE Latin1_General_100_BIN2 = N'amen');

  -- ---- the new rates, in exact integer arithmetic ----
  --   per-unit rate = rate x S / U, pool lump sum = rate x S, each rounded to
  --   the cent HALF UP (256.825 -> 256.83). Done on whole numbers — rate in
  --   1/10000ths, S in 1/100ths, U in 1/10000ths — with a remainder test,
  --   because DECIMAL division keeps only six places and could round a value
  --   a hair under a half-cent up. In cents:
  --     per unit: (rate4 x S2) / U4      pool: (rate4 x S2) / 10000
  --   MIRROR: halfUpCents() in tools/input-driven-defaults.js.
  DECLARE @S2 DECIMAL(38,0) = CAST(@S * 100 AS DECIMAL(38,0));
  DECLARE @U4 DECIMAL(38,0) = CAST(@U * 10000 AS DECIMAL(38,0));
  DECLARE @rates TABLE (Src VARCHAR(8) NOT NULL, Idx INT NOT NULL, Ord INT NOT NULL,
                        NewUnit DECIMAL(19,2) NOT NULL, NewBaseUnit DECIMAL(19,2) NULL,
                        PRIMARY KEY (Src, Idx));
  INSERT INTO @rates (Src, Idx, Ord, NewUnit, NewBaseUnit)
  SELECT k.Src, k.Idx, t.Ord,
         CAST(((nu.n - nu.n % dd.d) / dd.d + CASE WHEN 2 * (nu.n % dd.d) >= dd.d THEN 1 ELSE 0 END) / 100.0 AS DECIMAL(19,2)),
         CAST(((nb.n - nb.n % dd.d) / dd.d + CASE WHEN 2 * (nb.n % dd.d) >= dd.d THEN 1 ELSE 0 END) / 100.0 AS DECIMAL(19,2))
  FROM @lk AS k
  JOIN @targets AS t
    ON k.Scope COLLATE Latin1_General_100_BIN2 = N'res'
   AND k.Code  COLLATE Latin1_General_100_BIN2 = t.Code
   AND k.Descr COLLATE Latin1_General_100_BIN2 = t.OldDesc
  CROSS APPLY (SELECT CASE t.Kind WHEN 'unit' THEN @U4 ELSE CAST(10000 AS DECIMAL(38,0)) END AS d) AS dd
  CROSS APPLY (SELECT CAST(TRY_CONVERT(DECIMAL(19,4), k.Unit) * 10000 AS DECIMAL(38,0)) * @S2 AS n) AS nu
  -- the library has no baseUnit: NULL in, NULL out
  CROSS APPLY (SELECT CAST(TRY_CONVERT(DECIMAL(19,4), k.BaseUnit) * 10000 AS DECIMAL(38,0)) * @S2 AS n) AS nb;
  IF (SELECT COUNT(*) FROM @rates) <> 2 * @nTargets
     OR EXISTS (SELECT 1 FROM @rates WHERE Src = 'template' AND NewBaseUnit IS NULL)
    THROW 50075, 'Could not compute every new rate — aborting, nothing changed.', 1;

  -- ---- the pricing library's lines ----
  DECLARE @pLines NVARCHAR(MAX) = (
    SELECT STRING_AGG(CAST(x.v AS NVARCHAR(MAX)), N',') WITHIN GROUP (ORDER BY x.ord)
    FROM (
      SELECT CASE WHEN t.Kind = 'pool' THEN ISNULL(@pAmenLast + 0.5, CAST(l.[key] AS INT))
                  ELSE CAST(l.[key] AS INT) END AS ord,
             CASE t.Kind
               WHEN 'pool' THEN
                 JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(l.value,
                   '$.scope', t.NewScope), '$.grp', t.NewGrp), '$.basis', t.NewBasis),
                   '$.unit', r.NewUnit)
               WHEN 'unit' THEN
                 JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(l.value,
                   '$.desc', t.NewDesc), '$.basis', t.NewBasis),
                   '$.unit', r.NewUnit)
               ELSE l.value END AS v
      FROM OPENJSON(@pDoc, '$.lines') AS l
      LEFT JOIN @rates AS r ON r.Src = 'pricing' AND r.Idx = CAST(l.[key] AS INT)
      LEFT JOIN @targets AS t ON t.Ord = r.Ord
    ) AS x);

  DECLARE @effective DATE = CAST(SYSUTCDATETIME() AS DATE);
  DECLARE @newPDoc NVARCHAR(MAX) =
    JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(@pDoc,
      '$.lines', JSON_QUERY(N'[' + @pLines + N']')),
      '$.version', @newPricingVersion),
      '$.effective', CONVERT(NVARCHAR(10), @effective, 23));
  IF ISJSON(@newPDoc) <> 1
    THROW 50068, 'Composed pricing library document is not valid JSON — aborting.', 1;

  -- ---- the template's lines ----
  -- The same formula on unit AND baseUnit, so a line at its library rate
  -- stays at it (unit = baseUnit = the new library rate) and a deliberately
  -- re-priced template line keeps its own scaled rate.
  DECLARE @tLines NVARCHAR(MAX) = (
    SELECT STRING_AGG(CAST(x.v AS NVARCHAR(MAX)), N',') WITHIN GROUP (ORDER BY x.ord)
    FROM (
      SELECT CASE WHEN t.Kind = 'pool' THEN ISNULL(@tAmenLast + 0.5, CAST(l.[key] AS INT))
                  ELSE CAST(l.[key] AS INT) END AS ord,
             CASE t.Kind
               WHEN 'pool' THEN
                 JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(l.value,
                   '$.scope', t.NewScope), '$.grp', t.NewGrp), '$.basis', t.NewBasis),
                   '$.unit', r.NewUnit), '$.baseUnit', r.NewBaseUnit),
                   '$.qty', 1), '$.auto', CAST(0 AS BIT))
               WHEN 'unit' THEN
                 JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(l.value,
                   '$.desc', t.NewDesc), '$.basis', t.NewBasis),
                   '$.unit', r.NewUnit), '$.baseUnit', r.NewBaseUnit)
               ELSE l.value END AS v
      FROM OPENJSON(@tDoc, '$.lines') AS l
      LEFT JOIN @rates AS r ON r.Src = 'template' AND r.Idx = CAST(l.[key] AS INT)
      LEFT JOIN @targets AS t ON t.Ord = r.Ord
    ) AS x);

  DECLARE @newTDoc NVARCHAR(MAX) =
    JSON_MODIFY(JSON_MODIFY(@tDoc,
      '$.lines', JSON_QUERY(N'[' + @tLines + N']')),
      '$.pricingVersion', @newPricingVersion);
  IF ISJSON(@newTDoc) <> 1
    THROW 50069, 'Composed template document is not valid JSON — aborting.', 1;

  -- ---- totals before, and after the line changes ----
  DECLARE @c0 FLOAT, @p0 FLOAT, @d0 FLOAT, @f0 FLOAT;   -- current template
  DECLARE @c1 FLOAT, @p1 FLOAT, @d1 FLOAT, @f1 FLOAT;   -- new lines, fee unchanged
  DECLARE @c2 FLOAT, @p2 FLOAT, @d2 FLOAT, @f2 FLOAT;   -- new lines, fee as a percentage
  EXEC sp_executesql @partsSql, @partsParams, @doc = @tDoc,
       @contract = @c0 OUTPUT, @project = @p0 OUTPUT, @devFee = @d0 OUTPUT, @feePct = @f0 OUTPUT;
  EXEC sp_executesql @partsSql, @partsParams, @doc = @newTDoc,
       @contract = @c1 OUTPUT, @project = @p1 OUTPUT, @devFee = @d1 OUTPUT, @feePct = @f1 OUTPUT;

  -- ---- developer fee: the same dollars, as a share of total project cost ----
  -- Only a positive DOLLAR fee is converted (a bare number, or mode 'amt').
  -- On a percentage fee the share is of the FINAL project cost, which is
  -- circular, and parts() solves it in closed form — so fee$ / project is
  -- exactly the percentage that reproduces the same project cost.
  DECLARE @devType INT = (SELECT [type] FROM OPENJSON(@newTDoc, '$.projectCosts') WHERE [key] = N'dev');
  DECLARE @devIsAmt BIT = CASE
    WHEN @devType = 2 THEN 1
    WHEN @devType = 5 AND ISNULL(JSON_VALUE(@newTDoc, '$.projectCosts.dev.mode'), N'amt') COLLATE Latin1_General_100_BIN2 <> N'pct' THEN 1
    ELSE 0 END;
  DECLARE @devPct DECIMAL(9,4) = NULL;
  IF @devIsAmt = 1 AND @d1 > 0 AND @p1 > 0
  BEGIN
    SET @devPct = CAST(ROUND(@d1 / @p1 * 100, 4) AS DECIMAL(9,4));
    SET @newTDoc = JSON_MODIFY(@newTDoc, '$.projectCosts.dev',
                     JSON_QUERY(CONCAT(N'{"mode":"pct","val":', CONVERT(NVARCHAR(20), @devPct), N'}')));
    IF ISJSON(@newTDoc) <> 1
      THROW 50070, 'Template document is not valid JSON after the developer-fee change — aborting.', 1;
  END
  ELSE
    PRINT 'The template developer fee is not a positive dollar amount — left as it is.';

  EXEC sp_executesql @partsSql, @partsParams, @doc = @newTDoc,
       @contract = @c2 OUTPUT, @project = @p2 OUTPUT, @devFee = @d2 OUTPUT, @feePct = @f2 OUTPUT;

  -- In-transaction proof that the defaults did not move. Tolerance: cent
  -- rounding of the nine per-unit rates can move hard cost by at most half a
  -- cent per unit per line; one cent per unit per line also covers the
  -- markups that ride on hard cost. The fee percentage is rounded to four
  -- places, worth at most ~5e-7 of project cost; 1e-6 is allowed.
  DECLARE @tol FLOAT = 1.0 + 0.01 * CAST(@U AS FLOAT)
                     * (SELECT COUNT(*) FROM @targets WHERE Kind = 'unit');
  IF ABS(@c2 - @c0) > @tol
  BEGIN
    DECLARE @cMsg NVARCHAR(2048) = CONCAT('Default contract sum would move from ', FORMAT(@c0, 'N2'),
      ' to ', FORMAT(@c2, 'N2'), ' (tolerance ', FORMAT(@tol, 'N2'), ') — aborting, nothing changed.');
    THROW 50071, @cMsg, 1;
  END
  IF ABS(@p2 - @p0) > @tol + 0.000001 * @p0
  BEGIN
    DECLARE @pMsg NVARCHAR(2048) = CONCAT('Default total project cost would move from ', FORMAT(@p0, 'N2'),
      ' to ', FORMAT(@p2, 'N2'), ' — aborting, nothing changed.');
    THROW 50072, @pMsg, 1;
  END
  -- The fee-percentage rail (feeSum, max 95%) must still pass.
  IF @f2 > 0.95
    THROW 50073, 'Fee percentages would sum above 95% (the feeSum rail) — aborting, nothing changed.', 1;

  -- ---- publish: demote, then insert (both current flags are filtered-unique) ----
  UPDATE dbo.PricingLibrary SET IsCurrent = 0 WHERE IsCurrent = 1 AND Version = @pVersion;
  IF @@ROWCOUNT <> 1
    THROW 50074, 'Could not demote the current pricing library row — aborting.', 1;
  INSERT INTO dbo.PricingLibrary (Version, Effective, IsCurrent, Doc)
  VALUES (@newPricingVersion, @effective, 1, @newPDoc);

  UPDATE dbo.BudgetTemplateVersions SET IsCurrent = 0 WHERE Id = @tId;
  INSERT INTO dbo.BudgetTemplateVersions
    (TemplateKey, VersionNumber, VersionLabel, IsCurrent, TemplateSchemaVersion,
     PricingVersion, Doc, ContentHash, ChangeSummary, CreatedById, CreatedByName, PublishedAt)
  VALUES
    (@templateKey, @tNo + 1, @versionLabel, 1, 1,
     @newPricingVersion, @newTDoc,
     LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', @newTDoc), 2)),
     CONCAT(N'Pool moved to the amenity scope as a lump sum (drops out at Amenity SF 0); appliances, ',
            N'cabinets, countertops, interior doors, door hardware, mirrors, bath accessories, blinds ',
            N'and mailboxes priced per unit; developer fee ',
            CASE WHEN @devPct IS NULL THEN N'unchanged' ELSE CONCAT(N'as ', CONVERT(NVARCHAR(20), @devPct), N'% of project cost') END,
            N'. Rates back-solved from v', @tNo, N' so its default totals are unchanged. Pricing library ',
            @newPricingVersion, N'.'),
     NULL, N'System (script)', SYSUTCDATETIME());

  UPDATE dbo.BudgetTemplates SET UpdatedAt = SYSUTCDATETIME() WHERE TemplateKey = @templateKey;

  PRINT CONCAT('Published pricing library ', @newPricingVersion, ' (was ', @pVersion, ') and multifamily template v', @tNo + 1, '.');
  PRINT CONCAT('Default contract sum  ', FORMAT(@c0, 'N2'), ' -> ', FORMAT(@c2, 'N2'));
  PRINT CONCAT('Default project cost  ', FORMAT(@p0, 'N2'), ' -> ', FORMAT(@p2, 'N2'));
  IF @devPct IS NOT NULL
    PRINT CONCAT('Developer fee         ', FORMAT(@d0, 'N2'), ' -> ', CONVERT(NVARCHAR(20), @devPct), '% = ', FORMAT(@d2, 'N2'));
  END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  PRINT '=== ROLLED BACK — nothing was changed ===';
  THROW;
END CATCH;

-- ---------------------------------------------------------------------------
--  3 · VERIFICATION — one result set. Every row must read PASS or INFO.
--      Rows 8-9 compare the template version this script published with the
--      one before it, so they stay meaningful after later publishes.
-- ---------------------------------------------------------------------------
DECLARE @vPricingDoc NVARCHAR(MAX), @vPricingVersion NVARCHAR(32);
SELECT @vPricingDoc = Doc, @vPricingVersion = Version FROM dbo.PricingLibrary WHERE IsCurrent = 1;
DECLARE @vTDoc NVARCHAR(MAX), @vTNo INT, @vTPv NVARCHAR(32);
SELECT @vTDoc = Doc, @vTNo = VersionNumber, @vTPv = PricingVersion
FROM dbo.BudgetTemplateVersions WHERE TemplateKey = @templateKey AND IsCurrent = 1;

-- The version this script published, and the one it was built from.
DECLARE @oursNo INT = (SELECT MAX(VersionNumber) FROM dbo.BudgetTemplateVersions
                       WHERE TemplateKey = @templateKey AND VersionLabel = @versionLabel
                         AND CreatedByName = N'System (script)');
DECLARE @oursDoc NVARCHAR(MAX) = (SELECT Doc FROM dbo.BudgetTemplateVersions
                                  WHERE TemplateKey = @templateKey AND VersionNumber = @oursNo);
DECLARE @prevDoc NVARCHAR(MAX) = (SELECT Doc FROM dbo.BudgetTemplateVersions
                                  WHERE TemplateKey = @templateKey AND VersionNumber = @oursNo - 1);
DECLARE @vc0 FLOAT, @vp0 FLOAT, @vd0 FLOAT, @vf0 FLOAT, @vc1 FLOAT, @vp1 FLOAT, @vd1 FLOAT, @vf1 FLOAT;
IF @oursDoc IS NOT NULL AND @prevDoc IS NOT NULL
BEGIN
  EXEC sp_executesql @partsSql, @partsParams, @doc = @prevDoc,
       @contract = @vc0 OUTPUT, @project = @vp0 OUTPUT, @devFee = @vd0 OUTPUT, @feePct = @vf0 OUTPUT;
  EXEC sp_executesql @partsSql, @partsParams, @doc = @oursDoc,
       @contract = @vc1 OUTPUT, @project = @vp1 OUTPUT, @devFee = @vd1 OUTPUT, @feePct = @vf1 OUTPUT;
END
DECLARE @vU FLOAT = (SELECT SUM(ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(u.value, '$.count')), 0))
                     FROM OPENJSON(@oursDoc, '$.units') AS u);
DECLARE @vTol FLOAT = 1.0 + 0.01 * ISNULL(@vU, 0) * (SELECT COUNT(*) FROM @targets WHERE Kind = 'unit');

-- The ten target lines under their NEW keys, in the current library and template.
DECLARE @vNew TABLE (Ord INT PRIMARY KEY, PCount INT, PBasis NVARCHAR(4000), PUnit NVARCHAR(4000),
                     TCount INT, TBasis NVARCHAR(4000), TUnit NVARCHAR(4000), TBaseUnit NVARCHAR(4000),
                     TQty NVARCHAR(4000), TAuto NVARCHAR(4000), POldCount INT, TOldCount INT);
INSERT INTO @vNew
SELECT t.Ord,
       (SELECT COUNT(*) FROM OPENJSON(@vPricingDoc, '$.lines') AS l
         WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = t.NewScope
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.NewDesc),
       pl.basis, pl.unit,
       (SELECT COUNT(*) FROM OPENJSON(@vTDoc, '$.lines') AS l
         WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = t.NewScope
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.NewDesc),
       tl.basis, tl.unit, tl.baseUnit, tl.qty, tl.auto,
       (SELECT COUNT(*) FROM OPENJSON(@vPricingDoc, '$.lines') AS l
         WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = N'res'
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.OldDesc),
       (SELECT COUNT(*) FROM OPENJSON(@vTDoc, '$.lines') AS l
         WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = N'res'
           AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
           AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.OldDesc)
FROM @targets AS t
OUTER APPLY (SELECT TOP 1 JSON_VALUE(l.value, '$.basis') AS basis, JSON_VALUE(l.value, '$.unit') AS unit
             FROM OPENJSON(@vPricingDoc, '$.lines') AS l
             WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = t.NewScope
               AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
               AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.NewDesc) AS pl
OUTER APPLY (SELECT TOP 1 JSON_VALUE(l.value, '$.basis') AS basis, JSON_VALUE(l.value, '$.unit') AS unit,
                    JSON_VALUE(l.value, '$.baseUnit') AS baseUnit, JSON_VALUE(l.value, '$.qty') AS qty,
                    JSON_VALUE(l.value, '$.auto') AS auto
             FROM OPENJSON(@vTDoc, '$.lines') AS l
             WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = t.NewScope
               AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = t.Code
               AND JSON_VALUE(l.value, '$.desc')  COLLATE Latin1_General_100_BIN2 = t.NewDesc) AS tl;

-- The devFee rail measures fee $ / project cost whatever the fee's mode, so
-- converting the same dollars to a percentage cannot change its verdict
-- (short of the 4-place rounding landing exactly on a boundary). A template
-- whose fee was already outside the rail stays outside: that is INFO for a
-- person to review, not something this script should paper over.
DECLARE @vDevMode NVARCHAR(20) = JSON_VALUE(@oursDoc, '$.projectCosts.dev.mode');
DECLARE @vDevVal  FLOAT = TRY_CONVERT(FLOAT, JSON_VALUE(@oursDoc, '$.projectCosts.dev.val'));
DECLARE @vDevMin  FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@oursDoc, '$.guardrails.Multifamily.devFee.min')), 0.02);
DECLARE @vDevMax  FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@oursDoc, '$.guardrails.Multifamily.devFee.max')), 0.05);
DECLARE @vDevR0   FLOAT = CASE WHEN @vp0 > 0 AND @vd0 > 0 THEN @vd0 / @vp0 END;   -- before
DECLARE @vDevR1   FLOAT = CASE WHEN @vp1 > 0 AND @vd1 > 0 THEN @vd1 / @vp1 END;   -- after
DECLARE @vDevIn0  BIT = CASE WHEN @vDevR0 >= @vDevMin AND @vDevR0 <= @vDevMax THEN 1 ELSE 0 END;
DECLARE @vDevIn1  BIT = CASE WHEN @vDevR1 >= @vDevMin AND @vDevR1 <= @vDevMax THEN 1 ELSE 0 END;
DECLARE @vFeeMax  FLOAT = ISNULL(TRY_CONVERT(FLOAT, JSON_VALUE(@vTDoc, '$.guardrails.Multifamily.feeSum.max')), 0.95);
DECLARE @vc FLOAT, @vp FLOAT, @vd FLOAT, @vf FLOAT;
EXEC sp_executesql @partsSql, @partsParams, @doc = @vTDoc,
     @contract = @vc OUTPUT, @project = @vp OUTPUT, @devFee = @vd OUTPUT, @feePct = @vf OUTPUT;

SELECT Check_ AS [Check], Detail,
       CASE Pass WHEN 1 THEN 'PASS' WHEN 2 THEN 'INFO' ELSE 'FAIL' END AS Result
FROM (
  SELECT 1 AS Ord, 'Exactly one current pricing library' AS Check_,
         CONCAT((SELECT COUNT(*) FROM dbo.PricingLibrary WHERE IsCurrent = 1), ' current: ', @vPricingVersion) AS Detail,
         CASE WHEN (SELECT COUNT(*) FROM dbo.PricingLibrary WHERE IsCurrent = 1) = 1 THEN 1 ELSE 0 END AS Pass
  UNION ALL
  SELECT 2, 'Exactly one current multifamily template version',
         CONCAT((SELECT COUNT(*) FROM dbo.BudgetTemplateVersions WHERE TemplateKey = @templateKey AND IsCurrent = 1),
                ' current: v', @vTNo),
         CASE WHEN (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions
                    WHERE TemplateKey = @templateKey AND IsCurrent = 1) = 1 THEN 1 ELSE 0 END
  UNION ALL
  SELECT 3, 'Library carries all ten lines under their new keys, none under the old',
         CONCAT('new keys found once: ', (SELECT COUNT(*) FROM @vNew WHERE PCount = 1),
                '/10; old keys left: ', (SELECT SUM(POldCount) FROM @vNew)),
         CASE WHEN (SELECT COUNT(*) FROM @vNew WHERE PCount = 1) = 10
               AND (SELECT SUM(POldCount) FROM @vNew) = 0 THEN 1 ELSE 0 END
  UNION ALL
  SELECT 4, 'Template carries all ten lines under their new keys, none under the old',
         CONCAT('new keys found once: ', (SELECT COUNT(*) FROM @vNew WHERE TCount = 1),
                '/10; old keys left: ', (SELECT SUM(TOldCount) FROM @vNew)),
         CASE WHEN (SELECT COUNT(*) FROM @vNew WHERE TCount = 1) = 10
               AND (SELECT SUM(TOldCount) FROM @vNew) = 0 THEN 1 ELSE 0 END
  UNION ALL
  SELECT 5, 'Pool is an amenity lump sum (drops out at Amenity SF 0)',
         (SELECT CONCAT('library ', PBasis, ' ', PUnit, '; template ', TBasis, ' ', TUnit,
                        ', qty ', TQty, ', auto ', TAuto) FROM @vNew WHERE Ord = 1),
         CASE WHEN EXISTS (SELECT 1 FROM @vNew WHERE Ord = 1 AND PBasis = N'ls' AND TBasis = N'ls'
                             AND TRY_CONVERT(FLOAT, TQty) = 1 AND TAuto = N'false') THEN 1 ELSE 0 END
  UNION ALL
  SELECT 6, 'Nine finish lines are per unit, template at the library rate',
         CONCAT('per unit: ', (SELECT COUNT(*) FROM @vNew AS n JOIN @targets AS t ON t.Ord = n.Ord
                               WHERE t.Kind = 'unit' AND n.PBasis = N'unit' AND n.TBasis = N'unit'),
                '/9; baseUnit = library rate: ',
                (SELECT COUNT(*) FROM @vNew WHERE TRY_CONVERT(DECIMAL(19,4), TBaseUnit) = TRY_CONVERT(DECIMAL(19,4), PUnit)),
                '/10'),
         CASE WHEN (SELECT COUNT(*) FROM @vNew AS n JOIN @targets AS t ON t.Ord = n.Ord
                    WHERE t.Kind = 'unit' AND n.PBasis = N'unit' AND n.TBasis = N'unit') = 9
               AND (SELECT COUNT(*) FROM @vNew
                    WHERE TRY_CONVERT(DECIMAL(19,4), TBaseUnit) = TRY_CONVERT(DECIMAL(19,4), PUnit)) = 10
              THEN 1 ELSE 0 END
  UNION ALL
  -- The deploy-order rule: published data may use only what the deployed
  -- code understands.
  SELECT 7, 'Only scopes res/amen/soft and bases sf/asf/unit/ls are published',
         CONCAT('offending lines: ', ISNULL((
           SELECT STRING_AGG(CAST(CONCAT(s.Src, ' ', JSON_VALUE(l.value, '$.code'), ' ',
                                         JSON_VALUE(l.value, '$.scope'), '/', JSON_VALUE(l.value, '$.basis')) AS NVARCHAR(MAX)), '; ')
           FROM (VALUES ('library', @vPricingDoc), ('template', @vTDoc)) AS s(Src, Doc)
           CROSS APPLY OPENJSON(s.Doc, '$.lines') AS l
           WHERE ISNULL(JSON_VALUE(l.value, '$.scope'), '') COLLATE Latin1_General_100_BIN2 NOT IN (N'res', N'amen', N'soft')
              OR ISNULL(JSON_VALUE(l.value, '$.basis'), '') COLLATE Latin1_General_100_BIN2 NOT IN (N'sf', N'asf', N'unit', N'ls')),
           'none')),
         CASE WHEN EXISTS (
           SELECT 1 FROM (VALUES (@vPricingDoc), (@vTDoc)) AS s(Doc)
           CROSS APPLY OPENJSON(s.Doc, '$.lines') AS l
           WHERE ISNULL(JSON_VALUE(l.value, '$.scope'), '') COLLATE Latin1_General_100_BIN2 NOT IN (N'res', N'amen', N'soft')
              OR ISNULL(JSON_VALUE(l.value, '$.basis'), '') COLLATE Latin1_General_100_BIN2 NOT IN (N'sf', N'asf', N'unit', N'ls'))
           THEN 0 ELSE 1 END
  UNION ALL
  SELECT 8, 'Default contract sum unchanged by this publish',
         CASE WHEN @oursNo IS NULL THEN 'this script has not published a template version'
              ELSE CONCAT('v', @oursNo - 1, ' ', FORMAT(@vc0, 'N2'), ' -> v', @oursNo, ' ', FORMAT(@vc1, 'N2'),
                          ' (difference ', FORMAT(@vc1 - @vc0, 'N2'), ', tolerance ', FORMAT(@vTol, 'N2'), ')') END,
         CASE WHEN @oursNo IS NOT NULL AND ABS(@vc1 - @vc0) <= @vTol THEN 1 ELSE 0 END
  UNION ALL
  SELECT 9, 'Default total project cost unchanged by this publish',
         CASE WHEN @oursNo IS NULL THEN 'this script has not published a template version'
              ELSE CONCAT('v', @oursNo - 1, ' ', FORMAT(@vp0, 'N2'), ' -> v', @oursNo, ' ', FORMAT(@vp1, 'N2'),
                          ' (difference ', FORMAT(@vp1 - @vp0, 'N2'), ')') END,
         CASE WHEN @oursNo IS NOT NULL AND ABS(@vp1 - @vp0) <= @vTol + 0.000001 * @vp0 THEN 1 ELSE 0 END
  UNION ALL
  SELECT 10, 'Developer fee is a percentage; devFee rail verdict unchanged',
         CASE WHEN @oursNo IS NULL THEN 'this script has not published a template version'
              ELSE CONCAT('v', @oursNo, ' mode ', ISNULL(@vDevMode, 'amount'), ' ', ISNULL(CONVERT(NVARCHAR(30), @vDevVal), 'n/a'),
                          ' = ', FORMAT(ISNULL(@vd1, 0), 'N2'), '; ratio ', FORMAT(ISNULL(@vDevR0, 0) * 100, 'N4'), '% -> ',
                          FORMAT(ISNULL(@vDevR1, 0) * 100, 'N4'), '% against the ',
                          CONVERT(NVARCHAR(10), @vDevMin * 100), '-', CONVERT(NVARCHAR(10), @vDevMax * 100), '% rail: ',
                          CASE @vDevIn0 WHEN 1 THEN 'inside' ELSE 'outside' END, ' -> ',
                          CASE @vDevIn1 WHEN 1 THEN 'inside' ELSE 'outside' END) END,
         CASE WHEN @oursNo IS NULL THEN 0
              WHEN ISNULL(@vDevMode, N'') <> N'pct' THEN 2   -- not converted (fee was not a positive dollar amount)
              WHEN @vDevIn1 = 1 THEN 1
              WHEN @vDevIn0 = 0 THEN 2                        -- outside before AND after: review the fee
              ELSE 0 END
  UNION ALL
  SELECT 11, 'Fee percentages inside the feeSum rail',
         CONCAT(FORMAT(ISNULL(@vf, 0) * 100, 'N4'), '% of ', FORMAT(@vFeeMax * 100, 'N0'), '% allowed'),
         CASE WHEN ISNULL(@vf, 0) <= @vFeeMax THEN 1 ELSE 0 END
  UNION ALL
  SELECT 12, 'Template is priced on the current library',
         CONCAT('template v', @vTNo, ' column ', ISNULL(@vTPv, 'NULL'), ', document ',
                ISNULL(JSON_VALUE(@vTDoc, '$.pricingVersion'), 'NULL'), '; current library ', @vPricingVersion),
         -- INFO, not FAIL, when they differ: a later pricing publish legitimately
         -- moves the library on; new budgets are stamped with it at creation.
         CASE WHEN @vTPv = @vPricingVersion AND JSON_VALUE(@vTDoc, '$.pricingVersion') = @vPricingVersion THEN 1 ELSE 2 END
  UNION ALL
  SELECT 13, 'Previous pricing and template versions retained',
         CONCAT((SELECT COUNT(*) FROM dbo.PricingLibrary WHERE IsCurrent = 0), ' earlier pricing version(s), ',
                (SELECT COUNT(*) FROM dbo.BudgetTemplateVersions WHERE TemplateKey = @templateKey AND IsCurrent = 0),
                ' earlier template version(s)'),
         CASE WHEN EXISTS (SELECT 1 FROM dbo.PricingLibrary WHERE IsCurrent = 0)
               AND EXISTS (SELECT 1 FROM dbo.BudgetTemplateVersions WHERE TemplateKey = @templateKey AND IsCurrent = 0)
              THEN 1 ELSE 0 END
  UNION ALL
  SELECT 14, 'Existing budgets left as they were (by design)',
         CONCAT((SELECT COUNT(*) FROM dbo.Budgets AS b
                 WHERE b.IsDeleted = 0 AND ISJSON(b.Doc) = 1
                   AND EXISTS (SELECT 1 FROM OPENJSON(b.Doc, '$.lines') AS l
                               WHERE JSON_VALUE(l.value, '$.scope') COLLATE Latin1_General_100_BIN2 = N'res'
                                 AND JSON_VALUE(l.value, '$.code')  COLLATE Latin1_General_100_BIN2 = N'13 11 00')),
                ' live budget(s) keep their residential pool line; Update Pricing leaves it at its own rate'),
         2
) AS v
ORDER BY Ord;
