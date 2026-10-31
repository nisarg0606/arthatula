/*
 * Frontend pure-logic tests: planned-vs-actual variance and the daily
 * rollup overlay. Run: node tests/logic.test.mjs — dummy amounts only.
 */
import assert from "node:assert/strict";
import * as app from "../js/core/index.js";

const state = app.blankState();
state.startingBalance = 100;
// October (first planner month): planned pay 1000, planned groceries 300.
const first = state.months.find((m) => m.monthKey === "2026-10");
first.takeHomePay = 1000; first.groceries = 300;
// October (first planner month) actuals (manual): pay 1000, groceries 250 -> net +50 vs plan.
const firstA = state.actuals.find((a) => a.monthKey === "2026-10");
firstA.entered = true; firstA.takeHomePay = 1000; firstA.groceries = 250;

let cmp = app.computeComparison(state);
let row = cmp.rows.find((r) => r.monthKey === "2026-10");
assert.equal(row.predictedNet, 700);
assert.equal(row.actualNet, 750);
assert.equal(row.variance, 50, "variance = actual net - predicted net");
assert.equal(row.actualCumulative, 850);
assert.equal(cmp.rows.find((r) => r.monthKey === "2026-11").actualNet, null,
  "months without actuals stay blank, not zero");
assert.equal(cmp.enteredCount, 1);

// Daily rollup replaces (never adds to) manual actual expenses for the month.
state.dailyExpenses.push({
  id: 1, date: "2026-10-27", description: "Shop", amount: 200,
  category: "Groceries", categorizationSource: "rules"
});
cmp = app.computeComparison(state);
row = cmp.rows.find((r) => r.monthKey === "2026-10");
assert.equal(row.actualExpenses, 200, "daily log is authoritative for actual expenses");
assert.equal(row.actualNet, 800, "manual actual income (1000) minus rolled-up expenses (200)");
assert.equal(row.variance, 100);

// Baseline rule: an expense dated before the baseline date (2026-10-26)
// is already reflected in the starting balance, so the rollup ignores
// it — October actuals keep only the post-baseline 200 above.
state.dailyExpenses.push({
  id: 2, date: "2026-10-10", description: "Pre-baseline shop", amount: 999,
  category: "Groceries", categorizationSource: "rules"
});
cmp = app.computeComparison(state);
row = cmp.rows.find((r) => r.monthKey === "2026-10");
assert.equal(row.actualExpenses, 200, "pre-baseline expense must not roll into actuals");
assert.equal(app.dailyRollupByMonth(state)["2026-10"].count, 1, "rollup counts only on/after-baseline rows");

// Rules fallback categorizer sanity.
assert.equal(app.categorizeByRulesJs("Netflix month"), "Subscriptions");
assert.equal(app.categorizeByRulesJs("something unheard of"), "Misc/Other");

// ---- Credit cards: sanitize + statement-window filter ----
const cardState = app.sanitizeState({
  months: [], actuals: [],
  cards: [
    { id: 7, name: "Visa", statementStart: "2026-11-03", statementEnd: "2026-12-02", dueDate: "2026-12-27" },
    { name: "", statementStart: "2026-11-01", statementEnd: "2026-11-30" },
    { name: "Backwards", statementStart: "2026-12-01", statementEnd: "2026-11-01" }
  ],
  dailyExpenses: [
    { id: 1, date: "2026-11-03", description: "start boundary", amount: 10, category: "Groceries", card: "Visa", myShare: 4 },
    { id: 2, date: "2026-12-02", description: "end boundary", amount: 20, category: "Groceries", card: "Visa" },
    { id: 3, date: "2026-12-03", description: "after window", amount: 40, category: "Groceries", card: "Visa" },
    { id: 4, date: "2026-11-02", description: "before window", amount: 80, category: "Groceries", card: "Visa" },
    { id: 5, date: "2026-11-15", description: "other card", amount: 160, category: "Groceries", card: "Other" },
    { id: 6, date: "2026-11-15", description: "no card", amount: 320, category: "Groceries" }
  ]
});
assert.equal(cardState.cards.length, 1, "cards with no name or a backwards window are dropped");
assert.equal(cardState.cards[0].dueDate, "2026-12-27");
assert.equal(cardState.dailyExpenses.find((e) => e.id === 6).card, null,
  "an expense saved without a card field sanitizes to card: null");
const stmt = app.statementExpenses(cardState.cards[0], cardState.dailyExpenses);
assert.deepEqual(stmt.items.map((e) => e.id), [1, 2],
  "only this card's in-window expenses, boundaries inclusive");
