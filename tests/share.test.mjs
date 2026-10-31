/*
 * "My share" (shared expenses) tests: API accept/validate/store/return,
 * the share-based monthly rollup, the my_share migration on an old-schema
 * database, and the regression test for expenses dated OUTSIDE the 12
 * planner months (a pre-plan date used to save but return HTTP 400).
 * Run: node tests/share.test.mjs — dummy amounts only.
 */
import assert from "node:assert/strict";
import {
  onRequestGet as expenseGet, onRequestPost as expensePost,
  onRequestPut as expensePut, onRequestDelete as expenseDelete
} from "../functions/api/expenses.js";
import { onRequestGet as budgetGet, MONTH_KEYS } from "../functions/api/budget.js";
import { FakeD1, makeCtx, setupTestAuth, authedCtx } from "./_fake-d1.mjs";

const EXP = "http://local/api/expenses";
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctxA = authedCtx(env, token);
const post = (b) => expensePost(ctxA( b, "POST", EXP));
const put = (b) => expensePut(ctxA( b, "PUT", EXP));
const list = async (q) => (await (await expenseGet(ctxA( undefined, "GET", EXP + (q || "")))).json()).expenses;
const novActual = (state) => state.actuals.find((a) => a.monthKey === "2026-11");

/* 1. No share -> myShare null, rollup counts the full amount. */
let res = await post({ date: "2026-11-03", description: "Walmart weekly shop", amount: 50 });
assert.equal(res.status, 201);
let body = await res.json();
assert.equal(body.expense.myShare, null, "absent myShare stores null");
const fullId = body.expense.id;
assert.equal(novActual(body.state).groceries, 50);

/* 2. With a share -> returned + stored, and the rollup sums the SHARE:
      50 (full) + 30 (share of 80) = 80 in Groceries. */
res = await post({ date: "2026-11-04", description: "Walmart weekly shop", amount: 80, myShare: 30 });
assert.equal(res.status, 201);
body = await res.json();
assert.equal(body.expense.myShare, 30);
assert.equal(body.expense.amount, 80, "the full amount is never rewritten");
const sharedId = body.expense.id;
assert.equal(novActual(body.state).groceries, 80, "rollup: 50 full + share 30 = 80");

/* 3. The share round-trips through the list endpoint and /api/budget. */
let expenses = await list("?month=2026-11");
assert.equal(expenses.find((e) => e.id === sharedId).myShare, 30);
let state = await (await budgetGet(ctxA( undefined, "GET"))).json();
assert.equal(state.dailyExpenses.find((e) => e.id === sharedId).myShare, 30,
  "budget state's dailyExpenses carry myShare");

/* 4. A zero share is valid and contributes 0 to the rollup. */
res = await post({ date: "2026-11-05", description: "Gift for a friend", amount: 25, category: "One-off", myShare: 0 });
assert.equal(res.status, 201);
body = await res.json();
assert.equal(body.expense.myShare, 0);
assert.equal(novActual(body.state).oneOffs, 0, "share 0 rolls up as 0");
assert.equal(novActual(body.state).entered, true);

/* 5. Shares are stored rounded to cents. */
res = await post({ date: "2026-11-06", description: "Coffee run", amount: 40, category: "Eating Out", myShare: 33.333 });
assert.equal(res.status, 201);
assert.equal((await res.json()).expense.myShare, 33.33);

/* 6. Validation: negative, over-amount and non-numeric shares are 400s
      and write nothing. */
const countBefore = (await list()).length;
for (const bad of [
  { date: "2026-11-07", description: "x", amount: 50, myShare: -1 },
  { date: "2026-11-07", description: "x", amount: 50, myShare: 50.01 },
  { date: "2026-11-07", description: "x", amount: 50, myShare: "abc" },
  { date: "2026-11-07", description: "x", amount: 50, myShare: {} }
]) {
  res = await post(bad);
  assert.equal(res.status, 400, "rejected: " + JSON.stringify(bad.myShare));
  assert.ok((await res.json()).error);
}
assert.equal((await list()).length, countBefore, "rejected shares added nothing");

/* 7. PUT: set a share, change it, clear it with null; rollup follows. */
res = await put({ id: fullId, patch: { myShare: 20 } });
assert.equal(res.status, 200);
body = await res.json();
assert.equal(body.expense.myShare, 20);
assert.equal(novActual(body.state).groceries, 50, "rollup: share 20 + share 30 = 50");
res = await put({ id: fullId, patch: { myShare: null } });
body = await res.json();
assert.equal(body.expense.myShare, null, "null clears the share");
assert.equal(novActual(body.state).groceries, 80, "cleared share -> full amount counts again");

