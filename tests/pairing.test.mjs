/*
 * Automation pairing tests (v7).
 * The owner opens a 10-minute pairing window in Settings (pair-open) and
 * gets a one-time pairing code; the Plaid sync script generates its own
 * token locally and registers ONLY its SHA-256 hash together with that
 * code (pair-request, no session). Nothing authenticates until the owner
 * approves with the matching fingerprint (pair-approve -> kind 'sync').
 * Covers: pre-setup 409, bad hash 400, no window 403 (no unsolicited
 * requests), wrong code 401 under the attempt limit, single-use code,
 * pending visibility (fingerprint, never the hash), approve needs the
 * fingerprint that is actually pending (409 if it changed), deny, the
 * hijack scenario from the v6.1 audit, and expiry of window + request.
 * Run: node tests/pairing.test.mjs — dummy tokens only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, TEST_SETUP_SECRET } from "./_fake-d1.mjs";
import { onRequestGet as authGet, onRequestPost as authPost } from "../functions/api/auth.js";
import { onRequestGet as budgetGet, sha256Hex } from "../functions/api/budget.js";
import { onRequestGet as expGet } from "../functions/api/expenses.js";

const AUTH = "http://local/api/auth";
const CODE = "pairing test code 7";
const post = (env, body, headers) => authPost(makeCtx(env, body, "POST", AUTH, headers));
const getPairing = (env, token) => authGet(makeCtx(env, undefined, "GET", AUTH + "?action=pairing", authHeaders(token)));
const getSessions = (env, token) => authGet(makeCtx(env, undefined, "GET", AUTH + "?action=sessions", authHeaders(token)));
/* Sync sessions are scoped to expense/card routes, so probe with GET /api/expenses. */
const syncStatus = (env, token) =>
  expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", authHeaders(token))).then((r) => r.status);

async function freshApp() {
  const env = { DB: new FakeD1(), SETUP_SECRET: TEST_SETUP_SECRET };
  const device = (await (await post(env, { action: "setup", setupSecret: TEST_SETUP_SECRET, code: CODE, label: "Phone" })).json()).token;
  return { env, device };
}
/* Mirror of the sync script: mint a token locally, keep the raw value,
   share only its SHA-256 hash. */
async function localToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token, tokenHash: await sha256Hex(token) };
}
async function openWindow(env, device) {
  const res = await post(env, { action: "pair-open" }, authHeaders(device));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, "8-char pairing code, shown as XXXX-XXXX");
  return body.code;
}

/* ---------- 1. Before setup: pair-request -> 409 --------------------- */
{
  const env = { DB: new FakeD1(), SETUP_SECRET: TEST_SETUP_SECRET };
  const { tokenHash } = await localToken();
  const res = await post(env, { action: "pair-request", pairCode: "AAAA-AAAA", tokenHash, label: "Plaid sync" });
  assert.equal(res.status, 409, "pair-request before setup -> 409");
  assert.equal((await res.json()).setupRequired, true);
}

/* ---------- 2. Happy path: open -> request -> compare -> approve ------ */
{
  const { env, device } = await freshApp();
  const { token, tokenHash } = await localToken();

  /* Without an open window, nobody can even file a request. */
  const unsolicited = await post(env, { action: "pair-request", pairCode: "ABCD-EFGH", tokenHash });
  assert.equal(unsolicited.status, 403, "no window -> 403");
  assert.equal((await (await getPairing(env, device)).json()).pending, null);

  /* pair-open is device-only and authenticated. */
  assert.equal((await post(env, { action: "pair-open" })).status, 401);
  const code = await openWindow(env, device);
  const win = (await (await getPairing(env, device)).json()).window;
  assert.ok(win && win.expiresAt, "open window is visible in Settings");

  /* Bad hashes are rejected before anything is stored. */
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash: "not-a-hash" })).status, 400);
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash: tokenHash.toUpperCase() })).status, 400, "uppercase hex rejected");
  /* A wrong code is refused (and counts as an attempt). */
  assert.equal((await post(env, { action: "pair-request", pairCode: "WXYZ-2345", tokenHash })).status, 401);

  /* The right code — accepted lowercase and without the dash too. */
  const res = await post(env, { action: "pair-request", pairCode: code.toLowerCase().replace("-", ""), tokenHash, label: "Plaid sync" });
  assert.equal(res.status, 200);
  const reqBody = await res.json();
  assert.equal(reqBody.fingerprint, tokenHash.slice(0, 8), "script learns the fingerprint to print");

  /* Single use: the window closed, the code cannot file a second request. */
  const other = await localToken();
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash: other.tokenHash })).status, 403, "code is single-use");

  /* Not alive until approved. */
  assert.equal(await syncStatus(env, token), 401, "pending (unapproved) token rejected");

  /* Settings sees label, time and fingerprint — never the full hash. */
  assert.equal((await authGet(makeCtx(env, undefined, "GET", AUTH + "?action=pairing"))).status, 401);
  const pairingBody = await (await getPairing(env, device)).json();
  assert.equal(pairingBody.pending.label, "Plaid sync");
  assert.ok(pairingBody.pending.requestedAt, "requestedAt present");
  assert.equal(pairingBody.pending.fingerprint, tokenHash.slice(0, 8));
  assert.equal(pairingBody.window, null, "window closed after use");
  assert.ok(!JSON.stringify(pairingBody).includes(tokenHash), "full tokenHash is never returned");

  /* Approve: authenticated, and needs the fingerprint that is pending. */
  assert.equal((await post(env, { action: "pair-approve", fingerprint: reqBody.fingerprint })).status, 401);
  assert.equal((await post(env, { action: "pair-approve" }, authHeaders(device))).status, 400, "fingerprint required");
  assert.equal((await post(env, { action: "pair-approve", fingerprint: "deadbeef" }, authHeaders(device))).status, 409, "wrong fingerprint -> 409");
  assert.equal(await syncStatus(env, token), 401);
  const approve = await post(env, { action: "pair-approve", fingerprint: pairingBody.pending.fingerprint }, authHeaders(device));
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).label, "Plaid sync");

  /* Now the token the script held all along authenticates (sync scope). */
  assert.equal(await syncStatus(env, token), 200, "approved pairing token works on expense routes");
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(token)))).status, 403, "...but not on the full budget");
  assert.equal((await (await getPairing(env, device)).json()).pending, null);
  const sessions = (await (await getSessions(env, device)).json()).sessions;
  const syncRow = sessions.find((s) => s.kind === "sync");
  assert.ok(syncRow, "paired session listed as kind 'sync'");
  assert.ok(syncRow.expiresAt, "sync sessions now expire");
  assert.ok(!JSON.stringify(sessions).includes(tokenHash), "sessions list never carries the hash");

  /* Revocable like any session. */
  assert.equal((await post(env, { action: "revoke", id: syncRow.id }, authHeaders(device))).status, 200);
  assert.equal(await syncStatus(env, token), 401, "revoked paired token rejected");
  assert.equal((await post(env, { action: "pair-approve", fingerprint: "anything" }, authHeaders(device))).status, 400, "nothing left to approve");
}

