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

## Unreleased — Site-wide flow, saving and input-driven defaults

A pass over the whole app: how a budget gets started, how work is kept safe
while it is edited, how the editor reads, and how new budgets follow their
inputs.

### Migration required

- `sql/publish_multifamily_input_defaults.sql` — **optional, NOT YET RUN,
  safe to run any time** (it uses only scopes and bases the code running today
  already understands). Publishes pricing library `2026.10-v1` and the next
  Multifamily template so new budgets follow their inputs:
  - the swimming pool becomes an Amenity lump sum, so it drops out when
    Amenity SF is 0;
  - appliances, cabinets, countertops, interior doors and hardware, mirrors,
    bath accessories, blinds and mailboxes are priced per unit (shown as
    "… (per Unit)"), so the budget moves with the unit count;
  - the developer fee becomes a percentage of total project cost.

  The default budget's totals are unchanged (to within a few dollars of
  rounding). Existing budgets are not touched, and Update Pricing leaves their
  per-SF versions of these lines alone. **The per-unit rates are back-solved
  starting points** — whoever owns pricing should review them before running.

### Breaking

- **"Leave without saving?" now means it.** Answering OK discards the
  changes — a saved budget goes back to its last save, a never-saved one is
  dropped. Before, the edits quietly stayed in memory and the question came
  back on the next page.
- **A budget's ID can't be changed after its first save.** Changing it used to
  overwrite whatever budget already had that ID. Use **+ Add Alternate
  Budget** to copy a budget under a new ID.
- **Analytics money counts each project's primary budget only** (plus budgets
  not linked to a project). Total Contract Sum, Total Project Cost and Top 5
  Projects no longer add alternates in, so these totals may drop.

### Added

- **Unsaved work is kept on this device.** While you edit a budget or an
  investment analysis, your changes are kept in this browser. If the tab
  closes, the connection drops or your session ends, open it again on the same
  device and choose **Restore** (or **Discard**). Nothing reaches the server
  until you Save, every Save still records a version, and signing out clears
  the kept copy. (This is deliberately not server auto-save: each server save
  writes a permanent version, so saving on a timer would bury the history.)
- **Two people editing one budget no longer overwrite each other silently.**
  If someone saved after you opened it, Save asks: **Keep Editing**,
  **Reload Latest** or **Overwrite Anyway**.
- **New Budget no longer dead-ends without a project.** Step 2 has
  **+ New Project…**; create it there and you come straight back with it
  chosen, its name and address filled in and its Budget ID suggested. With no
  projects yet, Home leads with **+ New Project**, and the welcome's
  **Get Started** opens it.
- The Budget Detail grid shows a running **Contract Sum** and **Total Project
  Cost** pinned to its bottom edge, one above the other in the Total column.
- **Enter** and the **arrow keys** in Qty or Rate move up and down the
  column. In the CSI catalog, **Enter** adds the first match, and a new line
  scrolls into view with its rate ready to type.
- An edited rate or overridden quantity is marked on the field itself, shows
  the library value on hover, and has a **↺** button to put it back.
- Each **Guard Rails** name is a link to the field that drives it.
- With Amenity SF at 0, the budget grid shows "Amenity / Clubhouse — N lines
  excluded because Amenity SF is 0" instead of the section silently vanishing,
  and the Inputs page says the same under the Amenity SF field.
- Re-syncing an analysis from its budget lists exactly which values will
  change and flags the ones you had changed yourself.
- The New Investment Analysis picker groups budgets under their project,
  marks each project's primary budget, and has search and keyboard navigation.
- An analysis save conflict offers **Save As Copy**, which keeps your
  on-screen inputs as a new analysis.

### Changed

- **The save indicator tells the truth.** It shows *Saving…*, *Saved · 2 min
  ago*, *Unsaved Changes · Kept on This Device*, *Unsaved · N Guard Rails
  Blocking* (click to see them), or *Couldn't Save — Retry* (click to retry),
  which stays until a save succeeds. The save message says whether a new
  version was recorded. Raw server errors are no longer shown.
- The Inputs page **Save Draft** button is now **Save** (it never set the
  Draft status).
- Re-syncing an analysis applies the new values as unsaved changes; nothing is
  stored until you Save, and leaving without saving discards the re-sync.
  Export on an analysis is available only once it is saved and up to date, so
  every export matches the version it names.
- Calculate no longer jumps away from the step you are on; use **View
  Results**.
- **Home:** Needs Attention sits above Recent. "No Analysis" only flags a
  project's primary budget, and only until the project has an analysis. "N
  more" opens the matching list. Your Activity leaves out sign-ins and shows
  five rows. An analysis that was never calculated shows "—", not "$0".
- **Budgets list:** the id column is **Budget ID**, and **Group by Project**
  groups budgets under their linked project ("OP-0003 — Name", unlinked ones
  under "No Project"). It replaces Group by Project ID, which grouped by id
  prefix.
- **Project page:** an empty project leads with **+ New Budget**; statuses use
  the same coloured, clickable chip as everywhere else; money columns read
  Contract Sum and Total Project Cost.
- The Budget ID waits for the project: blank until you pick one, then that
  project's next `BDG-` id.
- Consistent wording: **+ New Project**, **+ New Budget**, **+ New Investment
  Analysis**; the Budgets page is titled **Budgets**; the coming-soon templates
  are one line; the Inputs page says "Step 1 of 3".
- Negative amounts read **−$31,866**, and Net Other Income turns red when
  expenses exceed other income. Rates show two decimals and quantities show
  thousands separators.
- On a phone, the Line Item column stays pinned while you pan to Qty and Rate,
  and so do the scope and group names and the footer labels (long group names
  shorten with "…"; before, they scrolled off and left blank bands).
  The bug-report button shrinks to an icon on the editing pages so it no
  longer covers the grid.
- Contrast, focus outlines, dark-mode banners and buttons, dialog semantics
  and screen-reader labels are improved throughout.
- The Dashboard PDF includes the converted-project figures and the project
  pipeline.
- The New Investment Analysis picker's search box now looks like every other
  field in the app instead of the browser's default.

### Fixed

- Edits made while a save was in flight were marked saved and lost — for
  budgets and analyses alike.
- More works on phones: Pricing Library, How to Use, Analytics, Admin and
  Version were unreachable because the menu was clipped. The tab bar now keeps
  the current tab in view.
- Back after creating a budget went to whichever project you had last visited.
- Cancelling a link to another budget left the address bar pointing at it, so
  a reload opened the wrong budget.
- Closing the tab, or switching to another analysis, with unsaved analysis
  edits now warns.
- Saving an analysis no longer resets its status to Draft.
- Saved SOV rows (what reporting and the lender package read) no longer carry
  amenity money when Amenity SF is 0, so they agree with the contract sum.
- Update Pricing no longer copies a rate onto a line whose library basis has
  changed (a per-unit rate on a per-SF line); it keeps the line and says so.
- A line id crafted into a saved budget can no longer run as script in the
  editor.
- The column headers on the Budget and CSI grids stay put cleanly while you
  scroll.
- Feedback no longer offers "send as email" for a validation problem; the
  activity log describes feedback and role-change events in words.
- The activity log and its CSV export report failures instead of silently
  showing old rows or downloading a partial file.
- Analysis dialogs close with Escape and return focus; the analysis delete
  confirmation no longer promises an administrator restore.

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
