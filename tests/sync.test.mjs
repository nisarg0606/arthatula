/*
 * Manual sync request tests: the "Sync now" queue behind the Daily
 * tab button. Covers auth scoping (device sessions file and read
 * requests; ONLY the paired sync automation claims and completes),
 * the no-duplicate rule for an active request, the claim -> complete
 * flow, the failure path, and stale-request expiry. Handlers are
 * invoked directly against the fake D1, like the other suites.
 * Run: node tests/sync.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import {
  FakeD1, makeCtx, authHeaders, setupTestAuth, authedCtx
} from "./_fake-d1.mjs";
import { onRequestPost as syncRequestPost } from "../functions/api/sync-requests.js";
import { onRequestGet as syncLatestGet } from "../functions/api/sync-requests/latest.js";
import { onRequestGet as syncClaimGet } from "../functions/api/sync-requests/claim.js";
import { onRequestPost as syncCompletePost } from "../functions/api/sync-requests/[id]/complete.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { sha256Hex } from "../functions/api/budget.js";

const REQUESTS = "http://local/api/sync-requests";
const LATEST = "http://local/api/sync-requests/latest";
const CLAIM = "http://local/api/sync-requests/claim";
const AUTH = "http://local/api/auth";
const completeUrl = (id) => "http://local/api/sync-requests/" + id + "/complete";

/* Mint a paired sync token the same way the real automation gets one
   (same helper shape as pending.test.mjs). */
async function pairedSyncToken(env, deviceToken) {
  const raw = "sync-test-sync-token-0123456789abcdef";
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

/* The complete handler reads its id from context.params (Pages
   routing); makeCtx has no params, so wrap it. */
function completeCtx(env, token, id, body) {
  const ctx = makeCtx(env, body, "POST", completeUrl(id), authHeaders(token));
  ctx.params = { id };
  return ctx;
}

/* ---------- 1. Before setup: 403 setupRequired, like every data route */
{
  const envPre = { DB: new FakeD1() };
  const res = await syncRequestPost(makeCtx(envPre, undefined, "POST", REQUESTS));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).setupRequired, true);
}

/* ---------- 2. Auth scoping ------------------------------------------ */
const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);
const sync = await pairedSyncToken(env, device);
const devCtx = authedCtx(env, device);
const syncCtx = authedCtx(env, sync);

/* No token at all -> 401 on every route. */
assert.equal((await syncRequestPost(makeCtx(env, undefined, "POST", REQUESTS))).status, 401);
assert.equal((await syncLatestGet(makeCtx(env, undefined, "GET", LATEST))).status, 401);
assert.equal((await syncClaimGet(makeCtx(env, undefined, "GET", CLAIM))).status, 401);
assert.equal((await syncCompletePost(completeCtx(env, null, "x", { status: "done", result: {} }))).status, 401);

/* Nothing requested yet: latest is null, claim is empty. */
let res = await syncLatestGet(devCtx(undefined, "GET", LATEST));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { request: null });
res = await syncClaimGet(syncCtx(undefined, "GET", CLAIM));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { request: null });

/* The wrong kind is refused on both sides of the queue. */
res = await syncRequestPost(syncCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 403, "sync sessions can't file requests");
res = await syncLatestGet(syncCtx(undefined, "GET", LATEST));
assert.equal(res.status, 403, "sync sessions can't read latest");
res = await syncClaimGet(devCtx(undefined, "GET", CLAIM));
assert.equal(res.status, 403, "device sessions can't claim");
res = await syncCompletePost(completeCtx(env, device, "x", { status: "done", result: {} }));
assert.equal(res.status, 403, "device sessions can't complete");

/* ---------- 3. File + dedupe ------------------------------------------ */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 201, "first request is created");
const first = await res.json();
assert.equal(first.status, "pending");
assert.ok(first.id, "an id comes back");

/* A second tap while the first is active returns the SAME request. */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 200, "active request is handed back, not duplicated");
assert.deepEqual(await res.json(), first);

res = await syncLatestGet(devCtx(undefined, "GET", LATEST));
let latest = (await res.json()).request;
assert.equal(latest.id, first.id);
assert.equal(latest.status, "pending");
assert.equal(latest.result, null);
assert.equal(latest.finishedAt, null);
assert.ok(latest.requestedAt, "requestedAt is set");

/* ---------- 4. Claim -> complete (done) -------------------------------- */
res = await syncClaimGet(syncCtx(undefined, "GET", CLAIM));
assert.equal(res.status, 200);
const claimed = (await res.json()).request;
assert.equal(claimed.id, first.id);
assert.equal(claimed.status, "running");

/* The claim is single-winner: a second claim finds an empty queue. */
res = await syncClaimGet(syncCtx(undefined, "GET", CLAIM));
assert.deepEqual(await res.json(), { request: null });

/* Still deduped while running. */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 200);
assert.equal((await res.json()).id, first.id);

/* Completing an unknown id, or with a bad status, fails cleanly. */
res = await syncCompletePost(completeCtx(env, sync, "no-such-id", { status: "done", result: {} }));
assert.equal(res.status, 404);
res = await syncCompletePost(completeCtx(env, sync, first.id, { status: "sideways", result: {} }));
assert.equal(res.status, 400);
res = await syncCompletePost(completeCtx(env, sync, first.id, undefined));
assert.equal(res.status, 400);

