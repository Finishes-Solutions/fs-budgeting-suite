# Build & Deployment Guide — FS Budgeting Suite (Phase 1)

Audience: Matthew (VP Technology). Assumes Owner/Contributor on an Azure subscription
and admin rights in the Finishes Solutions Entra tenant.

This guide covers **Phase 1 (standalone hosted tool)**. Phases 2–4 (SharePoint export,
Monday.com sync, Lender Package service) are defined with exit criteria in `ROADMAP.md`.

**Repo:** `github.com/Finishes-Solutions/fs-budgeting-suite` (private — correct; keep it that way).

---

## 0 · Decisions made up front (so you don't relitigate them mid-build)

| Decision | Value | Why |
|---|---|---|
| Region | **Central US** | Matches your existing Azure footprint (App Services, SQL). Keep everything co-located. |
| Resource group | **`rg-fs-budgeting-prod`** | One RG per workload per environment. Everything for this tool lives and dies together — delete the RG, delete the tool cleanly. |
| SWA SKU | **Standard** (~$9/mo) | Free tier cannot use a custom Entra registration, which is what locks sign-in to the Finishes tenant. Non-negotiable for this design. |
| SQL | **Serverless GP, Gen5, 0.5–1 vCore, auto-pause 60 min** | Right-sized for an internal tool; near-zero cost on idle weekends. |
| SQL server | **Reuse your existing production SQL server** if the BD governance DB already has one in Central US; otherwise create `sql-finishes-cus-prod-<unique>` | One server, many databases is the normal pattern — a server is a free logical container. Fewer firewalls to manage. |
| Database name | **`fs-budgeting-suite`** | Matches repo/docs. |
| Static Web App name | **`stapp-fs-budgeting-prod`** | CAF-style prefix; the default hostname is random anyway and you'll put a custom domain on it. |
| Custom domain | **`budgets.finishessolutions.com`** | Set in §6. |
| Auth to SQL (Phase 1) | SQL auth, dedicated least-privilege user | Pragmatic v1. Managed identity is hardening item #2 (§9). |
| Tags on everything | `workload=fs-budgeting-suite` `env=prod` `owner=msinitiere` | Cost reporting and future cleanup. Add `costCenter` if you use one. |

Naming follows Microsoft's Cloud Adoption Framework abbreviations (`rg-`, `sql-`,
`sqldb-`, `stapp-`). If Finishes already has a different convention in place, use
yours — consistency with your estate beats consistency with this document.

---

## 1 · Resource group

Portal: Resource groups → Create → name `rg-fs-budgeting-prod`, region Central US, add the three tags.

CLI (everything below assumes `az login` done and the right subscription selected —
check with `az account show`):

```bash
az group create \
  --name rg-fs-budgeting-prod \
  --location centralus \
  --tags workload=fs-budgeting-suite env=prod owner=msinitiere
```

Recommendation: skip a separate dev environment for now. SWA gives you free
**preview environments per pull request** automatically — that's your dev/staging.
Point previews at the same database until Phase 2; the data volume doesn't justify a
second SQL bill yet.

## 2 · Entra ID app registration

Portal → Microsoft Entra ID → App registrations → **New registration**:

