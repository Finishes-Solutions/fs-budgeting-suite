# Finishes Solutions Budgeting Suite — Phased Roadmap

Principle: one new integration risk per phase. Ship, verify, then extend.
(Working name: fs-budgeting-suite. Rename is a find/replace + SWA/repo rename — cheap
at any point; pick the cool name whenever.)

## Phase 1 — Standalone hosted tool  ← THIS REPO, DEPLOY NOW
- Azure SWA (Standard) + Entra ID + Functions + Azure SQL per BUILD_GUIDE.md.
- Excel export: client-side (SheetJS), one worksheet per selected section.
- PDF export: browser print pipeline honoring section selection.
  *Known limitation, accepted for Phase 1:* print-quality PDF, not the branded
  WeasyPrint output. Server-side branded PDF arrives with Phase 2 since it wants a
  server anyway (reuse the fs-report-service FastAPI/WeasyPrint pattern or a Function
  + PDF template).
- Exit criteria: budgets persist per BUILD_GUIDE §5; a non-admin cannot publish pricing.

## Phase 2 — SharePoint export (finalize workflow)
- New endpoint `POST /api/budget/{id}/finalize`: flips Status→Finalized, locks edits,
  generates Excel (+ branded PDF), writes both to the project's SharePoint folder.
- Graph setup: app registration gains `Sites.Selected` (NOT Sites.ReadWrite.All —
  grant access to only the projects site via the permissions endpoint). Folder path
  convention should match the existing gate-provisioning automation's structure.
- Exit criteria: Finalize on BD-0001 drops files into the correct project folder;
  budget becomes read-only; re-finalize creates a new versioned file, never overwrites.

## Phase 3 — Monday.com BD template sync
- On finalize (or explicit "Sync to Monday"), push to the BD project template:
  contract sum → Client Contract Amount; unit/SF metrics → their columns; SOV Excel →
  the SOV files column; budget doc link → Handoff files. Exact column IDs to be
  mapped against the current BD board template before building (column IDs are
  board-specific; hardcode per-template, store in app settings).
- Monday is intake/notification only per the BD governance design — Azure SQL stays
  the system of record; the sync is one-way, overwrite-on-push.
- Exit criteria: finalizing a budget updates the matching Monday item (matched by
  Project ID) and attaches the export; no manual retyping of contract numbers.

## Phase 4 — Lender Package service (SEPARATE deployment)
- Separate repo/service. Reads dbo.Budgets + dbo.SovLines (see DATA_CONTRACT.md);
  never writes budgeting data.
- Adds: baseline freeze at gate promotion, change-order/revision records, quarterly
  (ops) / semi-annual (stabilized) cadence scheduler, completeness checklist +
  attestation gate, branded PDF via the fs-report-service pattern, AIA-style G702/703
  continuation sheet from the same SOV rows.
- Kept separate deliberately: different cadence, different blast radius, and it will
  eventually read from more systems than this one.

---

## Planned — Emailing exports (not built)

The Export dialog carries a disabled **Email** button so the intent is visible. Nothing
behind it exists yet. This is the design, recorded so it is not re-litigated later.

### Why it needs infrastructure

Exports are built in the browser today: ExcelJS composes the workbook client-side and
the PDF is the browser's own print pipeline. Neither artifact exists anywhere a server
could attach it, and the print pipeline has no headless equivalent in the browser. So
emailing needs two things the app does not have: **server-side rendering of both files**,
and **a way to send mail**.

### Azure pieces

