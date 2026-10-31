/*
 * v2 core money logic (js/core/v2/money.js): report lines and splits,
 * shares, transfers and hidden rows; cash flow by month; budgets with
 * rollover; the rolling forecast (current month only adds what is still
 * to come; repeated months drop one-offs); net worth carried forward
 * from snapshots; rules; recurring detection; upcoming; goals.
 * Run: node tests/v2-core.test.mjs — made-up numbers only.
 */
import assert from "node:assert/strict";
import {
  summarize, cashFlow, budgetMonth, forecast, netWorthSeries, ruleMatches, applyRules, merchantKey,
  detectRecurring, upcoming, goalProgress, addMonths, monthRange, reportLines, addDays
} from "../js/core/v2/money.js";

const cats = {
  pay: { kind: "income" }, food: { kind: "expense" }, rent: { kind: "expense" },
  fun: { kind: "expense" }, xfer: { kind: "transfer" }, oneoff: { kind: "expense" }
};
const tx = (date, amountCents, categoryId, extra) => Object.assign({ date, amountCents, categoryId, myShareCents: null, splits: [] }, extra || {});

/* ---- dates ---- */
assert.equal(addMonths("2026-11", 2), "2027-01");
assert.equal(addMonths("2027-01", -1), "2026-12");
assert.deepEqual(monthRange("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
assert.equal(addDays("2026-02-27", 2), "2026-03-01");

/* ---- summarize ---- */
{
  const list = [
    tx("2026-11-01", 410000, "pay"),
    tx("2026-11-02", -12000, "food", { myShareCents: -4000 }),        // shared dinner: my share counts
    tx("2026-11-03", -110000, "rent"),
    tx("2026-11-04", -75000, "xfer"),                                // card payment: never spending
    tx("2026-11-05", -9999, "fun", { hidden: true }),                // hidden: nowhere
    tx("2026-11-06", -5000, "fun", { excludeReports: true }),        // listed, not counted
    tx("2026-11-07", 1500, "food"),                                  // refund lowers food
    tx("2026-11-08", -3000, "food", { pending: true }),              // pending: not yet
    tx("2026-11-09", -10000, null, { splits: [{ categoryId: "food", amountCents: -6000 }, { categoryId: "fun", amountCents: -4000 }] }),
    tx("2026-11-10", -700, null)                                     // uncategorized spending
  ];
  const s = summarize(list, cats);
  assert.equal(s.incomeCents, 410000);
  assert.equal(s.byCategory.food, 4000 - 1500 + 6000);
  assert.equal(s.byCategory.fun, 4000);
  assert.equal(s.byCategory.rent, 110000);
  assert.equal(s.byCategory[""], 700);
  assert.equal(s.spendingCents, 4000 - 1500 + 110000 + 6000 + 4000 + 700);
  assert.equal(s.netCents, s.incomeCents - s.spendingCents);
  assert.deepEqual(reportLines(tx("2026-11-01", -100, "food", { hidden: true })), []);
}

/* ---- cash flow ---- */
{
  const cf = cashFlow([tx("2026-11-01", 1000, "pay"), tx("2026-12-15", -400, "food"), tx("2027-02-01", -50, "food")], cats, "2026-11", "2027-01");
  assert.deepEqual(cf.months.map((m) => m.month), ["2026-11", "2026-12", "2027-01"]);
  assert.equal(cf.months[1].spendingCents, 400);
  assert.equal(cf.months[2].spendingCents, 0, "empty month present with zeros");
  assert.equal(cf.total.incomeCents, 1000);
  assert.equal(cf.total.spendingCents, 400, "February is outside the range");
}

/* ---- budgets + rollover ---- */
{
  const budgets = [
    { month: "2026-11", categoryId: "food", amountCents: 50000, rollover: true },
    { month: "2026-12", categoryId: "food", amountCents: 50000, rollover: true },
    { month: "2027-01", categoryId: "food", amountCents: 50000, rollover: false },
    { month: "2026-12", categoryId: "pay", amountCents: 410000 }
  ];
  const txs = [tx("2026-11-10", -30000, "food"), tx("2026-12-10", -60000, "food"), tx("2026-12-01", 410000, "pay"), tx("2026-12-11", -2000, "fun")];
  const dec = budgetMonth("2026-12", budgets, txs, cats);
  const food = dec.rows.find((r) => r.categoryId === "food");
  assert.equal(food.rolloverCents, 20000, "November's $200 left rolls into December");
  assert.equal(food.remainingCents, 50000 + 20000 - 60000);
  assert.ok(dec.rows.find((r) => r.categoryId === "fun"), "unbudgeted spending still shows");
  assert.equal(dec.plannedIncomeCents, 410000);
  assert.equal(dec.actualIncomeCents, 410000);
  assert.equal(dec.actualSpendingCents, 62000);
  const jan = budgetMonth("2027-01", budgets, txs, cats);
  assert.equal(jan.rows.find((r) => r.categoryId === "food").rolloverCents, 0, "rollover off in January");
  /* Overspending rolls forward as a negative. */
  const over = budgetMonth("2026-12", [
    { month: "2026-11", categoryId: "food", amountCents: 10000, rollover: true },
    { month: "2026-12", categoryId: "food", amountCents: 10000, rollover: true }
  ], [tx("2026-11-05", -15000, "food")], cats);
  assert.equal(over.rows[0].rolloverCents, -5000);
}

/* ---- forecast ---- */
{
  const budgets = [
    { month: "2026-11", categoryId: "pay", amountCents: 410000 },
    { month: "2026-11", categoryId: "rent", amountCents: 110000 },
    { month: "2026-12", categoryId: "pay", amountCents: 410000 },
    { month: "2026-12", categoryId: "rent", amountCents: 110000 },
    { month: "2026-12", categoryId: "oneoff", amountCents: 333333 }
  ];
  const f = forecast({
    cashCents: 512345, month: "2026-11", count: 4, budgets, categories: cats, oneOffCategoryIds: ["oneoff"],
    transactions: [tx("2026-11-01", 205000, "pay"), tx("2026-11-01", -110000, "rent")]
  });
  assert.equal(f[0].netCents, 205000, "November: half the pay still to come, rent already paid");
  assert.equal(f[1].netCents, 410000 - 110000 - 333333, "December includes its one-off");
  assert.equal(f[2].netCents, 410000 - 110000, "January repeats December without the one-off");
  assert.equal(f[3].balanceCents, 512345 + 205000 + (410000 - 110000 - 333333) + 2 * (410000 - 110000));
  const extras = forecast({ cashCents: 0, month: "2027-07", count: 1, budgets: [], categories: cats, extras: [{ month: "2027-07", cents: -900000 }] });
  assert.equal(extras[0].balanceCents, -900000);
}

/* ---- net worth ---- */
{
  const accounts = { chk: { type: "depository" }, card: { type: "credit" }, house: { type: "property", includeInNetWorth: false } };
  const series = netWorthSeries(accounts, [
    { accountId: "chk", date: "2026-11-01", balanceCents: 100000 },
    { accountId: "card", date: "2026-11-01", balanceCents: 30000 },
    { accountId: "chk", date: "2026-11-05", balanceCents: 150000 },
    { accountId: "house", date: "2026-11-05", balanceCents: 99999999 }
  ]);
  assert.deepEqual(series.map((p) => p.netWorthCents), [70000, 120000], "card carried forward; excluded house ignored");
}

/* ---- rules ---- */
{
  assert.equal(merchantKey("SQ *BLUE BOTTLE #123 SF"), "sq blue bottle sf");
  const r = { id: "r1", matchText: "Blue Bottle", setCategoryId: "food", minCents: 100, maxCents: 5000 };
  assert.ok(ruleMatches(r, { merchant: "SQ *BLUE BOTTLE #9", amountCents: -450 }));
  assert.ok(!ruleMatches(r, { merchant: "SQ *BLUE BOTTLE #9", amountCents: -9000 }), "above max");
  assert.ok(!ruleMatches(r, { merchant: "Starbucks", amountCents: -450 }));
  assert.ok(!ruleMatches({ id: "x", setHidden: true }, { merchant: "Anything", amountCents: -1 }), "a rule matching nothing never matches everything");
  const hit = applyRules([{ id: "a", matchText: "venmo", addTag: "friends" }, r], { merchant: "Blue Bottle", amountCents: -500 });
  assert.equal(hit.ruleId, "r1");
  assert.equal(hit.change.categoryId, "food");
  assert.equal(applyRules([{ id: "acct", matchAccountId: "chk", setHidden: true }], { merchant: "x", accountId: "chk", amountCents: -1 }).change.hidden, true);
}

/* ---- recurring ---- */
{
  const netflix = ["2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15"].map((d) => tx(d, -1549, "fun", { merchant: "NETFLIX.COM 866" }));
  const pay = ["2026-10-02", "2026-10-16", "2026-10-30", "2026-11-13"].map((d) => tx(d, 205000, "pay", { merchant: "PAYROLL ACME" }));
  const random = [tx("2026-09-01", -500, "food", { merchant: "Corner Cafe" }), tx("2026-09-04", -4500, "food", { merchant: "Corner Cafe" }), tx("2026-10-20", -800, "food", { merchant: "Corner Cafe" })];
  const two = [tx("2026-10-01", -2000, "fun", { merchant: "Gym Pass" }), tx("2026-11-01", -2000, "fun", { merchant: "Gym Pass" })];
  const found = detectRecurring(netflix.concat(pay, random, two), "2026-11-20");
  const byM = Object.fromEntries(found.map((f) => [f.merchant, f]));
  assert.equal(byM["NETFLIX.COM 866"].cadence, "monthly");
  assert.equal(byM["NETFLIX.COM 866"].amountCents, -1549);
  assert.ok(byM["NETFLIX.COM 866"].nextDate >= "2026-12-14" && byM["NETFLIX.COM 866"].nextDate <= "2026-12-16");
  assert.equal(byM["PAYROLL ACME"].cadence, "biweekly");
  assert.ok(!byM["Corner Cafe"], "irregular spending is not recurring");
  assert.ok(!byM["Gym Pass"], "two charges are not enough");
  const up = upcoming([{ id: "n", name: "Netflix", nextDate: "2026-11-15", cadence: "monthly", amountCents: -1549 }], "2026-11-20", "2027-01-31");
  assert.equal(up.length, 2, "Dec + Jan occurrences in the window");
  assert.ok(up[0].date >= "2026-12-14");
}

/* ---- goals ---- */
{
  const g = goalProgress({ targetCents: 900000, targetDate: "2027-05-15", accountId: "sav" }, 300000, "2026-11");
  assert.equal(g.leftCents, 600000);
  assert.equal(g.monthsLeft, 7);
  assert.equal(g.perMonthCents, Math.ceil(600000 / 7));
  assert.equal(goalProgress({ targetCents: 1000, savedCents: 1500 }, null, "2026-11").done, true);
}

console.log("v2-core.test.mjs: all assertions passed");
