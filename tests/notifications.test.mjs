/*
 * Notifications: what writes a row (pairing request, sync-imported
 * expense, NEW pending charge, failed sync), what doesn't (an expense
 * typed in the app, a pending charge already seen), the read/unread
 * route, and the copy sent to Telegram once a bot is connected.
 * Run: node tests/notifications.test.mjs — dummy data only, Telegram stubbed.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { onRequestGet as notifGet, onRequestPost as notifPost } from "../functions/api/notifications.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { onRequestPost as pendingPost } from "../functions/api/pending.js";
import { createExpense } from "../functions/api/expenses.js";
import { onRequestPost as syncRequestPost } from "../functions/api/sync-requests.js";
import { sha256Hex, claimSyncRequest, completeSyncRequest } from "../functions/api/budget.js";

const URL_N = "http://local/api/notifications", AUTH = "http://local/api/auth";
const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);
const sent = [];
globalThis.fetch = async (url, opts) => {
  const method = String(url).split("/").pop();
  sent.push({ method, body: JSON.parse(opts.body) });
  const result = method === "getMe" ? { username: "test_bot" }
    : method === "getUpdates" ? [{ message: { chat: { id: 42 }, text: "/start" } }] : {};
  return new Response(JSON.stringify({ ok: true, result }));
};
const list = async (after) => (await notifGet(makeCtx(env, undefined, "GET", URL_N + (after ? "?after=" + after : ""), authHeaders(device)))).json();
const post = (body, headers) => notifPost(makeCtx(env, body, "POST", URL_N, headers || authHeaders(device)));

// 1. Empty to start; the sync automation can't read it.
let data = await list();
assert.deepEqual(data.notifications, []);
assert.equal(data.unread, 0);
assert.equal(data.telegram.connected, false);

// 2. A pairing request notifies (with the fingerprint), so the owner sees it without a reload.
const raw = "notif-test-sync-token-0123456789abcdef", tokenHash = await sha256Hex(raw);
let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", AUTH, authHeaders(device)));
const code = (await res.json()).code;
res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash, label: "Plaid sync" }, "POST", AUTH));
assert.equal(res.status, 200);
data = await list();
assert.equal(data.notifications[0].kind, "pairing");
assert.match(data.notifications[0].body, new RegExp(tokenHash.slice(0, 8)));
res = await authPost(makeCtx(env, { action: "pair-approve", fingerprint: tokenHash.slice(0, 8) }, "POST", AUTH, authHeaders(device)));
assert.equal(res.status, 200);
const sync = authHeaders(raw);
assert.equal((await notifGet(makeCtx(env, undefined, "GET", URL_N, sync))).status, 403, "sync sessions can't read notifications");

// 3. Sync imports notify; an expense typed in the app doesn't; a duplicate import doesn't.
const before = (await list()).notifications.length;
await createExpense(env.DB, env, { date: "2026-10-28", description: "Coffee Shop", amount: 4.5, category: "Food" }, false);
assert.equal((await list()).notifications.length, before, "manual expense: no notification");
let r = await createExpense(env.DB, env, { date: "2026-10-28", description: "Grocer", amount: 62.1, card: "Amex", bankTxId: "tx1" }, true);
assert.equal(r.status, 201);
r = await createExpense(env.DB, env, { date: "2026-10-28", description: "Grocer", amount: 62.1, card: "Amex", bankTxId: "tx1" }, true);
assert.equal(r.data.duplicate, true);
data = await list();
assert.equal(data.notifications.length, before + 1);
assert.equal(data.notifications[0].kind, "transaction");
assert.equal(data.notifications[0].title, "$62.10 · Grocer");
assert.match(data.notifications[0].body, /Amex/);

// 4. Pending: only charges not seen before notify; four or more at once become one row.
const pend = (txs) => pendingPost(makeCtx(env, { transactions: txs }, "POST", "http://local/api/pending", sync));
const p = (id, amount) => ({ id, date: "2026-10-29", name: "Shop " + id, amount });
let last = data.notifications[0].id;
assert.equal((await pend([p("a", 10)])).status, 200);
data = await list(last);
assert.equal(data.notifications.length, 1);
assert.equal(data.notifications[0].title, "Pending: $10.00 · Shop a");
last = data.notifications[0].id;
await pend([p("a", 10), p("b", 5)]);
data = await list(last);
assert.deepEqual(data.notifications.map((n) => n.title), ["Pending: $5.00 · Shop b"], "a was already pending");
last = data.notifications[0].id;
await pend([p("c", 1), p("d", 2), p("e", 3), p("f", 4)]);
data = await list(last);
assert.equal(data.notifications.length, 1);
assert.equal(data.notifications[0].title, "4 new pending charges");
last = data.notifications[0].id;

// 5. A failed sync notifies; a finished one doesn't (its expenses already did).
const runSync = async (status, result) => {
  await syncRequestPost(makeCtx(env, {}, "POST", "http://local/api/sync-requests", authHeaders(device)));
  await completeSyncRequest(env.DB, (await claimSyncRequest(env.DB)).id, status, result);
};
await runSync("done", { addedCount: 0 });
assert.equal((await list(last)).notifications.length, 0);
await runSync("failed", { error: "Plaid login expired" });
data = await list(last);
assert.equal(data.notifications[0].title, "Sync failed");
assert.equal(data.notifications[0].body, "Plaid login expired");
last = data.notifications[0].id;

// 6. Read marks everything read.
assert.ok((await list()).unread > 0);
assert.equal((await post({ action: "read" })).status, 200);
assert.equal((await list()).unread, 0);

// 7. Telegram: nothing is sent before a bot is connected; after, every notification goes to the chat.
assert.equal(sent.length, 0);
res = await post({ action: "telegram", botToken: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ" });
assert.deepEqual(await res.json(), { connected: true, bot: "test_bot" });
assert.equal(sent.at(-1).method, "sendMessage");
assert.equal(sent.at(-1).body.chat_id, 42);
assert.equal((await list()).telegram.connected, true);
await pend([p("g", 7.25)]);
assert.equal(sent.at(-1).body.text, "Pending: $7.25 · Shop g");
assert.equal((await post({ action: "telegram", botToken: "nope" })).status, 400, "bad token shape");

// 8. Telegram failing never fails the import that caused it.
globalThis.fetch = async () => { throw new Error("network down"); };
assert.equal((await pend([p("h", 1)])).status, 200);
assert.equal((await list(last)).notifications[0].title, "Pending: $1.00 · Shop h");

// 9. Disconnect forgets the bot.
await post({ action: "telegram-off" });
assert.deepEqual((await list()).telegram, { connected: false, bot: "" });

console.log("notifications tests passed");