| Piece | Purpose | Notes |
|---|---|---|
| **Azure Communication Services** — Email | Sends the message | Needs a verified sender domain (SPF/DKIM on `finishessolutions.ai` or a subdomain such as `mail.`). Provisioning is a day plus DNS propagation. Alternative: Microsoft Graph `sendMail` from a service principal, which reuses the existing tenant and sends as a real mailbox |
| **A queue** — Storage Queue or Service Bus | Decouples the request from the work | Rendering a workbook and a PDF then sending mail exceeds what an HTTP request should hold open, and gives retries for free |
| **A worker Function** | Renders and sends | Queue-triggered. Excel via ExcelJS server-side (the same builder, refactored to run in Node); PDF via headless Chromium — Playwright or Puppeteer — which does **not** fit the SWA-managed Functions runtime |
| **Standalone Function App** (Premium or Container Apps) | Hosts the worker | SWA-managed Functions cannot run headless Chromium and have a hard request timeout. This is the main new piece of infrastructure |
| **Blob Storage** | Holds the rendered artifacts | Short TTL via lifecycle rule. Lets the email carry a link rather than a large attachment, and gives support something to inspect |
| **Table row or Storage Table** | Job status | So the UI can report queued / sent / failed rather than fire-and-forget |

### Shape of the change

1. `POST /api/budget/{id}/email` — validates the recipient, writes a job row, enqueues,
   returns `202` with a job id. Keep it in the existing SWA API: it is fast and does no
   rendering.
2. Worker: dequeue → load budget + SOV from SQL (never trust a document posted from the
   browser) → render `.xlsx` and `.pdf` → upload to blob → send → update job status.
3. UI: Email becomes enabled, asks for a recipient defaulting to the signed-in user, and
   polls the job for a sent/failed toast.

### Recipient restriction

Only `@finishessolutions.com` and `@finishesetc.net` addresses. Enforce it **server-side**
in the API and again in the worker — a client-side check is a hint, not a control. The
signed-in principal's own address should be the default and the common case; sending to
an arbitrary in-domain colleague is the exception worth an audit log entry. Log sender,
recipient, project ID and timestamp for every send: this mails cost data outside the app.

### Cost and effort

Azure Communication Services email is billed per message and is negligible at this
volume. The standalone Function App is the real cost — Premium plan or Container Apps,
roughly $50–150/month depending on tier and whether it can scale to zero. Build effort is
several days, most of it in server-side PDF rendering, which is genuinely the hard part:
the current report is composed from the live DOM's print stylesheet, so a headless
renderer has to load the app, hydrate a budget and print it, or the report has to be
re-implemented against the data model.

**Cheaper interim option worth considering:** a `mailto:` link that opens the user's
Outlook with the recipient and a subject prefilled, leaving them to attach the files they
just downloaded. No infrastructure, no server rendering, and it covers the common "send
this to myself" case — at the cost of being manual.

---

## Shipped — Fully capable mobile

Mobile went through two designs. The first shipped as a width-gated read-only mode
(banner, hidden editing tabs, guarded routes, a session-scoped "Use Full Version"
escape hatch). The owner then asked for the opposite: the full app on small screens.
The read-only mode was removed and replaced with responsive layout only.

The current behavior, pinned by suite-06:

- Every page, editor, action, and export works on a phone. There is no
  width-based feature gate anywhere in the app.
- `@media(max-width:760px)` blocks in `app/index.html` and
  `app/investment-analysis.css` reflow the layout: wide tables keep their
  desktop column widths and pan horizontally inside their card (`.card-bd`
  gets `overflow-x:auto` plus per-table `min-width`s), input grids collapse
  to one column, the tab bar scrolls sideways, and modals cap their height.
- Nothing overlaps, clips, or overruns the viewport — suite-06 asserts
  `scrollWidth <= innerWidth` on the phone viewport for Home and the Inputs
  editor.

If a real editing lock is ever needed (approvals, finalized budgets), it has to be
a role or per-budget lock enforced in the API — device width was never a security
boundary and is no longer even a UX one.

### Effort

Roughly a day to a day and a half including tests: one media-query flag, one render
function, nav filtering, a route guard, the banner, and the card layout. Splittable if
value is wanted sooner — phase one is the home list, the summary, the banner and the
guard; phase two adds the CSI rollup detail.

