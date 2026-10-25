# Investment Analysis — Formula Reference

Every value the investment engine produces, with the exact formula that
produces it. This is a transcription of `api/shared/investment/*` — the
server-authoritative engine, calculation version **`before-tax-1.1.0`**. Each
section names the module the formula lives in, so this document and the code
stay in step. If a formula here disagrees with the code, the code is right and
this file is stale — fix it.

The engine is a pure function: `calculateInvestmentAnalysis(rawInput)` in
`calculate.js` validates, normalizes, then runs the pipeline below and returns
one canonical result object. The browser only renders that object; it never
calculates.

---

## 1. Conventions & notation

- **`N`** — the projection horizon, 5 or 10 years (`projection.years`).
- **`t`** — a report year, `1 … N`. The engine always computes **one extra
  operating year** (`N + 1`), because a sale at the end of year `t` is priced
  on year `t + 1`'s income. Year `N + 1` is calculation-only; it is never a
  report row.
- **Rates are decimal fractions** everywhere in the engine and API: 6.5% is
  `0.065`, not `6.5`. The browser converts to and from percentage display.
- **Full precision throughout.** Intermediate values keep full JavaScript
  double precision. Rounding happens at exactly two places: the terminal gross
  sale price (to the nearest $1,000, which then feeds downstream math), and at
  display time. IRRs are never computed from rounded display strings.
- **Null, never NaN.** Any value that cannot be computed (an IRR with no sign
  change, a ratio dividing by zero) is `null`. The final result is passed
  through `sanitize()` in `calculate.js`, which converts any non-finite number
  to `null` — the serialized result never contains `NaN` or `Infinity`.
- **Money vs ratio storage.** Persisted annual rows store money as
  `DECIMAL(19,4)` and rates/ratios as `DECIMAL(19,10)`; `ResultDoc` keeps full
  precision and is the authority.

---

## 2. Normalization  ·  `normalize.js`, `defaults.js`

### Property size → normalized square feet

```
unit = squareFeet →  normalizedSquareFeet = value
unit = acres      →  normalizedSquareFeet = value × 43,560
unit = units      →  normalizedSquareFeet = null   (a unit count is not an area;
                                                     price/SF would be a lie —
                                                     price/unit is used instead)
```

`43,560` is `SQFT_PER_ACRE` in `constants.js`.

### Organization defaults (`defaults.js`)

Applied to any optional field the user leaves unset. All are editable in the UI.

| Default | Value |
|---|---|
| Acquisition cost % | 2.00% (`0.02`) |
| Selling cost % | 5.00% (`0.05`) |
| Loan fee % | 1.00% (`0.01`) |
| Income growth | 3.00% (`0.03`) |
| Other-income growth | 3.00% (`0.03`) |
| Dollar-expense growth | 3.00% (`0.03`) |
| Vacancy | 10.00% (`0.10`) |
| LTV suggestion | 65.00% (`0.65`) |
| Amortization | 25 years |
| Term | 5 years |
| Interest calculation | 30/360 |

---

## 3. Budget-import prefill  ·  `api/investment-analyses/index.js`, `budget-calc.js`

When an analysis is created from a saved budget version, these **suggestions**
are computed server-side from the immutable budget document. Every one is
editable; each carries a "From Budget" origin badge. `nz(x)` coerces a
non-finite value to 0; `tu` is the budget's total unit count.

```
Year-1 potential rental income  = 12 × Σ(unit.count × unit.rent)      [gross scheduled rent — NEVER the budget's Net Income figure]
Suggested purchase price        = total project cost (parts().project)
Other-income row (annual)       = 12 × rate × (auto ? tu : count)     per budget other-income row
Property size                   = budget siteSF if > 0, else resSF + amenSF
Unit count                      = Σ unit.count

Support (reference only, not applied automatically):
  annual service expenses       = 12 × Σ expense.monthlyAmount        [partial — NOT complete property OPEX]
```

Purchase month, the complete operating-expense figure, and the exit cap rate
are deliberately **never** prefilled — the user must enter them.

