// Building an analysis input from an immutable budget version.
//
// Extracted from api/investment-analyses/index.js so the same projection can be
// reused by the re-sync scope — creation and re-sync MUST derive identically,
// or re-syncing would quietly change numbers that were never wrong.
//
// THREE RULES, each of which was got wrong once:
//
//  1. Property size is the BUILDING (residential + amenity SF), never the site.
//     doc.siteSF is land — app/index.html says so itself: "Site SF is land, so
//     it prices nothing." Importing it as property size made every $/SF figure
//     in the analysis a price per square foot of dirt, and it only looked wrong
//     on budgets that had a site area entered.
//
//  2. Purchase price is the budget's Total Project Cost, recomputed here from
//     the version document rather than trusted from a stored column.
//
//  3. The expense ratio is DERIVED from the budget, against the same Gross
//     Operating Income the engine's percentOfGOI mode multiplies — that is,
//     after vacancy. Deriving against gross income instead would understate the
//     ratio by exactly the vacancy factor.

const { parts, grossIncome, totUnits, expenseMonthly, nz } = require('../budget-calc');
const D = require('./defaults');

const round2 = x => Math.round(x * 100) / 100;
const round4 = x => Math.round(x * 10000) / 10000;

// The engine multiplies GOI — after vacancy, other income included — so the
// derivation has to divide by the same thing. Returns null when the budget
// cannot support a ratio (no income, or no expenses entered).
function deriveExpenseRatio(doc, vacancy) {
  const g = grossIncome(doc);
  const vac = Number.isFinite(+vacancy) ? +vacancy : D.vacancy;
  const goi = g.grossYr * (1 - vac);
  if (!(goi > 0)) return null;
  const annualOpex = 12 * g.expMo;
  if (!(annualOpex > 0)) return null;
  return {
    value: round4(annualOpex / goi),
    annualOpex: round2(annualOpex),
    grossIncomeYr: round2(g.grossYr),
    vacancy: vac,
    goi: round2(goi)
  };
}

// Everything the analysis imports from one budget version. `vacancy` lets a
// re-sync re-derive the expense ratio against the assumption the analysis is
// actually carrying rather than the organisation default.
function projectFromBudget(doc, v, opts) {
  opts = opts || {};
  const projectId = opts.projectId;
  const p = parts(doc), gi = grossIncome(doc), tu = totUnits(doc);
  const bldgSF = nz(doc.resSF) + nz(doc.amenSF);
  const rentableSF = (doc.units || []).reduce((s, u) => s + nz(u.sf) * nz(u.count), 0);
  const siteSF = nz(doc.siteSF);
  const derived = deriveExpenseRatio(doc, opts.vacancy);

  const imported = {
    property: {
      // The PROJECT's name first, because that is what the property is
      // actually called. The budget's own name is the fallback, and the id is
      // the last resort — an analysis called "BD-2108" is a symptom of a
      // budget that was never tied to a project, not a name.
      name: doc.name || opts.projectName || v.Name || projectId,
      address: doc.address || opts.projectAddress || '',
      // Rule 1. The building, never the land.
      size: { unit: 'squareFeet', value: bldgSF },
      unitCount: tu || null
    },
    acquisition: { basis: { mode: 'purchasePrice', value: round2(p.project) } },   // rule 2
    income: {
      year1PotentialIncome: round2(12 * gi.rentMo),
      otherIncome: (doc.other || []).map(o => ({
        label: o.label || 'Other Income',
        year1Amount: round2(12 * nz(o.rate) * (o.auto ? tu : nz(o.count))),
        growth: { mode: 'constant', value: D.otherIncomeGrowth }
      }))
    },
    // Rule 3. null when the budget cannot support a ratio — the field then
    // falls back to being typed, exactly as a standalone analysis is.
    expenses: derived
      ? { mode: 'percentOfGOI', value: derived.value, override: false,
          derivedFrom: {
            projectId, budgetVersionNumber: v.VersionNumber,
            annualOpex: derived.annualOpex, grossIncomeYr: derived.grossIncomeYr,
            vacancy: derived.vacancy, goi: derived.goi,
            opexSchemaVersion: nz(doc.opexSchemaVersion) || 1
          } }
      : { mode: 'percentOfGOI', value: null, override: false, derivedFrom: null }
  };

  const support = {
    contractSum: round2(p.contract),
    projectCost: round2(p.project),
    // Land is not discarded — it stops masquerading as the property size and
    // becomes what it always was: a site measure.
    landSquareFeet: siteSF || null,
    buildingSquareFeet: bldgSF || null,
    rentableSquareFeet: rentableSF || null,
    siteEfficiency: siteSF > 0 && bldgSF > 0 ? round4(bldgSF / siteSF) : null,
    annualServiceExpenses: round2(12 * gi.expMo),
    expenseRows: (doc.expenses || []).map(e => ({
      label: e.label,
      basis: e.per === 'pctIncome' ? '% of income' : e.per === 'fixed' ? 'fixed / mo' : 'per unit',
      annualAmount: round2(12 * expenseMonthly(doc, e, gi.rentMo + gi.otherMo))
    })),
    // Kept under its old name too: existing analyses render from it.
    serviceExpenseRows: (doc.expenses || []).map(e => ({
      label: e.label,
      annualAmount: round2(12 * expenseMonthly(doc, e, gi.rentMo + gi.otherMo))
    })),
    unitMix: (doc.units || []).map(u => ({ label: u.label, count: nz(u.count), rent: nz(u.rent) })),
    opexSchemaVersion: nz(doc.opexSchemaVersion) || 1
  };

  const fieldOrigins = {
    'property.name': 'Budget name',
    'property.address': 'Budget address',
    'property.size': 'Budget Residential + Amenity SF',
    'property.unitCount': 'Budget unit mix',
    'acquisition.basis': 'Budget Total Project Cost',
    'income.year1PotentialIncome': 'Budget unit mix — gross scheduled rent × 12',
    'income.otherIncome': 'Budget other-income rows × 12'
  };
  if (derived) fieldOrigins['expenses'] = 'Budget operating expenses ÷ gross operating income';

  return { imported, support, fieldOrigins, derived };
}

/* A new analysis starts in the month it is created — the overwhelmingly common
   answer, and one the user can change on step 1. It is set at CREATION only:
   an analysis that already carries a month (or was created before this
   default existed) is never rewritten, because a saved assumption is the
   user's, not ours. */
function currentPurchaseMonth() { return new Date().toISOString().slice(0, 7); }

module.exports = { projectFromBudget, deriveExpenseRatio, currentPurchaseMonth, round2, round4 };
