/* Forecast and "can I afford it?" math for the Ask box. The app does all
   of the arithmetic here; the AI only explains the result. */
import { MONTHS } from "./plan.js";
import { planFreeAfterBills } from "./spending.js";
import { computeComparison } from "./summary.js";

/* Below this balance a month counts as tight. */
export var AFFORD_CUSHION = 1000;

/* Month-by-month balance: months before the current one use their
   actuals while they are entered back to back from the start (the same
   rule as the dashboard's actual balance); the current month and later
   use the plan. -> [{ monthKey, label, net, balance, source, freeAfterBills }] */
export function forecast(state, todayKey) {
  var cmp = computeComparison(state);
  var balance = state.startingBalance || 0;
  var useActual = true;
  return cmp.rows.map(function (r) {
    var month = (state.months || []).filter(function (m) { return m.monthKey === r.monthKey; })[0];
    var actual = useActual && r.entered && r.monthKey < todayKey;
    if (!actual) useActual = false;
    var net = actual ? r.actualNet : r.predictedNet;
    balance += net;
    return {
      monthKey: r.monthKey, label: labelOf(r.monthKey), net: round(net), balance: round(balance),
      source: actual ? "actual" : "plan", freeAfterBills: planFreeAfterBills(month)
    };
  });
}

/* Effect of spending `amount` in monthKey (repeated for `months` months
   when it is a monthly cost). */
export function affordCheck(state, opts) {
  var amount = Math.abs(Number(opts.amount) || 0);
  var months = Math.max(1, Math.min(24, parseInt(opts.months, 10) || 1));
  var keys = MONTHS.map(function (m) { return m.key; });
  var start = keys.indexOf(opts.monthKey);
  if (start === -1) return { error: "That month is outside the plan (" + MONTHS[0].label + " to " + MONTHS[MONTHS.length - 1].label + ")." };
  var base = forecast(state, opts.todayKey);
  var hit = keys.slice(start, start + months);
  var spent = 0;
  var after = base.map(function (row) {
    if (hit.indexOf(row.monthKey) !== -1) spent += amount;
    return { monthKey: row.monthKey, label: row.label, balance: round(row.balance - spent) };
  });
  var rest = after.slice(start);
  var lowest = rest.reduce(function (lo, r) { return r.balance < lo.balance ? r : lo; }, rest[0]);
  var belowZero = rest.filter(function (r) { return r.balance < 0; }).map(function (r) { return r.label; });
  var verdict = belowZero.length ? "no" : lowest.balance < AFFORD_CUSHION ? "tight" : "comfortable";
  var first = base[start];
  return {
    item: opts.item || null, amount: amount, months: months, totalCost: round(amount * hit.length),
    month: first.label, balanceBefore: first.balance, balanceAfter: after[start].balance,
    freeAfterBillsThatMonth: first.freeAfterBills,
    lowestAfter: { month: lowest.label, balance: lowest.balance },
    endingBefore: base[base.length - 1].balance, endingAfter: after[after.length - 1].balance,
    endMonth: base[base.length - 1].label, monthsBelowZero: belowZero,
    cushion: AFFORD_CUSHION, verdict: verdict
  };
}

function labelOf(key) {
  var m = MONTHS.filter(function (x) { return x.key === key; })[0];
  return m ? m.label : key;
}
function round(n) { return Math.round((n || 0) * 100) / 100; }
