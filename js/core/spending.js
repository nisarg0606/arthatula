/* Spending rules: my share of an expense, daily rollups, what counts as spending, plan room. */
import { CATEGORY_TO_FIELD } from "./categories.js";

/* His effective cost of an expense: the optional myShare (his portion
   of a shared expense) when set, otherwise the full amount. Monthly
   actuals always sum this; card statement totals use the full amount. */

export function expenseShare(e) {
  if (e && typeof e.myShare === "number" && isFinite(e.myShare)) return e.myShare;
  return e ? (e.amount || 0) : 0;
}

export function sanitizeMyShare(v, amount) {
  if (v === undefined || v === null || v === "") return null;
  var n = typeof v === "number" ? v : parseFloat(v);
  if (!isFinite(n)) return null;
  var r = Math.round(n * 100) / 100;
  return r >= 0 && r <= amount ? r : null;
}

/* Group a state's daily expenses by monthKey -> { fieldKey: total },
   summing each expense's share (mirrors the server rollup's
   COALESCE(my_share, amount)). Baseline rule (mirrors the server):
   the starting balance is a snapshot taken on the baseline date, so
   expenses dated before it are already reflected in that balance and
   never count toward actuals — they stay in the log as records. */

export function dailyRollupByMonth(state) {
  var byMonth = {};
  var baseline = state && typeof state.baselineDate === "string" ? state.baselineDate : "";
  (state.dailyExpenses || []).forEach(function (e) {
    if (baseline && String(e.date || "") < baseline) return;
    var mk = String(e.date || "").slice(0, 7);
    if (!mk) return;
    if (!byMonth[mk]) byMonth[mk] = { count: 0, totals: {} };
    byMonth[mk].count += 1;
    var field = CATEGORY_TO_FIELD[e.category] || "otherExpenses";
    byMonth[mk].totals[field] = Math.round(((byMonth[mk].totals[field] || 0) + expenseShare(e)) * 100) / 100;
  });
  return byMonth;
}

/* Spending view (charge date): every daily-log entry except the
   pre-logged card-bill settlements, filed as "One-off". A bill is the
   PAYMENT of purchases already logged on their own dates, so counting
   it here would count those purchases twice. The Spent tile and the
   Daily spending / By category (actual) charts all use this one rule,
   so their totals agree. The baseline date only matters for the
   balance, so pre-baseline purchases still count as spending. */

export function isSpending(e) {
  return !!e && typeof e.date === "string" && e.category !== "One-off";
}

export function spentInMonth(state, monthKey) {
  var total = 0;
  ((state && state.dailyExpenses) || []).forEach(function (e) {
    if (!isSpending(e) || e.date.slice(0, 7) !== monthKey) return;
    total += expenseShare(e);
  });
  return Math.round(total * 100) / 100;
}

/* The fixed obligations a planned month must cover before any
   day-to-day spending: rent, utilities, insurance, subscriptions and
   the debt/one-off lines. */

export const FIXED_PLAN_KEYS = ["rent", "utilities", "insurance", "subscriptions",
  "oneOffs", "credilaEmi", "otherLoan", "creditCardPayment"];

/* What a planned month leaves FREE after its bills & loans (pure):
   income minus the fixed obligations above. Day-to-day categories
   (groceries, eating out, fuel, shopping, ...) are deliberately NOT
   subtracted — this figure is the room available for them, plus
   savings. Missing fields count as 0; null month yields 0. */

export function planFreeAfterBills(month) {
  if (!month) return 0;
  var free = (month.takeHomePay || 0) + (month.otherIncome || 0);
  FIXED_PLAN_KEYS.forEach(function (k) { free -= month[k] || 0; });
  return Math.round(free * 100) / 100;
}

/* Total still-PENDING charges dated inside monthKey (pure): the
   dashboard's preview line next to "Spent so far". Pending charges
   are display only (GET /api/pending) — this sum is shown alongside
   spentInMonth, never added to it, to any actual, or to a balance:
   a pending amount can still change or vanish before it posts. */

export function pendingInMonth(pendingList, monthKey, counted) {
  var total = 0;
  (pendingList || []).forEach(function (t) {
    if (!t || typeof t.date !== "string") return;
    if (counted && counted[t.id]) return; /* already an expense ("Count it now") */
    if (t.date.slice(0, 7) !== monthKey) return;
    total += t.amount || 0;
  });
  return Math.round(total * 100) / 100;
}
