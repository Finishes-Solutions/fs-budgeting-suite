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
