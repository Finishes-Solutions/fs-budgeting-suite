# Research data files

Every default the budgeting engine uses comes from a file in this folder — never
from code. The app does no live research: these files are researched, reviewed,
committed, and then compiled into `app/research-data.js` by
`node tools/build-research-data.js`, which the browser and the tests load.

```
data/research/
  catalog.json            the project-type list (ids, category, primary unit)
  units.json              the unit-of-measure vocabulary
  _indices/escalation.json construction cost escalation index by year (+ method)
  _indices/regional.json   regional cost factors (national = 1.00) by state / metro
  _common/*.json           soft-cost norms, contingency norms, fees, financing norms,
                           quality / size / construction-type adjustment factors
  _blocks/*.json           reusable cost building blocks (parking, site work, …)
  <category>/<type>.json   one file per project type in catalog.json
```

After editing anything here: `node tools/validate-research.js` (schema check) then
`node tools/build-research-data.js` (rebuild the shipped bundle). The test suite
fails if the bundle is stale.

## Ground rules

1. **Never invent a source, URL, number or quote.** If no solid number exists,
   reason from comparable types and mark the value `"derived": true` with a
   `"method"` that explains exactly how it was reached. The UI labels these
   **"derived estimate — verify"**.
2. A paywalled source may be cited only for what is publicly visible.
3. Every money value states the **dollar year** and **region** it is expressed in.
   The build script escalates to the base year (`catalog.json` → `baseYear`) with
   `_indices/escalation.json` and converts to a national baseline with
   `_indices/regional.json`. You never pre-normalize by hand unless you say so in
   `method` and set `region: "US"` and `dollarYear` to the base year.
4. When sources disagree keep **all** of them as evidence; the default is a
   reasoned midpoint and the range is shown.
5. Percentages are decimal fractions (6% is `0.06`).

## Shared shapes

### Evidence item (one sourced data point)

```json
{
  "id": "e1",
  "metric": "hardCostPerUnit",
  "value": 185000,              // point value, or null when only a range is given
  "low": 160000, "high": 210000, // optional range from the source
  "unit": "USD/unit",           // USD/<unit id> | pct | ratio | count | text
  "region": "Dallas-Fort Worth, TX",
  "regionKey": "TX-DFW",        // "US", a state code ("TX"), or "<ST>-<metro>" from _indices/regional.json
  "dataYear": 2025,             // year the dollars are in
  "source": {
    "title": "…exact page or report title…",
    "url": "https://…",
    "publisher": "…",
    "accessed": "2026-10-24"
  },
  "quote": "short exact quote, or a table reference like 'Table 3, row Garden apartments'",
  "scopeNotes": "what the number includes/excludes vs. our definition",
  "confidence": "high | medium | low"
}
```

Confidence: **high** = primary/authoritative source (cost consultant report,
government data, public budget) quoting this exact metric for this type;
**medium** = reputable secondary source or a close proxy; **low** = blog/vendor
marketing, single anecdote, or loose proxy.

### Money range (what the engine uses)

```json
{ "low": 150000, "mid": 185000, "high": 230000,
  "dollarYear": 2025, "region": "US",
  "evidence": ["e1", "e2"],      // ids in this file's evidence[] (or "<file>#eN")
  "derived": false,
  "method": "Mid = median of e1,e2,e4; low/high = their ranges." }
```

`derived: true` requires `method` and usually `evidence: []` or proxy evidence.

### Percent range

Same as money but without `dollarYear`/`region`: `{ "low": 0.04, "mid": 0.05, "high": 0.07, "evidence": [], "derived": true, "method": "…" }`.

## Project type file — `<category>/<type>.json`