/* 8. PUT validation: a share above the (final) amount is a 400. */
res = await put({ id: sharedId, patch: { myShare: 81 } });
assert.equal(res.status, 400);
res = await put({ id: sharedId, patch: { amount: 60, myShare: 61 } });
assert.equal(res.status, 400, "share is validated against the patched amount");
res = await put({ id: sharedId, patch: { amount: 60, myShare: 45 } });
assert.equal(res.status, 200);
body = await res.json();
assert.equal(body.expense.amount, 60);
assert.equal(body.expense.myShare, 45);

/* 9. PUT amount-only edit below the stored share clamps the share. */
res = await put({ id: sharedId, patch: { amount: 20 } });
assert.equal(res.status, 200);
body = await res.json();
assert.equal(body.expense.myShare, 20, "share clamped to the new amount");

/* 10. Regression: an expense dated OUTSIDE the planner months (September 2026, before the first month)
       now POSTs with 200 (it used to save but return 400), is listed,
       and creates/corrupts no actuals row. PUT and DELETE work too. */
const envOct = { DB: new FakeD1() };
const tokenOct = await setupTestAuth(envOct);
const ctxOct = authedCtx(envOct, tokenOct);
const postO = (b) => expensePost(ctxOct( b, "POST", EXP));
res = await postO({ date: "2026-09-15", description: "September shop", amount: 42.5, myShare: 21.25 });
assert.equal(res.status, 201, "September expense POST succeeds (regression)");
body = await res.json();
assert.equal(body.expense.myShare, 21.25);
assert.equal(body.state.actuals.length, MONTH_KEYS.length, "state still has exactly one actual per planner month");
assert.ok(body.state.actuals.every((a) => a.monthKey !== "2026-09"), "no September actuals row appeared");
assert.ok(body.state.actuals.every((a) => a.entered === false), "no actuals were marked entered");
const octId = body.expense.id;
res = await expenseGet(ctxOct( undefined, "GET", EXP + "?month=2026-09"));
assert.equal((await res.json()).expenses.length, 1, "September expense is listed");
res = await expensePut(ctxOct( { id: octId, patch: { amount: 44 } }, "PUT", EXP));
assert.equal(res.status, 200, "September expense PUT succeeds");
res = await expenseDelete(ctxOct( undefined, "DELETE", EXP + "?id=" + octId));
assert.equal(res.status, 200, "September expense DELETE succeeds");
res = await expenseGet(ctxOct( undefined, "GET", EXP + "?month=2026-09"));
assert.equal((await res.json()).expenses.length, 0);

/* 11. Migration: a database created with the pre-share schema (no
       card_name, no my_share) gains my_share; legacy rows keep
       myShare null and new shared writes + rollup work. */
const old = new FakeD1();
old.db.exec(`CREATE TABLE daily_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Misc/Other',
  categorization_source TEXT NOT NULL DEFAULT 'rules',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
old.db.prepare("INSERT INTO daily_expenses (date, description, amount, category, categorization_source) VALUES (?, ?, ?, ?, ?)")
  .run("2026-11-05", "Legacy shop", 33.25, "Groceries", "rules");
const oldEnv = { DB: old };
const oldToken = await setupTestAuth(oldEnv);
const ctxOld = authedCtx(oldEnv, oldToken);
state = await (await budgetGet(ctxOld( undefined, "GET"))).json();
const colNames = old.db.prepare("PRAGMA table_info(daily_expenses)").all().map((r) => r.name);
assert.ok(colNames.includes("my_share"), "my_share column was added by the migration");
assert.ok(colNames.includes("card_name"), "card_name migration still applies");
assert.equal(state.dailyExpenses.length, 1);
assert.equal(state.dailyExpenses[0].myShare, null, "legacy rows read as no-share (full amount his)");
res = await expensePost(ctxOld(
  { date: "2026-11-06", description: "Shared shop", amount: 25, category: "Groceries", myShare: 12.5 }, "POST", EXP));
assert.equal(res.status, 201, "shared writes work on the migrated database");
body = await res.json();
assert.equal(body.expense.myShare, 12.5);
assert.equal(novActual(body.state).groceries, 45.75,
  "rollup on migrated DB: legacy 33.25 full + share 12.5 = 45.75");

console.log("share.test.mjs: all assertions passed");