/* ---------- 3. Deny: the would-be token never works ------------------- */
{
  const { env, device } = await freshApp();
  const { token, tokenHash } = await localToken();
  const code = await openWindow(env, device);
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash })).status, 200);
  assert.ok((await (await getPairing(env, device)).json()).pending, "request pending before deny");
  assert.equal((await post(env, { action: "pair-deny" }, authHeaders(device))).status, 200);
  assert.equal((await (await getPairing(env, device)).json()).pending, null, "deny clears the pending request");
  assert.equal(await syncStatus(env, token), 401, "denied token does not authenticate");
}

/* ---------- 4. The v6.1 hijack no longer works ------------------------ */
{
  const { env, device } = await freshApp();
  const attacker = await localToken();
  const script = await localToken();

  /* An attacker can't squat the slot: with no window, every request is 403. */
  for (let i = 0; i < 3; i++) {
    assert.equal((await post(env, { action: "pair-request", pairCode: "AAAA-BBBB", tokenHash: attacker.tokenHash, label: "Plaid sync" })).status, 403);
  }
  /* While a window IS open, guessing the code is capped by the attempt limit. */
  const code = await openWindow(env, device);
  const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    post(env, { action: "pair-request", pairCode: "GUES-S" + String(i).padStart(3, "2"), tokenHash: attacker.tokenHash, label: "Plaid sync" },
      { "CF-Connecting-IP": "203.0.113.50" })));
  assert.ok(guesses.every((r) => r.status === 401 || r.status === 429), "guesses fail");
  assert.ok(guesses.filter((r) => r.status === 401).length <= 5, "only 5 guesses per IP are checked");

  /* The spray can DELAY pairing (the global cap is spent), never hijack it. */
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash: script.tokenHash })).status, 429);
  env.DB.db.prepare("UPDATE auth_attempts SET at = at - 11 * 60 * 1000").run();
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash: script.tokenHash })).status, 200,
    "the window's code still works once the limiter cools down (if the window is still open)");
  assert.equal((await post(env, { action: "pair-deny" }, authHeaders(device))).status, 200);

  /* Owner re-opens; the real script uses the new code; the owner sees ITS fingerprint. */
  const code2 = await openWindow(env, device);
  assert.equal((await post(env, { action: "pair-request", pairCode: code2, tokenHash: script.tokenHash, label: "Plaid sync" })).status, 200);
  const pending = (await (await getPairing(env, device)).json()).pending;
  assert.equal(pending.fingerprint, script.tokenHash.slice(0, 8));
  assert.equal((await post(env, { action: "pair-approve", fingerprint: pending.fingerprint }, authHeaders(device))).status, 200);
  assert.equal(await syncStatus(env, script.token), 200);
  assert.equal(await syncStatus(env, attacker.token), 401, "attacker's token never authenticates");
}

/* ---------- 5. Expiry: window after 10 min, pending after 30 ---------- */
{
  const { env, device } = await freshApp();
  const { tokenHash } = await localToken();
  const code = await openWindow(env, device);
  const raw = JSON.parse(env.DB.db.prepare("SELECT value FROM budget_settings WHERE key = 'pair_open'").get().value);
  env.DB.db.prepare("UPDATE budget_settings SET value = ? WHERE key = 'pair_open'").run(JSON.stringify({ ...raw, until: Date.now() - 1000 }));
  assert.equal((await post(env, { action: "pair-request", pairCode: code, tokenHash })).status, 403, "expired window -> 403");

  const code2 = await openWindow(env, device);
  assert.equal((await post(env, { action: "pair-request", pairCode: code2, tokenHash })).status, 200);
  const old = new Date(Date.now() - 31 * 60000).toISOString().slice(0, 19).replace("T", " ");
  const p = JSON.parse(env.DB.db.prepare("SELECT value FROM budget_settings WHERE key = 'pending_pairing'").get().value);
  env.DB.db.prepare("UPDATE budget_settings SET value = ? WHERE key = 'pending_pairing'").run(JSON.stringify({ ...p, requestedAt: old }));
  assert.equal((await (await getPairing(env, device)).json()).pending, null, "stale request hidden");
  assert.equal((await post(env, { action: "pair-approve", fingerprint: tokenHash.slice(0, 8) }, authHeaders(device))).status, 400, "stale request can't be approved");
}

console.log("pairing.test.mjs: all assertions passed");
