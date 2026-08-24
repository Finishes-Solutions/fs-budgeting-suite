# Changelog

Every change that reaches `staging` gets an entry here, newest first. This is
the log a person reads to answer "what changed, and what do I have to do about
it" — so an entry says what someone will *notice*, not which functions moved.

Two things earn their own callout because they are the ones that bite:

- **Migration required** — SQL that must be run before or with the deploy, named
  by file and in run order. The app and the database have to agree.
- **Breaking** — behaviour someone relied on that is deliberately gone.

House rules for writing one:

- Add to **Unreleased** as you work; move the block under a dated heading when
  it ships to `staging`.
- Keep it in the user's language: "the Projects button creates a project", not
  "refactored `openNewBudget`".
- One entry per user-visible change. Refactors with no visible effect belong in
  the commit message, not here.
- Never rewrite a shipped entry. If it was wrong, add a correcting entry.

---

## 2026-08-24 — The identifier model

A project is a number; prefixes are labels; children carry the number
(PROJECT_NUMBERS_GUIDE.md, adopted as far as this suite's legacy keys allow).

### Migration required

Run align first, then adopt. **Both applied 2026-08-24, all verification rows
PASS.**

- `sql/align_project_numbers.sql` — gives each existing project the number its
  budget already carries (`OP-0005` → `OP-4821`, and so on), so a project and
  its budgets read as one family. No budget is renamed. A destination number
  held by a childless deleted project is cleared automatically; one that is
  live, or deleted with history attached, is skipped and reported rather than
  fought over. *(Applied: three projects moved — 2519, 4821, 2108. `OP-0006`
  wants 9999 but a live test project holds `OP-9999`, so it was skipped, as
  designed; `OP-0004` keeps test budget `TST-9999`.)*
- `sql/adopt_project_numbers.sql` — surfaces the PROJECT NUMBER as a real,
  indexed, unique column on projects — and on each linked budget and analysis,
  computed from the link — plus per-project item numbers for analyses. Nothing
  is renamed or re-keyed. *(Fixed once after a failed run: the two
  ProjectNumber indexes were filtered on a computed column, which SQL Server
  refuses — they are now plain indexes. The script is idempotent; the re-run
  completed the migration.)*

### Changed

- **The identifier model arrives** (PROJECT_NUMBERS_GUIDE.md). A project is a
  number; prefixes are labels. New budgets are created as that number's
  children — `BDG-0042-01`, `BDG-0042-02` — with the ID suggested
  automatically from the project you pick, and investment analyses show a
  matching `INA-0042-01` display id. Nothing existing is renamed: legacy
  `BD-`/`OP-`/`AS-` budgets open, save and keep numbering their alternates
  the old way, and `TST-` test data keeps its own sequence. Every project
  payload now carries its bare number, so other systems can join on
  `ProjectNumber = 42` instead of parsing display strings. The Help guide's
  ID section is rewritten around the model.
- **A deleted project frees its number.** Project IDs are unique among LIVE
  projects, not forever: delete `OP-9999` and a new project can be created as
  `OP-9999` later — a fresh project, starting at Lead with no budgets — while
  two live projects with one number remain impossible. The suggested next
  number still skips deleted ones, so reuse only ever happens by typing the
  number on purpose. Budget IDs keep the stricter rule: a budget's version
  history hangs off its id, so a deleted budget's number stays reserved.

---

## 2026-08-22 — Projects get their own identity

The release the second review document asked for. Its through-line: a **project**
is a thing in its own right, and a **budget** is a different thing that belongs
to one.

### Migration required

Run in this order, reading each section's output before the next:

1. `sql/migrate_project_op_ids.sql` — re-keys projects off borrowed budget ids.
2. `sql/widen_project_op_ids.sql` — widens those ids to four digits.

`sql/rollback_project_op_ids.sql` reverses both from `dbo.ProjectIdMap`, which
is kept permanently as the record of every key that moved. A fresh database
needs neither: `sql/schema.sql` already describes the end state.

Applied to the live database on 2026-08-22 — seven projects re-keyed to
`OP-0001`…`OP-0007`, every budget, analysis, favourite and activity row
following, all verification rows PASS.

### Breaking

- **Project ids are now `OP-####` and nothing else.** They used to be borrowed
  from a budget — the project for `BD-0002` was literally keyed `BD-0002` — which
  is why the Projects list showed `BD-…` in its PROJECT ID column.
- **Saving a budget no longer creates its project.** A budget id cannot name a
  project, so the project is created first and the budget says which one it
  belongs to. Existing budgets keep the link they already have.
- **A budget cannot be saved without a building size greater than zero.** This
  is what stopped an investment analysis being built from a budget that could
  never calculate.
- **A project has no type.** One property can carry a Multifamily budget and a
  Commercial budget at once, so type belongs to each budget; a project reports
  the distinct types its budgets actually are.

### Added

- **+ Create Project** on the Projects tab, replacing + New Budget there. Asks
  for Project ID, Project Name and Address — all required, the ID checked for
  shape and uniqueness by the database, not just the form.
- **Make Primary** in a budget row's ⋮ menu. Exactly one budget is primary;
  promoting one demotes the previous in the same write.
- **Three-dot menus on project rows and cards** — Open, Favorite, and a red
  **Delete Project** that soft-deletes the project's budgets and analyses with
  it, after saying how many. Nothing is destroyed; every version is kept.
- **Favorited projects appear on Home.** Starring one used to save correctly and
  then show nowhere, because Home never loaded projects at all.
- **A granular activity log.** Favouriting used to land as one blunt "Updated
  settings" row. Every event now names what it happened to and what changed —
  which budget, which project, which field, from what to what — with a new
  **Details** column in the admin Activity Log, its CSV and its PDF, and the
  same detail on Home.
- **A changelog**, which is this file.

### Changed

- **Total Project Cost (Primary)** — renamed, and it reports the primary budget
  alone. An alternate is another way of pricing the same work, so it is never
  summed in.
- **New Budget asks which project.** Two steps: the template, then the project —
  which carries that project's name and address across, and suggests the next
  free `BD-####`.
- **Back from a budget returns where you came from.** Opened from a project, it
  goes back to that project; otherwise to the Budgets list. Route state, not
  browser history, and the button's tooltip says where it goes.
- **A new budget is born on the current pricing library.** It used to take the
  version the template was published on, so a budget created after a publish
  opened claiming the old library and flagged itself outdated. Lines still at
  their library rate are refreshed; a rate the template deliberately set is kept.
- **The Add Investment Analysis picker is a real dialog** — centered, over a
  dimmed page, with the page behind it locked, focus moving in and back out, and
  Escape and backdrop-click closing it. It used to render as a plain block at
  the foot of the page and follow you to every other tab, because it asked for a
  `.modal` class that did not exist. Leaving a page now closes any dialog opened
  over it.
- **Year 1 - Potential Income** at the top of the Income step, showing unit
  rent plus other income. The components keep their own fields, so nothing
  downstream is counted twice.
- **The budget-drift notice reads "Budget Updated to vN - Click to Re-Sync".**
- **The assumptions warning drops its count sentence** and keeps the detail
  underneath — the amber flag already means "needs attention".
- **An analysis inherits its project's name and address**, instead of being
  named after a budget id.
- **Switch Account signs out first.** `/.auth/login/aad` short-circuits while
  the session cookie is present, so it never reached Microsoft and the page
  simply reloaded as the same user.
- Help and the exported guide describe the two namespaces and the new flows.

### Fixed

- **Creating a budget under an existing ID no longer overwrites that budget.**
  It used to replace it and version the replacement as its next revision; the
  original survived only in history. A create now refuses the id and offers the
  next free one.
- "The current pricing library" is a database-enforced singleton
  (`UX_PricingLibrary_Current`), matching how templates already worked.

---

## 2026-08-21 — Review document 1, sign-in, and the welcome

- The 33 actionable comments from the first review document: number formatting
  that never touches the stored values, canonical SF/acres conversion,
  budget-derived fields locked behind a deliberate override, the Projects page
  rebuild, and the dashboard KPI grid.
- A sign-in screen and a first-run welcome, widened to the first five sessions
  and versioned so a changed welcome can be re-shown once to everyone.
- Sign Out returns to the login screen.
- **Migration:** `sql/migrate_projects_and_guardrails.sql`,
  `sql/publish_multifamily_opex_template.sql` (both applied 2026-08-21).

## 2026-08-20 — Design system

- Finishes Solutions design-system tokens vendored and bridged; super-admin
  theme packs.

## 2026-08-19 — Feedback, analytics and account pins

- In-app bug reports and feature requests; the analytics chart row and the
  activity log's filtering and paging rebuilt; Home pins moved onto the account
  so they follow you between browsers.

## 2026-08-18 — Home, dashboard and roles

- Home became a personal dashboard; a dedicated Budgets page and unified
  workflow navigation; the Analytics dashboard, its Activity Log and PDF export.
- **Migration:** `sql/migrate_roles_and_ownership.sql`.
