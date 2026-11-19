/*
 * Merge aliases: the long-term fix for feed switches. A merge is
 * recorded (account_aliases), and every ingest path — the classic
 * mirror, the Plaid push, the SimpleFIN sync — resolves a
 * merged-away feed id to the survivor instead of resurrecting the
 * duplicate. Also covers duplicate detection: when two feeds carry
 * the same real account, the user is told once.
 * Run: node tests/account-alias.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { findDuplicateIdentities } from "../functions/api/_v2identity.js";
import { ensureV2 } from "../functions/api/_v2db.js";
import { mirrorV1 } from "../functions/api/_v2mirror.js";
import * as accounts from "../functions/api/v2/accounts.js";
import * as simplefin from "../functions/api/v2/simplefin.js";

const B = "http://local/api/v2/";
async function call(env, token, mod, method, route, body) {
  const fn = mod["onRequest" + method[0] + method.slice(1).toLowerCase()];
  const res = await fn(makeCtx(env, body, method, B + route, authHeaders(token)));
  return { status: res.status, data: JSON.parse(await res.text()) };
}
const ins = (env) => async (sql, ...binds) => { await env.DB.prepare(sql).bind(...binds).run(); };
const acctIns = (env) => (id, ext, name, type, mask, source, bal) =>
  ins(env)("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, source) VALUES (?, 'me', ?, ?, 'Bank', ?, '', ?, ?, ?)",
    id, ext, name, type, mask, bal === undefined ? 100 : bal, source);

/* ---------- findDuplicateIdentities: pure ---------- */
{
  const rows = [
    { id: "a", external_id: "plaid:P1", name: "Everyday Checking", mask: "6404", type: "depository" },
    { id: "b", external_id: "sfin:S1", name: "Everyday Checking (6404)", mask: "", type: "depository" },
    { id: "c", external_id: "sfin:S2", name: "Savings (9999)", mask: "", type: "depository" }
  ];
  const dupes = findDuplicateIdentities(rows);
  assert.equal(dupes.length, 1);
  assert.deepEqual(dupes[0].accounts.map((r) => r.id).sort(), ["a", "b"]);
  assert.deepEqual(findDuplicateIdentities([rows[0]]), []);
  console.log("findDuplicateIdentities ok");
}

/* ---------- a merge writes its alias; a chained merge re-points it ---------- */
{
  const env = { DB: new FakeD1() };
  const token = await setupTestAuth(env);
  await ensureV2(env.DB);
  const acct = acctIns(env);
  await acct("acc_a", "plaid:A", "Everyday Checking", "depository", "6404", "plaid");
  await acct("acc_b", "sfin:B", "Everyday Checking (6404)", "depository", "", "simplefin");
  await acct("acc_c", "sfin:C", "Everyday Checking (6404)", "depository", "", "simplefin");

  const r1 = await call(env, token, accounts, "POST", "accounts", { fromId: "acc_a", toId: "acc_b" });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.merged, "acc_a");
  let aliases = (await env.DB.prepare("SELECT * FROM account_aliases WHERE owner_id = 'me'").all()).results;
  assert.deepEqual(aliases.map((a) => [a.external_id, a.account_id]), [["plaid:A", "acc_b"]],
    "the merged-away feed id now points at the survivor");

  const r2 = await call(env, token, accounts, "POST", "accounts", { fromId: "acc_b", toId: "acc_c" });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  aliases = (await env.DB.prepare("SELECT * FROM account_aliases WHERE owner_id = 'me' ORDER BY external_id").all()).results;
  assert.deepEqual(aliases.map((a) => [a.external_id, a.account_id]),
    [["plaid:A", "acc_c"], ["sfin:B", "acc_c"]],
    "the older alias followed the chain to the final survivor");
  console.log("merge aliases ok");
}

