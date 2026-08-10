# Build & Deployment Guide — FS Budgeting Suite

Audience: Matthew (VP Technology). Assumes an Azure subscription with rights to create
resources, and the Finishes Solutions Entra tenant.

---

## Architecture

```
Browser (Entra ID sign-in)
   │  https://budgets.<yourdomain>  (or *.azurestaticapps.net)
   ▼
Azure Static Web App (Standard tier)
   ├─ app/          static frontend (this repo)
   ├─ /.auth/*      built-in auth endpoints (Entra ID, custom registration)
   └─ /api/*        SWA-managed Azure Functions (Node 18)
                       │  mssql over TLS
                       ▼
                 Azure SQL Database (fs-budgeting-suite)
                    ├─ PricingLibrary   versioned rate library (JSON docs)
                    ├─ Budgets          budget documents + meta
                    └─ SovLines         normalized SOV — lender package read surface
```

Design decisions worth knowing before you build:
- **Budgets snapshot pricing at creation.** Publishing a new library version never
  mutates existing drafts; reprice is an explicit user action. This mirrors the
  baseline-freeze rule planned for the Master Lender Package.
- **Documents in JSON, SOV normalized.** The budget doc is stored whole (fast, simple,
  schema-flexible) while SOV lines are also written to a relational table on every
  save — that table is what the lender package generator will query.
- **Role enforcement happens twice**: SWA route rules block `PUT /api/pricing` for
  non-admins at the edge, and the function re-checks the `pricing_admin` role from the
  `x-ms-client-principal` header. Client-side UI state is cosmetic only.

## Costs (honest estimate)

- Static Web Apps **Standard**: ~$9/mo. Required — the Free tier cannot use a custom
  Entra registration, which is what locks sign-in to the Finishes tenant.
- Azure SQL **Serverless (GP, 0.5–1 vCore, auto-pause)**: roughly $5–15/mo at this
  workload; auto-pause can take it near zero on idle weekends. First query after a
  pause takes ~30–60 s to warm — acceptable here; disable auto-pause if it annoys you.

## 1 · Entra ID app registration

1. Entra admin center → App registrations → **New registration**
   - Name: `FS Budgeting Suite`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI (Web): `https://<YOUR_SWA_HOSTNAME>/.auth/login/aad/callback`
     (add the real hostname after step 3; you can register with a placeholder first)
2. Copy the **Application (client) ID** and your **Directory (tenant) ID**.
3. Certificates & secrets → **New client secret** → copy the value immediately.

## 2 · Azure SQL

1. Create a SQL Server (or reuse an existing Finishes one) + database `fs-budgeting-suite`
   (Serverless GP as above).
2. Networking: allow Azure services, plus your IP for setup.
3. Run, in order, via SSMS / Azure Data Studio / query editor:
   - `sql/schema.sql`
   - `sql/seed_pricing.sql`  (loads pricing library `2026.08-v2` as current)
