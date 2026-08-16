# Email Export — Plan (Idea, Not Yet Built)

Status: **idea / deferred**. Nothing in this document is implemented. It records
the agreed approach for adding "Email" as an export option to the Investment
Analysis Export modal (and later the budget's), so the design is not re-litigated
when the feature is picked up. Email delivery was deliberately excluded from the
phase-2 roadmap; this plan exists so the thinking is saved, not as a commitment.

## Why this fits the current staging architecture

Everything the feature needs except two Azure resources already exists:

- SWA (Standard) with managed Functions on Node 22, secrets in app settings
  (the same pattern as the SQL connection string — never in the repo).
- Entra ID auth with the `x-ms-client-principal` header available to every
  function.
- Immutable saved versions in `InvestmentAnalysisVersions` — the exact thing an
  email should carry.
- An Export modal on the analysis editor where an Email button belongs.

The missing pieces are a Storage account (for outbound files) and an email
sender (Azure Communication Services Email).

## The architectural decision

Two ways to get a file to email; **Option B is the plan**.

- **Option A — upload what the browser built.** The modal POSTs the ExcelJS
  blob it already generates. Least new code, but it creates an endpoint that
  accepts arbitrary client bytes and mails them under the company's brand —
  every upload would need to be trusted, capped, and sniffed.
- **Option B — the server builds the file from a saved version (chosen).**
  The Email button sends only `{analysisId, versionNumber, recipient, note}`.
  The function loads that version's immutable `ResultDoc` from SQL, builds the
  workbook server-side, uploads it to Blob Storage, and emails a short-lived
  link. This matches the suite's standing invariants: emails carry exactly what
  was saved (never recalculated, never client-tampered), provenance stays
  server-owned, and "save before you can email" mirrors how versions already
  work. The cost is a second workbook builder in `api/` — the drift risk is
  real but testable (see Testing).

**PDF wrinkle:** the PDF is produced by the browser's print dialog, so there is
no PDF file to attach — and SWA-managed functions cannot run headless Chromium
to make one server-side. Phase 1 emails the **Excel workbook plus a sign-in
link to the analysis**. Server-rendered PDFs would need a separate dedicated
Functions app running Playwright; deferred.

## Step 1 — Azure resources (one-time)

```bash
# Storage account + private container for outbound exports
az storage account create -n fsbudgetexports -g <rg> -l <region> --sku Standard_LRS \
  --min-tls-version TLS1_2 --allow-blob-public-access false
az storage container create --account-name fsbudgetexports -n analysis-exports

# Auto-delete blobs after 14 days so the container never accumulates
az storage account management-policy create --account-name fsbudgetexports -g <rg> \
  --policy '{"rules":[{"enabled":true,"name":"purge-exports","type":"Lifecycle",
    "definition":{"filters":{"blobTypes":["blockBlob"],"prefixMatch":["analysis-exports/"]},
    "actions":{"baseBlob":{"delete":{"daysAfterModificationGreaterThan":14}}}}}]}'

# Azure Communication Services + Email
az communication create -n fs-comm -g <rg> --location global --data-location UnitedStates
az communication email create -n fs-email -g <rg> --location global --data-location UnitedStates
```

Sender address: start with the **Azure-managed domain** ACS provides
(`donotreply@<guid>.azurecomm.net`) — zero DNS work, good enough to prove the
flow on staging. For production, connect `finishessolutions.com` as a custom
domain in the Email Communication Service (TXT verification + SPF + DKIM
records at the DNS host), then send as e.g. `reports@finishessolutions.com`.

App settings on the Static Web App (Portal → Configuration; same place as the
SQL connection string):

| Setting | Value |
| --- | --- |
| `EXPORT_STORAGE_CONNECTION` | Storage account connection string |
| `ACS_EMAIL_CONNECTION` | ACS connection string |
| `ACS_EMAIL_SENDER` | Verified from-address |
| `EXPORT_EMAIL_ALLOWED_DOMAINS` | e.g. `finishessolutions.com` |

## Step 2 — API changes

Add to `api/package.json`: `@azure/storage-blob`, `@azure/communication-email`,
`exceljs` (pure JS, safe in managed functions) — and commit the updated
`api/package-lock.json`, as was done for mssql.

New function `api/investment-analysis-email/` following the existing function
shape (`function.json` + `index.js`):

1. **Auth** — parse `x-ms-client-principal` exactly as the other functions do;
   reject anonymous.
2. **Validate** — body is `{analysisId, versionNumber, recipient, note?}`.
   Enforce the recipient allowlist from `EXPORT_EMAIL_ALLOWED_DOMAINS` so the
   endpoint can never be used as an open relay.
3. **Load** — fetch that exact version's `ResultDoc` from
   `InvestmentAnalysisVersions` (404 if missing; refuse soft-deleted analyses).
   Never recalculate.
4. **Build** — a new `api/shared/investment/workbook.js` producing the same six
   sheets from the result doc: a sheet-by-sheet port of the client's
   `exportWorkbook()`. The Assumptions sheet keeps Calculation Version / Input
   Schema Version / Saved Analysis Version.
5. **Store** — upload to `analysis-exports/{analysisId}/v{n}-{timestamp}.xlsx`;
   generate a **service SAS, read-only, 24–72 hour expiry** for the link.
6. **Send** — ACS `EmailClient.beginSend()` with a branded plain HTML body:
   analysis name, version number, who sent it, the note, and the SAS link.
   Attach the file directly only if small (ACS caps total message size at
   10 MB); the link is the reliable path.
7. **Audit** — one new table via an additive migration like the others:
   `InvestmentExportEmails (Id, AnalysisId, VersionNumber, SentByUserId,
   Recipient, BlobPath, SentAtUtc)`. Doubles as the rate-limit source: refuse
   more than N sends per user per hour with a 429.

## Step 3 — UI wiring

The investment Export modal gets an **Email** button next to Excel Workbook and
PDF (Print) — and this is the moment to retire the budget modal's
"Email (Soon)" placeholder pattern when the budget gets the same treatment.
Clicking it swaps the modal body to a small form: Recipient, optional Note, and
a Send button disabled until the analysis is saved and un-stale (the same
`st.loadedVersion` gate the toolbar uses — an email carries a version, not a
draft). POST, toast "Emailed to …", done. House style throughout: Title Case
labels, no emojis.

## Step 4 — Testing

- Wrap the mailer and blob client in a small module so `test/mock-api.js` can
  register the route with both stubbed — the mock records "an email would have
  been sent with this blob" and the Playwright suite asserts the request shape,
  the disabled-until-saved gating, and the allowlist rejection.
- One node:test builds the server workbook from a fixture result (Wedgewood)
  and re-reads it with ExcelJS, asserting cell-for-cell parity with what
  suite-14 captures from the client — the drift guard between the two builders.

## Costs and gotchas

Costs are negligible: ACS email is roughly $0.00025 per message plus a fraction
of a cent per MB; storage at this volume is pennies per month. Gotchas worth
knowing up front:

- SWA-managed functions cannot use managed identity, so both connections ride
  app-setting connection strings (consistent with the SQL setup anyway).
- Custom-domain DKIM/SPF setup is the only fiddly part and takes a DNS
  propagation wait.
- Deliverability from the Azure-managed domain is fine internally, but a custom
  domain matters before anything goes to clients.
