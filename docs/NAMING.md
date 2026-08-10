# Finishes Solutions — Azure Naming Reference

Pattern: `<type>-<scope>-<region>-<env>[-<seq>]` · scope = `finishes` (shared platform)
or the workload name · region `cus` = Central US · CAF type prefixes (`rg-`, `sql-`,
`stapp-`, `app-`, `asp-`, `kv-`, `log-`, `appi-`).

Exceptions forced by Azure: storage accounts & container registries = no hyphens,
≤24 lowercase alphanumeric · Key Vault ≤24 chars · SQL server names globally unique
(hence `-fs01` suffixes) · SQL logins use underscores (SQL identifiers, not Azure names).

## Resource groups
| Name | Holds | When |
|---|---|---|
| rg-finishes-data-prod | SQL server + all work databases | Phase 1 |
| rg-fs-budgeting-prod | Budget tool SWA (+ its App Insights) | Phase 1 |
| rg-fs-lender-package-prod | Lender package service | Phase 4 |
| rg-finishes-platform-prod | Shared Key Vault, Log Analytics | When first needed |

## SQL — one server, many databases
| Name | What | When |
|---|---|---|
| sql-finishes-cus-prod-fs01 | Production server | Phase 1 |
| fs-budgeting-suite | Budget tool DB | Phase 1 |
| fs-bd-governance | BD governance DB | Sept 1 |
| fs-lender-package | Lender package store (reads the other two) | Phase 4 |
| fsadmin | Server admin login | Phase 1 |
| fs_budgeting_app / fs_governance_app / fs_lender_app | Per-app least-privilege users — one per app, one DB of blast radius each | Per phase |

## Compute & web
| Name | What | When |
|---|---|---|
| stapp-fs-budgeting-prod | Static Web App | Phase 1 |
| budgets.finishessolutions.com | Custom domain | Phase 1 |
| app-fs-lender-cus-prod on asp-finishes-cus-prod-01 | Lender package App Service; plan named generically for sharing | Phase 4 |
| reports.finishessolutions.com | Lender package domain (suggestion) | Phase 4 |

## Identity, monitoring, platform (as needed)
| Name | What |
|---|---|
| App registrations: "FS Budgeting Suite", "FS Lender Package" | Human-readable display names |
| pricing_admin | SWA custom role (in code — do not rename) |
| kv-finishes-prod-01 | Key Vault |
| log-finishes-cus-prod / appi-fs-budgeting-prod | Log Analytics / per-workload App Insights |
| stfinishesprodfs01 | Storage account, if needed |
| crfinishesprod | Container registry — reuse the fs-report-service ACR if one exists |

## Tags & GitHub
Every resource: `workload=<name>` `env=prod` `owner=fs-technology` (+ `costCenter`).
Repos: `fs-budgeting-suite`, `fs-lender-package` — `fs-` prefix matches fs-report-service.

Rename-proofing: only workload-scoped names change if the tool is renamed;
`finishes`-scoped platform names are permanent by design.
