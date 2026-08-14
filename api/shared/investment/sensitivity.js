// Acquisition-price sensitivity: five scenarios at 90/95/100/105/110% of the
// base price. Each scenario preserves the operating projection, exit cap,
// selling costs, and the terminal sale prices; it re-derives everything that
// hangs off the acquisition — cap rate, loan (base LTV preserved), fees,
// equity, debt service — and recalculates CoC and IRR series. Proven against
// the complete recovered Combo matrix.
const C = require('./constants');
const { irr } = require('./finance');
const { loanSchedule } = require('./debt');

function buildSensitivity({ norm, operatingYears, sales, baseLoanInput, basePrincipal,
                            basePurchasePrice, reportYears }) {
  const costPct = norm.acquisition.costPercent;
  const baseLTV = basePrincipal !== null && basePurchasePrice > 0
    ? basePrincipal / basePurchasePrice : null;
  const cfBeforeDebt = t => operatingYears[t - 1].NOI - operatingYears[t - 1].capitalExpenses;
  const sizeSF = norm.property.size.normalizedSquareFeet;

  return C.SENSITIVITY_FACTORS.map(factor => {
    const price = Math.round(basePurchasePrice * factor);
    const acqCosts = price * costPct;
    const unleveragedInitial = price + acqCosts;

    let loan = null;
    if (baseLTV !== null && baseLoanInput) {
      loan = loanSchedule(baseLoanInput, price * baseLTV, reportYears);
    }
    const equity = price + acqCosts + (loan ? loan.fees : 0) - (loan ? loan.principal : 0);
    const annualDS = loan ? loan.annualDebtService : 0;

    const unleveragedCoC = [], leveragedCoC = [], unleveragedIRR = [], leveragedIRR = [];
    for (let t = 1; t <= reportYears; t++) {
      unleveragedCoC.push(unleveragedInitial > 0 ? cfBeforeDebt(t) / unleveragedInitial : null);
      leveragedCoC.push(equity > 0 ? (cfBeforeDebt(t) - annualDS) / equity : null);

      const propFlows = [-unleveragedInitial];
      for (let y = 1; y <= t; y++) {
        let f = cfBeforeDebt(y);
        if (y === t) f += sales[t - 1].grossSalePrice - sales[t - 1].sellingCosts;
        propFlows.push(f);
      }
      unleveragedIRR.push(irr(propFlows));

      const netProceeds = sales[t - 1].grossSalePrice - sales[t - 1].sellingCosts
        - (loan ? loan.endingBalance[t - 1] : 0);
      const eqFlows = [-equity];
      for (let y = 1; y <= t; y++) {
        let f = cfBeforeDebt(y) - annualDS;
        if (y === t) f += netProceeds;
        eqFlows.push(f);
      }
      leveragedIRR.push(irr(eqFlows));
    }

    return {
      factor,
      purchasePrice: price,
      acquisitionCapRate: price > 0 ? operatingYears[0].NOI / price : null,
      pricePerSquareFoot: sizeSF ? price / sizeSF : null,
      loanAmount: loan ? loan.principal : null,
      initialEquity: equity,
      unleveragedCoC, leveragedCoC, unleveragedIRR, leveragedIRR
    };
  });
}

module.exports = { buildSensitivity };
