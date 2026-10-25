// One-time capture of the pro forma (investment) engine's outputs for seven
// realistic sample deals. Run ONLY to (re)create the goldens on purpose:
//
//   node tools/capture-proforma-golden.js
//
// The goldens were captured from staging @ 63ef1a4 BEFORE the budgeting-v2
// upgrade touched any code. test/proforma-golden.test.js asserts the engine
// still reproduces them exactly. Re-capturing them is a deliberate engine
// change and must be called out in CHANGELOG.md — never a way to make a red
// test green.
const fs = require('fs');
const path = require('path');
const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const { annualRows } = require('../api/shared/investment/result-rows');

const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'proforma-golden');

const loan = (amount, rate, amort, term, fee) => ({
  label: 'First Mortgage', kind: 'newAmortizing', amount, annualRate: rate,
  amortizationYears: amort, termYears: term, feePercent: fee, interestCalculation: '30/360'
});
const base = (o) => Object.assign({
  schemaVersion: 1, projection: { years: 5, taxMode: 'beforeTax' },
  capitalExpenses: [], reportOptions: { includeSensitivity: false }
}, o);

const DEALS = {
  'garden-multifamily-240u': base({
    analysisName: 'Garden MF 240 units',
    property: { name: 'Cedar Hollow', address: '1200 Example Pkwy, Katy TX', size: { unit: 'units', value: 240 }, unitCount: 240, purchaseMonth: '2027-06' },
    acquisition: { basis: { mode: 'purchasePrice', value: 52800000 }, costPercent: 0.02 },
    income: { mode: 'aggregate', year1PotentialIncome: 4752000, growth: { mode: 'constant', value: 0.03 },
      otherIncome: [{ label: 'Parking & storage', year1Amount: 115200, growth: { mode: 'constant', value: 0.03 } },
                    { label: 'RUBS & fees', year1Amount: 216000, growth: { mode: 'constant', value: 0.025 } }] },
    vacancy: { mode: 'constant', value: 0.07 },
    expenses: { mode: 'percentOfGOI', value: 0.40 },
    financing: { loans: [loan({ mode: 'ltv', value: 0.65 }, 0.0625, 30, 10, 0.01)] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.0575 }, sellingCostPercent: 0.025 },
    reportOptions: { includeSensitivity: true }
  }),
  'select-service-hotel-120k': base({
    analysisName: 'Select-service hotel 120 keys',
    property: { name: 'Hotel Example', address: 'I-35 & Main, San Marcos TX', size: { unit: 'squareFeet', value: 72000 }, unitCount: 120, purchaseMonth: '2027-01' },
    acquisition: { basis: { mode: 'purchasePrice', value: 24600000 }, costPercent: 0.025 },
    income: { mode: 'aggregate', year1PotentialIncome: 6132000, growth: { mode: 'constant', value: 0.035 },
      otherIncome: [{ label: 'F&B and other departments', year1Amount: 310000 }] },
    vacancy: { mode: 'constant', value: 0.28 },
    expenses: { mode: 'annualDollar', value: 2750000, growth: { mode: 'constant', value: 0.035 } },
    capitalExpenses: [{ label: 'FF&E reserve', annualAmounts: [180000, 186000, 193000, 199000, 206000] }],
    financing: { loans: [loan({ mode: 'amount', value: 15990000 }, 0.0725, 25, 5, 0.0125)] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.085 }, sellingCostPercent: 0.03 }
  }),
  'warehouse-250ksf-all-cash': base({
    analysisName: 'Bulk warehouse 250k SF',
    property: { name: 'Logistics Center', address: 'FM 1960 & Hwy 6, Houston TX', size: { unit: 'squareFeet', value: 250000 }, purchaseMonth: '2026-11' },
    acquisition: { basis: { mode: 'acquisitionCapRate', value: 0.0625 }, costPercent: 0.015 },
    income: { mode: 'aggregate', year1PotentialIncome: 2375000, growth: { mode: 'constant', value: 0.035 }, otherIncome: [] },
    vacancy: { mode: 'constant', value: 0.05 },
    expenses: { mode: 'annualDollar', value: 187500, growth: { mode: 'constant', value: 0.03 } },
    financing: { loans: [] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.065 }, sellingCostPercent: 0.02 },
    reportOptions: { includeSensitivity: true }
  }),
  'medical-office-10yr': base({
    analysisName: 'MOB 45k SF 10-year',
    property: { name: 'Example Medical Pavilion', address: 'Medical Center Dr, Austin TX', size: { unit: 'squareFeet', value: 45000 }, purchaseMonth: '2027-03' },
    projection: { years: 10, taxMode: 'beforeTax' },
    acquisition: { basis: { mode: 'purchasePrice', value: 19800000 }, costPercent: 0.02 },
    income: { mode: 'aggregate', year1PotentialIncome: 1530000, growth: { mode: 'constant', value: 0.03 },
      otherIncome: [{ label: 'Expense reimbursements', year1Amount: 495000, growth: { mode: 'constant', value: 0.03 } }] },
    vacancy: { mode: 'constant', value: 0.08 },
    expenses: { mode: 'annualDollar', value: 585000, growth: { mode: 'constant', value: 0.03 } },
    capitalExpenses: [{ label: 'TI / LC reserve', annualAmounts: [45000, 45000, 45000, 45000, 90000, 45000, 45000, 45000, 45000, 90000] }],
    financing: { loans: [loan({ mode: 'ltv', value: 0.60 }, 0.0675, 25, 10, 0.01)] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.0725 }, sellingCostPercent: 0.025 },
    reportOptions: { includeSensitivity: true }
  }),
  'retail-pad-qsr-acres': base({
    analysisName: 'QSR pad ground-up',
    property: { name: 'QSR Pad', address: 'Hwy 290 Outparcel, Cypress TX', size: { unit: 'acres', value: 1.1 }, purchaseMonth: '2027-02' },
    acquisition: { basis: { mode: 'purchasePrice', value: 3150000 }, costPercent: 0.02 },
    income: { mode: 'aggregate', year1PotentialIncome: 189000, growth: { mode: 'constant', value: 0.02 }, otherIncome: [] },
    vacancy: { mode: 'constant', value: 0.0 },
    expenses: { mode: 'percentOfGOI', value: 0.05 },
    financing: { loans: [loan({ mode: 'ltv', value: 0.55 }, 0.0675, 25, 5, 0.01)] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.0575 }, sellingCostPercent: 0.03 }
  }),
  'self-storage-ltv-sensitivity': base({
    analysisName: 'Climate self-storage 95k NRSF',
    property: { name: 'Example Storage', address: 'FM 2920, Spring TX', size: { unit: 'squareFeet', value: 95000 }, unitCount: 760, purchaseMonth: '2027-08' },
    acquisition: { basis: { mode: 'purchasePrice', value: 12350000 }, costPercent: 0.02 },
    income: { mode: 'aggregate', year1PotentialIncome: 1596000, growth: { mode: 'constant', value: 0.04 },
      otherIncome: [{ label: 'Tenant insurance & retail', year1Amount: 96000 }] },
    vacancy: { mode: 'constant', value: 0.12 },
    expenses: { mode: 'percentOfGOI', value: 0.35 },
    financing: { loans: [loan({ mode: 'ltv', value: 0.60 }, 0.07, 25, 5, 0.01)] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.0625 }, sellingCostPercent: 0.03 },
    reportOptions: { includeSensitivity: true }
  }),
  'podium-mixed-use-10yr': base({
    analysisName: 'Podium mixed-use 300 units + retail',
    property: { name: 'Example Station', address: 'Downtown, Example TX', size: { unit: 'squareFeet', value: 342000 }, unitCount: 300, purchaseMonth: '2028-04' },
    projection: { years: 10, taxMode: 'beforeTax' },
    acquisition: { basis: { mode: 'purchasePrice', value: 118500000 }, costPercent: 0.015 },
    income: { mode: 'aggregate', year1PotentialIncome: 8964000, growth: { mode: 'constant', value: 0.03 },
      otherIncome: [{ label: 'Retail NNN rent', year1Amount: 690000, growth: { mode: 'constant', value: 0.02 } },
                    { label: 'Structured parking', year1Amount: 540000, growth: { mode: 'constant', value: 0.03 } }] },
    vacancy: { mode: 'constant', value: 0.06 },
    expenses: { mode: 'percentOfGOI', value: 0.38 },
    financing: { loans: [loan({ mode: 'ltv', value: 0.60 }, 0.06, 30, 10, 0.0075)] },
    disposition: { exitCapRate: { mode: 'constant', value: 0.055 }, sellingCostPercent: 0.02 }
  })
};

for (const [name, input] of Object.entries(DEALS)) {
  const output = calculateInvestmentAnalysis(input);
  const golden = { capturedFrom: 'staging@63ef1a4', input, output, annualRows: annualRows(output) };
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(golden, null, 1) + '\n');
  console.log(name, 'NOI1', Math.round(output.summary.year1NOI), 'IRR', output.summary.finalYearEquityIRR);
}
