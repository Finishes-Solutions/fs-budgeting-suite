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

## Unreleased — Budgeting v2: estimate any project type

A new way to start a budget: **New Budget → Estimate Any Project Type**. Pick from
94 researched project types — apartments of every kind, single-family and
build-to-rent, hotels, offices, medical, retail, restaurants, car washes, food truck
parks, RV resorts, glamping, marinas, warehouses, cold storage, self-storage, data
centers, solar farms, battery storage, EV charging, schools, fire stations and more —
enter the size, and a detailed, sourced budget appears immediately.

- **Quick estimate:** type + size + baseline price per unit of measure ($/SF, $/unit,
  $/key, $/bed, $/pad, $/site, $/slip, $/space, $/kW, $/MW, $/MWh…). The price box is
  pre-filled with the researched default and shows its range and sources. Location,
  quality tier, construction start and land are one screen.
- **Mixed-use & phases:** several components of different types, shared elements
  (a parking garage, a podium, roads, detention, an amenity center) split by SF, units,
  revenue, cost, equally or by hand, and phases on a timeline — each with its own
  escalation to its construction midpoint, draw schedule and construction loan.
- **Custom builder:** assemble anything from 144 priced building blocks (site work,
  paving, parking, utilities, amenities, marine, specialty MEP, energy, FF&E…) or your
  own priced items.
- **Detailed budget:** component → phase → CSI division → line, with an override on
  every line, edited lines marked and resettable, and a source trail on every line
  (researched, derived estimate — verify, computed, or edited).
- **Draw schedules, scenarios side by side, and a sensitivity view** on the Budget page.
- **Warnings** when a component's all-in cost falls outside the researched range for
  its type.
- **Pro forma per component or phase:** "Create pro forma" sends the chosen slice's
  cost, size, unit count and revenue to a new investment analysis; re-sync keeps the
  same slice. The investment calculations themselves are unchanged.
- **Exports:** an estimate workbook and PDF with summary, components, phases, line
  detail, draw schedules and sources & assumptions. **Project files:** download an
  estimate's inputs as a file and open it into another budget.
- Estimate budgets save, version, export and feed the lender SOV exactly like any
  other budget. Multifamily-template and blank budgets are unchanged.
- Research data ships with the app and is never fetched live. A budget keeps its
  numbers until you edit it or choose **Update to current research**.

### Migration required

None. Everything rides in the budget document.

## Unreleased — Site-wide flow, saving and input-driven defaults

A pass over the whole app: how a budget gets started, how work is kept safe
while it is edited, how the editor reads, and how new budgets follow their
inputs. (Merged onto `feature`, which had fixed three of the same things on its
own — the Budget ID lock, the identifier XSS and amenity SOV rows; those
entries live once, in the block below.)

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
- The Inputs and Impact Fees pages' **Save Draft** buttons are now **Save**
  (they never set the Draft status).
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
  are one line; the Inputs page step count matches its pills.
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
- Update Pricing no longer copies a rate onto a line whose library basis has
  changed (a per-unit rate on a per-SF line); it keeps the line and says so.
- The column headers on the Budget and CSI grids stay put cleanly while you
  scroll.
- Feedback no longer offers "send as email" for a validation problem; the
  activity log describes feedback and role-change events in words.
- The activity log and its CSV export report failures instead of silently
  showing old rows or downloading a partial file.
- Analysis dialogs close with Escape and return focus; the analysis delete
  confirmation no longer promises an administrator restore.
## Unreleased

### The Budget Assistant is now a chat panel on the right, with a reasoning control

- **It docks to the right edge instead of covering the page.** On a wide
  screen the page shifts left to make room, so the budget stays readable and
  editable beside the conversation. On a narrow screen it covers the page.
  Escape closes it when you are typing in it.
- **One conversation that follows you around the app.** The panel stays open
  as you move between pages, and it switches to whatever budget or pro forma
  is on screen without losing the thread. Ask about a pro forma, open its
  budget, and keep asking: the assistant reads the budget now on screen and
  still has your earlier pro forma questions and answers. A divider in the
  thread marks each change of subject. On a page that is about neither (Home,
  the lists), it keeps talking about the last one you had open. **New
  conversation** starts over.
- **A redesigned conversation.** Your question sits in a bubble on the right
  and the answer reads as plain text beside the assistant's mark. Each answer
  has a **Copy** button. Suggested questions show as cards when a conversation
  is empty. The question box grows as you type.
- **New conversation is now an icon** (pencil on a square) in the panel's
  header, next to Close.
