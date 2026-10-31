/* Dashboard numbers: plan summary, planned vs actual comparison, the combined dashboard view. */
import { EXPENSE_FIELD_KEYS, monthExpenses, monthIncome } from "./plan.js";
import { dailyRollupByMonth } from "./spending.js";

export function computeSummary(state) {
  var totalIncome = 0, totalExpenses = 0, balance = state.startingBalance || 0;
  var rows = state.months.map(function (m) {
    var inc = monthIncome(m), exp = monthExpenses(m), net = inc - exp;
    totalIncome += inc; totalExpenses += exp; balance += net;
    return { monthKey: m.monthKey, income: inc, expenses: exp, net: net, cumulative: balance };
  });
  var netSaved = totalIncome - totalExpenses;
  return {
    totalIncome: totalIncome, totalExpenses: totalExpenses, netSaved: netSaved,
    endingBalance: (state.startingBalance || 0) + netSaved,
    averageNet: rows.length ? netSaved / rows.length : 0,
    savingsRate: totalIncome > 0 ? (netSaved / totalIncome) * 100 : 0,
    rows: rows
  };
}

/*
 * Planned vs actual comparison.
 * - variance (per month) = actual net - predicted net, only for months
 *   whose actuals have been entered; otherwise null (shown blank).
 * - actual cumulative balance is only carried forward while actuals are
 *   entered contiguously from the first month; after a gap it is null.
 */

export function computeComparison(state) {
  var predicted = computeSummary(state);
  var actualByKey = {};
  (state.actuals || []).forEach(function (a) { actualByKey[a.monthKey] = a; });
  /* Daily-log rollup: for a month with daily expenses, the log is
     authoritative for actual EXPENSE fields (same rule as the server's
     syncDailyRollup) — manual actual income still applies, and the
     rolled-up expenses replace, never add to, manual actual expenses,
     so nothing is double-counted. */
  var rollup = dailyRollupByMonth(state);
  var actualBalance = state.startingBalance || 0;
  var contiguous = true;
  var actualNetEntered = 0, varianceEntered = 0, enteredCount = 0;
  var rows = predicted.rows.map(function (r) {
    var stored = actualByKey[r.monthKey];
    var a = stored;
    var roll = rollup[r.monthKey];
    if (roll && roll.count > 0 && stored) {
      a = { monthKey: stored.monthKey, entered: true,
        takeHomePay: stored.takeHomePay, otherIncome: stored.otherIncome };
      EXPENSE_FIELD_KEYS.forEach(function (k) { a[k] = roll.totals[k] || 0; });
    }
    var entered = !!(a && a.entered);
    var actualNet = null, variance = null, actualCumulative = null;
    var actualIncome = null, actualExpenses = null;
    if (entered) {
      actualIncome = monthIncome(a); actualExpenses = monthExpenses(a);
      actualNet = actualIncome - actualExpenses;
      variance = actualNet - r.net;
      actualNetEntered += actualNet; varianceEntered += variance; enteredCount += 1;
      if (contiguous) { actualBalance += actualNet; actualCumulative = actualBalance; }
    } else {
      contiguous = false;
    }
    return {
      monthKey: r.monthKey, income: r.income, expenses: r.expenses,
      predictedNet: r.net, predictedCumulative: r.cumulative,
      entered: entered, actualNet: actualNet, variance: variance,
      actualIncome: actualIncome, actualExpenses: actualExpenses,
      actualCumulative: actualCumulative
    };
  });
  return { rows: rows, actualNetEntered: actualNetEntered,
    varianceEntered: varianceEntered, enteredCount: enteredCount,
    predicted: predicted };
}

/*
 * Dashboard mode selection (pure): compareWithPlan=false presents
 * ACTUALS only — totals are summed over the months whose actuals have
 * been entered (non-entered months contribute nothing and stay blank in
 * the rows, never zero-filled), and the ending figure is the latest
 * contiguous actual cumulative balance (null when no entered month has
 * one, e.g. nothing entered yet). compareWithPlan=true returns the
 * planned/predicted totals exactly as computeSummary always has.
 */

export function computeDashboard(state, compareWithPlan) {
  var cmp = computeComparison(state);
  if (compareWithPlan) {
    var s = cmp.predicted;
    return { mode: "compare", cmp: cmp, enteredCount: cmp.enteredCount,
      totals: { income: s.totalIncome, expenses: s.totalExpenses,
        net: s.netSaved, ending: s.endingBalance, average: s.averageNet,
        rate: s.savingsRate } };
  }
  var income = 0, expenses = 0, ending = null;
  cmp.rows.forEach(function (r) {
    if (!r.entered) return;
    income += r.actualIncome || 0;
    expenses += r.actualExpenses || 0;
    if (r.actualCumulative !== null && r.actualCumulative !== undefined) ending = r.actualCumulative;
  });
  income = Math.round(income * 100) / 100;
  expenses = Math.round(expenses * 100) / 100;
  var net = cmp.actualNetEntered;
  return { mode: "actual", cmp: cmp, enteredCount: cmp.enteredCount,
    totals: { income: income, expenses: expenses, net: net, ending: ending,
      average: cmp.enteredCount ? Math.round((net / cmp.enteredCount) * 100) / 100 : 0,
      rate: income > 0 ? (net / income) * 100 : 0 } };
}
