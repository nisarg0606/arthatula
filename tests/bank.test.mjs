/*
 * Bank tab snapshot tests: auth scoping (device sessions read, ONLY
 * the paired sync automation writes), the sync POST upsert (a re-push
 * updates rows in place — balances move, transactions never
 * duplicate), defensive validation, the 500-per-call cap, and the
 * dollars <-> cents conversion at the API boundary.
 * Run: node tests/bank.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import {
  FakeD1, makeCtx, authHeaders, setupTestAuth, authedCtx
} from "./_fake-d1.mjs";
import { onRequestGet as bankGet, onRequestPost as bankPost } from "../functions/api/bank.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { sha256Hex } from "../functions/api/budget.js";

const BANK = "http://local/api/bank";
const AUTH = "http://local/api/auth";

/* Mint a paired sync token the same way the real automation gets one:
   the owner opens a pairing window, the script registers only the
   SHA-256 of a token it generated locally, the owner approves the
   fingerprint. */
async function pairedSyncToken(env, deviceToken) {
  const raw = "bank-test-sync-token-0123456789abcdef";
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

const SYNCED_1 = "2026-10-28T03:00:00.000Z";
const SYNCED_2 = "2026-10-29T03:00:00.000Z";
function snapshot(balance, powerAmount, syncedAt) {
  return {
    syncedAt,
    accounts: [
      { plaidAccountId: "acc-checking", institution: "Chase", name: "Everyday Checking", subtype: "checking", mask: "1111", currentBalance: balance, availableBalance: balance },
      { plaidAccountId: "acc-savings", institution: "American Express", name: "High Yield Savings", subtype: "savings", mask: "2222", currentBalance: 1500.25, availableBalance: null }
    ],
    transactions: [
      { plaidTransactionId: "tx-rent", accountId: "acc-checking", date: "2026-10-07", name: "Online Transfer / Payment: Debit", amount: 1200.33, pending: false, pfc: "TRANSFER_OUT" },
      { plaidTransactionId: "tx-salary", accountId: "acc-checking", date: "2026-10-14", name: "PAYROLL ACME", amount: -1700.6, pending: false, pfc: "INCOME" },
      { plaidTransactionId: "tx-power", accountId: "acc-checking", date: "2026-10-02", name: "APS ELECTRIC", amount: powerAmount, pending: true, pfc: "UTILITIES" }
    ]
  };
}

/* ---------- 1. Before setup: 403 setupRequired, like every data route */
{
  const envPre = { DB: new FakeD1() };
  const res = await bankGet(makeCtx(envPre, undefined, "GET", BANK));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).setupRequired, true);
}

/* ---------- 2. Auth scoping ------------------------------------------ */
const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);
const sync = await pairedSyncToken(env, device);
const devCtx = authedCtx(env, device);
const syncCtx = authedCtx(env, sync);
const getAs = (ctx) => bankGet(ctx(undefined, "GET", BANK));
const postAs = (ctx, b) => bankPost(ctx(b, "POST", BANK));

/* No token at all -> 401 on both verbs. */
assert.equal((await bankGet(makeCtx(env, undefined, "GET", BANK))).status, 401);
assert.equal((await bankPost(makeCtx(env, snapshot(1, 1, SYNCED_1), "POST", BANK))).status, 401);

/* Empty snapshot reads fine for a device session. */
let res = await getAs(devCtx);
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { accounts: [], transactions: [], reviews: {}, ignoreRules: [], syncedAt: null });

/* Device sessions can never write; sync sessions can never read. */
res = await postAs(devCtx, snapshot(300.45, 80.15, SYNCED_1));
assert.equal(res.status, 403, "device POST refused");
res = await getAs(syncCtx);
assert.equal(res.status, 403, "sync GET refused");

/* ---------- 3. Sync POST upserts; device GET reads dollars back ------ */
res = await postAs(syncCtx, snapshot(300.45, 80.15, SYNCED_1));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, accounts: 2, transactions: 3 });

res = await getAs(devCtx);
assert.equal(res.status, 200);
let body = await res.json();
assert.equal(body.syncedAt, SYNCED_1);
assert.equal(body.accounts.length, 2);
const savings = body.accounts.find((a) => a.id === "acc-savings");
const checking = body.accounts.find((a) => a.id === "acc-checking");
assert.equal(savings.institution, "American Express");
assert.equal(savings.currentBalance, 1500.25, "cents converted back to dollars");
assert.equal(savings.availableBalance, null, "a missing available balance stays null, not 0");
assert.equal(checking.currentBalance, 300.45);
assert.equal(checking.mask, "1111");
assert.equal(body.transactions.length, 3);
assert.deepEqual(body.transactions.map((t) => t.id), ["tx-salary", "tx-rent", "tx-power"], "newest first");
const salary = body.transactions[0];
assert.equal(salary.amount, -1700.6, "money IN keeps the Plaid sign (negative) over the API");
assert.equal(salary.pending, false);
assert.equal(body.transactions[2].pending, true, "pending flag round-trips");
assert.equal(body.transactions[2].amount, 80.15);

/* ---------- 4. Re-push updates in place — no duplicates -------------- */
res = await postAs(syncCtx, snapshot(300.25, 160.0, SYNCED_2));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, accounts: 2, transactions: 3 });
body = await (await getAs(devCtx)).json();
assert.equal(body.syncedAt, SYNCED_2);
assert.equal(body.accounts.find((a) => a.id === "acc-checking").currentBalance, 300.25, "balance updated");
assert.equal(body.transactions.length, 3, "same Plaid ids upsert, never duplicate");
assert.equal(body.transactions.find((t) => t.id === "tx-power").amount, 160, "amount updated in place");

/* ---------- 5. Defensive validation ---------------------------------- */
/* Malformed JSON -> 400; a non-object body -> 400. */
{
  const badJson = {
    env,
    request: new Request(BANK, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sync) },
      body: "{not json"
    })
  };
  assert.equal((await bankPost(badJson)).status, 400);
}
res = await postAs(syncCtx, ["not", "an", "object"]);
assert.equal(res.status, 400);

/* Junk entries are skipped, valid ones still land. */
res = await postAs(syncCtx, {
  syncedAt: SYNCED_2,
  accounts: [
    { name: "No id at all", currentBalance: 5 },
    { plaidAccountId: "acc-valid", institution: "Test Bank", name: "Everyday", subtype: "checking", mask: "0001", currentBalance: 42.5 }
  ],
  transactions: [
    { plaidTransactionId: "tx-bad-date", accountId: "acc-valid", date: "10/05/2026", name: "X", amount: 1 },
    { plaidTransactionId: "tx-no-amount", accountId: "acc-valid", date: "2026-10-05", name: "X" },
    { plaidTransactionId: "tx-valid", accountId: "acc-valid", date: "2026-10-05", name: "Corner Shop", amount: 12.34 }
  ]
});
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true, accounts: 1, transactions: 1 });

/* ---------- 6. Per-call cap of 500 ------------------------------------ */
{
  const many = {
    syncedAt: SYNCED_2,
    accounts: Array.from({ length: 501 }, (_, i) => ({
      plaidAccountId: "bulk-" + i, institution: "Bulk", name: "A" + i, subtype: "checking", mask: "", currentBalance: i
    })),
    transactions: []
  };
  res = await postAs(syncCtx, many);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).accounts, 500, "accounts capped at 500 per call");
}

console.log("bank.test.mjs: all assertions passed");