- **Pick the reasoning effort as you chat.** The chip under the question box
  offers **Low** (fastest), **Medium** (balanced) and **High** (most thorough,
  and slower: a long answer may be cut short at the time limit). Your choice
  applies from the next question and is remembered in your browser. Until you
  pick one, the `ANTHROPIC_EFFORT` setting applies (Medium if unset). Each
  answer says which effort it used. Extra-high and max are not offered: they
  think longer than a request is allowed to run.

### Security: fixed a stored cross-site scripting flaw

A specially crafted budget could run script in the browser of anyone who opened
it, including an administrator. This was confirmed against a local test copy of
the app; we have no evidence it was ever used. It is fixed in three layers:

- **Saving refuses malformed identifiers.** The server rejects a budget whose
  line or fee identifiers are not plain letters, digits, hyphens and
  underscores. Publishing a fee schedule does the same.
- **Old budgets are repaired on open.** A budget saved with a bad identifier
  before this fix gets a fresh one when opened, and saves normally afterwards.
- **Pages no longer place stored values inside clickable code.** Pricing Library
  codes and groups, and stored investment-analysis inputs, are always shown as
  plain text.

### The Budget Assistant reads your pro formas, reviews budgets and finds revenue

**Answers no longer fail with "ran out of time" when the model is slow.** The
assistant streams its answer. If the time limit arrives mid-answer, you get
what it had written, marked as cut short, instead of an error. When it truly
has nothing yet, the error says where the time went, so a slow answer can be
diagnosed. Answers are also kept shorter and lean on the context already
loaded.

**The assistant now runs on Claude Haiku 5.5 by default**, at medium effort:
fast, inexpensive, and well inside the time a request is allowed. To use a
more capable model for deeper analysis, set the `ANTHROPIC_MODEL` application
setting (for example `claude-opus-5-5`); `ANTHROPIC_EFFORT` sets the effort
(`low`, `medium`, `high`, `xhigh`, `max`).

**Ask AI** now works on both sides of the app, and each side can see the other:

- **On a budget**, the assistant also sees the investment analyses (pro formas)
  built from that budget or its project. You can ask how the pro forma looks
  without leaving the budget.
- **On an investment analysis**, there is now an **Ask AI** button too. It reads
  the analysis, the budget it was built from, and the project's other analyses.
- **"Where might this budget be wrong, or what is it missing?"** The assistant
  starts from a rule-based review:
  - lines priced at $0;
  - pricing-library lines the budget doesn't carry, with what each would cost
    here;
  - rates far from the library;
  - the impact-fee placeholder still in place;
  - unit-mix and income gaps;
  - $/SF outliers against the median of **your own** other budgets of the same
    type;
  - a development checklist (construction interest, loan fees, builder's risk,
    taxes during construction, reserves…) matched by keyword.

  Each finding says what it's based on.
- **"What is making this pro forma bad?"** The assistant gets the analysis's
  drivers, computed by re-running the investment engine with each assumption
  nudged one step (rent, vacancy, expenses, price, exit cap, rate, growth) and
  ranking them by their effect on IRR. It also gets checks against common
  underwriting rules of thumb (DSCR, negative leverage, exit cap below going-in
  cap, and so on), labelled as rules of thumb.
- **"How could this property make more money?"** Ideas such as RUBS, parking,
  storage, pet fees and tech packages are sized per unit, then **run through the
  engine** so the NOI, value and IRR effects are computed, not guessed. Nothing is
  saved.

### Fixed: pro forma expense ratio came out slightly high

An analysis created or re-synced from a budget derives its expense ratio from
the budget's expenses. The derivation applied vacancy to other income, which the
investment engine does not, so the analysis's year-1 operating expenses came out
a little above the budget's own (about 0.5% on a typical budget). It now matches
the engine exactly. Existing analyses keep their saved ratio until you re-sync
them.

### Fixed: exports show the real amount for "% of income" expenses

The print report, both PDFs and the Excel workbook printed **$0** for expense
rows set as a percentage of income, such as property taxes and management, while
the total underneath was right. Each row now shows its real monthly and yearly
amount with its rate as a percent, and the rows add up to the total.

### Fixed: the impact-fee line is "derived", not "edited", everywhere

Every export now marks the impact & tap fee line as **Derived**, naming the fee
schedule it came from, instead of "edited" with a $/SF library rate. The
"lines manually edited" count no longer includes it.

### Fixed: SOV rows match the contract sum when amenity SF is 0

With no amenity square footage, amenity lines contribute $0 to the budget, but
the schedule-of-values rows saved for lenders still carried their amounts. Those
rows are now saved at $0, so they add up to the contract sum.

### Fixed: changing a saved budget's ID overwrote another budget

The Budget ID field stayed editable after a budget was saved. Typing another
budget's ID and saving silently replaced that other budget and recorded it as
its next version. The field now **locks once a budget is saved**, and the server
refuses a save whose ID differs from the one the budget was opened as. To price
the same project another way, use **Add Alternate**.

