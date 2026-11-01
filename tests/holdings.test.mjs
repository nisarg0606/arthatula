/*
 * Holdings view test: the sync pushes Plaid positions (with cost
 * basis, latest price, and the date that price belongs to), the
 * investments endpoint serves them per investment account, a re-push
 * replaces the set (a sold position disappears), and a push WITHOUT
 * the holdings key leaves stored positions untouched.
 * Run: node tests/holdings.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { sha256Hex } from "../functions/api/budget.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import * as accounts from "../functions/api/v2/accounts.js";
import * as investments from "../functions/api/v2/investments.js";
import * as sync from "../functions/api/v2/sync.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const B = "http://local/api/v2/";
async function call(mod, method, route, body, tok) {
  const fn = mod["onRequest" + method[0] + method.slice(1).toLowerCase()];
  const res = await fn(makeCtx(env, body, method, B + route, authHeaders(tok === undefined ? token : tok)));
  return { status: res.status, data: JSON.parse(await res.text()) };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.ok(r.status >= 200 && r.status < 300, args[1] + " " + args[2] + " -> " + r.status + " " + JSON.stringify(r.data));
  return r.data;
};
async function pairedSyncToken() {
  const raw = "holdings-test-sync-token-0123456789abcdef";
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", "http://local/api/auth", authHeaders(token)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash: await sha256Hex(raw) }, "POST", "http://local/api/auth"));
  const fingerprint = (await res.json()).fingerprint;
  await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", "http://local/api/auth", authHeaders(token)));
  return raw;
}
const syncTok = await pairedSyncToken();

await ok(accounts, "GET", "accounts"); /* creates the tables */

const INV = { id: "plaid-inv-1", name: "Robinhood", institution: "Robinhood", type: "investment", subtype: "brokerage", mask: "3951", balanceCents: 380964 };
const AVGO = { accountId: "plaid-inv-1", securityId: "sec-avgo", ticker: "AVGO", name: "Broadcom Inc", quantity: 5.022125, costBasisCents: 204344, priceCents: 32618, valueCents: 163812, kind: "security", asOf: "2026-10-31" };
const AAPL = { accountId: "plaid-inv-1", securityId: "sec-aapl", ticker: "AAPL", name: "Apple Inc", quantity: 0.179569, costBasisCents: 5015, priceCents: 34463, valueCents: 6188, kind: "security", asOf: "2026-10-31" };
const CASH = { accountId: "plaid-inv-1", securityId: "sec-cash", ticker: "", name: "Cash", quantity: 747, costBasisCents: null, priceCents: 100, valueCents: 747, kind: "cash", asOf: "2026-10-31" };

/* 1. A push carrying holdings stores them; the investments endpoint
      serves them sorted by value, linked to the investment account. */
let r = await ok(sync, "POST", "sync", { accounts: [INV], holdings: [AVGO, AAPL, CASH], asOf: "2026-11-01" }, syncTok);
assert.equal(r.accounts, 1);
assert.equal(r.holdings, 3);
let inv = await ok(investments, "GET", "investments");
assert.equal(inv.holdings.length, 3);
assert.equal(inv.holdings[0].ticker, "AVGO"); /* biggest value first */
assert.equal(inv.holdings[0].costBasisCents, 204344);
assert.equal(inv.holdings[0].priceCents, 32618);
assert.equal(inv.holdings[0].asOf, "2026-10-31");
assert.equal(inv.holdingsAsOf, "2026-10-31");
const invAcct = inv.accounts.find((a) => a.mask === "3951"); /* the investments payload carries no type field */
assert.ok(invAcct, "investment account listed");
assert.ok(inv.holdings.every((x) => x.accountId === invAcct.id), "holdings linked to the v2 account id");
assert.equal(inv.holdings.find((x) => x.kind === "cash").valueCents, 747);
console.log("ok 1 - push stores holdings; investments serves them sorted + linked");

/* 2. A holding for an account that was never pushed is dropped. */
r = await ok(sync, "POST", "sync", { accounts: [INV], holdings: [AVGO, { ...AAPL, accountId: "plaid-ghost" }], asOf: "2026-11-01" }, syncTok);
inv = await ok(investments, "GET", "investments");
assert.equal(inv.holdings.length, 1);
assert.equal(inv.holdings[0].ticker, "AVGO");
console.log("ok 2 - holdings for unknown accounts are dropped");

/* 3. Replace semantics: AAPL was sold, so a fresh complete set
      without it removes it. */
r = await ok(sync, "POST", "sync", { accounts: [INV], holdings: [AVGO, AAPL], asOf: "2026-11-01" }, syncTok);
assert.equal((await ok(investments, "GET", "investments")).holdings.length, 2);
r = await ok(sync, "POST", "sync", { accounts: [INV], holdings: [AVGO], asOf: "2026-11-02" }, syncTok);
inv = await ok(investments, "GET", "investments");
assert.equal(inv.holdings.length, 1);
assert.equal(inv.holdings[0].ticker, "AVGO");
console.log("ok 3 - a re-push replaces the set (sold positions disappear)");

/* 4. A push WITHOUT the holdings key (older sync) must not wipe
      stored positions. */
r = await ok(sync, "POST", "sync", { accounts: [INV], asOf: "2026-11-02" }, syncTok);
assert.equal(r.holdings, 0);
inv = await ok(investments, "GET", "investments");
assert.equal(inv.holdings.length, 1);
console.log("ok 4 - a holdings-less push leaves stored positions untouched");

/* 5. An empty holdings array IS a complete set: it clears them. */
r = await ok(sync, "POST", "sync", { accounts: [INV], holdings: [], asOf: "2026-11-02" }, syncTok);
inv = await ok(investments, "GET", "investments");
assert.equal(inv.holdings.length, 0);
console.log("ok 5 - an explicit empty set clears the account's holdings");

console.log("holdings.test.mjs: all checks passed");
