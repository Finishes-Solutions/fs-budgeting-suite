# Budgeting Suite Expansion — Implementation Plan (revised)

Branch: `claude/budgeting-suite-expansion-lwuc2e`. Never `main` or `staging`.

## Context

The Budgeting Suite builds internal construction budgets well, but the money model stops at one document: no legal-entity structure, no lender-facing budget, no per-company profit allocation beyond the free-text `doc.companies[{name,pct}]` markup, and no contract records. The goal is a traceable **Project → Project Entity → Budget → Approved Budget → Bank/Allocation Views → Contracts → Reconciliation** workflow where every number reconciles from one source of truth — without turning the suite into an ERP.

Owner's revision directives folded into this plan:
- Keep the existing Project Overview layout; **add a Contracts section below Investment Analyses on the project page** — no new top-level tabs/pages.
- Keep all enhanced financial views **inside the existing Budget experience**.
- **One derived allocation model** feeds profit split, waterfall, contracts, and reconciliation — not per-feature math.
- Contracts are created **only from an approved Budget Version**, never from a working/draft budget. Working-budget edits after contracts exist change nothing; a newly **approved** version whose allocations differ flags contracts **Requires Review** with the variance.
- Structured Contract records only — **no contract templates, template versioning, PDF legal documents, merge fields, e-signature, amendments, or change orders** (real templates don't exist yet).
- **No Version Compare screen.**
- Keep the UI **modular** — new external no-build modules, not large inline additions to `app/index.html`.
- Preserve existing Projects, Budgets, Templates, and calculation semantics.

Codebase ground rules this plan honors (established by exploration):
- No build step; external IIFE modules behind `window.FS*` globals wired via adapter objects (the `FSProjects.init({esc, usd, api, go, openDialog, …})` pattern, index.html:3777).
- **A new `api/<name>/` folder is not reliably picked up by the deployed host** → all new server surface is query scopes on endpoints that already deploy; the in-function role check is the *only* gate (route rules can't see query strings).
- One database for all environments; migrations run manually after deploy → every new column/table is probed via `api/shared/schema.js` `features(pool)`; code degrades gracefully pre-migration.
- Shared arithmetic ships as **byte-identical UMD pairs** (guardrails precedent, byte-compare test). Browser `parts()` mirrors `api/shared/budget-calc.js` (suite-09 parity). Server recomputes stored money/guardrails from the submitted doc.
- `policyFor(doc)` (app/guardrails.js:171) already prefers `doc.guardrails` — the wired-but-unpopulated hook for template-driven rules.
- `parts()` semantics (`profit = Σ hard·pct/100`; `contract = hard + profit + cont`; closed-form fee solve) are load-bearing and **unchanged**.
- `migrate()` is client-only; canonical JSON + SHA-256 defines "changed" — no volatile keys, no injected defaults (old docs must stay no-op hashes).
- Budget status has no approval semantics; the status-only PUT skips versioning — so approval needs its own explicit pointer.
- No project-edit UI exists today (name/address are creation-only).

## Architecture decisions

1. **Bank Budget, profit splits, waterfall, intercompany view are DERIVED LAYERS over the internal budget** — pure functions of `(doc, parts(), csiSchedule(), finance rules)`. They cannot drift and reconcile by construction. The alternates mechanism (full copies) is not used for variants.
2. **One new byte-identical calc pair: `app/budget-finance.js` ↔ `api/shared/budget-finance.js`** (`window.FSBudgetFinance` / CommonJS; byte-compare in `test/budget-finance.test.js`). It consumes already-computed `parts()`/`csiSchedule()` outputs — never recomputes them. It is the **single allocation model**: bank derivation, allocation engine, waterfall stages, consolidation/eliminations, contract expectations, reconciliation statuses. Everything downstream (UI, contract generation, reconciliation) reads this one model.
3. **One new UI module: `app/budget-financials.js`** (`window.FSBudgetFinancials`, adapter pattern) renders every new budget-side view (bank table, splits, waterfall SVG, intercompany, exec summary card, template finance/guardrail authoring forms, Entity Master admin card). `index.html` gains only page shells, wiring, and small dispatch lines. Contracts UI lives in `app/projects.js` (already modular).
4. **Finance rules live in the template doc (`doc.finance`)**, inherited into the budget doc at creation (the same journey lines/expenses take; the same hook style as `doc.guardrails`). Per-budget override by director+ app role. Absent key = `DEFAULT_FINANCE` fallback — old docs behave identically; `migrate()` normalizes the key only if present, never injects it.
5. **`doc.companies[]` stays authoritative for contract-sum profit.** `parts()`/`csiSchedule()` untouched. The allocation engine *maps* streams `parts()` already produces onto Entity Master entities. `companies[i]` gains optional `entityKey`; absent, the engine name-matches ("Finishes Solutions LLC" matches the seeded entity).
6. **Explicit approval pointer**: `dbo.Budgets.ApprovedVersionId` (+At/ById/ByName), set by a deliberate `PUT ?scope=approve` (director+). Status ('Completed') is not approval: it's a one-click mutable pill whose status-only PUT pins nothing; contracts must cut from an immutable `BudgetVersions` row. Approving (or a confirmed project-entity change) is the **only** event that re-checks contracts — working-draft edits never touch them.
7. **Contract records are plain structured rows** — no templates, no generated documents, no PDF. A contract stores who/what/how-much/from-which-version and its status; that is the whole record.

## Database / schema changes

Three idempotent portal migrations (PREFLIGHT/MIGRATION/VERIFICATION, `--` comments only, `SET XACT_ABORT ON`, existence-guarded DDL, `sp_executesql` for same-batch column refs — model: `sql/migrate_projects_and_guardrails.sql`, `sql/adopt_project_numbers.sql`). `sql/schema.sql` gains the same objects with the same constraint names in the same commits.

**`sql/migrate_entities.sql`** (Phase 2)
- `dbo.Entities`: `EntityId INT IDENTITY PK`, `EntityKey VARCHAR(64) UNIQUE` (slug), `LegalName NVARCHAR(300)`, `DisplayName NVARCHAR(200)`, `EntityType NVARCHAR(50)`, `Address NVARCHAR(300)`, `IsFinishesCompany BIT`, `IsActive BIT`, timestamps. Master data deactivates rather than deletes (template precedent).
- `dbo.Projects.EntityId INT NULL` + `FK_Projects_Entity`.
- Idempotent seed of six `IsFinishesCompany=1` rows: `finishes-solutions` (LegalName exactly `Finishes Solutions LLC`, so name-matching lifts existing `companies[]`), `finishes-construction`, `finishes-development`, `finishes-marketing`, `brokerage`, `property-management`.

**`sql/migrate_budget_approval.sql`** (Phase 6)
- `dbo.Budgets`: `ApprovedVersionId INT NULL` (FK → `dbo.BudgetVersions.Id`), `ApprovedAt`, `ApprovedById`, `ApprovedByName`.

**`sql/migrate_contracts.sql`** (Phase 7)
- `dbo.Contracts`: `ContractId INT IDENTITY PK`, `BudgetId` (FK Budgets), `ProjectKey` (FK Projects), `BudgetVersionId` (FK BudgetVersions — the immutable pin), `ProjectEntityId`/`ContractingEntityId`/`PerformingEntityId` (FKs Entities), `AllocationKey VARCHAR(80)` (`<entityKey>:<stream>` — the allocation row this contract reifies), `OriginalAmount`/`CurrentAmount DECIMAL(18,2)`, `ProfitAmount DECIMAL(18,2) NULL`, `Scope NVARCHAR(1000)` (plain description), `EffectiveDate DATE NULL`, `Status NVARCHAR(30)` (`Generated | Requires Review | Superseded | Void`), `ReviewNote NVARCHAR(1000) NULL`, creator/timestamps, `IsDeleted`+`DeletedAt`. Index `IX_Contracts_Budget (BudgetId) WHERE IsDeleted=0`, `IX_Contracts_Project (ProjectKey) WHERE IsDeleted=0`.
- **No** ContractTemplates / ContractTemplateVersions / GeneratedDoc — out of scope by directive.

**`api/shared/schema.js`**: add `'Entities','Contracts'` to the `WHERE o.name IN (…)` list; flags `entitiesTable`, `projectsEntityId`, `budgetsApproved`, `contractsTable` — in both `probe()` and the all-false catch fallback. Cover in `test/schema-probe.test.js`.

## Budget doc changes

New keys (stable user-authored config; no volatile keys → canonical hashing safe; derived numbers never written into the doc):

- `doc.finance` — inherited from the template at creation; shape below. `migrate()` (index.html:4304) normalizes **only if present** (nz-coerce numerics, drop malformed rows — the `guardrailAcks` style). Never injected into old docs.
- `doc.guardrails` — now authored by the Template Editor (already consumed by `policyFor()`).
- `doc.companies[i].entityKey` — optional string.
- `blankDoc()` (index.html:4276): non-bare docs get `finance: FSBudgetFinance.DEFAULT_FINANCE` and the FS row gains `entityKey:'finishes-solutions'`.
- `api/shared/budget-calc.js`: **unchanged**. All `finance` reads live in the new pair behind `nz()` guards.

```js
doc.finance = {
  bank: {
    upliftPct: 10,               // bank total = internal project cost × 1.10 — configurable, never hard-coded
    allocation: [                // how the uplift distributes — NOT a blind 10% per line
      { match:'div',  key:'03', pct:15 },
      { match:'hard', pct:8 },
      { match:'soft', pct:5 }
    ],
    remainder: 'contingency'     // 'contingency' | 'lenderAllowance' | 'prorata'
  },
  allocations: [
    // markup pct itself LIVES in doc.companies (matched by entityKey/name);
    // rules map stream → entity and declare the performed-cost share.
    { entityKey:'finishes-solutions',    stream:'companyMarkup', costShare:0.30 },
    { entityKey:'finishes-construction', stream:'companyMarkup', costShare:0.70 },
    { entityKey:'finishes-development',  stream:'devFee' },
    { entityKey:'finishes-marketing',    stream:'mktFee', share:0.6 },
    { entityKey:'brokerage',             stream:'mktFee', share:0.4 }
    // property-management participates only when a rule names it
  ]
}
```

## The finance calc pair (`app/budget-finance.js` ↔ `api/shared/budget-finance.js`)

Pure functions; inputs are `doc` + the caller's `parts()`/`csiSchedule()` outputs + resolved rules + (where relevant) entity list / contract rows. Exports `DEFAULT_FINANCE` and `financeFor(doc)` (`doc.finance || DEFAULT_FINANCE`).

**`deriveBank({doc, parts, csi, finance})`** — pool = `parts.project × upliftPct/100`; each allocation rule computes its category uplift; shortfall lands on the `remainder` target (contingency `99 03 00`, a synthesized "Lender Allowance" `99 05 00`, or pro-rata); overshoot scales category uplifts down proportionally; rounding reconciles onto the remainder row. **Invariant: bankTotal === internalTotal + pool, to the cent.** Output: rows `{key,label,kind,internal,bank,diffUsd,diffPct}` + `{internalTotal, bankTotal, upliftPct, upliftUsd, remainderUsd, remainderTarget}` — every bank amount traces to its internal amount.
Worked example: internal $10.0M, 10% → pool $1.0M. Div 03 $2.0M→+$300k (15%), other hard $3.0M→+$240k (8%), soft $800k→+$40k (5%); category sum $760k; remainder $240k onto contingency; footer proves Σ = $11.0M = $10.0M + 10%.

**`allocate({doc, parts, csi, finance, entities})`** — streams map 1:1 to numbers `parts()` already computed (`companyMarkup` → the matching `companies[]` row's dollars; `devFee/mktFee/clsFee` → `parts.fee.*`, split by `share`). `costShare` distributes `parts.hard` as each company's Applicable Cost Basis (Σ must be 1; validated; remainder to FS). Per participating entity:
`{entityKey, displayName, legalName, costBasis, contractValue, profit, basisLabel:'markup'|'margin'|'fee', markupPct /* profit÷costBasis, null on zero basis */, marginPct /* profit÷contractValue */, pctOfProject}` — **both markup and margin always computed and shown**; `basisLabel` decides which is headlined. A doc with no `finance` and default `companies[]` yields exactly one FS row whose profit equals `parts().profit` (backward-compat identity, tested).

**`consolidate(allocResult, parts)`** — the Project Entity pays externally on the construction contract (`parts.contract` → Finishes Solutions) and the fee streams to their mapped entities. FS pays intercompany subcontracts `sub_i = costShare_i·hard + profit_i` to each non-FS `companyMarkup` entity. Output: `{entityRevenue:[{entityKey, external, intercompany, total}], eliminations:[{from,to,amount}], consolidatedExternalRevenue, intercompanyTotal, checks}`. Owner's example holds: PE→FS $10M, FS→others $7M ⇒ consolidated external revenue $10M, never $17M.

**`waterfall(allocResult, consolidation, parts)`** — ordered stages: Total Project Value → External Project Costs → each Finishes company's profit → Consolidated Finishes Profit; values in `$` and `%` (÷ `parts.project`).

**`contractPlan(allocResult, parts)`** — the expected contract set for a given (version) doc: the PE→FS primary contract (`parts.contract`), one FS→company row per participating `companyMarkup` entity (`sub_i`), one PE→entity row per fee stream — each `{allocationKey, contractingEntityKey, performingEntityKey, amount, profit}`. **This single output drives generation, reconciliation, and the requires-review check** — the "one derived allocation model" directive.

**`reconcile(contractPlan, contracts)`** — statuses: **Reconciled** (every planned allocation ↔ live contract within $1 and vice versa), **Overallocated / Underallocated**, **Missing Allocation** (live contract whose `AllocationKey` matches no planned row), **Missing Contract**, **Contract–Budget Variance** (`CurrentAmount ≠` planned amount). Drill rows `{entityKey, stream, allocationAmount, contractId, contractAmount, varianceUsd, status}`.

## API changes (all query scopes; the in-function check is the only gate)

| Endpoint | Method | Scope | Gate | Purpose |
|---|---|---|---|---|
| `/api/budgets` | GET | `entities` | signed-in | Entity list (`{available:false}` pre-migration); branch beside `scope=projects` (api/budgets/index.js:38) |
| `/api/user-settings` | PUT | `entities` | `isSuperAdmin` (the `scope=roles` precedent at api/user-settings/index.js:58) + platform `pricing_admin` | Entity create/update; seeded Finishes rows refuse deactivation/key edits; 503 `migration_pending` pre-migration |
| `/api/budget/{OP-####}` | PUT | `project` (existing) | signed-in | + `entityId` (validated against active entities), `confirmEntityChange`; **409 `entity_change_requires_confirmation`** with contract/approved-budget counts when changing the entity under live contracts or approved budgets; confirmed change flags that project's live contracts `Requires Review` + `project_entity` activity |
| `/api/budget/{id}` | PUT | `approve` | director+ (`dbo.Users.AppRole`; 503 pre-migration) | `{}` pins the latest version into `ApprovedVersionId`; `{clear:true}` unpins; on re-approve, runs the requires-review comparison |
| `/api/budget/{id}` | GET | `contracts` | signed-in | `{available, approved:{versionNumber,…}, contracts:[…], reconciliation:{…}}` (reconciliation computed server-side from `contractPlan` on the pinned version doc) |
| `/api/budget/{id}` | PUT | `contracts` | director+ | `{generate:true, effectiveDate?}` — generation flow below |
| `/api/budget/{id}` | PUT | `contract` | director+ | `{contractId, action:'accept'|'void', note?}` |
| `/api/budgets` | GET | `project` (existing) | signed-in | project detail additionally returns `contracts[]` for the project (probe-gated), so the project page's Contracts card needs no extra round trip |

Routing placement: new `api/budget` scope branches go **after** the `ID_RX` check (api/budget/index.js:81) and **before** the status-only PUT shortcut (:121) so the `!body.doc && typeof status==='string'` test can't swallow scope bodies. Entity CRUD deliberately does not ride `PUT /api/budget/{id}` (would require widening `ID_RX` — forbidden). `staticwebapp.config.json` untouched (route rules can't gate scopes).

**Contract generation** (server-side, `scope=contracts {generate:true}`): load `ApprovedVersionId` (400 `not_approved` if null — contracts only from an approved version, never a working draft) and the project's entity (400 `no_project_entity` if unset); recompute `parts()`/`csiSchedule()`/`allocate()`/`contractPlan()` from the **stored version Doc** via the shared modules; insert one contract row per plan row — PE→Finishes Solutions primary, FS→each participating company, PE→fee entities — amounts from the plan, never the request. Prior live contracts for the budget → `Superseded`.

**Requires-review** — exactly two triggers, both server-side, never silent rewrites: (a) `scope=approve` moving the pin → recompute `contractPlan` from the newly approved version, compare per `AllocationKey` to each live contract's `CurrentAmount`; mismatch → `Status='Requires Review'` + variance in `ReviewNote`; (b) confirmed project-entity change. Working-budget saves never touch contracts. Resolution: `accept` re-pins (`CurrentAmount`, `BudgetVersionId`; `OriginalAmount` never moves) or `void`.

Activity events (server-side; labels + detail cases in **both** `eventDetail()` maps — `app/dashboard.js` and `app/home.js`): `project_entity`, `entity_create`, `entity_update`, `budget_approve`, `contract_generate`, `contract_review`, `contract_status`.

## Frontend changes (modular)

**New module `app/budget-financials.js`** (`window.FSBudgetFinancials`, no-build IIFE, `init(adapter)` receiving `{esc, usd, api, doc:()=>doc, parts, csiSchedule, entities, canEditFinance, touch, markDirty, openDialog, closeDialog, toast, go}`; `node --check` before committing). It owns rendering of:
- **Bank Budget & Reconciliation** table (Internal / Bank / $ diff / % diff per category + reconciliation footer, layer banner "Derived from Current Working Budget" vs "Approved vN").
- **Profit Splits** table (per entity: Cost Basis, Contract Value, Fee/Markup, Profit $, Markup % and Margin % both shown with the basis labeled, % of Project).
- **Profit Waterfall** — model-composed inline SVG (the repo's recorded chart pattern, no chart library), `$ / %` segmented toggle (local state), colors via CSS variables; re-renders on every `recalc()` so it tracks the budget automatically.
- **Intercompany** — entity vs consolidated revenue, eliminations list, reconciliation statuses with expandable drill rows.
- **Executive Financial Summary** card content (see below).
- **Template-mode authoring forms** (finance rules + guardrail policy — see Template Editor).
- **Entity Master admin card** for `page-admin` (table + add/edit dialog via the shared `openDialog`).

**`app/index.html`** (kept to shells + wiring):
- A fourth budget workflow step **"Financials"** — inside the existing budget experience, exactly like CSI Schedule: `page-financials` shell div with empty section containers (`#sec-bank`, `#sec-splits`, `#sec-waterfall`, `#sec-interco`); add to `PAGE_SLUG`/`SLUG_PAGE`/`DOC_PAGES`/`NAV_PARENT` (:4364-4422) and `WORKFLOW_STEPS` (:4563); `recalc()` (:6181) gains `if(currentPage==='financials')FSBudgetFinancials.render();`. Route `#/financials/<budget id>`. No new top-level nav item.
- **`#sec-exec`** (Executive Financial Summary) shell between `#sec-summary` (:1367) and `#sec-guardrails` (:1400); `FSBudgetFinancials.renderExec()` added to the `withFocus` list. Rows: Internal Project Cost, Bank Budget + Uplift %, Project Entity → FS Contract, each company allocation, Total Finishes Profit, Consolidated Margin (margin and markup labeled), Reconciliation Status chip.
- **Versions modal** (:5226): "Approved" badge per row (probe-gated join in `api/budget-versions/index.js`) and an **Approve This Version** button (director+). **No compare feature.**
- **Companies card** (`renderCos` :6013): each row gains an entity-picker chip mapping `entityKey` (additive).
- `blankDoc()`/`migrate()` additions; `FSBudgetFinancials.init(...)` wiring in the boot sequence; script tag for the two new files.
- **Exports** (model-only, never DOM): `buildBudgetFsdoc()` (:6640) + `buildReport()` (:6446) gain Bank Budget and Profit Allocation sections; `exportExcel()` (:7122) gains "Bank Budget" and "Profit Allocation" worksheets — all composed from `FSBudgetFinance` outputs; waterfall exports as a table. New checkboxes follow the `sel()`/`exportDefaultsFor` idiom.

**`app/projects.js`**:
- **`projectInfoCard(p)`** in `paintDetail()` (:249) — the first project-edit UI: Name, Address, Notes, **Project Entity** select (active entities + None); save via `PUT ?scope=project`; on the 409 confirmation contract, a confirm dialog quoting the server's counts, retry with `confirmEntityChange:true`. Entity shown in the project sub-line.
- **`contractsCard(p)`** rendered **below `analysesCard`** (:397), preserving the Budgets → Investment Analyses → Contracts overview order: lists the project's contracts (Contracting → Performing, amount, status chip — `Requires Review` highlighted with its variance, drill row from `ReviewNote`), plus **Generate Contracts** (director+, enabled only when a budget has an approved version and the project has an entity; otherwise the row explains what's missing) and accept/void actions.
- Adapter gains a cached `entities()` fetch and passthroughs for the contract scopes.

## Backward-compat matrix

| Feature | Pre-migration (probe false) | Existing data |
|---|---|---|
| Entity Master / Project Entity | `{available:false}`; pickers hidden; writes 503 `migration_pending` | projects unchanged; entity nullable forever |
| `doc.finance` + bank/splits/waterfall/exec | fully functional immediately (doc key + pure derivation, no DB) | absent key = `DEFAULT_FINANCE` (110% flat-to-contingency, FS-only allocation = today's numbers); untouched docs stay no-op hashes |
| Approval | 503; Approve button hidden | statuses untouched; status pill means what it always meant |
| Contracts | `{available:false}`; Contracts card shows the standard not-migrated note; generate 503 | n/a |
| `companies[]` / `parts()` / guardrails | byte-untouched — stored ContractSum/ProjectCost identical; suite-09 parity is the canary | `entityKey` optional; name-match covers "Finishes Solutions LLC" |
| Templates | v1-schema published versions keep working via fallbacks | budgets keep their `templateVersionId` pins |

## Template Editor changes

Templates are edited as budget docs (`editTemplate` :4933 loads into the normal editor with `templateEdit` set), so authoring appears in template mode:
- On the Financials step, `FSBudgetFinancials.render()` shows the **authoring forms** instead of derived views: bank uplift % + allocation rules + remainder mode; the allocation-rule table (entity picker fed by `scope=entities`, stream, share, costShare). Inputs carry `data-k="fin.<path>"` focus keys and write to `doc.finance` via `touch()`.
- `#sec-guardrails` in template mode swaps read-only rail rows for editable min/max/severity inputs per rail (driven by `FSGuardrails.RAILS` metadata), writing `doc.guardrails` — finally populating the `policyFor()` hook. Contingency ranges, profit targets, margins, cost/SF, cost/unit, dev-fee, marketing ranges are existing rails; genuinely new checks (e.g. `costPerUnit`) are new entries in the byte-identical guardrails pair.
- `publishTemplate()` (:4968) passes `templateSchemaVersion:2`; published versions snapshot `finance`/`guardrails` immutably. Existing v1 versions keep working via fallbacks.
- In budget mode, director+ (`canEditFinance()`, modeled on `canAckGuardrail()` :6148) may override `doc.finance` per project; the override is part of the doc and versions normally.
- New project-type templates (Retail / Industrial / Office / Mixed-Use / Other Commercial) are created by an admin through the existing `createTemplate()` flow — documented as a post-release checklist (CHANGELOG + docs), not seeded in SQL.

## Tests (each phase ships with its tests + CHANGELOG entry; run `./test/run-all.sh`)

- **`test/budget-finance.test.js`** (node:test): byte-identity of the pair (guardrails.test.js clone); bank invariant (bankTotal = internal×(1+pct/100) to the cent, remainder reconciliation, overshoot scaling); Σ costShare = 1 validation; markup/margin identities (`profit = costBasis·markup = contractValue·margin`); null-not-NaN on zero bases; consolidation identity (consolidated external = Σ entity totals − eliminations; the $10M/$7M example as a fixture); contractPlan ↔ allocate consistency; all six reconciliation statuses; default-doc ⇒ single-FS-row ≡ `parts().profit`.
- **`test/contracts-api.test.js`**: against the mock — approve pins a version; generate refuses unapproved / no-entity; generated amounts equal the version-derived plan; working-budget save leaves contracts untouched; re-approve with changed allocations flags Requires Review with the variance; accept/void; entity-change 409 → confirm → flagging; role refusals.
- **`test/schema-probe.test.js`**: new flags + false fallback.
- **`test/mock-api.js`** (behavior-parallel; requires the real `api/shared/budget-finance.js` exactly as it already requires budget-calc/guardrails): entities store seeded with the six companies, all new scopes, contracts store, approval, versions `approvedVersionNumber`.
- **Playwright**: extend `suite-21` (Project Information card, entity picker, 409 confirm, Contracts card below Investment Analyses), `suite-20` (template-authored guardrail policy round-trips through publish); `suite-09` must pass unchanged (parity canary); new **`suite-23`** for the Financials step (pill/route, bank table reconciles on screen, waterfall $/% toggle, exec summary, approve → generate → requires-review flow, template finance form). Visible-text selectors; copy changes update suites in the same commit.
- `node --check` on every touched no-build file.

## Phase / commit ordering (each shippable, tested, changelogged)

1. **Finance calc pair + doc plumbing** — `app/budget-finance.js` ↔ `api/shared/budget-finance.js`, `DEFAULT_FINANCE`, `blankDoc`/`migrate()` additions, `companies[].entityKey`, byte-identity + invariant tests. No UI, no DB.
2. **Entity Master + Project Entity** — `sql/migrate_entities.sql`, probes, `scope=entities` read/write, `api/shared/projects.js` changes, Project Information card, Entity Master admin card, activity events. Ships dark pre-migration.
3. **Financials step + Executive Summary** — `app/budget-financials.js`, `page-financials` shell + wiring, `#sec-bank`, `#sec-exec`, export additions. Pure derivation; no migration.
4. **Profit splits + waterfall + intercompany** — `#sec-splits` / `#sec-waterfall` / `#sec-interco` (reconciliation shows "Contracts not yet available" until Phase 7).
5. **Template Editor authoring** — finance-rules form, guardrail-policy editor, any new rails (guardrails pair bump + byte test), `templateSchemaVersion:2`, new-type template checklist.
6. **Approval** — `sql/migrate_budget_approval.sql`, `scope=approve`, versions-modal Approved badge + Approve button.
7. **Contracts** — `sql/migrate_contracts.sql`, contract scopes, generation from the approved version, requires-review, Contracts card on the project page.
8. **Polish** — remaining exports, `docs/DATA_CONTRACT.md` finance/contract sections, `docs/HANDOFF.md` note, CHANGELOG consolidation (Migration required callouts listing the three SQL files in run order).

Push with `git push -u origin claude/budgeting-suite-expansion-lwuc2e` after each phase (retry w/ backoff on network failure).

## Verification

- `./test/run-all.sh` — node:test first (byte-identity, finance invariants, contracts API, schema probe), then the Playwright suites; suite-09 parity and suite-20 guardrails are regression canaries; suite-23 exercises the workflow end to end against the mock.
- Manual trace on the mock of the source-of-truth chain: edit a line → bank table, splits, waterfall, exec summary all move together; approve → generate contracts → amounts match the plan to the cent; edit the working budget → contracts unchanged; re-approve with different allocations → Requires Review with the exact variance.

## Defaults chosen (flagged, changeable cheaply)

1. **`costShare` granularity**: each company's performed share of hard cost is a fraction (template/budget-level), not per-CSI-division assignment.
2. **Roles**: entity administration = `super_admin` (+ platform `pricing_admin`); approve/generate contracts = director+ app role — mirroring existing gates.
3. **Fee payer mapping**: v1 assumes the Project Entity pays dev/mkt/cls fees directly to their mapped entities; a per-rule `payer` field is a cheap later addition if some fees actually flow inside the FS contract.