4. Create a least-privilege login for the app (don't use the admin):
   ```sql
   CREATE USER [fs_bd_budget_app] WITH PASSWORD = '<strong password>';
   ALTER ROLE db_datareader ADD MEMBER [fs_bd_budget_app];
   ALTER ROLE db_datawriter ADD MEMBER [fs_bd_budget_app];
   ```
   Connection string for later:
   ```
   Server=tcp:<server>.database.windows.net,1433;Database=fs-budgeting-suite;User Id=fs_bd_budget_app;Password=<pw>;Encrypt=true
   ```
   (Managed identity + Entra auth to SQL is the better long-term posture; SQL auth is
   the pragmatic v1. Hardening section covers the upgrade.)

## 3 · Static Web App + GitHub

1. Push this repo to a new private GitHub repo (e.g. `finishes/fs-budgeting-suite`).
2. Azure Portal → Create **Static Web App**:
   - Plan: **Standard** · Region: Central US (or your standard)
   - Source: GitHub → select the repo/branch `main`
   - Build presets: Custom → App location `app` · Api location `api` · Output ``
   - Azure writes its own workflow file; this repo already ships an equivalent one at
     `.github/workflows/azure-swa-deploy.yml`. Keep whichever you prefer — if you keep
     the repo's, add the deployment token as secret `AZURE_STATIC_WEB_APPS_API_TOKEN`
     (Portal → your SWA → Manage deployment token).
3. SWA → **Configuration → Application settings**, add:
   | Setting | Value |
   |---|---|
   | `SQL_CONN` | connection string from step 2 |
   | `AAD_CLIENT_ID` | app registration client ID |
   | `AAD_CLIENT_SECRET` | client secret value |
4. Edit `staticwebapp.config.json`: replace `<YOUR_TENANT_ID>` with the tenant ID.
   Commit + push → the workflow deploys.
5. Go back to the app registration and set the redirect URI to the real
   `https://<hostname>/.auth/login/aad/callback`.

## 4 · Roles

Everyone signing in from the tenant gets `authenticated` and can create/edit budgets.
Pricing publishing requires `pricing_admin`:

- SWA → **Role management → Invite** → your email → role `pricing_admin` → send →
  accept the invite link. That's the entire admin ACL — deliberately just you, per the
  requirement that only you edit pricing assumptions.

## 5 · Verify

1. Open the site → Entra sign-in → your name shows in the header.
2. Budgets page loads (empty list = API + SQL are talking).
3. New budget → BD-0001 → save → reload → it persists. Check SQL:
   `SELECT * FROM dbo.SovLines WHERE ProjectId='BD-0001'` → ~100 rows.
4. Pricing library → your account shows unlocked; publish a version bump; confirm a
   second `PricingLibrary` row with `IsCurrent=1`.
5. Have a non-admin colleague sign in → pricing shows locked for them; `PUT
   /api/pricing` from their session returns 403.

## 6 · Local development

```bash
npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4
cd api && npm install && cd ..
# api/local.settings.json (gitignored):
# { "IsEncrypted": false, "Values": { "FUNCTIONS_WORKER_RUNTIME": "node", "SQL_CONN": "<dev conn string>" } }
swa start app --api-location api
```
The SWA CLI emulates auth at `/.auth/*` and lets you pick roles — check
`pricing_admin` to test the admin path. Without the API running, the frontend falls
back to the built-in pricing seed read-only.

## 7 · Hardening / next steps (ordered by value)

1. **Server-side recompute.** The API currently trusts client-computed meta
   (ContractSum/ProjectCost) and recomputes only SOV quantities. Port the calc into
   `api/shared/calc.js` and derive meta server-side so a tampered client can't store
   wrong headline numbers.
2. **Managed identity → SQL** (drop the SQL password; `Authentication=Active Directory
   Managed Identity` in the connection string after granting the SWA's identity db
   access). Secrets to Key Vault references.
3. **Finalize workflow + SharePoint.** Add `POST /api/budget/{id}/finalize`: flips
   Status, locks edits, drops the Excel/PDF export into the project's SharePoint
   folder via Graph (same pattern as the gate-provisioning automation).
4. **Lender package hookup.** The Master Lender Package generator reads
   `dbo.SovLines` + `dbo.Budgets` — see `docs/DATA_CONTRACT.md`. Gate-promotion
   webhook copies the budget to a frozen baseline version at that moment.
5. **Audit trail.** Add a BudgetRevisions append-only table (ProjectId, ChangedBy from
   principal, timestamp, doc hash) — cheap now, painful to retrofit.
6. **Backups**: Azure SQL PITR is on by default (7 days); raise to 35 in the portal.

## Troubleshooting

- **401 loop after sign-in** → redirect URI mismatch (exact hostname + `/.auth/login/aad/callback`).
- **500 from /api/** → almost always `SQL_CONN` (check SWA → Functions → logs); or SQL
  firewall blocking Azure services.
- **Pricing publish 403 as you** → the invite assigns the role per-browser-session;
  re-accept the invite link, confirm at `/.auth/me` that `pricing_admin` is listed.
- **Serverless SQL first-hit timeout** → auto-pause warmup; retry once or disable auto-pause.