assert.equal(stmt.total, 30, "statement total is the FULL amount (what he owes the bank)");
assert.equal(stmt.shareTotal, 24, "shareTotal: share 4 on the first + full 20 on the second");
assert.deepEqual(app.statementExpenses({ name: "Visa" }, cardState.dailyExpenses),
  { items: [], total: 0, shareTotal: 0 }, "a card without statement dates matches nothing");
assert.deepEqual(app.sanitizeState({ months: [] }).cards, [],
  "an old-format state without cards loads with cards: []");

// ---- My share: sanitize + share-based daily rollup ----
const ms = app.sanitizeState({ months: [], dailyExpenses: [
  { id: 1, date: "2026-11-01", description: "ok share", amount: 100, category: "Groceries", myShare: 40 },
  { id: 2, date: "2026-11-01", description: "share too big", amount: 100, category: "Groceries", myShare: 140 },
  { id: 3, date: "2026-11-01", description: "negative share", amount: 100, category: "Groceries", myShare: -5 },
  { id: 4, date: "2026-11-01", description: "old format, no share", amount: 100, category: "Groceries" },
  { id: 5, date: "2026-11-01", description: "zero share", amount: 100, category: "Groceries", myShare: 0 }
]});
assert.equal(ms.dailyExpenses.find((e) => e.id === 1).myShare, 40, "a valid share survives sanitize");
assert.equal(ms.dailyExpenses.find((e) => e.id === 2).myShare, null, "a share above the amount is dropped to null");
assert.equal(ms.dailyExpenses.find((e) => e.id === 3).myShare, null, "a negative share is dropped to null");
assert.equal(ms.dailyExpenses.find((e) => e.id === 4).myShare, null, "an old-format expense loads with myShare null");
assert.equal(ms.dailyExpenses.find((e) => e.id === 5).myShare, 0, "a zero share is kept (his portion really is 0)");

const shareState = app.blankState();
const sNovA = shareState.actuals.find((a) => a.monthKey === "2026-11");
sNovA.entered = true; sNovA.takeHomePay = 1000;
shareState.dailyExpenses.push(
  { id: 1, date: "2026-11-05", description: "Full", amount: 50, category: "Groceries", categorizationSource: "rules" },
  { id: 2, date: "2026-11-06", description: "Shared", amount: 80, category: "Groceries", categorizationSource: "rules", myShare: 30 }
);
const sRow = app.computeComparison(shareState).rows.find((r) => r.monthKey === "2026-11");
assert.equal(sRow.actualExpenses, 80, "frontend rollup sums shares: 50 full + 30 of the shared 80");
assert.equal(app.expenseShare({ amount: 80, myShare: 30 }), 30);
assert.equal(app.expenseShare({ amount: 80 }), 80, "no share set -> full amount");

// ---- Dashboard mode selection ----
const ds = app.blankState();
ds.startingBalance = 500;
const dFirst = ds.months.find((m) => m.monthKey === "2026-10");
dFirst.takeHomePay = 2000; dFirst.rent = 800;
const dFirstA = ds.actuals.find((a) => a.monthKey === "2026-10");
dFirstA.entered = true; dFirstA.takeHomePay = 1900; dFirstA.rent = 800;
let dash = app.computeDashboard(ds, false);
assert.equal(dash.mode, "actual");
assert.equal(dash.enteredCount, 1);
assert.deepEqual(
  { income: dash.totals.income, expenses: dash.totals.expenses, net: dash.totals.net, ending: dash.totals.ending },
  { income: 1900, expenses: 800, net: 1100, ending: 1600 },
  "actual-only totals come from the entered actuals, not the plan");
dash = app.computeDashboard(ds, true);
assert.equal(dash.mode, "compare");
assert.deepEqual(
  { income: dash.totals.income, expenses: dash.totals.expenses, net: dash.totals.net, ending: dash.totals.ending },
  { income: 2000, expenses: 800, net: 1200, ending: 1700 },
  "compare mode keeps the planned/predicted totals exactly as before");
// Planned average is net over every plan month (13 since the Oct start), not a fixed 12.
assert.equal(dash.totals.average, 1200 / app.MONTHS.length, "average net divides by the real month count");
const emptyDash = app.computeDashboard(app.blankState(), false);
assert.equal(emptyDash.enteredCount, 0);
assert.equal(emptyDash.totals.ending, null, "no actuals entered -> no actual ending balance");
assert.equal(emptyDash.totals.income, 0);
assert.equal(emptyDash.totals.net, 0);

