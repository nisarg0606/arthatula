/*
 * Credit cards (statement cycles) tests: CRUD + validation, the
 * card_name migration on a pre-existing (old-schema) database, the
 * expense `card` round-trip with an unchanged rollup, and cards in the
 * whole-state import/export path. Run: node tests/cards.test.mjs
 * Dummy names/amounts only.
 */
import assert from "node:assert/strict";
import {
  onRequestGet as cardsGet, onRequestPost as cardsPost,
  onRequestPut as cardsPut, onRequestDelete as cardsDelete
} from "../functions/api/cards.js";
import { onRequestGet as budgetGet, onRequestPut as budgetPut, MONTH_KEYS } from "../functions/api/budget.js";
import {
  onRequestPost as expensePost, onRequestPut as expensePut, onRequestGet as expenseGet
} from "../functions/api/expenses.js";
import { FakeD1, makeCtx, setupTestAuth, authedCtx } from "./_fake-d1.mjs";

const CARDS = "http://local/api/cards";
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctxA = authedCtx(env, token);
const get = () => cardsGet(ctxA( undefined, "GET", CARDS));
const post = (b) => cardsPost(ctxA( b, "POST", CARDS));
const put = (b) => cardsPut(ctxA( b, "PUT", CARDS));
const del = (q) => cardsDelete(ctxA( undefined, "DELETE", CARDS + q));

/* 1. Fresh list is empty. */
let res = await get();
assert.equal(res.status, 200);
assert.deepEqual((await res.json()).cards, []);

/* 2. Create a valid card (with due date). */
res = await post({ name: "Test Visa", statementStart: "2026-11-03", statementEnd: "2026-12-02", dueDate: "2026-12-27" });
assert.equal(res.status, 201);
let body = await res.json();
assert.equal(body.cards.length, 1);
assert.equal(body.card.name, "Test Visa");
assert.equal(body.card.statementStart, "2026-11-03");
assert.equal(body.card.statementEnd, "2026-12-02");
assert.equal(body.card.dueDate, "2026-12-27");
const visaId = body.card.id;
assert.ok(Number.isInteger(visaId));

/* 3. Create without a due date -> null. */
res = await post({ name: "Store Card", statementStart: "2026-11-01", statementEnd: "2026-11-30" });
assert.equal(res.status, 201);
body = await res.json();
assert.equal(body.cards.length, 2);
assert.equal(body.cards.find((c) => c.name === "Store Card").dueDate, null);

/* 4. Validation errors are 400s and change nothing. */
for (const bad of [
  { name: "", statementStart: "2026-11-01", statementEnd: "2026-11-30" },          // empty name
  { name: "X" },                                                                    // missing dates
  { name: "X", statementStart: "11/01/2026", statementEnd: "2026-11-30" },          // bad format
  { name: "X", statementStart: "2026-13-01", statementEnd: "2026-13-30" },          // impossible dates
  { name: "X", statementStart: "2026-11-30", statementEnd: "2026-11-01" },          // end before start
  { name: "X", statementStart: "2026-11-01", statementEnd: "2026-11-30", dueDate: "soon" } // bad due date
]) {
  res = await post(bad);
  assert.equal(res.status, 400, "rejected: " + JSON.stringify(bad));
  assert.ok((await res.json()).error);
}
assert.equal((await (await get()).json()).cards.length, 2, "failed creates added nothing");

/* 5. PUT patches a card; unknown id -> 404; bad patch -> 400. */
res = await put({ id: visaId, patch: { statementEnd: "2026-12-05", dueDate: null } });
assert.equal(res.status, 200);
body = await res.json();
const visa = body.cards.find((c) => c.id === visaId);
assert.equal(visa.statementEnd, "2026-12-05");
assert.equal(visa.dueDate, null, "dueDate can be cleared");
assert.equal(visa.statementStart, "2026-11-03", "unpatched fields untouched");
res = await put({ id: 99999, patch: { name: "Ghost" } });
assert.equal(res.status, 404);
res = await put({ id: visaId, patch: { statementEnd: "2026-01-01" } });
assert.equal(res.status, 400, "merged end before start is rejected");

