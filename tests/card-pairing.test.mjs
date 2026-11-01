/*
 * Card pairing test: a classic Cards-page card and the Plaid-synced
 * account for the same physical card must be ONE account in v2.
 *
 * The classic list uses short names ("Chase", "Amex"); Plaid calls
 * the same cards "CREDIT CARD" and "Blue Cash Everyday®". The mirror
 * originally paired them by exact name, which matched nothing, so
 * every card appeared twice — once with statement dates and no
 * balance, once with a balance and no dates. Pairing is by issuer
 * (from the synced account's name or institution). This test also
 * covers healing: duplicates created before the pairing existed are
 * removed, and their transactions move to the surviving account.
 * Run: node tests/card-pairing.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { sha256Hex } from "../functions/api/budget.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import * as accounts from "../functions/api/v2/accounts.js";
import * as transactions from "../functions/api/v2/transactions.js";
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
  const raw = "card-pairing-test-sync-token-0123456789";
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", "http://local/api/auth", authHeaders(token)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash: await sha256Hex(raw) }, "POST", "http://local/api/auth"));
  const fingerprint = (await res.json()).fingerprint;
  await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", "http://local/api/auth", authHeaders(token)));
  return raw;
}
const syncTok = await pairedSyncToken();

/* The classic cards, exactly as the Cards page holds them. */
await ok(accounts, "GET", "accounts"); /* creates the tables */
const seedCard = async (name, start, end, due) => {
  await env.DB.prepare("INSERT INTO credit_cards (name, statement_start, statement_end, due_date) VALUES (?, ?, ?, ?)")
    .bind(name, start, end, due).run();
};
await seedCard("Chase", "2026-10-14", "2026-11-13", "2026-11-10");
await seedCard("Amex", "2026-10-12", "2026-11-11", "2026-11-05");
await seedCard("Discover", "2026-10-20", "2026-11-19", null);

/* First mirror: three classic-only accounts, no balances — the
   pre-sync state that used to linger as duplicates forever. */
let list = (await ok(accounts, "GET", "accounts")).accounts;
let credit = list.filter((a) => a.type === "credit");
assert.equal(credit.length, 3);
assert.ok(credit.every((a) => a.source === "v1card" && a.balanceCents === null));
const dupChase = credit.find((a) => a.name === "Chase");

/* A transaction filed against the duplicate, as the expense mirror
   would have done while the duplicate existed. */
const tx = (await ok(transactions, "POST", "transactions",
  { date: "2026-10-20", merchant: "Test charge", amountCents: -1500, accountId: dupChase.id })).transaction;
assert.equal(tx.accountId, dupChase.id);

/* The nightly sync pushes the same cards under Plaid's names. */
await ok(sync, "POST", "sync", {
  accounts: [
    { id: "plaid-chase", name: "CREDIT CARD", institution: "Chase", type: "credit", subtype: "credit card", mask: "6543", balanceCents: 73484 },
    { id: "plaid-amex", name: "Blue Cash Everyday®", institution: "American Express", type: "credit", subtype: "credit card", mask: "4007", balanceCents: 85545 },
    { id: "plaid-disc", name: "Discover it", institution: "Discover", type: "credit", subtype: "credit card", mask: "3670", balanceCents: 37133 }
  ]
}, syncTok);

/* Now: one account per card, carrying BOTH the Plaid balance and
   the classic statement dates. */
list = (await ok(accounts, "GET", "accounts")).accounts;
credit = list.filter((a) => a.type === "credit");
assert.equal(credit.length, 3, "each card appears exactly once");
const byMask = {};
credit.forEach((a) => { byMask[a.mask] = a; });
assert.equal(byMask["6543"].balanceCents, 73484);
assert.equal(byMask["6543"].dueDate, "2026-11-10", "Chase kept its classic due date");
assert.equal(byMask["6543"].source, "plaid");
assert.equal(byMask["4007"].balanceCents, 85545);
assert.equal(byMask["4007"].dueDate, "2026-11-05", "Amex paired via its institution, American Express");
assert.equal(byMask["3670"].balanceCents, 37133);
assert.equal(byMask["3670"].statementEnd, "2026-11-19");

/* The duplicate is gone and its transaction moved to the survivor. */
assert.ok(!credit.some((a) => a.id === dupChase.id), "the v1card duplicate was removed");
const moved = (await ok(transactions, "GET", "transactions?from=2026-10-01&to=2026-10-31")).transactions
  .find((t) => t.id === tx.id);
assert.equal(moved.accountId, byMask["6543"].id, "the duplicate's transactions moved to the synced account");

/* And net worth sees each card's balance exactly once. */
const nw = (await ok(accounts, "GET", "accounts")).netWorth;
assert.equal(nw.liabilitiesCents, 73484 + 85545 + 37133);

console.log("card-pairing.test.mjs: all assertions passed");
