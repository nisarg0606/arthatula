/*
 * Merchant category rules, category pacing and the 4-week owed flag.
 * Run: node tests/merchant.test.mjs — dummy amounts only.
 */
import assert from "node:assert/strict";
import * as core from "../js/core/index.js";
import { onRequestPost } from "../functions/api/expenses.js";
import { onRequestPatch } from "../functions/api/budget.js";
import { FakeD1, setupTestAuth, authedCtx } from "./_fake-d1.mjs";

// Matching: whole words, longest rule wins.
assert.equal(core.merchantKey("FOX RENT A CAR #123 PHOENIX"), "fox rent a car phoenix");
const rules = [{ match: "amazon", category: "Shopping/Personal" }, { match: "amazon prime", category: "Subscriptions" }];
assert.equal(core.merchantCategory(rules, "AMAZON PRIME*1X2"), "Subscriptions");
assert.equal(core.merchantCategory(rules, "Amazon.com order"), "Shopping/Personal");
assert.equal(core.merchantCategory(rules, "Amazonia Cafe"), null);
assert.deepEqual(core.sanitizeMerchantRules([{ match: "  Fox Rent!! ", category: "Fuel/Transport" },
  { match: "fox rent", category: "Groceries" }, { match: "x", category: "Nope" }]),
  [{ match: "fox rent", category: "Fuel/Transport" }]);

// Server: saving a rule re-files existing expenses; new ones follow it.
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctx = authedCtx(env, token);
const add = async (b) => (await (await onRequestPost(ctx(b, "POST", "http://local/api/expenses"))).json());
await add({ date: "2026-11-03", description: "ACME RENTALS 42", amount: 50, category: "Rent" });
await add({ date: "2026-11-04", description: "Walmart", amount: 20 });
let state = await (await onRequestPatch(ctx({ merchantRules: [{ match: "acme rentals", category: "Fuel/Transport" }] },
  "PATCH", "http://local/api/budget"))).json();
assert.deepEqual(state.merchantRules, [{ match: "acme rentals", category: "Fuel/Transport" }]);
const filed = state.dailyExpenses.find((e) => e.description === "ACME RENTALS 42");
assert.equal(filed.category, "Fuel/Transport");
assert.equal(filed.categorizationSource, "merchant");
const nov = state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.rent, 0);
assert.equal(nov.gasTransport, 50);
assert.equal(state.dailyExpenses.find((e) => e.description === "Walmart").category, "Groceries");
const next = await add({ date: "2026-11-05", description: "Acme Rentals airport", amount: 30 });
assert.equal(next.expense.category, "Fuel/Transport");
assert.equal(next.expense.categorizationSource, "merchant");

// Pacing: day 10 of 30 in November.
const s = core.blankState();
s.months[1].groceries = 300; s.months[1].eatingOut = 100; s.months[1].rent = 500;
s.dailyExpenses = [{ date: "2026-11-03", amount: 90, category: "Groceries" },
  { date: "2026-11-05", amount: 80, category: "Eating Out" }, { date: "2026-11-01", amount: 500, category: "Rent" }];
const pace = core.categoryPacing(s, "2026-11", "2026-11-10");
assert.equal(pace.daysLeft, 21);
assert.deepEqual(pace.rows.map((r) => [r.key, r.status]), [["groceries", "ok"], ["eatingOut", "ahead"]]);
assert.equal(pace.rows[0].perDay, 10);
assert.deepEqual(pace.rows[1].items.map((e) => e.amount), [80]);
assert.equal(core.categoryPacing(s, "2026-12", "2026-11-10"), null);
assert.equal(core.categoryPacing(s, "2026-11", "2026-12-02").daysLeft, 1);

// Owed: repayments clear the oldest shares first; only 4+ weeks old counts.
const o = core.blankState(); o.baselineDate = "2026-09-01";
o.dailyExpenses = [{ date: "2026-09-10", amount: 100, myShare: 50 }, { date: "2026-09-20", amount: 60, myShare: 30 },
  { date: "2026-10-25", amount: 40, myShare: 20 }];
const bank = { transactions: [{ id: "r", amount: -40 }], reviews: { r: "repayment" } };
assert.equal(core.owedToMe(o, bank), 60);
assert.equal(core.owedOverdue(o, bank, "2026-10-28"), 40);
assert.equal(core.owedOverdue(o, bank, "2026-10-07"), 0);

console.log("merchant.test.mjs: all assertions passed");