### Guard-rail overrides need a director or super admin, on the server too

The editor only offered **Override…** to directors and super admins, but the
server accepted an override from anyone. Now the server refuses a save that adds
or rewords an override unless it comes from a director or super admin, and says
why. Overrides already on a budget keep saving for everyone. A copy made by
someone without the role starts without overrides.

**Breaking:** the server now judges the rails by the built-in table for the
budget's type, ignoring any thresholds or type a save carries. It also refuses
to re-save an existing budget as **Blank**; a budget is Blank only when it is
created that way.

### The expense guard rail waits for expense rows

A budget with rent but **no expense rows at all** was blocked at "0% operating
expenses". The rail now waits until expenses are entered. Rows priced at $0 are
still judged.

### Fixed: in-app bug reports failed in production

The server was not set up to accept the request the bug button sends, so
reports failed and fell back to an email draft. They now reach the server.

### Fixed: deleting an investment analysis showed an error

The delete went through, but the server then crashed and the activity log never
recorded it. It now finishes cleanly and is logged.

### Clearer Update Pricing help

The help page said Update Pricing leaves "overrides untouched". Rates you
changed by hand on standard lines **are** replaced by the library rate. The help
now says so.

### Fixed: one budget's fee schedule version could reprice another

After viewing a budget priced on one version of a jurisdiction's fee schedule,
opening another budget priced on a different version of the same schedule could
recalculate its impact fees against the wrong version. It cannot happen yet,
because only one version of each schedule exists, but it is fixed before it can.

### Ask AI: a Budget Assistant on every budget

A new **Ask AI** button in the budget editor, next to Save and Export, opens the
**Budget Assistant**. You can ask about the open budget in plain English and
Claude (Anthropic) answers:

- **How a number was built.** "How was the total project cost calculated?" walks
  from line items to hard cost, profit, contingency, the contract sum, soft costs,
  land and fees, using the same formulas the editor uses (see
  [`BUDGET-SYSTEM.md`](BUDGET-SYSTEM.md)).
- **What changed and why.** It can read the budget's saved versions and compare
  any two of them line by line: lines added, removed, re-rated or re-quantified,
  sorted by dollar impact.
- **How it compares.** It can look up your other budgets for $/SF, $/unit and
  scope comparisons. It only sees the budgets your Budgets list shows you.
- **Analysis.** It flags cost drivers, manual edits, guard-rail breaches and
  assumptions worth a second look. It labels its opinions as opinions.

Things you should know:

- **The figures come from the app, not the model.** Every total the assistant
  sees is computed on the server by the same code that sets the stored Contract
  Sum and Project Cost. The assistant explains those numbers and does not invent
  them. It can still be wrong, so check before you rely on an answer.
- **Unsaved changes count.** If the budget has unsaved edits, the assistant reads
  what is on your screen and says so.
- **Read only.** It cannot change a budget.
- **Data leaves the building.** The budget's contents are sent to Anthropic's API
  to answer each question. The dialog says so.
- **Logged.** Each question is recorded in the activity log as *Asked Budget
  Assistant*, with the question and token counts. The answer is not stored.

**Setup required (no SQL migration).** Add the application setting
`ANTHROPIC_API_KEY` to the Static Web App, in **every environment that should
have the assistant** (production, staging, feature). Until you do, Ask AI
explains that the assistant is not configured. Optional settings:
`ANTHROPIC_MODEL` (default `claude-haiku-5-5`), `ANTHROPIC_EFFORT` (default
`medium`) and `ANTHROPIC_FALLBACKS=off`.

### How a budget is calculated, in one document

[`BUDGET-SYSTEM.md`](BUDGET-SYSTEM.md) explains how every number in a budget is
produced: line quantities and rates, amenity suppression, profit and contingency,
the circular developer-fee percentage, impact and tap fees, income and expenses,
the CSI schedule, $/SF and per-unit metrics, the guard rails, where rates come
from, and every way a budget's numbers can change after it is created. It
includes a worked example run against the real code, and a list of known
discrepancies found while writing it.

It is now a rule that any change to the budget math updates this file in the
same change. The Budget Assistant reads it as its reference manual.

### Impact & tap fees are calculated, not guessed

Every budget used to carry municipal fees as one parametric line — **Water &
Sewer Impact & Tap Fees at $7.50 per residential square foot**. On a 51,365 SF
building that is $385,238, and it is a placeholder nobody can defend to a lender.

There is now a fourth step in the budget workflow, between **Inputs** and
**Budget**: **Impact Fees**. Pick the jurisdiction, enter how many meters of each
size the project needs, and the real number is computed from the city's published
schedule and carried onto that same soft-cost line.

