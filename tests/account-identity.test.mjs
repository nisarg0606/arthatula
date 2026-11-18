/*
 * Account identity across feed-id generations: a bank reconnect
 * re-issues Plaid's account ids, and the money model must recognise
 * "same real account, new id" instead of minting a duplicate.
 * Covers planRekeys (pure), the /api/v2/sync re-key, the v1 mirror's
 * generation handling (one account, transactions mirrored once), and
 * the merge_accounts MCP tool that repairs duplicates created before
 * re-keying existed.
 * Run: node tests/account-identity.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { planRekeys, namesCollide } from "../functions/api/_v2identity.js";
import { onRequestPost as syncPost } from "../functions/api/v2/sync.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { onRequestPost as mcpPost } from "../functions/api/mcp.js";
import { mirrorV1 } from "../functions/api/_v2mirror.js";
import { sha256Hex } from "../functions/api/budget.js";

const SYNC = "http://local/api/v2/sync";
const AUTH = "http://local/api/auth";
const MCP = "http://local/api/mcp";

/* ---------- planRekeys: pure matching ---------- */
{
  const existing = [
    { id: "a1", external_id: "plaid:OLD1", institution: "American Express", mask: "4007", type: "credit" },
    { id: "a2", external_id: "plaid:OLD2", institution: "Wells Fargo", mask: "6404", type: "depository" }
  ];
  /* New ids, same identities -> both re-key. */
  assert.deepEqual(planRekeys(existing, [
    { ext: "plaid:NEW1", institution: "American Express", mask: "4007", type: "credit" },
    { ext: "plaid:NEW2", institution: "Wells Fargo", mask: "6404", type: "depository" }
  ]), [
    { accountId: "a1", fromExt: "plaid:OLD1", toExt: "plaid:NEW1" },
    { accountId: "a2", fromExt: "plaid:OLD2", toExt: "plaid:NEW2" }
  ]);
  /* Same id pushed again -> nothing to do. */
  assert.deepEqual(planRekeys(existing, [
    { ext: "plaid:OLD1", institution: "American Express", mask: "4007", type: "credit" }
  ]), []);
  /* Ambiguous: two existing accounts share the identity -> no re-key. */
  assert.deepEqual(planRekeys([...existing,
    { id: "a3", external_id: "plaid:OLD3", institution: "American Express", mask: "4007", type: "credit" }
  ], [
    { ext: "plaid:NEW1", institution: "American Express", mask: "4007", type: "credit" }
  ]), []);
  /* No mask -> no identity -> no re-key. */
  assert.deepEqual(planRekeys(existing, [
    { ext: "plaid:NEW9", institution: "American Express", mask: "", type: "credit" }
  ]), []);
  /* A genuinely new account (new mask) -> no re-key. */
  assert.deepEqual(planRekeys(existing, [
    { ext: "plaid:NEW8", institution: "American Express", mask: "9999", type: "credit" }
  ]), []);
  /* Names: prefix-extended payee strings collide; different ones don't. */
  assert.equal(namesCollide("American Express PAYROLL 000101 CER000760820", "American Express PAYROLL 000101 CER000760820870 Nisarg S"), true);
  assert.equal(namesCollide("ZELLE TO NISARG ON 11/12 REF # WFCT22WAAAA", "ZELLE TO NISARG ON 11/12 REF # WFCT22WAAAA"), true);
  assert.equal(namesCollide("COFFEE SHOP PURCHASE", "ZELLE TO NISARG ON 11/12"), false);
  console.log("planRekeys + namesCollide ok");
}