```json
{
  "schemaVersion": 1,
  "id": "garden-multifamily",          // must match catalog.json
  "name": "Garden multifamily",
  "category": "residential",
  "researchedAt": "2026-10-24",
  "primaryUnit": "unit",
  "summary": "2–3 sentences on what drives cost for this type and how good the data is.",

  "sizing": {
    "typicalSize":         { "low": 150, "mid": 250, "high": 400, "unit": "unit", "evidence": [], "derived": true, "method": "…" },
    "sfPerPrimaryUnit":    { "low": 850, "mid": 1000, "high": 1150, "evidence": [], "derived": false, "method": "gross building SF per unit incl. common area" },
    "primaryUnitsPerAcre": { "low": 16, "mid": 22, "high": 30, "evidence": [], "derived": true, "method": "…" },
    "parkingPerPrimaryUnit": { "low": 1.5, "mid": 1.75, "high": 2.0, "type": "surface", "evidence": [], "derived": true, "method": "…" }
  },

  "hardCost": {
    "perPrimaryUnit": { "low": 0, "mid": 0, "high": 0, "dollarYear": 2025, "region": "US", "evidence": [], "derived": false, "method": "…" },
    "perSF":          { "low": 0, "mid": 0, "high": 0, "dollarYear": 2025, "region": "US", "evidence": [], "derived": false, "method": "…" },
    "scope": {
      "includesSitework": true,          // typical on-site work (CSI 31–33 within the property line)
      "includesStructuredParking": false,
      "includesFFE": false,
      "notes": "Contractor price incl. general conditions and OH&P; excludes land, soft costs, FF&E, off-sites, impact/tap fees."
    }
  },
  // perSF may be omitted when primaryUnit is "sf" (perPrimaryUnit IS per SF);
  // for site-type products (RV site, slip, MW) perSF may be omitted entirely.

  "qualityTiers": {                     // multipliers on the mid; optional (else _common/adjustments.json)
    "economy": 0.85, "standard": 1.0, "premium": 1.2, "luxury": 1.45,
    "evidence": [], "derived": true, "method": "low/mid and high/mid of the hard-cost range"
  },

  "systemSplit": {                      // CSI MasterFormat divisions; pct of the hard cost; must sum to 1.000
    "lines": [ { "division": "01", "pct": 0.08 }, { "division": "03", "pct": 0.07 } ],
    "evidence": [], "derived": true, "method": "…"
  },

  "lineItems": [                        // specialty and non-scaling items unique to this type
    {
      "id": "grease-interceptor",
      "name": "Grease interceptor (1,500 gal)",
      "division": "22",
      "block": "utilities",             // optional building-block id from _blocks/
      "unit": "ea",
      "qty": { "per": "project", "value": 1 },   // per: project | primaryUnit | sf | acre | <unit id>
      "cost": { "low": 0, "mid": 0, "high": 0, "dollarYear": 2025, "region": "US", "evidence": [], "derived": true, "method": "…" },
      "inBaseline": false,              // true = already inside hardCost (shown as a carve-out, not added)
      "scales": false,                  // false = does not scale with size (fixed / per-project)
      "optional": false,                // true = off by default, user can switch it on
      "notes": "…"
    }
  ],

  "ffe": { "perPrimaryUnit": { "low": 0, "mid": 0, "high": 0, "dollarYear": 2025, "region": "US", "evidence": [], "derived": true, "method": "…" } },

  "softCosts": {
    // EXCLUDES impact & tap fees, the developer fee, construction financing and contingency —
    // the engine adds each of those as its own line.
    "pctOfHard": { "low": 0.18, "mid": 0.22, "high": 0.28, "evidence": [], "derived": false, "method": "…" },
    "developerFee": { "low": 0, "mid": 0, "high": 0, "evidence": [], "derived": true, "method": "…" },  // optional; else _common developerFee
    "breakdown": {                      // optional per-type overrides of _common/soft-costs.json, pct of hard cost
      "architectureEngineering": 0.06
    },
    "notes": "…"
  },

  "contingency": {
    "design":  { "low": 0.03, "mid": 0.05, "high": 0.10, "evidence": [], "derived": true, "method": "…" },
    "hard":    { "low": 0.03, "mid": 0.05, "high": 0.10, "evidence": [], "derived": true, "method": "…" },
    "soft":    { "low": 0.03, "mid": 0.05, "high": 0.10, "evidence": [], "derived": true, "method": "…" }
  },

  "rangeCheck": {                       // plausible ALL-IN total project cost (hard+soft, excl. land) per primary unit
    "perPrimaryUnit": { "min": 0, "max": 0, "dollarYear": 2025, "region": "US", "method": "…" }
  },

  "evidence": [ /* evidence items */ ],
  "openQuestions": [ "what would make this data better" ]
}
```

## Building block file — `_blocks/<id>.json`

```json
{
  "schemaVersion": 1,
  "id": "parking",
  "name": "Parking",
  "researchedAt": "2026-10-24",
  "items": [
    { "id": "parking-surface", "name": "Surface parking", "division": "32", "unit": "space",
      "cost": { "low": 0, "mid": 0, "high": 0, "dollarYear": 2025, "region": "US", "evidence": [], "derived": false, "method": "…" },
      "notes": "…" }
  ],
  "evidence": []
}
```

## Index files

`_indices/escalation.json` — `{ "series": { "2015": 100.0, …, "2026": 160.2 }, "forecast": { "2027": 0.04 }, "method": "…", "evidence": [] }`.
Values are an annual-average cost index; escalation from year A to B is `series[B] / series[A]`.
`forecast` gives annual escalation rates used to escalate to a future construction midpoint.

`_indices/regional.json` — `{ "factors": { "US": 1.00, "TX": 0.89, "TX-Austin": 0.92, … }, "method": "…", "evidence": [] }`.
A value in region R converts to national with `value / factors[R]` (metro falls back to state, then US).
