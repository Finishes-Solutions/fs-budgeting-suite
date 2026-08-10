# FS Budgeting Suite — Phased Roadmap

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