/* 6. DELETE removes; deleting again -> 404; missing id -> 400. */
const storeId = body.cards.find((c) => c.name === "Store Card").id;
res = await del("?id=" + storeId);
assert.equal(res.status, 200);
assert.deepEqual((await res.json()).cards.map((c) => c.name), ["Test Visa"]);
res = await del("?id=" + storeId);
assert.equal(res.status, 404);
res = await del("");
assert.equal(res.status, 400);

/* 7. GET /api/budget carries the cards in the same state load. */
res = await budgetGet(ctxA( undefined, "GET"));
let state = await res.json();
assert.equal(state.cards.length, 1);
assert.equal(state.cards[0].name, "Test Visa");

/* 8. Expense `card` round-trips and the rollup ignores it (amounts only). */
const EXP = "http://local/api/expenses";
res = await expensePost(ctxA(
  { date: "2026-11-10", description: "Walmart weekly shop", amount: 50, card: "Test Visa" }, "POST", EXP));
assert.equal(res.status, 201);
body = await res.json();
assert.equal(body.expense.card, "Test Visa");
const expId = body.expense.id;
assert.equal(body.state.actuals.find((a) => a.monthKey === "2026-11").groceries, 50);
res = await expensePost(ctxA(
  { date: "2026-11-11", description: "Walmart weekly shop", amount: 30 }, "POST", EXP));
body = await res.json();
assert.equal(body.expense.card, null, "no card -> null");
assert.equal(body.state.actuals.find((a) => a.monthKey === "2026-11").groceries, 80,
  "rollup sums carded + uncarded expenses identically");
res = await expenseGet(ctxA( undefined, "GET", EXP));
assert.equal((await res.json()).expenses.find((e) => e.id === expId).card, "Test Visa",
  "list returns the card field");
res = await expensePut(ctxA( { id: expId, patch: { card: "Store Card" } }, "PUT", EXP));
assert.equal((await res.json()).expense.card, "Store Card");
res = await expensePut(ctxA( { id: expId, patch: { card: "" } }, "PUT", EXP));
assert.equal((await res.json()).expense.card, null, "empty string clears the card");
state = await (await budgetGet(ctxA( undefined, "GET"))).json();
assert.equal(state.dailyExpenses.find((e) => e.id === expId).card, null,
  "budget state's dailyExpenses carry the card field too");

/* 9. Whole-state PUT (import) carries cards; invalid entries are skipped;
      a PUT WITHOUT cards (an old-format export) leaves cards intact. */
const importBody = {
  startingBalance: 0,
  months: MONTH_KEYS.map((monthKey) => ({ monthKey })),
  cards: [
    { name: "Imported Card", statementStart: "2026-11-01", statementEnd: "2026-11-30", dueDate: "2026-12-21" },
    { name: "Broken Card", statementStart: "not-a-date", statementEnd: "2026-11-30" }
  ]
};
res = await budgetPut(ctxA( importBody, "PUT"));
state = await res.json();
assert.deepEqual(state.cards.map((c) => c.name), ["Imported Card"],
  "import replaces cards and skips the invalid entry");
res = await budgetPut(ctxA(
  { startingBalance: 0, months: MONTH_KEYS.map((monthKey) => ({ monthKey })) }, "PUT"));
state = await res.json();
assert.deepEqual(state.cards.map((c) => c.name), ["Imported Card"],
  "old-format import (no cards field) does not wipe existing cards");

/* 10. Migration: a database created with the OLD schema (no credit_cards
       table, no daily_expenses.card_name) gains both, rows preserved. */
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
res = await budgetGet(ctxOld( undefined, "GET"));
state = await res.json();
assert.deepEqual(state.cards, [], "cards table created empty on the old database");
assert.equal(state.dailyExpenses.length, 1);
assert.equal(state.dailyExpenses[0].description, "Legacy shop");
assert.equal(state.dailyExpenses[0].amount, 33.25, "existing expense row preserved");
assert.equal(state.dailyExpenses[0].card, null, "legacy rows read as no-card");
const colNames = old.db.prepare("PRAGMA table_info(daily_expenses)").all().map((r) => r.name);
assert.ok(colNames.includes("card_name"), "card_name column was added by the migration");
res = await expensePost(ctxOld(
  { date: "2026-11-06", description: "New shop", amount: 10, card: "Any Card" }, "POST", EXP));
assert.equal(res.status, 201, "writes with a card work on the migrated database");
assert.equal((await res.json()).expense.card, "Any Card");

console.log("cards.test.mjs: all assertions passed");
