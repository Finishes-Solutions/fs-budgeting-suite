// KPIs, IRR series, leverage, and optimal hold — every recovered definition,
// including the unusual ones, exactly as reconciled:
//   - CoC divides by ORIGINAL initial equity every year;
//   - ROE divides cash flow by that year's hypothetical net sale proceeds;
//   - debt yield divides NOI by ORIGINAL principal, not the declining balance;
//   - leverage impact is equity IRR minus property IRR (not minus loan rate);
//   - optimal hold is the year of maximum equity IRR.
const { irr } = require('./finance');

function buildReturns({ operatingYears, sales, loan, acquisition, reportYears, warnings }) {
  const { purchasePrice, acquisitionCosts, initialEquity, unleveragedInitialInvestment } = acquisition;
  const cashFlowBeforeDebt = t => operatingYears[t - 1].NOI - operatingYears[t - 1].capitalExpenses;
  const annualDS = loan ? loan.annualDebtService : 0;
  const rows = [];
  let cumulativeCF = 0;
  let missingIrrWarned = false;

  for (let t = 1; t <= reportYears; t++) {
    const op = operatingYears[t - 1];
    const sale = sales[t - 1];
    const cashFlowBeforeTaxes = cashFlowBeforeDebt(t) - annualDS;
    cumulativeCF += cashFlowBeforeTaxes;

    // --- IRR cash-flow vectors for a sale at the end of year t
    const propertyFlows = [-(purchasePrice + acquisitionCosts)];
    for (let y = 1; y <= t; y++) {
      let f = cashFlowBeforeDebt(y);
      if (y === t) f += sale.grossSalePrice - sale.sellingCosts;
      propertyFlows.push(f);
    }
    const propertyIRR = irr(propertyFlows);

    let effectiveLoanRate = null;
    if (loan && loan.principal > 0) {
      const finFlows = [loan.principal - loan.fees];
      for (let y = 1; y <= t; y++) {
        let f = -annualDS;
        if (y === t) f -= loan.endingBalance[t - 1];
        finFlows.push(f);
      }
      effectiveLoanRate = irr(finFlows);
    }

    const equityFlows = [-initialEquity];
    for (let y = 1; y <= t; y++) {
      let f = cashFlowBeforeDebt(y) - annualDS;
      if (y === t) f += sales[t - 1].netSaleProceeds;
      equityFlows.push(f);
    }
    const equityIRR = irr(equityFlows);
    if ((propertyIRR === null || equityIRR === null) && !missingIrrWarned) {
      warnings.push('An IRR could not be calculated for at least one sale year (no valid sign change) — the affected cells are shown as not available.');
      missingIrrWarned = true;
    }

    rows.push({
      year: t,
      cashFlowBeforeTaxes,
      projectedLTV: loan && sale.grossSalePrice > 0 ? loan.endingBalance[t - 1] / sale.grossSalePrice : null,
      dscr: loan && annualDS > 0 ? op.NOI / annualDS : null,
      debtYield: loan && loan.principal > 0 ? op.NOI / loan.principal : null,
      cashOnCash: initialEquity > 0 ? cashFlowBeforeTaxes / initialEquity : null,
      unleveragedCashOnCash: unleveragedInitialInvestment > 0
        ? cashFlowBeforeDebt(t) / unleveragedInitialInvestment : null,
      returnOnEquity: sale.netSaleProceeds !== 0 ? cashFlowBeforeTaxes / sale.netSaleProceeds : null,
      equityMultiple: initialEquity > 0 ? (cumulativeCF + sale.netSaleProceeds) / initialEquity : null,
      propertyIRR,
      effectiveLoanRate,
      equityIRR,
      leverageImpact: propertyIRR !== null && equityIRR !== null ? equityIRR - propertyIRR : null
    });
  }

  // Optimal hold: the year whose equity IRR is highest (ties go to the earlier
  // year, matching argmax over an in-order scan).
  let optimalHoldingYear = null, optimalHoldingYield = null;
  rows.forEach(r => {
    if (r.equityIRR !== null && (optimalHoldingYield === null || r.equityIRR > optimalHoldingYield)) {
      optimalHoldingYield = r.equityIRR; optimalHoldingYear = r.year;
    }
  });

  return { rows, optimalHoldingYear, optimalHoldingYield };
}

module.exports = { buildReturns };
