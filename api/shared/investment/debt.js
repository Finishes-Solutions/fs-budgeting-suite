// Debt schedule for the (at most one) fully amortizing 30/360 first mortgage.
const { pmt, remainingBalance } = require('./finance');

// Resolve the dollar principal from the entered mode. LTV needs the resolved
// purchase price, which is why this takes it as an argument.
function resolveLoanAmount(loan, purchasePrice) {
  return loan.amount.mode === 'ltv' ? purchasePrice * loan.amount.value : loan.amount.value;
}

// principal → { principal, monthlyPayment, annualDebtService, fees,
//               endingBalance: [y1..yN] }
function loanSchedule(loan, principal, years) {
  const monthlyRate = loan.annualRate / 12;
  const months = Math.round(loan.amortizationYears * 12);
  const monthlyPayment = pmt(monthlyRate, months, principal);
  const endingBalance = [];
  for (let t = 1; t <= years; t++) {
    const paid = Math.min(t * 12, months);
    endingBalance.push(remainingBalance(principal, monthlyRate, monthlyPayment, paid));
  }
  return {
    principal,
    monthlyPayment,
    annualDebtService: monthlyPayment * 12,
    fees: principal * loan.feePercent,
    endingBalance
  };
}

module.exports = { resolveLoanAmount, loanSchedule };
