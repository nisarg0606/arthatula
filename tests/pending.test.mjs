/*
 * Pending charges snapshot tests: auth scoping (device sessions read,
 * ONLY the paired sync automation writes), the sync POST replace
 * semantics (each push is the full set Plaid currently reports as
 * pending — a charge that posts or vanishes drops out), defensive
 * validation, and the dollars <-> cents conversion at the boundary.
 * Run: node tests/pending.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import {
  FakeD1, makeCtx, authHeaders, setupTestAuth, authedCtx
} from "./_fake-d1.mjs";
import { onRequestGet as pendingGet, onRequestPost as pendingPost } from "../functions/api/pending.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { sha256Hex } from "../functions/api/budget.js";

const PENDING = "http://local/api/pending";
const AUTH = "http://local/api/auth";

/* Mint a paired sync token the same way the real automation gets one:
   the owner opens a pairing window, the script registers only the
   SHA-256 of a token it generated locally, the owner approves the
   fingerprint. */
async function pairedSyncToken(env, deviceToken) {
  const raw = "pending-test-sync-token-0123456789abcdef";
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

const SYNCED_1 = "2026-10-28T07:00:00.000Z";
const SYNCED_2 = "2026-10-29T07:00:00.000Z";
function push(transactions, syncedAt) {
  return { syncedAt, transactions };
}
const SET_1 = [
  { plaidTransactionId: "pend-costco", date: "2026-10-27", name: "Costco", amount: 56.06, accountLabel: "Robinhood", category: "Groceries" },
  { plaidTransactionId: "pend-target", date: "2026-10-27", name: "Target", amount: 17.08, accountLabel: "Robinhood", category: "Shopping/Personal" },
  { plaidTransactionId: "pend-groupon", date: "2026-10-27", name: "Groupon", amount: 69.74, accountLabel: "Amex", category: "Shopping/Personal" }
];

/* ---------- 1. Before setup: 403 setupRequired, like every data route */
{
  const envPre = { DB: new FakeD1() };
  const res = await pendingGet(makeCtx(envPre, undefined, "GET", PENDING));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).setupRequired, true);
}

/* ---------- 2. Auth scoping ------------------------------------------ */
const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);
const sync = await pairedSyncToken(env, device);
const devCtx = authedCtx(env, device);
const syncCtx = authedCtx(env, sync);
const getAs = (ctx) => pendingGet(ctx(undefined, "GET", PENDING));
const postAs = (ctx, b) => pendingPost(ctx(b, "POST", PENDING));

/* No token at all -> 401 on both verbs. */
assert.equal((await pendingGet(makeCtx(env, undefined, "GET", PENDING))).status, 401);
assert.equal((await pendingPost(makeCtx(env, push(SET_1, SYNCED_1), "POST", PENDING))).status, 401);

/* Empty snapshot reads fine for a device session. */
let res = await getAs(devCtx);
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { transactions: [], syncedAt: null });

/* Device sessions can never write; sync sessions can never read. */
res = await postAs(devCtx, push(SET_1, SYNCED_1));
assert.equal(res.status, 403, "device POST refused");
res = await getAs(syncCtx);
assert.equal(res.status, 403, "sync GET refused");

/* ---------- 3. Sync POST writes; device GET reads dollars back ------- */
res = await postAs(syncCtx, push(SET_1, SYNCED_1));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, transactions: 3 });

res = await getAs(devCtx);
assert.equal(res.status, 200);
let body = await res.json();
assert.equal(body.syncedAt, SYNCED_1);
assert.equal(body.transactions.length, 3);
const costco = body.transactions.find((t) => t.id === "pend-costco");
assert.equal(costco.amount, 56.06, "cents converted back to dollars");
assert.equal(costco.accountLabel, "Robinhood");
assert.equal(costco.category, "Groceries");
assert.equal(costco.date, "2026-10-27");

/* ---------- 4. Replace semantics: posted / vanished charges drop out - */
/* Costco posted and Target's hold vanished; only Groupon remains,
   plus a new Safeway charge appeared. */
const SET_2 = [
  { plaidTransactionId: "pend-groupon", date: "2026-10-27", name: "Groupon", amount: 69.74, accountLabel: "Amex", category: "Shopping/Personal" },
  { plaidTransactionId: "pend-safeway", date: "2026-10-26", name: "Safeway", amount: 8.94, accountLabel: "Amex", category: "Groceries" }
];
res = await postAs(syncCtx, push(SET_2, SYNCED_2));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, transactions: 2 });
body = await (await getAs(devCtx)).json();
assert.equal(body.syncedAt, SYNCED_2);
assert.deepEqual(body.transactions.map((t) => t.id).sort(), ["pend-groupon", "pend-safeway"],
  "the second push fully replaces the first set");

/* An empty push clears the snapshot (nothing pending anywhere). */
res = await postAs(syncCtx, push([], SYNCED_2));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, transactions: 0 });
body = await (await getAs(devCtx)).json();
assert.deepEqual(body, { transactions: [], syncedAt: null });

/* ---------- 5. Defensive validation ---------------------------------- */
/* Malformed entries are skipped, never fatal; counts say what landed. */
res = await postAs(syncCtx, push([
  { plaidTransactionId: "pend-ok", date: "2026-10-28", name: "Valid", amount: 3.25, accountLabel: "Chase", category: "Groceries" },
  { date: "2026-10-28", name: "No id", amount: 1.00 },
  { plaidTransactionId: "pend-bad-date", date: "10/28/2026", name: "Bad date", amount: 1.00 },
  { plaidTransactionId: "pend-zero", date: "2026-10-28", name: "Zero", amount: 0 },
  { plaidTransactionId: "pend-negative", date: "2026-10-28", name: "Refund", amount: -4.50 },
  { plaidTransactionId: "pend-nan", date: "2026-10-28", name: "Not a number", amount: "abc" },
  "garbage",
  null
], SYNCED_1));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, transactions: 1 }, "only the valid entry lands");
body = await (await getAs(devCtx)).json();
assert.deepEqual(body.transactions.map((t) => t.id), ["pend-ok"]);

/* Malformed JSON -> 400; a non-object body -> 400. */
{
  const badJson = {
    env,
    request: new Request(PENDING, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sync) },
      body: "{not json"
    })
  };
  assert.equal((await pendingPost(badJson)).status, 400);
  assert.equal((await postAs(syncCtx, [1, 2, 3])).status, 400);
}

console.log("pending.test.mjs: all assertions passed");