- **A fee schedule library.** Jurisdictions are admin-published and versioned,
  the same way the pricing library and budget templates already are. **City of
  Waller, TX** ships as the first one, seeded from the city's table: water and
  sewer impact fees by meter size (EDU based), plus meter, vault, water tap and
  sewer tap costs.
- **Low, average or high.** The city publishes a range for meter, vault and tap
  work. Each budget picks which side to carry and **defaults to the high side** —
  a fee estimate that comes in under what the city bills is worse than one that
  comes in over. Impact fees themselves are single-valued and do not move.
- **Pick your meters, don't hunt for them.** Choose a size from the dropdown and
  it drops into a short list. Add as many as the project is served by — domestic,
  irrigation, fire line, one per building — and name each in the **Serves**
  column so the budget says what it is paying for. The same size can appear
  twice; those are two meters, and they price as two.
- **The picker always names size, rate and EDU together**, because size alone is
  ambiguous: 2", 3", 4", 6", 8" and 10" each appear twice in Waller's table at
  different continuous-duty rates, and the rate is what sets the fee. A 2" at
  80 gpm and a 2" at 100 gpm differ by more than $22,000.
- **Per-meter control.** A project tapping an existing stub can switch off the
  meter or the tap work on any row and keep the impact fee, which is what the
  city charges for capacity either way.
- **It shows its work.** The soft-cost line reads *"Water & Sewer Impact & Tap
  Fees — City of Waller, TX (high side, v1)"*, the printed report states the same
  under Soft Costs, and the edited-lines report calls it **derived** rather than
  manually edited.
- **Publishing a schedule never reprices saved work.** A budget keeps the version
  it was priced from. When a jurisdiction publishes a newer one, the Impact Fees
  step offers **Update to v2** — the same way Update Pricing has always worked.
- **None is a real answer.** The jurisdiction picker offers **None — no impact
  fees**, distinct from not having chosen yet. Choosing it carries the soft-cost
  line at **zero** and says so, rather than falling back to the template's
  per-SF allowance — a project that pays no impact fees should not be quietly
  charged $7.50/SF.
- Other fees a city charges — roadway, park, drainage, plan review — are already
  expressible (flat, per unit, per acre, per SF, or a share of hard cost), and
  one-off fees can be typed in per budget. Waller charges none of these today.

Soft costs still sit outside the construction contract sum and still join at
total project cost. Nothing about the contract sum, the CSI schedule or the
guard rails changed.

### The Pricing Library shows what budgets are priced from

- The **Cost Assumptions Table** is no longer titled "Multifamily" — the property
  type is a dropdown beside it. Multifamily is the one published table today;
  Retail, Industrial, Office, Mixed-Use, Flex and Custom are listed but disabled,
  so the shape of the library is visible without offering a table that prices
  nothing.
- **Impact & Tap Fee Schedules** now appear directly below it, as published
  reference rates: every meter size for the selected jurisdiction with its EDU
  multiplier, both impact fees, the low–high range on each adder, and the row
  totals. Read-only here — a schedule is published through the API, and a budget
  picks one on its Impact Fees step.

### A `feature` environment for work in progress

Pushing the `feature` branch — or any `feature/…` branch — now deploys to a
**new named environment you can actually sign in to**:

`https://wonderful-rock-071c8e810-feature.centralus.7.azurestaticapps.net`

Staging and production are untouched by it — the three deploy jobs are mutually
exclusive on branch name, so a feature push reports both of them as skipped.
This is what per-PR previews could never be: they put the PR number in the
hostname, so their sign-in redirect can never be registered.

Two things to know before using it:

1. **A one-time Azure step is needed** before anyone can sign in — the
   environment's `/.auth/login/aad/callback` has to be added as a redirect URI on
   the *FS Budgeting Suite* app registration. Until then the page loads blank.
2. **The database is not isolated.** One Azure SQL database serves every
   environment including production, so this isolates code, not data. **Use
   `TST-####` budget ids there** — those are excluded from every reporting view
   and purged by `sql/cleanup_test_budgets.sql`.

They all publish to the same environment, so the last push wins. Push one at a
time.

### Migration required

- `sql/migrate_impact_fees.sql` — creates `dbo.FeeSchedules` and
  `dbo.FeeScheduleVersions` and seeds the City of Waller schedule.

Run it as a whole file — it is three `GO`-separated batches (preflight,
migration, verification) and they must run in that order.

Purely additive: it creates two new tables and changes nothing that already
exists, and the deploy tolerates its absence — until it runs, the Impact Fees
step says "no fee schedules published yet" and every other page behaves exactly
as before. So it can be run before or after the release, and re-running it is a
no-op. Its verification section recomputes each meter's low and high total from
what it stored and compares against the figures the city published; every row
must read PASS.

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
