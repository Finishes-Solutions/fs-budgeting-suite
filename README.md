# Finishes Solutions — FS Budgeting Suite

Internal Business Development budgeting application: multifamily project budgets built
from a versioned, admin-controlled pricing library, with unit-mix revenue, other income
and operating expenses, construction contract + total project cost rollups, and a
normalized SOV table that feeds the Master Lender Package pipeline.

**Stack:** Azure Static Web Apps (Standard) · Entra ID auth · SWA-managed Azure
Functions (Node 18) · Azure SQL Database.

| Path | What it is |
|---|---|
| `app/` | Frontend (single-file, Finishes Solutions design system) |
| `api/` | Azure Functions API — pricing, budgets, budget/{id} |
| `sql/` | Schema + initial pricing library seed |
| `docs/ROADMAP.md` | Phased plan: standalone → SharePoint → Monday → lender package |
| `docs/BUILD_GUIDE.md` | **Start here** — full provisioning & deployment guide |
| `docs/DATA_CONTRACT.md` | SOV data contract → lender package integration |
| `staticwebapp.config.json` | Routes, Entra ID provider, role enforcement |

Quick path: follow `docs/BUILD_GUIDE.md` top to bottom. First deploy is ~45 minutes.
