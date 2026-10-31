/*
 * Expense <-> bank transaction links: manual links, exact-match auto
 * links (in either arrival order), and the rule that a linked bank
 * transaction is never imported as a second expense.
 * Run: node tests/banklink.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, setupTestAuth, authedCtx } from "./_fake-d1.mjs";
import { onRequestPost, onRequestPut } from "../functions/api/expenses.js";
import { upsertBankData } from "../functions/api/budget.js";

const env = { DB: new FakeD1() };
const ctx = authedCtx(env, await setupTestAuth(env));
const url = "http://local/api/expenses";
const post = async (b) => { const r = await onRequestPost(ctx(b, "POST", url)); return { status: r.status, body: await r.json() }; };
const put = async (b) => { const r = await onRequestPut(ctx(b, "PUT", url)); return { status: r.status, body: await r.json() }; };
const count = () => env.DB.db.prepare("SELECT COUNT(*) AS n FROM daily_expenses").get().n;

await upsertBankData(env.DB, { transactions: [
  { id: "T-rent", accountId: "chase", date: "2026-11-02", name: "Zelle payment to Alex", amount: 400 },
  { id: "T-sam", accountId: "chase", date: "2026-11-26", name: "Zelle payment to Sam", amount: 50 }
] });

// 1. A hand-entered rent links to the bank payment the user picks.
const rent = (await post({ date: "2026-11-01", description: "Rent — November", amount: 400, category: "Rent" })).body.expense;
assert.equal(rent.bankTxId, null, "different name: no auto link");
let res = await put({ id: rent.id, patch: { bankTxId: "T-rent" } });
assert.equal(res.status, 200);
assert.equal(res.body.expense.bankTxId, "T-rent");

// 2. The sync importing that same payment is a no-op, by exact match or by id.
const before = count();
res = await post({ date: "2026-11-02", description: "Zelle payment to Alex", amount: 400 });
assert.equal(res.status, 200);
assert.equal(res.body.duplicate, true);
assert.equal(res.body.expense.id, rent.id);
res = await post({ date: "2026-11-02", description: "anything", amount: 400, bankTxId: "T-rent" });
assert.equal(res.body.duplicate, true);
assert.equal(count(), before, "no second rent expense");
const nov = res.body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.rent, 400, "rent counted once");

// 3. An import that exactly matches an unlinked bank row links itself.
res = await post({ date: "2026-11-26", description: "Zelle payment to Sam", amount: 50 });
assert.equal(res.status, 201);
assert.equal(res.body.expense.bankTxId, "T-sam");

// 4. Expense first, bank row later: the bank push links it.
const ins = (await post({ date: "2026-11-03", description: "Acme Insurance", amount: 120 })).body.expense;
assert.equal(ins.bankTxId, null);
await upsertBankData(env.DB, { transactions: [
  { id: "T-ins", accountId: "cap1", date: "2026-11-03", name: "Acme Insurance", amount: 120 }
] });
assert.equal(env.DB.db.prepare("SELECT bank_tx_id FROM daily_expenses WHERE id = ?").get(ins.id).bank_tx_id, "T-ins");

// 5. Linking a bank row that another expense holds is a 409 naming it.
res = await put({ id: ins.id, patch: { bankTxId: "T-rent" } });
assert.equal(res.status, 409);
assert.equal(res.body.conflict.id, rent.id);

// 6. Unlinking frees it.
res = await put({ id: rent.id, patch: { bankTxId: null } });
assert.equal(res.body.expense.bankTxId, null);
res = await put({ id: ins.id, patch: { bankTxId: "T-rent" } });
assert.equal(res.status, 200);

console.log("banklink.test.mjs: all assertions passed");