- Name: `FS Budgeting Suite`
- Supported account types: **Accounts in this organizational directory only (Finishes Solutions only — Single tenant)** ← this is the line that keeps the rest of the world out.
- Redirect URI: leave blank for now (you don't have the hostname yet; §5 step 4 comes back here).

Then:

1. Overview → copy **Application (client) ID** and **Directory (tenant) ID**.
2. Certificates & secrets → New client secret → description `swa-auth`, expiry
   **180 days** (set a calendar reminder for rotation — expired secret = nobody can
   sign in, and the error message won't tell you that's why). Copy the **Value**
   immediately; it's shown once.
3. No API permissions needed for Phase 1. (Phase 2 adds `Sites.Selected` here.)

CLI alternative:

```bash
az ad app create --display-name "FS Budgeting Suite" --sign-in-audience AzureADMyOrg
# note the appId from the output, then:
az ad app credential reset --id <appId> --display-name swa-auth --years 0.5
```

## 3 · Azure SQL

### 3a. Server (skip if reusing an existing Central US server)

```bash
az sql server create \
  --name sql-finishes-cus-prod-fs01 \
  --resource-group rg-fs-budgeting-prod \
  --location centralus \
  --admin-user fsadmin \
  --admin-password '<STRONG-ADMIN-PW>'   # store in your password manager / Key Vault, not in notes

az sql server firewall-rule create \
  --resource-group rg-fs-budgeting-prod --server sql-finishes-cus-prod-fs01 \
  --name AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0

az sql server firewall-rule create \
  --resource-group rg-fs-budgeting-prod --server sql-finishes-cus-prod-fs01 \
  --name MattSetupIP --start-ip-address <your-ip> --end-ip-address <your-ip>
```

(Server names are globally unique; the `-fs01` suffix is there to dodge collisions.
`0.0.0.0` is Azure's magic "allow Azure services" rule, which is how the SWA-managed
Functions reach the DB. Delete `MattSetupIP` when setup is done.)

### 3b. Database

```bash
az sql db create \
  --resource-group rg-fs-budgeting-prod \
  --server sql-finishes-cus-prod-fs01 \
  --name fs-budgeting-suite \
  --edition GeneralPurpose --compute-model Serverless --family Gen5 \
  --capacity 1 --min-capacity 0.5 --auto-pause-delay 60 \
  --backup-storage-redundancy Local \
  --tags workload=fs-budgeting-suite env=prod owner=msinitiere
```

Then raise point-in-time restore retention from the 7-day default:

```bash
az sql db str-policy-set \
  --resource-group rg-fs-budgeting-prod --server sql-finishes-cus-prod-fs01 \
  --name fs-budgeting-suite --retention-days 35
```

### 3c. Schema, seed, and app login

Connect with Azure Data Studio / SSMS as the admin, **to the `fs-budgeting-suite` database**, and run in order:

1. `sql/schema.sql`
2. `sql/seed_pricing.sql` — loads pricing library `2026.08-v2` as current.
3. The app's least-privilege user (never let the app connect as admin):

```sql
CREATE USER [fs_budgeting_app] WITH PASSWORD = '<STRONG-APP-PW>';
ALTER ROLE db_datareader ADD MEMBER [fs_budgeting_app];
ALTER ROLE db_datawriter ADD MEMBER [fs_budgeting_app];
```

Connection string for §5:

```
Server=tcp:sql-finishes-cus-prod-fs01.database.windows.net,1433;Database=fs-budgeting-suite;User Id=fs_budgeting_app;Password=<STRONG-APP-PW>;Encrypt=true;TrustServerCertificate=false;Connection Timeout=60
```

(`Connection Timeout=60` matters with serverless: the first query after auto-pause
takes 30–60 s to warm. If that annoys daily use, `az sql db update ... --auto-pause-delay -1`
disables pausing for roughly $5–10/mo more.)

## 4 · Static Web App + GitHub

Portal is the smoother path here because of the GitHub OAuth handshake:

Create resource → **Static Web App**:

| Field | Value |
|---|---|
| Resource group | `rg-fs-budgeting-prod` |
| Name | `stapp-fs-budgeting-prod` |
| Plan type | **Standard** |
| Region (Functions API) | Central US |
| Source | GitHub → org `Finishes-Solutions` → repo `fs-budgeting-suite` → branch `main` |
| Build presets | **Custom** |
| App location | `app` |
| Api location | `api` |
| Output location | *(leave empty)* |

Azure commits its own workflow file to the repo and stores the deployment token as a
repo secret automatically. **Recommendation: keep Azure's generated workflow and
delete the repo's `.github/workflows/azure-swa-deploy.yml`** — two workflows deploying
the same app is a race, and Azure's is already wired with the token. (The repo copy
existed so the pipeline was reviewable before the SWA existed; its job is done.)

CLI alternative if you prefer:

```bash
az staticwebapp create \
  --name stapp-fs-budgeting-prod \
  --resource-group rg-fs-budgeting-prod \
  --location centralus --sku Standard \
  --source https://github.com/Finishes-Solutions/fs-budgeting-suite \
  --branch main --app-location app --api-location api --login-with-github
```

## 5 · Configuration (the four values that make it live)

1. SWA → **Environment variables** (a.k.a. Application settings), add:

| Setting | Value |
|---|---|
| `SQL_CONN` | connection string from §3c |
| `AAD_CLIENT_ID` | client ID from §2 |
| `AAD_CLIENT_SECRET` | secret value from §2 |

```bash
az staticwebapp appsettings set \
  --name stapp-fs-budgeting-prod --resource-group rg-fs-budgeting-prod \
  --setting-names SQL_CONN='<conn-string>' AAD_CLIENT_ID='<client-id>' AAD_CLIENT_SECRET='<secret>'
```