/* ---------- /api/v2/sync: a reconnect re-keys, never duplicates ---------- */
async function pairedSyncToken(env, deviceToken) {
  const raw = "identity-test-sync-token-0123456789abcdef";
  const tokenHash = await sha256Hex(raw);
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", AUTH, authHeaders(deviceToken)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash, label: "Plaid sync" }, "POST", AUTH));
  const fingerprint = (await res.json()).fingerprint;
  await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", AUTH, authHeaders(deviceToken)));
  return raw;
}
{
  const env = { DB: new FakeD1() };
  const device = await setupTestAuth(env);
  const syncTok = await pairedSyncToken(env, device);
  const push = async (accounts, holdings) => {
    const res = await syncPost(makeCtx(env, { accounts, holdings }, "POST", SYNC, authHeaders(syncTok)));
    assert.equal(res.status, 200, "sync push status");
    return res.json();
  };
  const acct = (id, bal) => ({ id, name: "Robinhood individual", institution: "Robinhood", type: "investment", subtype: "brokerage", mask: "3951", balanceCents: bal });
  await push([acct("GEN1", 10000)], [{ accountId: "GEN1", securityId: "SEC1", ticker: "X", quantity: 2, valueCents: 500 }]);
  let rows = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me'").all()).results;
  assert.equal(rows.length, 1);
  const theAccount = rows[0].id;
  /* The reconnect: same account, new feed id, new balance, same holding. */
  await push([acct("GEN2", 12345)], [{ accountId: "GEN2", securityId: "SEC1", ticker: "X", quantity: 2, valueCents: 600 }]);
  rows = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me'").all()).results;
  assert.equal(rows.length, 1, "still exactly one account after the reconnect");
  assert.equal(rows[0].id, theAccount, "same account row");
  assert.equal(rows[0].external_id, "plaid:GEN2", "re-keyed to the new feed id");
  assert.equal(rows[0].balance_cents, 12345, "balance from the new push");
  const holds = (await env.DB.prepare("SELECT * FROM holdings WHERE owner_id = 'me'").all()).results;
  assert.equal(holds.length, 1, "the holding survived the re-key, not deleted as stale");
  assert.equal(holds[0].account_id, theAccount);
  assert.equal(holds[0].value_cents, 600);
  /* A genuinely different account in the same batch is still created. */
  await push([acct("GEN2", 12345), { id: "OTHER", name: "360 Checking", institution: "Capital One", type: "depository", subtype: "checking", mask: "7447", balanceCents: 150 }], undefined);
  rows = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me'").all()).results;
  assert.equal(rows.length, 2, "a different real account still gets its own row");
  console.log("sync re-key ok");
}