---

## 4. Operating projection (per year `t`)  ·  `operating.js`

Let `g` = income growth, computed for `t = 1 … N+1`.

```
Potential rental income      PRI[t]   = PRI[1] × (1 + g)^(t − 1)
Vacancy / credit loss        VL[t]    = PRI[t] × vacancyRate
Effective rental income      ERI[t]   = PRI[t] − VL[t]
Other income                 OI[t]    = Σ_rows ( row.year1Amount × (1 + row.growth)^(t − 1) )
Gross operating income       GOI[t]   = ERI[t] + OI[t]

Operating expenses           OE[t]:
  percent-of-GOI mode   →  OE[t] = GOI[t] × expenseRatio
  annual-dollar mode    →  OE[t] = expense₁ × (1 + expenseGrowth)^(t − 1)

Net operating income         NOI[t]   = GOI[t] − OE[t]

Capital expenses             CapEx[t] = Σ_rows row.annualAmounts[t]   for t ≤ N; 0 for the extra year N+1
```

Capital expenses sit **below** NOI — they reduce cash flow, never reported NOI.

---

## 5. Acquisition & initial investment  ·  `calculate.js`

The acquisition basis resolves only **after** Year-1 NOI is known (because a
cap-rate input derives the price from NOI):

```
purchasePrice mode        →  purchasePrice     = input value
                             acquisitionCapRate = NOI[1] ÷ purchasePrice

acquisitionCapRate mode   →  acquisitionCapRate = input value
                             purchasePrice      = NOI[1] ÷ acquisitionCapRate
```

Then:

```
Acquisition costs               = purchasePrice × acquisitionCostPercent
Loan fees                       = principal × loanFeePercent            (0 if all-cash)      [debt.js]
Unleveraged initial investment  = purchasePrice + acquisitionCosts
Initial equity investment       = purchasePrice + acquisitionCosts + loanFees − principal
```

For an all-cash deal, initial equity equals the unleveraged investment (no fees,
no principal subtracted).

---

## 6. Debt schedule  ·  `debt.js`, `finance.js`

At most one fully amortizing first mortgage, 30/360 convention.

```
Loan principal:
  amount mode  →  principal = entered dollars
  LTV mode     →  principal = purchasePrice × LTV

monthlyRate           = annualRate ÷ 12
amortizationMonths    = amortizationYears × 12
```

**Monthly payment (`pmt`)** — a fully amortizing payment, with a linear
zero-rate branch:

```
if monthlyRate = 0:   payment = principal ÷ amortizationMonths
else:                 payment = principal × monthlyRate ÷ ( 1 − (1 + monthlyRate)^(−amortizationMonths) )

Annual debt service   = payment × 12
```

**Ending loan balance** after `m` payments (`remainingBalance`), evaluated at
`m = min(t × 12, amortizationMonths)` for each year `t`:

```
if monthlyRate = 0:   balance = max(0, principal − payment × m)
else:                 f = (1 + monthlyRate)^m
                      balance = max(0, principal × f − payment × (f − 1) ÷ monthlyRate)
```

This matches Excel `=-PMT(annualRate/12, amortizationYears*12, principal)` and
the corresponding balance to within a dollar on all reference deals.

---

## 7. Disposition — hypothetical sale at end of year `t`  ·  `disposition.js`, `finance.js`

The load-bearing conventions live here:

```
Unrounded sale price   = NOI[t + 1] ÷ exitCapRate            [priced on NEXT year's NOI]
Gross sale price        = round( unroundedSalePrice ÷ 1000 ) × 1000     [nearest $1,000, then used downstream]
Selling costs           = grossSalePrice × sellingCostPercent
Loan payoff             = endingLoanBalance[t]               (0 if all-cash)
Net sale proceeds       = grossSalePrice − sellingCosts − loanPayoff
```

The **rounded** gross sale price — not the unrounded value — feeds selling costs
and net proceeds. This is arithmetic, not display formatting.

---

## 8. Cash flow (per year `t`)  ·  `returns.js`