// ---- Dashboard month figures: Spent (charge date) + Free after bills ----
// Spent sums the month's log entries by charge date at his-share value,
// on/after the baseline only, and excludes "One-off" entries (those are
// pre-logged card-bill settlements = payments, not spending).
const sp = app.blankState(); // baselineDate defaults to 2026-10-26
sp.dailyExpenses.push(
  { id: 1, date: "2026-11-03", description: "Groceries", amount: 100, category: "Groceries" },
  { id: 2, date: "2026-11-10", description: "Split dinner", amount: 80, category: "Eating Out", myShare: 30 },
  { id: 3, date: "2026-11-05", description: "Amex bill — due Nov 5", amount: 210.5, category: "One-off" },
  { id: 4, date: "2026-10-27", description: "October spend", amount: 50, category: "Groceries" },
  { id: 5, date: "2026-11-01", description: "November rent", amount: 400, category: "Rent" }
);
assert.equal(app.spentInMonth(sp, "2026-11"), 530,
  "Nov spent = 100 + 30 (myShare) + 400; the One-off bill entry is excluded");
sp.dailyExpenses.push({ id: 6, date: "2026-10-25", description: "Pre-baseline", amount: 999, category: "Groceries" });
assert.equal(app.spentInMonth(sp, "2026-10"), Math.round((app.spentInMonth({ dailyExpenses: sp.dailyExpenses.filter((e) => e.id !== 6) }, "2026-10") + 999) * 100) / 100,
  "pre-baseline purchases still count as spending (the baseline only affects the balance)");
assert.equal(app.isSpending({ date: "2026-11-21", category: "One-off", amount: 999.9 }), false, "card bills are not spending");
assert.equal(app.isSpending({ date: "2026-11-02", category: "Rent", amount: 400 }), true);
assert.equal(app.spentInMonth(sp, "2026-12"), 0, "a month with no entries spends 0");

// ---- Pending preview: still-settling charges, shown but never counted ----
// pendingInMonth sums the display-only pending snapshot for one month;
// it is rendered beside Spent and must stay independent of the log.
const pend = [
  { id: "p1", date: "2026-10-27", name: "Costco", amount: 56.06, accountLabel: "Robinhood", category: "Groceries" },
  { id: "p2", date: "2026-10-27", name: "Target", amount: 17.08, accountLabel: "Robinhood", category: "Shopping/Personal" },
  { id: "p3", date: "2026-10-26", name: "Safeway", amount: 8.94, accountLabel: "Amex", category: "Groceries" },
  { id: "p4", date: "2026-11-02", name: "November charge", amount: 20, accountLabel: "Amex", category: "Groceries" }
];
assert.equal(app.pendingInMonth(pend, "2026-10"), 82.08, "October pending = 56.06 + 17.08 + 8.94");
assert.equal(app.pendingInMonth(pend, "2026-11"), 20, "November pending counts only its own month");
assert.equal(app.pendingInMonth(pend, "2026-12"), 0, "a month with nothing pending previews 0");
assert.equal(app.pendingInMonth(null, "2026-10"), 0, "no snapshot yet previews 0");
assert.equal(app.pendingInMonth([], "2026-10"), 0, "empty snapshot previews 0");
assert.equal(app.spentInMonth(null, "2026-11"), 0, "missing state spends 0");

// Free after bills & loans: plan income minus rent/utilities/insurance/
// subscriptions and the debt/one-off lines. Day-to-day categories
// (groceries etc.) are NOT subtracted — they are what the room is for.
const nov = sp.months.find((m) => m.monthKey === "2026-11");
Object.assign(nov, {
  takeHomePay: 5000, otherIncome: 0, rent: 400, utilities: 50,
  insurance: 200, subscriptions: 27, oneOffs: 2500, credilaEmi: 0,
  otherLoan: 0, creditCardPayment: 0, groceries: 500, eatingOut: 0
});
assert.equal(app.planFreeAfterBills(nov), 1823,
  "5000 - 400 - 50 - 200 - 27 - 2500; the $500 groceries plan stays unspent room");
const dec = sp.months.find((m) => m.monthKey === "2026-12");
Object.assign(dec, { takeHomePay: 5000, rent: 800, utilities: 50, insurance: 200,
  subscriptions: 27, oneOffs: 4600.5, otherLoan: 300 });
assert.equal(app.planFreeAfterBills(dec), -977.5, "an over-committed month goes negative");
assert.equal(app.planFreeAfterBills({ takeHomePay: 100 }), 100, "missing fields count as 0");
assert.equal(app.planFreeAfterBills(null), 0, "null month yields 0");

/* deviceLabel: sign-in session labels from user agents (v6). */
assert.equal(app.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
assert.equal(app.deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"), "Android phone · Chrome");
assert.equal(app.deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"), "Mac · Chrome");
assert.equal(app.deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"), "Windows PC · Firefox");
assert.equal(app.deviceLabel(""), "Unknown device · Browser");
assert.equal(app.deviceLabel(), "Unknown device · Browser");

console.log("logic.test.mjs: all assertions passed");
