/*
 * Daily review list: own-account transfer pairing, which bank rows need
 * a decision, the Owed to me total, and PATCH /api/bank (repayment /
 * income / ignore, income counted in the month's actuals only while the
 * mark stands). Run: node tests/review.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { onRequestPatch as bankPatch } from "../functions/api/bank.js";
import { upsertBankData, readState } from "../functions/api/budget.js";

import * as app from "../js/core/index.js";

const txs = [
  // Own transfer: out of A, into B two days later -> paired, never reviewed.
  { id: "out-1", accountId: "A", date: "2026-11-02", name: "Transfer to savings", amount: 300, pfc: "TRANSFER_OUT" },
  { id: "in-1", accountId: "B", date: "2026-11-04", name: "Transfer from checking", amount: -300, pfc: "TRANSFER_IN" },
  // Same amount but same account: not a transfer between accounts.
  { id: "in-2", accountId: "A", date: "2026-11-02", name: "Zelle payment from Alex", amount: -300, pfc: "TRANSFER_IN" },
  // Person-to-person both ways.
  { id: "out-2", accountId: "A", date: "2026-11-05", name: "Zelle payment to Sam", amount: 60, pfc: "TRANSFER_OUT" },
  // Not between people: card bill, payroll, a merchant bill.
  { id: "bill", accountId: "A", date: "2026-11-06", name: "CARD AUTOPAY", amount: 500, pfc: "LOAN_PAYMENTS" },
  { id: "pay", accountId: "B", date: "2026-11-07", name: "PAYROLL ACME", amount: -2000, pfc: "INCOME" },
  { id: "util", accountId: "A", date: "2026-11-08", name: "CITY POWER", amount: 45, pfc: "UTILITIES" },
  // Before the baseline: already inside the starting balance.
  { id: "old", accountId: "A", date: "2026-10-20", name: "Zelle payment from Alex", amount: -20, pfc: "TRANSFER_IN" }
];

// 1. Transfers pair across accounts within 3 days, same amount.
const internal = app.internalTransferIds(txs);
assert.deepEqual(Object.keys(internal).sort(), ["in-1", "out-1"]);
assert.equal(app.internalTransferIds([
  { id: "o", accountId: "A", date: "2026-11-01", amount: 50 },
  { id: "i", accountId: "B", date: "2026-11-06", amount: -50 }
]).o, undefined, "5 days apart is not a transfer");

// 2. Only person-to-person rows on/after the baseline need review.
const state = app.blankState(); // baseline 2026-10-26
let bank = { transactions: txs, reviews: {} };
assert.deepEqual(app.reviewQueue(state, bank).map((t) => t.id), ["in-2", "out-2"]);
state.dailyExpenses.push({ id: 9, date: "2026-11-05", description: "Lunch", amount: 60, category: "Eating Out", bankTxId: "out-2" });
assert.deepEqual(app.reviewQueue(state, bank).map((t) => t.id), ["in-2"], "linked rows are done");
bank = { transactions: txs, reviews: { "in-2": "repayment" } };
assert.deepEqual(app.reviewQueue(state, bank), [], "reviewed rows are done");

// 3. Owed to me: the non-share part of shared expenses minus repayments.
state.dailyExpenses.push(
  { id: 10, date: "2026-11-01", description: "Groceries", amount: 120, category: "Groceries", myShare: 40 },
  { id: 11, date: "2026-11-03", description: "Utilities", amount: 90, category: "Utilities", myShare: 30 },
  { id: 12, date: "2026-10-01", description: "Before baseline", amount: 100, category: "Groceries", myShare: 50 }
);
assert.equal(app.owedToMe(state, { transactions: txs, reviews: {} }), 140, "80 + 60 owed");
assert.equal(app.owedToMe(state, bank), -160, "a 300 repayment marked against 140 owed");
assert.equal(app.owedToMe(state, { transactions: [txs[7]], reviews: { old: "repayment" } }), 120);

// 4. PATCH /api/bank: device-only, income counted while marked.
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
await upsertBankData(env.DB, { transactions: [
  { id: "gift", accountId: "B", date: "2026-11-09", name: "Zelle payment from Alex", amount: -75 }
] });
const patch = (body) => bankPatch(makeCtx(env, body, "PATCH", "http://local/api/bank", authHeaders(token)));
const otherIncome = async () => (await readState(env.DB)).actuals.find((a) => a.monthKey === "2026-11").otherIncome;
let res = await patch({ txId: "gift", kind: "income" });
assert.equal(res.status, 200);
assert.equal((await res.json()).reviews.gift, "income");
assert.equal(await otherIncome(), 75, "marking income adds it");
res = await patch({ txId: "gift", kind: "income" });
assert.equal(await otherIncome(), 75, "marking it again does not double it");
res = await patch({ txId: "gift", kind: "repayment" });
assert.equal(await otherIncome(), 0, "moving it off income takes it back");
res = await patch({ txId: "gift", kind: null });
assert.deepEqual((await res.json()).reviews, {});
assert.equal((await patch({ txId: "gift", kind: "salary" })).status, 400);
assert.equal((await patch({ txId: "nope", kind: "ignore" })).status, 400);
assert.equal((await bankPatch(makeCtx(env, { txId: "gift", kind: "ignore" }, "PATCH", "http://local/api/bank"))).status, 401);

// 5. "Always ignore payments like this": same account, same direction,
// same name once digits and punctuation are stripped.
assert.equal(app.paymentKey("Online Transfer / Payment: Debit #4471"), "online transfer payment debit");
const monthly = [
  { id: "m1", accountId: "A", date: "2026-11-07", name: "Online Transfer / Payment: Debit 1001", amount: 120, pfc: "TRANSFER_OUT" },
  { id: "m2", accountId: "B", date: "2026-11-07", name: "Online Transfer / Payment: Debit 1002", amount: 75, pfc: "TRANSFER_OUT" },
  { id: "m3", accountId: "A", date: "2026-11-08", name: "Online Transfer / Payment: Credit", amount: -40, pfc: "TRANSFER_IN" }
];
const rule = app.ignoreRuleFor(monthly[0]);
assert.deepEqual(rule, { accountId: "A", direction: "out", name: "online transfer payment debit" });
assert.deepEqual(app.reviewQueue(app.blankState(), { transactions: monthly, reviews: {}, ignoreRules: [rule] }).map((t) => t.id),
  ["m2", "m3"], "other accounts and money in still ask");
assert.equal(app.ignoredByRule({ accountId: "A", amount: 999, name: "Online Transfer / Payment: Debit 2002" }, [rule]), true,
  "next month's payment with a new reference number is ignored too");

res = await patch({ ignoreRules: [rule, { accountId: "A", direction: "sideways", name: "x" }, { name: "" }] });
assert.equal(res.status, 200);
assert.deepEqual((await res.json()).ignoreRules, [rule], "invalid rules are dropped");
res = await patch({ ignoreRules: [] });
assert.deepEqual((await res.json()).ignoreRules, []);

console.log("review.test.mjs: all assertions passed");
