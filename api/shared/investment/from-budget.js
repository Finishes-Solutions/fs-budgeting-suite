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
//     Operating Income the engine's percentOfGOI mode multiplies:
//     rent × (1 − vacancy) + other income (investment/operating.js). Vacancy
//     applies to RENT only — the engine never vacates other income. Deriving
//     against gross income would understate the ratio by the vacancy factor;
//     vacating other income too (as this once did) overstated it, so year-1
//     operating expenses in the analysis came out above the budget's own.

const { parts, grossIncome, totUnits, expenseMonthly, nz } = require('../budget-calc');
const D = require('./defaults');

const round2 = x => Math.round(x * 100) / 100;
const round4 = x => Math.round(x * 10000) / 10000;

// The engine multiplies GOI — after vacancy, other income included — so the
// derivation has to divide by the same thing. Returns null when the budget
// cannot support a ratio (no income, or no expenses entered).
// Gross Operating Income as the engine's percentOfGOI mode multiplies it:
// vacancy applies to rent only (rule 3). The one formula, for both derivations.
function goiOf(rentYr, otherYr, vacancy) { return rentYr * (1 - vacancy) + otherYr; }

function deriveExpenseRatio(doc, vacancy) {
  const g = grossIncome(doc);
  const vac = Number.isFinite(+vacancy) ? +vacancy : D.vacancy;
  const goi = goiOf(12 * g.rentMo, 12 * g.otherMo, vac);
  if (!(goi > 0)) return null;
  const annualOpex = 12 * g.expMo;
  if (!(annualOpex > 0)) return null;
  return {
    value: round4(annualOpex / goi),
    annualOpex: round2(annualOpex),
    grossIncomeYr: round2(g.grossYr),
    otherIncomeYr: round2(12 * g.otherMo),
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
            otherIncomeYr: derived.otherIncomeYr,
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

  // A budget built by the v2 estimate engine carries its own per-component and
  // per-phase pro forma inputs (doc.engineSummary, materialized at save). Those
  // replace the unit-mix projection above; everything else about the handoff —
  // the badges, the locks, the re-sync — is unchanged.
  if (doc && doc.engineSummary && doc.engineSummary.proforma) {
    return engineProjection(doc, v, p, imported, support, opts);
  }
  return { imported, support, fieldOrigins, derived, scope: null };
}

const { isSafeRowId } = require('../identifiers');
const SCOPE_KINDS = ['project', 'component', 'phase'];

// Normalize a requested scope; anything unrecognised is the whole project.
function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || !SCOPE_KINDS.includes(scope.kind)) return { kind: 'project', id: 'project' };
  if (scope.kind === 'project') return { kind: 'project', id: 'project' };
  return isSafeRowId(scope.id) ? { kind: scope.kind, id: scope.id } : { kind: 'project', id: 'project' };
}

function engineProjection(doc, v, p, imported, support, opts) {
  const pf = doc.engineSummary.proforma;
  const scope = normalizeScope(opts.scope);
  let s = pf.project;
  if (scope.kind === 'component') s = (pf.components || []).find(c => c.id === scope.id) || null;
  if (scope.kind === 'phase') s = (pf.phases || []).find(c => c.id === scope.id) || null;
  // A component or phase that is not in this version is NOT quietly replaced
  // by the whole project — that would turn a component analysis into a
  // project one with a different price. The caller refuses (scopeMissing).
  if (!s) return { scope, scopeMissing: true };
  // Rule 2 still holds for the whole project: the price is recomputed from the
  // document. A component or phase price is its materialized share.
  const price = scope.kind === 'project' ? round2(p.project) : round2(nz(s.totalCost));
  const label = scope.kind === 'project' ? '' : ' — ' + String(s.name || scope.id).slice(0, 120);
  imported.property.name = (imported.property.name + label).slice(0, 200);
  const puSum = Object.keys(s.primaryUnits || {}).reduce((a, k) => a + nz(s.primaryUnits[k]), 0);
  imported.property.size = s.size && s.size.value > 0 ? { unit: s.size.unit, value: s.size.value }
    : puSum > 0 ? { unit: 'units', value: puSum } : imported.property.size;
  imported.property.unitCount = s.unitCount || null;
  imported.acquisition = { basis: { mode: 'purchasePrice', value: price } };
  imported.income = {
    year1PotentialIncome: round2(nz(s.income && s.income.year1PotentialIncome)),
    otherIncome: nz(s.income && s.income.otherIncome) > 0
      ? [{ label: 'Other income', year1Amount: round2(nz(s.income.otherIncome)), growth: { mode: 'constant', value: D.otherIncomeGrowth } }]
      : []
  };
  const ratio = Number.isFinite(+s.expenseRatio) && s.expenseRatio !== null ? round4(+s.expenseRatio) : null;
  imported.vacancy = Number.isFinite(+s.vacancy) && s.vacancy !== null ? round4(+s.vacancy) : null;
  // The same provenance shape the classic derivation writes (deriveExpenseRatio),
  // because the analysis UI's badge, note and override-restore read it.
  const potential = nz(s.income && s.income.year1PotentialIncome), otherYr = nz(s.income && s.income.otherIncome);
  const vac = imported.vacancy !== null ? imported.vacancy : (Number.isFinite(+opts.vacancy) ? +opts.vacancy : D.vacancy);
  const goi = goiOf(potential, otherYr, vac);
  imported.expenses = ratio !== null
    ? { mode: 'percentOfGOI', value: ratio, override: false,
        derivedFrom: { projectId: opts.projectId, budgetVersionNumber: v && v.VersionNumber, scope,
          annualOpex: round2(ratio * goi), grossIncomeYr: round2(potential + otherYr), otherIncomeYr: round2(otherYr),
          vacancy: vac, goi: round2(goi), opexSchemaVersion: nz(doc.opexSchemaVersion) || 1,
          source: 'estimate engine revenue inputs' } }
    : { mode: 'percentOfGOI', value: null, override: false, derivedFrom: null };
  support.scope = scope;
  support.scopeName = s.name || null;
  support.projectCost = price;
  support.buildingSquareFeet = s.sizeSF || null;
  support.primaryUnits = s.primaryUnits || {};
  support.engineDataVersion = doc.engineSummary.dataVersion || null;
  const where = scope.kind === 'project' ? 'Estimate' : 'Estimate ' + scope.kind + ' "' + (s.name || scope.id) + '"';
  const fo = {
    'property.name': 'Budget name',
    'property.address': 'Budget address',
    'property.size': where + ' building SF (or units)',
    'property.unitCount': where + ' primary units',
    'acquisition.basis': where + ' total project cost',
    'income.year1PotentialIncome': where + ' revenue inputs',
    'income.otherIncome': where + ' other income'
  };
  if (ratio !== null) fo.expenses = where + ' expense ratio';
  return { imported, support, fieldOrigins: fo, derived: null, scope };
}

/* A new analysis starts in the month it is created — the overwhelmingly common
   answer, and one the user can change on step 1. It is set at CREATION only:
   an analysis that already carries a month (or was created before this
   default existed) is never rewritten, because a saved assumption is the
   user's, not ours. */
function currentPurchaseMonth() { return new Date().toISOString().slice(0, 7); }

module.exports = { projectFromBudget, deriveExpenseRatio, currentPurchaseMonth, normalizeScope, round2, round4 };