const SUMMARY = {
  addedCount: 2,
  addedTotal: 25.02,
  skippedCounts: { "already-seen": 5, pending: 3 },
  failedCount: 0,
  bank: { accounts: 5, transactions: 1 },
  pending: { transactions: 3 },
  window: { from: "2026-10-26", to: "2026-10-28" }
};
res = await syncCompletePost(completeCtx(env, sync, first.id, { status: "done", result: SUMMARY }));
assert.equal(res.status, 200);
assert.equal((await res.json()).ok, true);

res = await syncLatestGet(devCtx(undefined, "GET", LATEST));
latest = (await res.json()).request;
assert.equal(latest.status, "done");
assert.deepEqual(latest.result, SUMMARY, "the stored summary parses back intact");
assert.ok(latest.finishedAt, "finishedAt is set");

/* A finished request can't be completed twice. */
res = await syncCompletePost(completeCtx(env, sync, first.id, { status: "done", result: SUMMARY }));
assert.equal(res.status, 404);

/* ---------- 5. A fresh request after done; the failure path ----------- */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 201);
const second = await res.json();
assert.notEqual(second.id, first.id);

res = await syncClaimGet(syncCtx(undefined, "GET", CLAIM));
assert.equal((await res.json()).request.id, second.id);
res = await syncCompletePost(completeCtx(env, sync, second.id, { status: "failed", result: { error: "sync.mjs exited 1" } }));
assert.equal(res.status, 200);
res = await syncLatestGet(devCtx(undefined, "GET", LATEST));
latest = (await res.json()).request;
assert.equal(latest.status, "failed");
assert.equal(latest.result.error, "sync.mjs exited 1");

/* ---------- 6. Stale active requests expire --------------------------- */
/* A request nobody picks up (poller down) must not block the button
   forever: once it is older than 10 minutes the next read or filing
   expires it to failed and a fresh request can be made. */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 201);
const third = await res.json();
await env.DB.prepare("UPDATE sync_requests SET requested_at = ? WHERE id = ?")
  .bind("2000-01-01 00:00:00", third.id).run();
/* Filing again expires the stale row instead of returning it... */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
assert.equal(res.status, 201, "a new request can be filed after expiry");
assert.notEqual((await res.json()).id, third.id);
/* ...and the stale row itself is left marked failed with the reason. */
const staleRow = await env.DB.prepare("SELECT status, result FROM sync_requests WHERE id = ?")
  .bind(third.id).first();
assert.equal(staleRow.status, "failed", "the stale request expired");
assert.match(JSON.parse(staleRow.result).error, /Timed out/);

/* ---------- 7. A running sync's time counts from its claim -------------- */
/* A request that waited a while before the poller claimed it still gets
   its full 10 minutes to run; one claimed more than 10 minutes ago
   expires. */
const sqlAt = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
let fourth = (await (await syncLatestGet(devCtx(undefined, "GET", LATEST))).json()).request;
assert.equal(fourth.status, "pending");
await env.DB.prepare("UPDATE sync_requests SET requested_at = ? WHERE id = ?").bind(sqlAt(9 * 60e3), fourth.id).run();
res = await syncClaimGet(syncCtx(undefined, "GET", CLAIM));
const lateClaim = (await res.json()).request;
assert.equal(lateClaim.id, fourth.id);
assert.ok(lateClaim.claimedAt, "claimedAt is recorded");
/* Filed long ago, claimed just now: still running, and it can complete. */
await env.DB.prepare("UPDATE sync_requests SET requested_at = ? WHERE id = ?").bind("2000-01-01 00:00:00", fourth.id).run();
fourth = (await (await syncLatestGet(devCtx(undefined, "GET", LATEST))).json()).request;
assert.equal(fourth.status, "running", "a late claim is not expired by its request time");
res = await syncCompletePost(completeCtx(env, sync, fourth.id, { status: "done", result: { addedCount: 0 } }));
assert.equal(res.status, 200, "the late-claimed run completes");
/* Claimed more than 10 minutes ago and never completed: expires. */
res = await syncRequestPost(devCtx(undefined, "POST", REQUESTS));
const fifth = await res.json();
await syncClaimGet(syncCtx(undefined, "GET", CLAIM));
await env.DB.prepare("UPDATE sync_requests SET claimed_at = ? WHERE id = ?").bind(sqlAt(11 * 60e3), fifth.id).run();
const stuck = (await (await syncLatestGet(devCtx(undefined, "GET", LATEST))).json()).request;
assert.equal(stuck.id, fifth.id);
assert.equal(stuck.status, "failed", "a run 10+ minutes past its claim expires");

/* ---------- 8. A finished result stops showing after a day ------------- */
{
  const { syncResultExpired } = await import("../js/core/index.js");
  const now = Date.parse("2026-11-02T12:00:00Z");
  const done = (finishedAt) => ({ status: "done", finishedAt });
  assert.equal(syncResultExpired(done("2026-11-02 08:00:00"), now), false, "4 hours old: shown");
  assert.equal(syncResultExpired(done("2026-11-01 11:00:00"), now), true, "25 hours old: hidden");
  assert.equal(syncResultExpired({ status: "failed", finishedAt: "2026-10-30 12:00:00" }, now), true, "old failures hide too");
  assert.equal(syncResultExpired({ status: "running", finishedAt: null }, now), false, "a running sync always shows");
  assert.equal(syncResultExpired(null, now), false);
}

console.log("sync.test.mjs: all assertions passed");