/* ---------- mirror: two generations in the classic snapshot ---------- */
{
  const env = { DB: new FakeD1() };
  await setupTestAuth(env);
  const ins = async (sql, ...binds) => { await env.DB.prepare(sql).bind(...binds).run(); };
  await ins("INSERT INTO bank_accounts (plaid_account_id, institution, name, subtype, mask, current_cents, available_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "GEN_OLD", "Wells Fargo", "Everyday Checking", "checking", "6404", 100, 100, "2026-11-10T00:00:00Z");
  await ins("INSERT INTO bank_accounts (plaid_account_id, institution, name, subtype, mask, current_cents, available_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "GEN_NEW", "Wells Fargo", "Everyday Checking", "checking", "6404", 200, 200, "2026-11-18T00:00:00Z");
  const tx = (id, acct, date, name, amt) => ins("INSERT INTO bank_transactions (plaid_transaction_id, account_id, date, name, amount_cents, pending, pfc) VALUES (?, ?, ?, ?, ?, 0, '')", id, acct, date, name, amt);
  await tx("tx_old_1", "GEN_OLD", "2026-11-12", "ZELLE TO NISARG ON 11/12 REF # WFCT22WAAAA", 78411);
  await tx("tx_new_1", "GEN_NEW", "2026-11-12", "ZELLE TO NISARG ON 11/12 REF # WFCT22WAAAA", 78411);
  await tx("tx_old_2", "GEN_OLD", "2026-11-05", "COFFEE SHOP PURCHASE 1234", 500);
  await tx("tx_old_3", "GEN_OLD", "2026-11-13", "American Express PAYROLL 000101 CER000760820", -110000);
  await tx("tx_new_3", "GEN_NEW", "2026-11-13", "American Express PAYROLL 000101 CER000760820870 Nisarg Himanshukumar S", -110000);
  const out = await mirrorV1(env.DB);
  assert.equal(out.skipped, false);
  const accts = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me' AND source = 'plaid'").all()).results;
  assert.equal(accts.length, 1, "one v2 account for both generations");
  assert.equal(accts[0].external_id, "plaid:GEN_NEW", "the newest generation owns the account");
  const txs = (await env.DB.prepare("SELECT * FROM transactions WHERE owner_id = 'me' AND source = 'v1bank' ORDER BY date").all()).results;
  assert.equal(txs.length, 3, "each real bank transaction mirrored exactly once");
  assert.ok(txs.every((t) => t.account_id === accts[0].id), "all mirrored rows sit on the one account");
  assert.deepEqual(txs.map((t) => t.amount_cents).sort((a, b) => a - b), [-78411, -500, 110000] /* v2 sign: money out is negative, the paycheck inflow positive */);
  console.log("mirror generations ok");
}

/* ---------- merge_accounts: the duplicate is gone, history kept ---------- */
{
  const env = { DB: new FakeD1() };
  const device = await setupTestAuth(env);
  const mintRes = await authPost(makeCtx(env, { action: "mcp-create", label: "Test MCP" }, "POST", AUTH, authHeaders(device)));
  const mcpToken = (await mintRes.json()).token;
  const call = async (name, args) => {
    const res = await mcpPost(makeCtx(env, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args || {} } }, "POST", MCP, authHeaders(mcpToken)));
    assert.equal(res.status, 200, name + " http status");
    return (await res.json()).result;
  };
  await call("list_accounts", {}); /* forces the v2 schema to exist */
  const ins = async (sql, ...binds) => { await env.DB.prepare(sql).bind(...binds).run(); };
  const acct = (id, ext, type, stmt) => ins("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, source, statement_start, statement_end, due_date) VALUES (?, 'me', ?, 'Wells Fargo', 'Wells Fargo', ?, 'checking', '6404', 100, 'plaid', ?, ?, ?)",
    id, ext, type, stmt, stmt, stmt);
  await acct("acc_from", "plaid:OLD", "depository", "2026-11-01");
  await acct("acc_to", "plaid:NEW", "depository", null);
  await acct("acc_card", "plaid:CARD", "credit", null);
  const txIns = (id, acctId, ext, source, date, merchant, amt) => ins("INSERT INTO transactions (id, owner_id, external_id, source, account_id, date, merchant, description, amount_cents) VALUES (?, 'me', ?, ?, ?, ?, ?, ?, ?)",
    id, ext, source, acctId, date, merchant, merchant, amt);
  await txIns("tx_dup_from", "acc_from", "bank:old1", "v1bank", "2026-11-12", "ZELLE TO NISARG ON 11/12 REF # WFCT22WAAAA", -78411);
  await txIns("tx_dup_to", "acc_to", "bank:new1", "v1bank", "2026-11-12", "ZELLE TO NISARG ON 11/12 REF # WFCT22WAAAA", -78411);
  await txIns("tx_unique", "acc_from", "bank:old2", "v1bank", "2026-11-05", "COFFEE SHOP PURCHASE 1234", -500);
  await txIns("tx_manual", "acc_from", null, "manual", "2026-11-13", "American Express PAYROLL", 110000);
  await txIns("tx_mirror_to", "acc_to", "bank:new3", "v1bank", "2026-11-13", "American Express PAYROLL 000101 CER000760820870", 110000);
  await ins("INSERT INTO holdings (owner_id, account_id, security_id, ticker, quantity, value_cents) VALUES ('me', 'acc_from', 'SEC1', 'X', 1, 100)");
  await ins("INSERT INTO holdings (owner_id, account_id, security_id, ticker, quantity, value_cents) VALUES ('me', 'acc_from', 'SEC2', 'Y', 3, 300)");
  await ins("INSERT INTO holdings (owner_id, account_id, security_id, ticker, quantity, value_cents) VALUES ('me', 'acc_to', 'SEC1', 'X', 1, 100)");
  await ins("INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES ('me', 'acc_from', '2026-11-17', 100)");
  await ins("INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES ('me', 'acc_from', '2026-11-18', 100)");
  await ins("INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES ('me', 'acc_to', '2026-11-18', 200)");

  /* Different types refuse. */
  const bad = await call("merge_accounts", { fromId: "acc_from", toId: "acc_card" });
  assert.equal(bad.isError, true, "merging across types is refused");

  const out = JSON.parse((await call("merge_accounts", { fromId: "acc_from", toId: "acc_to" })).content[0].text);
  assert.equal(out.removedDuplicates, 1, "the duplicated Zelle copy was removed");
  assert.equal(out.movedTransactions, 2, "the unique row and the manual row moved");
  const accts = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me' AND id IN ('acc_from', 'acc_to')").all()).results;
  assert.equal(accts.length, 1, "the source account is deleted, not hidden");
  assert.equal(accts[0].id, "acc_to");
  assert.equal(accts[0].statement_start, "2026-11-01", "statement fields filled from the source");
  const txs = (await env.DB.prepare("SELECT * FROM transactions WHERE owner_id = 'me' AND account_id = 'acc_to'").all()).results;
  assert.equal(txs.length, 4, "target keeps its 2 rows + the 2 moved rows");
  assert.equal(txs.filter((t) => t.amount_cents === -78411).length, 1, "the Zelle counts once");
  assert.equal(txs.filter((t) => t.amount_cents === 110000).length, 2, "manual entry moved alongside the target's own mirror row");
  const holds = (await env.DB.prepare("SELECT * FROM holdings WHERE owner_id = 'me' AND account_id = 'acc_to' ORDER BY security_id").all()).results;
  assert.deepEqual(holds.map((h) => h.security_id), ["SEC1", "SEC2"], "holdings merged without duplication");
  const snaps = (await env.DB.prepare("SELECT * FROM balance_snapshots WHERE owner_id = 'me' AND account_id = 'acc_to' ORDER BY date").all()).results;
  assert.deepEqual(snaps.map((s) => [s.date, s.balance_cents]), [["2026-11-17", 100], ["2026-11-18", 200]], "snapshots merged, target's day wins");
  console.log("merge_accounts ok");
}

console.log("account-identity.test.mjs: all passed");