```
Cash flow before debt    CFBD[t]  = NOI[t] − CapEx[t]
Annual debt service      DS       = loan.annualDebtService   (0 if all-cash)
Cash flow before taxes   CFBT[t]  = CFBD[t] − DS
```

---

## 9. Returns & KPIs  ·  `returns.js`, `calculate.js`

Per report year `t` (a `null` result means the divisor was zero or the loan is
absent):

```
Projected LTV        = endingLoanBalance[t] ÷ grossSalePrice[t]      [uses the hypothetical sale value, not purchase price]
DSCR                 = NOI[t] ÷ annualDebtService
Debt yield           = NOI[t] ÷ originalPrincipal                    [ORIGINAL principal, not the declining balance]
Cash-on-cash         = CFBT[t] ÷ initialEquityInvestment            [ORIGINAL equity, every year]
Unleveraged CoC      = CFBD[t] ÷ unleveragedInitialInvestment
Return on equity     = CFBT[t] ÷ netSaleProceeds[t]                 [Analyst Pro convention: divides by that year's hypothetical net proceeds]
Equity multiple      = ( Σ CFBT[1..t] + netSaleProceeds[t] ) ÷ initialEquityInvestment
```

Headline / summary fields (`calculate.js`):

```
Year-1 NOI              = NOI[1]
Gross rent multiplier   = purchasePrice ÷ PRI[1]                    [potential income, not effective]
Price per square foot   = purchasePrice ÷ normalizedSquareFeet      (null when size unit = units)
Price per unit          = purchasePrice ÷ unitCount                 (when a unit count is present)
Initial LTV             = originalPrincipal ÷ purchasePrice
Terminal-year NOI       = NOI[N + 1]                                [audit value; prices the Year-N sale]
```

---

## 10. IRR series, leverage & optimal hold  ·  `returns.js`, `finance.js`

All IRRs use evenly spaced annual periods (ordinary IRR, not XIRR). For a sale
at the end of year `t`, three cash-flow vectors are built and solved:

**Property (unleveraged) IRR** — one entry per year, period 0 is the outflow:

```
[ −(purchasePrice + acquisitionCosts),
  CFBD[1], … , CFBD[t] + grossSalePrice[t] − sellingCosts[t] ]
```

**Financing IRR / effective borrowing rate** (only when financed):

```
[ principal − loanFees,
  −DS, … , −DS − endingLoanBalance[t] ]
```

The effective rate exceeds the nominal rate because the fees reduce net loan
proceeds.

**Equity (leveraged) IRR:**

```
[ −initialEquityInvestment,
  CFBT[1], … , CFBT[t] + netSaleProceeds[t] ]
```

**The IRR solver (`irr`)** — deterministic, dependency-free:

1. Return `null` immediately if the cash flows have no sign change (all
   non-negative or all non-positive) — there is no meaningful rate.
2. Grid-scan NPV from −99.99% upward (4,000 log-spaced steps) to bracket the
   lowest sign change; `null` if none is found in range.
3. Bisect that bracket up to 200 times to a tolerance of `1e-9` on NPV.

NPV at rate `r`: `Σ_k cashFlow[k] ÷ (1 + r)^k`. The solver never returns `NaN`,
`Infinity`, or a misleading zero.

**Leverage impact:**

```
leverageImpact[t] = equityIRR[t] − propertyIRR[t]
```

The engine stores the full-precision difference. **On the report and exports**
it is displayed as the difference of the two *displayed* two-decimal IRRs
(e.g. `13.67% − 9.80% = 3.87%`), matching the recovered reports; the display
formatter, not the engine, applies that rounding. Positive means borrowing
raised the equity return.

**Optimal holding period:**

```
optimalHoldingYear  = argmax over t of equityIRR[t]     (ties resolve to the earlier year)
optimalHoldingYield = max over t of equityIRR[t]
```

Years whose equity IRR is `null` are skipped.

---

## 11. Acquisition-price sensitivity  ·  `sensitivity.js`

