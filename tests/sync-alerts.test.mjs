/*
 * Sync failure alerts tests (Phase 2 failure alerting): POST
 * /api/sync-alerts is sync-session ONLY; the first alert for a
 * signature lands in the bell and goes to Telegram; a repeat of the
 * same signature inside the 6-hour window is deduped server-side; a
 * recovery always sends and clears the healed signatures' dedupe
 * stamps, so a later failure with the same signature alerts again.
 * Run: node tests/sync-alerts.test.mjs — dummy data only, Telegram stubbed.
 */
import assert from "node:assert/strict";
import {
  FakeD1, makeCtx, authHeaders, setupTestAuth, authedCtx
} from "./_fake-d1.mjs";
import { onRequestPost as alertsPost } from "../functions/api/sync-alerts.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { sha256Hex } from "../functions/api/budget.js";
import { connectTelegram, listNotifications } from "../functions/api/_notify.js";

const ALERTS = "http://local/api/sync-alerts";
const AUTH = "http://local/api/auth";

/* Mint a paired sync token the same way the real automation gets one
   (same helper shape as pending.test.mjs). */
async function pairedSyncToken(env, deviceToken) {
  const raw = "alerts-test-sync-token-0123456789abcdef";
  const tokenHash = await sha256Hex(raw);
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", AUTH, authHeaders(deviceToken)));
  assert.equal(res.status, 200, "pair-open");
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash, label: "Plaid sync" }, "POST", AUTH));
  assert.equal(res.status, 200, "pair-request");
  const fingerprint = (await res.json()).fingerprint;
  res = await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", AUTH, authHeaders(deviceToken)));
  assert.equal(res.status, 200, "pair-approve");
  return raw;
}

/* Telegram stub: capture sendMessage calls; getMe/getUpdates wire up
   connectTelegram the way notifications.test.mjs does. */
const sent = [];
globalThis.fetch = async (url, opts) => {
  const method = String(url).split("/").pop();
  sent.push({ method, body: JSON.parse(opts.body) });
  const result = method === "getMe" ? { username: "test_bot" }
    : method === "getUpdates" ? [{ message: { chat: { id: 42 }, text: "/start" } }] : {};
  return new Response(JSON.stringify({ ok: true, result }));
};
const telegramSends = () => sent.filter((s) => s.method === "sendMessage");

const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);
const sync = await pairedSyncToken(env, device);
await connectTelegram(env.DB, "123456:abcdefghijklmnopqrstuvwxyz");
sent.length = 0; /* drop the "connected" confirmation send */

const postAs = (token, body) => alertsPost(makeCtx(env, body, "POST", ALERTS, authHeaders(token)));
const bellRows = async () => (await listNotifications(env.DB, 0)).notifications;
/* The pairing flow itself leaves a bell row (pairing notifications),
   so counts are relative to this baseline. */
const BASE_ROWS = (await bellRows()).length;

const SIG_D1 = "bank: D1 daily row write limit";
const SIG_500 = "accounts: server 500";
const alertBody = (signature, extra) => ({
  signature,
  title: "⚠️ Sync failing: " + signature.split(": ")[1],
  body: "Real error text for " + signature,
  ...(extra || {})
});

/* ---------- 1. Auth scoping ------------------------------------------ */
/* No token at all -> 401; a device session -> 403. */
assert.equal((await alertsPost(makeCtx(env, alertBody(SIG_D1), "POST", ALERTS))).status, 401);
assert.equal((await postAs(device, alertBody(SIG_D1))).status, 403);
assert.equal((await postAs("not-a-real-token", alertBody(SIG_D1))).status, 401);
assert.equal((await bellRows()).length, BASE_ROWS, "rejected calls write no bell rows");
assert.equal(telegramSends().length, 0, "rejected calls send no Telegram");

/* ---------- 2. Malformed bodies -> 400 ------------------------------- */
assert.equal((await postAs(sync, { title: "x" })).status, 400, "missing signature");
assert.equal((await postAs(sync, { signature: SIG_D1 })).status, 400, "missing title");
assert.equal((await postAs(sync, { signature: "  ", title: "x" })).status, 400, "blank signature");
assert.equal((await postAs(sync, { signature: SIG_D1, title: "x", body: 42 })).status, 400, "non-string body");
assert.equal((await postAs(sync, { signature: SIG_D1, title: "x", recovered: "yes" })).status, 400, "non-boolean recovered");
assert.equal((await postAs(sync, { signature: SIG_D1, title: "x", clears: SIG_D1 })).status, 400, "clears not a list");
assert.equal((await postAs(sync, [1, 2, 3])).status, 400, "array body");
{
  const badJson = {
    env,
    request: new Request(ALERTS, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sync) },
      body: "{not json"
    })
  };
  assert.equal((await alertsPost(badJson)).status, 400, "unparseable JSON");
}
assert.equal((await bellRows()).length, BASE_ROWS, "malformed calls write no bell rows");

/* ---------- 3. First alert sends: bell row + Telegram ---------------- */
{
  const res = await postAs(sync, alertBody(SIG_D1));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  const rows = await bellRows();
  assert.equal(rows.length, BASE_ROWS + 1);
  assert.equal(rows[0].kind, "sync");
  assert.equal(rows[0].title, "⚠️ Sync failing: D1 daily row write limit");
  assert.equal(rows[0].body, "Real error text for " + SIG_D1);
  assert.equal(telegramSends().length, 1);
  assert.equal(String(telegramSends()[0].body.chat_id), "42");
  assert.match(telegramSends()[0].body.text, /Sync failing: D1 daily row write limit/);
}

/* ---------- 4. Repeat within the window is deduped -------------------- */
{
  const res = await postAs(sync, alertBody(SIG_D1));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deduped: true });
  assert.equal((await bellRows()).length, BASE_ROWS + 1, "dedupe writes no second bell row");
  assert.equal(telegramSends().length, 1, "dedupe sends no second Telegram");
}

/* ---------- 5. A different signature still sends ---------------------- */
{
  const res = await postAs(sync, alertBody(SIG_500));
  assert.deepEqual(await res.json(), { sent: true });
  assert.equal((await bellRows()).length, BASE_ROWS + 2);
  assert.equal(telegramSends().length, 2);
}

/* ---------- 6. Recovery always sends and clears the stamps ----------- */
{
  const res = await postAs(sync, {
    signature: SIG_D1 + " | " + SIG_500,
    title: "✅ Sync recovered",
    body: "Sync is clean again.",
    recovered: true,
    clears: [SIG_D1, SIG_500]
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  const rows = await bellRows();
  assert.equal(rows.length, BASE_ROWS + 3);
  assert.equal(rows[0].title, "✅ Sync recovered");
  assert.equal(telegramSends().length, 3);

  /* The cleared signature alerts again right away — no window. */
  const again = await postAs(sync, alertBody(SIG_D1));
  assert.deepEqual(await again.json(), { sent: true });
  assert.equal((await bellRows()).length, BASE_ROWS + 4);
  assert.equal(telegramSends().length, 4);
}

console.log("sync-alerts.test.mjs: all assertions passed");