/* ---------- the mirror: a recorded alias beats identity matching ---------- */
{
  const env = { DB: new FakeD1() };
  await setupTestAuth(env);
  await ensureV2(env.DB);
  const i = ins(env);
  await i("INSERT INTO bank_accounts (plaid_account_id, institution, name, subtype, mask, current_cents, available_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "PLAID_WF", "Wells Fargo", "Everyday Checking", "checking", "6404", 200, 200, "2026-11-18T00:00:00Z");
  await i("INSERT INTO bank_transactions (plaid_transaction_id, account_id, date, name, amount_cents, pending, pfc) VALUES (?, ?, ?, ?, ?, 0, '')",
    "btx_1", "PLAID_WF", "2026-11-12", "COFFEE SHOP PURCHASE 1234", 500);
  const acct = acctIns(env);
  await acct("acc_identity", "sfin:I", "Everyday Checking (6404)", "depository", "", "simplefin");
  await acct("acc_alias", "sfin:J", "Savings (9999)", "depository", "", "simplefin");
  await i("INSERT INTO account_aliases (owner_id, external_id, account_id) VALUES ('me', 'plaid:PLAID_WF', 'acc_alias')");
  await mirrorV1(env.DB);
  const accts = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me'").all()).results;
  assert.equal(accts.length, 2, "no classic account is resurrected");
  const txs = (await env.DB.prepare("SELECT * FROM transactions WHERE owner_id = 'me' AND source = 'v1bank'").all()).results;
  assert.equal(txs.length, 1);
  assert.equal(txs[0].account_id, "acc_alias", "the recorded merge target wins over the identity lookalike");
  console.log("mirror alias ok");
}

/* ---------- SimpleFIN sync: a merged-away account stays merged ---------- */
const CLAIM = "https://bridge.example/simplefin/claim/abc123";
const ACCESS = "https://user1:s3cret@bridge.example/simplefin";
const day = (iso) => Date.parse(iso + "T12:00:00Z") / 1000;
function mockFetch(set) {
  globalThis.fetch = async (url) => {
    if (url === CLAIM) return new Response(ACCESS);
    assert.ok(url.startsWith("https://bridge.example/simplefin/accounts?start-date="), url);
    return new Response(JSON.stringify(set));
  };
}
{
  const env = { DB: new FakeD1() };
  const token = await setupTestAuth(env);
  await ensureV2(env.DB);
  const acct = acctIns(env);
  await acct("acc_surv", "plaid:X1", "Everyday Checking", "depository", "6404", "plaid");
  await ins(env)("INSERT INTO account_aliases (owner_id, external_id, account_id) VALUES ('me', 'sfin:chk1', 'acc_surv')");
  mockFetch({
    connections: [{ conn_id: "c1", name: "Wells Fargo" }],
    accounts: [{ id: "chk1", name: "Everyday Checking", conn_id: "c1", currency: "USD",
      balance: "1520.10", "balance-date": day("2026-11-25"),
      transactions: [
        { id: "t1", posted: day("2026-11-22"), amount: "-12.34", description: "TRADER JOES #123" },
        { id: "t2", posted: day("2026-11-23"), amount: "2500.00", description: "ACME PAYROLL" }
      ] }]
  });
  const out = await call(env, token, simplefin, "POST", "simplefin", { setupToken: btoa(CLAIM) });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.added, 2);
  const all = (await env.DB.prepare("SELECT * FROM accounts WHERE owner_id = 'me'").all()).results;
  assert.equal(all.length, 1, "the SimpleFIN account was not recreated");
  assert.equal(all[0].id, "acc_surv");
  assert.equal(all[0].balance_cents, 152010, "the survivor's balance follows the surviving feed");
  const txs = (await env.DB.prepare("SELECT * FROM transactions WHERE owner_id = 'me' AND account_id = 'acc_surv'").all()).results;
  assert.equal(txs.length, 2, "the feed's transactions import into the survivor");
  console.log("simplefin alias ok");
}

/* ---------- duplicate detection: told once, not every sync ---------- */
{
  const env = { DB: new FakeD1() };
  const token = await setupTestAuth(env);
  await ensureV2(env.DB);
  const acct = acctIns(env);
  await acct("acc_p", "plaid:P9", "Everyday Checking", "depository", "6404", "plaid");
  mockFetch({
    connections: [{ conn_id: "c1", name: "Wells Fargo" }],
    accounts: [{ id: "chk9", name: "Everyday Checking (6404)", conn_id: "c1", currency: "USD",
      balance: "10.00", "balance-date": day("2026-11-25"), transactions: [] }]
  });
  await call(env, token, simplefin, "POST", "simplefin", { setupToken: btoa(CLAIM) });
  let notes = (await env.DB.prepare("SELECT * FROM notifications WHERE title = 'Possible duplicate accounts'").all()).results;
  assert.equal(notes.length, 1, "connecting a second feed for the same account is flagged");
  await call(env, token, simplefin, "POST", "simplefin", { action: "sync" });
  notes = (await env.DB.prepare("SELECT * FROM notifications WHERE title = 'Possible duplicate accounts'").all()).results;
  assert.equal(notes.length, 1, "the same set of duplicates is not reported twice");
  console.log("duplicate detection ok");
}

console.log("account-alias.test.mjs: all passed");