Five scenarios at **90%, 95%, 100%, 105%, 110%** of the base purchase price
(`SENSITIVITY_FACTORS`). Each scenario **preserves** the operating projection,
exit cap, selling costs, and the terminal sale prices, and **re-derives**
everything that hangs off acquisition. Base LTV is preserved:

```
baseLTV               = basePrincipal ÷ basePurchasePrice           (null if all-cash)

per scenario (factor f):
  price               = round( basePurchasePrice × f )
  acquisitionCosts    = price × acquisitionCostPercent
  unleveragedInitial  = price + acquisitionCosts
  loan principal      = price × baseLTV                             (a fresh schedule via loanSchedule)
  initialEquity       = price + acquisitionCosts + loanFees − principal
  acquisitionCapRate  = NOI[1] ÷ price
  pricePerSquareFoot  = price ÷ normalizedSquareFeet

  per year t:
    unleveragedCoC[t] = CFBD[t] ÷ unleveragedInitial
    leveragedCoC[t]   = (CFBD[t] − DS) ÷ initialEquity
    unleveragedIRR[t] = IRR[ −unleveragedInitial, CFBD[1..t] (+ grossSalePrice[t] − sellingCosts[t] at t) ]
    leveragedIRR[t]   = IRR[ −initialEquity, (CFBD − DS)[1..t] (+ netProceeds at t) ]
      where netProceeds = grossSalePrice[t] − sellingCosts[t] − endingLoanBalance[t]
```

This reproduces the recovered Combo acquisition-sensitivity matrix to displayed
precision, cell for cell.

---

## 12. Warnings & non-finite handling  ·  `calculate.js`

Non-blocking warnings are stored on the result (so a saved report stays
explainable) when:

- the loan exceeds the purchase price;
- initial equity ≤ 0 (the return divisors stop being meaningful);
- any year's cash flow before taxes is negative;
- DSCR falls below 1.00 in any year;
- leverage is negative in any year;
- the exit cap rate is below 75% of the acquisition cap rate (assumes
  significant appreciation);
- the operating-expense ratio is below 5% or above 75% of GOI.

Every serialized number is finite: `sanitize()` walks the whole result and maps
any `NaN`/`Infinity` to `null`.

---

## 13. Cross-reference — result field → source

| Result field(s) | Module | Section |
|---|---|---|
| `normalizedInput.property.size.normalizedSquareFeet` | `normalize.js` | 2 |
| prefill suggestions (`source.*`) | `api/investment-analyses/index.js` | 3 |
| `annual[].potentialIncome … netOperatingIncome`, `capitalExpenses` | `operating.js` | 4 |
| `summary.purchasePrice`, `acquisitionCapRate`, `acquisitionCosts`, `loanFees`, `unleveragedInitialInvestment`, `initialEquity` | `calculate.js` | 5 |
| `loans[].monthlyPayment`, `annualDebtService`, `fees`; `annual[].endingLoanBalance` | `debt.js`, `finance.js` | 6 |
| `annual[].grossSalePrice`, `sellingCosts`, `netSaleProceeds` | `disposition.js` | 7 |
| `annual[].debtService`, `cashFlowBeforeTaxes` | `returns.js` | 8 |
| `annual[].projectedLTV`, `dscr`, `debtYield`, `cashOnCash`, `unleveragedCashOnCash`, `returnOnEquity`, `equityMultiple`; `summary.grossRentMultiplier`, `pricePerSquareFoot`, `pricePerUnit`, `initialLTV`, `terminalYearNOI` | `returns.js`, `calculate.js` | 9 |
| `annual[].propertyIRR`, `effectiveLoanRate`, `equityIRR`, `leverageImpact`; `summary.optimalHoldingYear`, `optimalHoldingYield`, `finalYearEquityIRR`, `finalYearEquityMultiple` | `returns.js` | 10 |
| `sensitivity[]` | `sensitivity.js` | 11 |
| `warnings[]` | `calculate.js` | 12 |

---

## Budget-derived operating expense ratio (added 2026-08)

**Source module:** `api/shared/investment/from-budget.js` → `deriveExpenseRatio()`