2. In the repo, edit `staticwebapp.config.json`: replace `<YOUR_TENANT_ID>` with the
   Directory (tenant) ID from §2. Commit → push → workflow deploys (~3 min; watch it
   under the repo's Actions tab).
3. SWA Overview → copy the default hostname (`xxxx.azurestaticapps.net`).
4. **Back to the app registration** (§2) → Authentication → Add a platform → Web →
   Redirect URI: `https://<default-hostname>/.auth/login/aad/callback`. You'll add the
   custom-domain callback in §6 too. Miss this and you get the classic
   redirect-URI-mismatch error at sign-in.

## 6 · Custom domain (recommended, do it now — renaming later is when links break)

1. SWA → Custom domains → Add → `budgets.finishessolutions.com`.
2. At your DNS host, add the CNAME it shows you:
   `budgets  CNAME  <default-hostname>.azurestaticapps.net`
3. Validation + free managed TLS cert takes minutes to an hour.
4. Add the second redirect URI to the app registration:
   `https://budgets.finishessolutions.com/.auth/login/aad/callback`

## 7 · Roles

Everyone in the tenant who signs in gets `authenticated` → can create and edit
budgets. Pricing publishing requires `pricing_admin`, and the ACL is deliberately one
person:

- SWA → **Role management** → Invite → your email → Domain: pick the custom domain →
  Role: `pricing_admin` → Generate → open the invite link **in the browser/profile
  you'll actually use** and accept. The role is bound to that consent; if pricing
  publish ever 403s you, re-accept the invite and confirm the role appears at
  `https://budgets.finishessolutions.com/.auth/me`.

## 8 · Verification checklist (run every item before calling it deployed)

1. Open the site in a private window → redirected to Entra sign-in → only a Finishes
   account gets in → your name renders in the header.
2. Budgets page loads with an empty list (proves API ↔ SQL round trip).
3. New budget → `BD-0001` → Save → hard-refresh → it's still there. Then in SQL:
   `SELECT COUNT(*) FROM dbo.SovLines WHERE ProjectId='BD-0001';` → ~103 rows.
4. Pricing library → shows unlocked for you → publish a version bump → confirm a new
   `PricingLibrary` row with `IsCurrent=1` and the old row flipped to 0.
5. Second account (Luigi, or a test user) → pricing page shows locked with the
   role message → their `PUT /api/pricing` returns 403.
6. Export both Excel and PDF from BD-0001 → open both.
7. `az group show -n rg-fs-budgeting-prod --query tags` → tags present (future-you
   doing cost reports says thanks).

## 9 · Hardening / next steps (ordered by value)

1. **Server-side recompute** — the API currently trusts client-computed
   ContractSum/ProjectCost. Port the calc to `api/shared/calc.js`, derive meta
   server-side. Do this before anything downstream (Monday, lender package) treats
   those numbers as authoritative.
2. **Managed identity → SQL** — SWA → enable system-assigned identity; in SQL:
   `CREATE USER [stapp-fs-budgeting-prod] FROM EXTERNAL PROVIDER;` + role grants;
   connection string becomes `Authentication=Active Directory Managed Identity` and
   the app password dies. Then move the remaining secrets to Key Vault references.
3. **Secret rotation reminder** — the AAD client secret from §2 expires in 180 days.
4. **Audit trail** — append-only `BudgetRevisions` (ProjectId, ChangedBy from the
   principal, timestamp, doc). Cheap now, painful to retrofit, and the lender package
   revision-summary table will want it.
5. **Phase 2 prep** — add `Sites.Selected` to the app registration and grant it on
   the projects SharePoint site only. See `ROADMAP.md`.

## 10 · Local development

```bash
npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4
cd api && npm install && cd ..
# api/local.settings.json (gitignored):
# { "IsEncrypted": false, "Values": { "FUNCTIONS_WORKER_RUNTIME": "node", "SQL_CONN": "<dev conn string>" } }
swa start app --api-location api
```

The SWA CLI emulates `/.auth/*` and lets you pick roles at the fake login screen —
tick `pricing_admin` to test the admin path. Without the API running, the frontend
falls back to the built-in pricing seed, read-only.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Sign-in loops or AADSTS50011 | Redirect URI mismatch — must be the exact hostname + `/.auth/login/aad/callback`, on **both** hostnames if using the custom domain. |
| 500 from `/api/*` | Almost always `SQL_CONN`. SWA → Functions → open the function → Monitor/logs. Second suspect: SQL firewall missing the AllowAzureServices rule. |
| First request of the day times out | Serverless auto-pause warmup. Retry once, or disable auto-pause (§3b note). |
| Pricing publish 403 **as you** | Role invite not accepted in this browser profile — check `/.auth/me`, re-accept the invite. |
| Deploys stopped after initial setup | Two workflow files racing, or the deployment token secret was regenerated — keep one workflow (§4) and re-paste the token if you rotated it. |
| Personal Microsoft account gets a sign-in prompt but fails | Working as intended — single-tenant registration rejects non-Finishes accounts. |
