/*
 * "Count it now" for pending charges: the expense is created tagged with
 * the pending charge's id; the posted charge from the sync settles that
 * same expense (amount included) instead of adding a second one, by
 * Plaid's pending_transaction_id or, until the sync sends it, by card +
 * merchant name within 5 days. Run: node tests/pending-count.test.mjs —
 * dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { onRequestPost, onRequestPut } from "../functions/api/expenses.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { sha256Hex } from "../functions/api/budget.js";

const URL_ = "http://local/api/expenses";
const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);

async function pairedSyncToken() {
  const raw = "pending-test-sync-token-0123456789abcdef";
  const tokenHash = await sha256Hex(raw);
  const A = "http://local/api/auth";
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", A, authHeaders(device)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash, label: "Plaid sync" }, "POST", A));
  const fingerprint = (await res.json()).fingerprint;
  res = await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", A, authHeaders(device)));
  assert.equal(res.status, 200, "pair-approve");
  return raw;
}
const sync = await pairedSyncToken();
const call = async (fn, token, body, method) => {
  const r = await fn(makeCtx(env, body, method, URL_, authHeaders(token)));
  return { status: r.status, body: await r.json() };
};
const count = () => env.DB.db.prepare("SELECT COUNT(*) AS n FROM daily_expenses").get().n;

// 1. "Count it now" creates the expense, tagged; counting twice is a no-op.
let res = await call(onRequestPost, device, { date: "2026-11-03", description: "Corner Market", amount: 40, category: "Groceries", card: "Visa", pendingTxId: "pend-1" }, "POST");
assert.equal(res.status, 201);
const counted = res.body.expense;
assert.equal(counted.pendingTxId, "pend-1");
assert.equal(counted.pendingSettled, false);
res = await call(onRequestPost, device, { date: "2026-11-03", description: "Corner Market", amount: 40, pendingTxId: "pend-1" }, "POST");
assert.equal(res.body.duplicate, true);
assert.equal(count(), 1);

// 2. The posted charge (with Plaid's pending id) settles the same expense,
//    taking the posted amount: no second expense.
res = await call(onRequestPost, sync, { date: "2026-11-05", description: "CORNER MARKET #12", amount: 46.5, card: "Visa", pendingTransactionId: "pend-1", bankTxId: "post-1" }, "POST");
assert.equal(res.status, 200);
assert.equal(res.body.settled, true);
assert.equal(res.body.expense.id, counted.id);
assert.equal(res.body.expense.amount, 46.5, "amount follows the posted charge");
assert.equal(res.body.expense.date, "2026-11-03", "keeps the purchase date");
assert.equal(res.body.expense.pendingSettled, true);
assert.equal(count(), 1);
const nov = res.body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.groceries, 46.5, "counted once, at the posted amount");
// A re-send of the same posted charge is still a no-op.
res = await call(onRequestPost, sync, { date: "2026-11-05", description: "CORNER MARKET #12", amount: 46.5, card: "Visa", pendingTransactionId: "pend-1", bankTxId: "post-1" }, "POST");
assert.equal(res.body.duplicate, true);
assert.equal(count(), 1);

// 2b. A note added to a counted charge survives the posted charge settling it.
await call(onRequestPut, device, { id: counted.id, patch: { note: "weekly groceries" } }, "PUT");
res = await call(onRequestPost, sync, { date: "2026-11-05", description: "CORNER MARKET #12", amount: 47, card: "Visa", pendingTransactionId: "pend-1" }, "POST");
assert.equal(res.body.expense.note, "weekly groceries");
assert.equal(res.body.expense.amount, 47);

// 3. Without the pending id: same card + same merchant within 5 days settles it.
const c2 = (await call(onRequestPost, device, { date: "2026-11-10", description: "Book Shop", amount: 20, category: "Shopping/Personal", card: "Visa", pendingTxId: "pend-2" }, "POST")).body.expense;
res = await call(onRequestPost, sync, { date: "2026-11-12", description: "Book Shop", amount: 20, card: "Visa" }, "POST");
assert.equal(res.body.settled, true);
assert.equal(res.body.expense.id, c2.id);
assert.equal(count(), 2);

// 4. Fallback needs a match: other card, other merchant or >5 days apart add a new expense.
await call(onRequestPost, device, { date: "2026-11-15", description: "Gas Stop", amount: 30, card: "Visa", pendingTxId: "pend-3" }, "POST");
for (const body of [
  { date: "2026-11-16", description: "Gas Stop", amount: 30, card: "Other" },
  { date: "2026-11-16", description: "Different Shop", amount: 30, card: "Visa" },
  { date: "2026-11-25", description: "Gas Stop", amount: 30, card: "Visa" }
]) {
  res = await call(onRequestPost, sync, body, "POST");
  assert.equal(res.status, 201, "not settled: " + JSON.stringify(body));
}
// 5. The fallback is for sync imports only: an expense typed by hand is never swallowed.
res = await call(onRequestPost, device, { date: "2026-11-15", description: "Gas Stop", amount: 30, card: "Visa" }, "POST");
assert.equal(res.status, 201);

// 6. "Keep" marks a counted charge that never posted as final.
const c4 = (await call(onRequestPost, device, { date: "2026-11-20", description: "Hotel Hold", amount: 100, card: "Visa", pendingTxId: "pend-4" }, "POST")).body.expense;
res = await call(onRequestPut, device, { id: c4.id, patch: { pendingSettled: true } }, "PUT");
assert.equal(res.body.expense.pendingSettled, true);

// 7. App helpers: counted ids, unposted flags, preview totals skip counted ones.
const core = await import("../js/core/index.js");
const exps = [
  { id: 1, date: "2026-11-01", pendingTxId: "p-a", pendingSettled: false, amount: 10 },
  { id: 2, date: "2026-11-01", pendingTxId: "p-b", pendingSettled: true, amount: 10 },
  { id: 3, date: "2026-11-09", pendingTxId: "p-c", pendingSettled: false, amount: 10 },
  { id: 4, date: "2026-11-01", pendingTxId: "p-d", pendingSettled: false, amount: 10 }
];
const pendingNow = [{ id: "p-d", date: "2026-11-01", amount: 10 }, { id: "p-e", date: "2026-11-02", amount: 5 }];
assert.deepEqual(Object.keys(core.countedPending(exps)).sort(), ["p-a", "p-b", "p-c", "p-d"]);
assert.deepEqual(core.unpostedCounted(exps, pendingNow, "2026-11-10").map((e) => e.id), [1],
  "only unsettled, gone from pending, older than 5 days");
assert.deepEqual(core.unpostedCounted(exps, null, "2026-11-10"), [], "no snapshot loaded: no flags");
assert.equal(core.pendingInMonth(pendingNow, "2026-11", core.countedPending(exps)), 5, "counted charge not in the preview");
assert.equal(core.likelyToChange({ category: "Eating Out" }), true);
assert.equal(core.likelyToChange({ category: "Groceries", name: "Corner Market" }), false);

console.log("pending-count.test.mjs: all assertions passed");