When an analysis is created from a budget — or re-synced with
`PUT /api/investment-analysis/{id}?scope=resync` — the operating expense
percentage is derived rather than typed.

```
annualBudgetOpex     = 12 × grossIncome(budgetDoc).expMo
budgetGrossIncomeYr  = 12 × (rent + other income)          per month, from the budget
GOI                  = 12 × rent × (1 − vacancy) + 12 × other income
derived              = annualBudgetOpex / GOI
```

`vacancy` is **the analysis's own assumption**, not the organisation default,
whenever one is already set — which is why a re-sync re-derives rather than
copying the creation-time number.

### Why GOI and not gross income

`api/shared/investment/operating.js` applies `expenses.mode === 'percentOfGOI'`
against **Gross Operating Income**: effective rental income after vacancy, plus
other income. Deriving against gross scheduled income instead would understate
the ratio by exactly the vacancy factor — a 45% expense load would arrive as
40.5% at 10% vacancy, and NOI would be overstated all the way down the
projection.

Vacancy applies to **rent only**, exactly as the engine applies it. Until
2026-10 the derivation vacated other income too, which overstated the ratio
slightly (≈0.5% of operating expenses on a budget with typical other income).
Analyses derived before then record no `derivedFrom.otherIncomeYr`, keep their
saved ratio, and pick up the corrected one on their next re-sync.

### What is recorded

`normalizedInput.expenses` carries, alongside `mode` and `value`:

| Field | Meaning |
|---|---|
| `derivedFrom.projectId` | the budget it came from |
| `derivedFrom.budgetVersionNumber` | the exact immutable version |
| `derivedFrom.annualOpex` | the numerator |
| `derivedFrom.grossIncomeYr` | the budget's gross income (rent + other) |
| `derivedFrom.otherIncomeYr` | the other-income part of it, not vacated (absent on derivations before 2026-10) |
| `derivedFrom.vacancy` | the vacancy the GOI was computed at |
| `derivedFrom.goi` | the denominator |
| `derivedFrom.opexSchemaVersion` | 1 = service rows only, 2 = full schedule |
| `override` | the user took manual control; the value no longer tracks the budget |

### What did NOT change

`CALCULATION_VERSION` stays `before-tax-1.1.0`. Every formula in this document
is untouched — the engine receives a number in the same field it always did,
and only the provenance of that number is new. Bumping the version string here
would orphan every saved analysis from its engine for no arithmetic reason.

### The honesty clause

A budget whose expense rows total ~9% of income (every budget created before
the full OPEX schedule) produces a derived ratio of ~9%, and the analysis says
so at the point of use rather than quietly under-loading the projection:

> Budget BD-0001 is at 9.3% — outside the 35–55% guard rail and predates the
> full expense schedule. This analysis will misstate NOI until the budget is
> corrected.

That is the whole reason the 35–55% guard rail and the derived ratio shipped
together.

## Property size and purchase price on import (corrected 2026-08)

**Source module:** `api/shared/investment/from-budget.js` → `projectFromBudget()`

| Analysis field | Budget source |
|---|---|
| `property.size` | `resSF + amenSF` — the **building** |
| `acquisition.basis.value` | `parts(doc).project` — Total Project Cost |
| `income.year1PotentialIncome` | `12 × grossIncome(doc).rentMo` — gross scheduled rent |
| `source.support.landSquareFeet` | `doc.siteSF` — the land, kept as a site measure |
| `source.support.rentableSquareFeet` | `Σ(unit.sf × unit.count)` |

**Previously** `property.size` preferred `doc.siteSF` and only fell back to the
building. `siteSF` is the land area — `app/index.html` says so itself: *"Site SF
is land, so it prices nothing; it only feeds these measures."* Importing it as
property size made every price-per-square-foot figure in the analysis and its
exports a price per square foot of dirt. It looked correct on any budget where
Site SF was left at zero, which is why it survived.

Existing analyses are **not** auto-repaired: silently changing a saved number is
what the data contract forbids. They are told, and the user re-syncs.
