/*
 * First-run checklist (functions/api/v2/checklist.js): each item ticks
 * from your own data (never the sample data), the card waits for the
 * sample-data welcome card, and dismissing is for good (until undone).
 * Run: node tests/checklist.test.mjs
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import * as checklist from "../functions/api/v2/checklist.js";
import * as demo from "../functions/api/v2/demo.js";
import * as txs from "../functions/api/v2/transactions.js";
import * as budgets from "../functions/api/v2/budgets.js";
import * as budget from "../functions/api/budget.js";
import * as settings from "../functions/api/settings.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const call = async (mod, method, path, body) => {
  const res = await mod["onRequest" + method[0] + method.slice(1).toLowerCase()](makeCtx(env, body, method, "http://local/api/" + path, authHeaders(token)));
  return { status: res.status, data: await res.json() };
};
const get = async () => (await call(checklist, "GET", "v2/checklist")).data;
const none = { balance: false, expense: false, budget: false, ai: false, homescreen: false };

assert.equal((await checklist.onRequestGet(makeCtx(env, undefined, "GET", "http://local/api/v2/checklist"))).status, 401);
assert.deepEqual(await get(), { show: false, dismissed: false, items: none }, "hidden while the welcome card shows");

/* Sample data ticks nothing and keeps the card away. */
await call(demo, "POST", "v2/demo", {});
assert.deepEqual(await get(), { show: false, dismissed: false, items: none });
await call(demo, "DELETE", "v2/demo");
await call(demo, "POST", "v2/demo", { action: "dismiss" });
assert.deepEqual(await get(), { show: true, dismissed: false, items: none }, "shows once you start fresh");

/* Each item ticks itself from what you do. */
assert.equal((await call(budget, "PATCH", "budget", { startingBalance: 1500 })).status, 200);
assert.equal((await get()).items.balance, true, "starting balance");
assert.equal((await call(txs, "POST", "v2/transactions", { date: "2026-10-30", merchant: "Coffee", amountCents: -450 })).status, 201);
assert.equal((await get()).items.expense, true, "first expense");
const cat = env.DB.db.prepare("SELECT id FROM categories WHERE kind = 'expense' LIMIT 1").get().id;
assert.equal((await call(budgets, "PUT", "v2/budgets", { month: "2026-11", categoryId: cat, amountCents: 40000 })).status, 200);
assert.equal((await get()).items.budget, true, "a budget");
assert.equal((await call(settings, "PUT", "settings", { geminiApiKey: "test-key-1234" })).status, 200);
assert.equal((await get()).items.ai, true, "AI key saved");
assert.equal((await call(checklist, "POST", "v2/checklist", { done: "homescreen" })).data.items.homescreen, true);
const all = await get();
assert.deepEqual(all.items, { balance: true, expense: true, budget: true, ai: true, homescreen: true });
assert.equal(all.show, false, "nothing left to do -> no card");

/* Dismissing is stored; it can be undone. */
env.DB.db.prepare("DELETE FROM v2_settings WHERE key = 'checklist:homescreen'").run();
assert.equal((await get()).show, true);
assert.deepEqual((await call(checklist, "POST", "v2/checklist", { dismissed: true })).data.show, false);
assert.equal((await get()).dismissed, true, "dismissed for good");
assert.equal((await call(checklist, "POST", "v2/checklist", { dismissed: false })).data.show, true);
assert.equal((await call(checklist, "POST", "v2/checklist", { done: "budget" })).status, 400, "only homescreen is ticked by hand");

console.log("checklist.test.mjs: all assertions passed");
