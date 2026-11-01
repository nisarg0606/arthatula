/*
 * Card → transactions link test: clicking a credit card account in
 * v2 filters the transactions feed by that account. The feed rows
 * come from the classic daily log, whose expenses name their card
 * ("Chase", "Amex"); the mirror must attach them to the synced
 * Plaid account for that card, or the filtered feed is empty and
 * the card "doesn't show" on the transactions screen.
 * Run: node tests/card-transactions.test.mjs — made-up data only.
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
  const raw = "card-tx-test-sync-token-0123456789abcdef";
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", "http://local/api/auth", authHeaders(token)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash: await sha256Hex(raw) }, "POST", "http://local/api/auth"));
  const fingerprint = (await res.json()).fingerprint;
  await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", "http://local/api/auth", authHeaders(token)));
  return raw;
}
const syncTok = await pairedSyncToken();

await ok(accounts, "GET", "accounts"); /* creates the tables */
const seedCard = async (name, start, end, due) => {
  await env.DB.prepare("INSERT INTO credit_cards (name, statement_start, statement_end, due_date) VALUES (?, ?, ?, ?)")
    .bind(name, start, end, due).run();
};
await seedCard("Chase", "2026-10-14", "2026-11-13", "2026-11-10");
await seedCard("Amex", "2026-10-12", "2026-11-11", "2026-11-05");
const seedExpense = async (date, desc, amount, card) => {
  await env.DB.prepare("INSERT INTO daily_expenses (date, description, amount, category, card_name) VALUES (?, ?, ?, 'Groceries', ?)")
    .bind(date, desc, amount, card).run();
};
await seedExpense("2026-10-27", "Walmart", 53.29, "Chase");
await seedExpense("2026-10-28", "Shell", 40.00, "Chase");
await seedExpense("2026-10-29", "Target", 25.10, "Chase");
await seedExpense("2026-10-27", "Starbucks", 10.00, "Amex");
await seedExpense("2026-10-28", "Uber", 18.50, "Amex");
await seedExpense("2026-10-28", "Cash snack", 5.00, null);

/* The sync pushes the cards under Plaid's names — the production
   reality: the classic log says "Chase", Plaid says "CREDIT CARD".
   The link must work anyway (the issuer is on the account). */
await ok(sync, "POST", "sync", {
  accounts: [
    { id: "plaid-chase", name: "CREDIT CARD", institution: "Chase", type: "credit", subtype: "credit card", mask: "6543", balanceCents: 73484 },
    { id: "plaid-amex", name: "Blue Cash Everyday®", institution: "American Express", type: "credit", subtype: "credit card", mask: "4007", balanceCents: 85545 }
  ]
}, syncTok);

const list = (await ok(accounts, "GET", "accounts")).accounts;
const chase = list.find((a) => a.type === "credit" && a.mask === "6543");
const amex = list.find((a) => a.type === "credit" && a.mask === "4007");
assert.ok(chase && amex, "both synced card accounts exist");
assert.equal(list.filter((a) => a.type === "credit").length, 2, "one account per card");

const chaseTx = await ok(transactions, "GET", "transactions?accountId=" + chase.id);
assert.equal(chaseTx.total, 3, "the Chase feed shows its 3 charges");
assert.ok(chaseTx.transactions.every((t) => t.accountId === chase.id));
const amexTx = await ok(transactions, "GET", "transactions?accountId=" + amex.id);
assert.equal(amexTx.total, 2, "the Amex feed shows its 2 charges");

/* A later push under the app's own card names renames the account
   (the sync upsert must not keep the first name forever). */
await ok(sync, "POST", "sync", {
  accounts: [
    { id: "plaid-chase", name: "Chase", institution: "Chase", type: "credit", subtype: "credit card", mask: "6543", balanceCents: 70000 }
  ]
}, syncTok);
const renamed = (await ok(accounts, "GET", "accounts")).accounts.find((a) => a.type === "credit" && a.mask === "6543");
assert.equal(renamed.name, "Chase", "a re-push renames the synced account");
assert.equal(renamed.id, chase.id, "the rename keeps the same account");
const chaseTx2 = await ok(transactions, "GET", "transactions?accountId=" + chase.id);
assert.equal(chaseTx2.total, 3, "the feed still shows the charges after the rename");

console.log("card-transactions.test.mjs: all assertions passed");