Incidental cleanup to fold in: two `@media` rules still target `#whoami`, which no
longer exists — it was replaced by the account avatar.

---

## Decided — Charts in the exports (2026-08)

Three inline-SVG charts were built for the PDF report (project cost build-up waterfall,
cost by CSI division, monthly income / expenses / net), composed from the data model
like every other export surface — and then **removed at the owner's request** (2026-08):
the feature isn't wanted right now. If charts come back, that model-composed inline-SVG
approach is the recorded path; the git history has the working implementation
(`git log --all -S 'data-chart' -- app/index.html`). The "Show Edited Line Flags"
export toggle from the same wave stays: it gates the blue edited badges in the PDF and
the Edited / Library Rate columns in the workbook.

**The Excel workbook deliberately has no charts.** The vendored ExcelJS build has zero
native chart support (verified — no chart code in the build), so the options were
static embedded pictures, in-cell data bars via conditional formatting (which the build
does support), or hand-injecting OOXML chart parts. Decision: tables only for now;
data bars and embedded images are the recorded future path if workbook visuals are
ever wanted. Do not reach for a chart library — the constraint is the vendored build.

---

## Built — Investment Analysis (2026-08, pending staging release)

Five-year before-tax investment analysis in the Investment Analysis tab: created
from an exact saved budget version (or standalone), server-calculated
(`api/shared/investment/`, engine `before-tax-1.1.0`, fixture-proven against
five recovered reference deals including a complete acquisition-sensitivity
matrix), versioned with optimistic concurrency, soft-deletable, with an
on-screen tabular report and a six-sheet table-only Excel workbook.

Deliberately NOT built (validator rejects rather than approximates; revisit only
with controlled calibration exports): charts/chart exports, after-tax analysis,
ten-year reports, interest-only / assumed / second / refinance loans, partner
waterfalls, MIRR/NPV, disposition-price sensitivity, AI summaries, external
publishing. A future **Refresh From New Budget Version** action (diff + new
analysis version) is the planned path for re-importing after a budget changes.

---

## Planned — Investment Analysis phase 2 (recommended order)

Recorded 2026-08 after the first staging review. Each item is independent; the
order weighs user value against build risk. Email/SharePoint delivery is
explicitly excluded from this plan per the owner.

1. **Refresh From New Budget Version** — the analysis stays pinned to its
   imported budget version by design; this adds the explicit re-import: pick a
   newer version, see a field-by-field diff (imported value vs current
   assumption), apply selectively, save as a new analysis version. The
   provenance model already stores everything this needs.
2. **Scenario comparison** — two or three analyses (or versions of one)
   side-by-side: assumptions that differ highlighted, KPI/return tables in
   columns. Reads existing endpoints only; pure UI.
3. **More sensitivity axes** — exit-cap ± and income-growth ± grids using the
   same preserved-base pattern the acquisition matrix proved. Engine-only
   addition plus report tables; the fixture methodology carries over.
4. **Goal seek** — solve purchase price for a target equity IRR or Year-1
   DSCR (bisection over the existing engine, like the IRR solver). Turns the
   tool from "check a deal" into "price a deal".
5. **Assumption defaults admin** — vacancy/growth/cost defaults become an
   admin-editable, versioned document like the pricing library
   (pricing_admin-gated, both gates), instead of constants in
   api/shared/investment/defaults.js.
6. **Portfolio view** — KPI roll-up across active analyses (count, total
   equity, weighted IRR, DSCR floor) on top of vw_InvestmentAnalyses; a
   natural extension of the Home page linkage.
7. **Lender tie-ins** — covenant flags on the report (DSCR below a set
   threshold, debt yield below target) feeding the future lender-package
   service.
8. **After-tax & 10-year projections** — blocked on evidence, not effort:
   requires controlled Analyst Pro calibration exports (reverse-engineering
   spec §13) before any formula is trusted.
