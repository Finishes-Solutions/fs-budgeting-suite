# Data Contract — BD Budget → Master Lender Package

The lender package generator consumes this database; the budget tool is its write side.

## Read surface

**dbo.Budgets** — one row per project. `ContractSum` is the construction contract
number (hard cost + profit + contingency) → the lender package "Total Contract Sum".
`ProjectCost` adds soft costs, land, developer fee, marketing, closing. `Doc` holds
the full budget document (unit mix, income, expenses, markups) for narrative sections.

**dbo.SovLines** — one row per SOV line, rewritten on every save.

| Column | Lender package use |
|---|---|
| Code / Descr | SOV + AIA-style G703 continuation sheet line items (same rows, same order) |
| Scope | res/amen roll into the construction SOV; soft reported separately (not in contract sum) |
| Grp | Budget Category rollup table |
| Basis, Qty, Rate | Backup detail ("$/SF × SF") for lender due diligence |
| Total | Scheduled Value column |
| Provenance | `parametric-estimate` → `vendor-quote` → `contracted`. Package flags any allowance/estimate line above a threshold without backup docs |

## Rules the lender package relies on

1. **Baseline freeze at gate promotion.** When a BD deal promotes, the orchestrator
   copies the budget doc into a baseline (immutable v1). Quarterly packages diff
   current vs baseline to produce the Revision Summary table.
2. **Contingency is line 99.03**, explicit, never blended into other lines.
3. **Contract sum ≠ project cost.** The bank sees the contract sum; project cost is
   for internal underwriting and equity/sources-uses sections.
4. **Pricing version travels with the doc** (`Budgets.PricingVersion`) so any package
   can state which rate library produced it.
