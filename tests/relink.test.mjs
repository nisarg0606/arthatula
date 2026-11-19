/*
 * A bank linked again from scratch in Plaid: every account and
 * transaction comes back under a new id. The Bank tab snapshot must
 * fold the old generation into the new one (history kept, each real
 * payment once, expense links / review marks / ignore rules carried
 * over), leave look-alike accounts that are both live alone, and the
 * repair_relinked_accounts tool must fix data from before this existed
 * — on the Bank tab and in the money model — with a dry run first.
 * Run: node tests/relink.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth, authedCtx } from "./_fake-d1.mjs";
import { onRequestGet as bankGet, onRequestPost as bankPost, onRequestPatch as bankPatch } from "../functions/api/bank.js";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { onRequestPost as mcpPost } from "../functions/api/mcp.js";
import { sha256Hex, readState } from "../functions/api/budget.js";
import { planBankRelinks, pairCopies } from "../functions/api/_relink.js";
import { planV2Duplicates } from "../functions/api/_v2merge.js";
import { mirrorV1 } from "../functions/api/_v2mirror.js";

const BANK = "http://local/api/bank";
const AUTH = "http://local/api/auth";
const MCP = "http://local/api/mcp";

async function pairedSyncToken(env, deviceToken) {
  const raw = "relink-test-sync-token-0123456789abcdef";
  const tokenHash = await sha256Hex(raw);
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", AUTH, authHeaders(deviceToken)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash, label: "Plaid sync" }, "POST", AUTH));
  const fingerprint = (await res.json()).fingerprint;
  await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", AUTH, authHeaders(deviceToken)));
  return raw;
}
const rows = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;

/* ---------- planning (pure) ---------- */
{
  const acct = (id, inst, mask, subtype, at) => ({ plaid_account_id: id, institution: inst, mask, subtype, updated_at: at });
  const accounts = [
    acct("OLD_CHK", "Chase", "1111", "checking", "2026-11-18T14:48:00Z"),
    acct("NEW_CHK", "Chase", "1111", "checking", "2026-11-18T14:59:00Z"),
    acct("CARD", "Chase", "1111", "credit card", "2026-11-18T14:59:00Z"), /* same mask, other type: a different account */
    acct("NOMASK_A", "Chase", "", "savings", "2026-11-18T14:48:00Z"),
    acct("NOMASK_B", "Chase", "", "savings", "2026-11-18T14:59:00Z")
  ];
  /* Push mode: the pushed id wins, the unpushed one folds in. */
  assert.deepEqual(planBankRelinks(accounts, ["NEW_CHK", "CARD"]).merges.map((m) => [m.from, m.to]), [["OLD_CHK", "NEW_CHK"]]);
  /* A push that doesn't carry the group touches nothing. */
  assert.deepEqual(planBankRelinks(accounts, ["CARD"]), { merges: [], ambiguous: [] });
  /* Both look-alikes still pushed: ambiguous, never merged. */
  const amb = planBankRelinks(accounts, ["OLD_CHK", "NEW_CHK"]);
  assert.equal(amb.merges.length, 0);
  assert.deepEqual(amb.ambiguous[0].ids.sort(), ["NEW_CHK", "OLD_CHK"]);
  /* Repair mode: newest updated_at wins; a tie is ambiguous. */
  assert.deepEqual(planBankRelinks(accounts, null).merges.map((m) => [m.from, m.to]), [["OLD_CHK", "NEW_CHK"]]);
  const tie = planBankRelinks([acct("A", "Chase", "1111", "checking", "x"), acct("B", "Chase", "1111", "checking", "x")], null);
  assert.equal(tie.merges.length, 0);
  assert.equal(tie.ambiguous.length, 1);

  /* Pairing: date + cent amount + colliding payee, one-to-one. */
  const tx = (id, date, name, amt) => ({ plaid_transaction_id: id, date, name, amount_cents: amt });
  const pairs = pairCopies(
    [tx("o1", "2026-11-12", "ZELLE TO SAM ON 11/12 REF # ABCDEFGH1234", 5000), tx("o2", "2026-11-12", "ZELLE TO SAM ON 11/12 REF # ABCDEFGH1234", 5000), tx("o3", "2026-11-13", "COFFEE SHOP", 500)],
    [tx("n1", "2026-11-12", "ZELLE TO SAM ON 11/12 REF # ABCDEFGH1234", 5000), tx("n3", "2026-11-13", "BOOK STORE", 500)]
  );
  assert.deepEqual(pairs.map((p) => [p.oldTx.plaid_transaction_id, p.newTx.plaid_transaction_id]), [["o1", "n1"]],
    "two identical old payments pair with only the one new copy; a different payee never pairs");
  console.log("planning ok");
}

/* ---------- a sync push after a fresh re-link ---------- */
{
  const env = { DB: new FakeD1() };
  const device = await setupTestAuth(env);
  const sync = await pairedSyncToken(env, device);
  const post = async (body) => {
    const res = await bankPost(authedCtx(env, sync)(body, "POST", BANK));
    assert.equal(res.status, 200, "bank push");
    return res.json();
  };
  const chk = (id) => ({ plaidAccountId: id, institution: "Chase", name: "Everyday Checking", subtype: "checking", mask: "1111", currentBalance: 500, availableBalance: 500 });
  const sav = (id) => ({ plaidAccountId: id, institution: "Ally", name: "Savings", subtype: "savings", mask: "2222", currentBalance: 900, availableBalance: 900 });
  /* Generation 1: months of history. */
  await post({
    syncedAt: "2026-11-18T14:48:00.000Z",
    accounts: [chk("G1_CHK"), sav("G1_SAV")],
    transactions: [
      { id: "g1_old", accountId: "G1_CHK", date: "2026-10-03", name: "GROCERY MART 0042", amount: 40.5, pfc: "FOOD_AND_DRINK" },
      { id: "g1_zelle_in", accountId: "G1_CHK", date: "2026-11-12", name: "Zelle payment from ALEX SAMPLE 1234567", amount: -75, pfc: "TRANSFER_IN" },
      { id: "g1_rent", accountId: "G1_CHK", date: "2026-11-01", name: "RENT PAYMENT PROPERTY MGMT", amount: 1200, pfc: "RENT_AND_UTILITIES" },
      { id: "g1_pending", accountId: "G1_CHK", date: "2026-11-14", name: "ZELLE PAYMENT FROM ALEX SAMPLE 7654321", amount: -20, pending: true, pfc: "TRANSFER_IN" },
      { id: "g1_sav", accountId: "G1_SAV", date: "2026-11-10", name: "INTEREST PAYMENT", amount: -3.1, pfc: "INCOME" }
    ]
  });
  /* The owner's own decisions on generation 1. */
  const patch = async (b) => assert.equal((await bankPatch(authedCtx(env, device)(b, "PATCH", BANK))).status, 200);
  await patch({ txId: "g1_zelle_in", kind: "income" });
  await patch({ txId: "g1_pending", kind: "income" });
  await patch({ ignoreRules: [{ accountId: "G1_CHK", direction: "out", name: "RENT PAYMENT PROPERTY MGMT" }] });
  await env.DB.prepare("INSERT INTO daily_expenses (date, description, amount, category, bank_tx_id) VALUES ('2026-10-03', 'Groceries', 40.5, 'Groceries', 'g1_old')").run();
  const incomeBefore = (await readState(env.DB)).actuals.find((a) => a.monthKey === "2026-11").otherIncome;
  assert.equal(incomeBefore, 95, "two income marks counted: 75 + the pending 20");

  /* Generation 2: the re-link. New ids for everything; the new Item
     only reports the last couple of weeks, where it overlaps. */
  const out = await post({
    syncedAt: "2026-11-18T14:59:00.000Z",
    accounts: [chk("G2_CHK"), sav("G2_SAV")],
    transactions: [
      { id: "g2_zelle_in", accountId: "G2_CHK", date: "2026-11-12", name: "Zelle payment from ALEX SAMPLE 1234567", amount: -75, pfc: "TRANSFER_IN" },
      { id: "g2_rent", accountId: "G2_CHK", date: "2026-11-01", name: "RENT PAYMENT PROPERTY MGMT", amount: 1200, pfc: "RENT_AND_UTILITIES" },
      { id: "g2_posted", accountId: "G2_CHK", date: "2026-11-16", name: "Zelle payment from ALEX SAMPLE 7654321", amount: -20, pfc: "TRANSFER_IN" },
      { id: "g2_sav", accountId: "G2_SAV", date: "2026-11-10", name: "INTEREST PAYMENT", amount: -3.1, pfc: "INCOME" }
    ]
  });
  assert.equal(out.relink.merged.length, 2, "both accounts folded");
  assert.deepEqual(out.relink.ambiguous, []);
  const chkMerge = out.relink.merged.find((m) => m.to === "G2_CHK");
  assert.equal(chkMerge.from, "G1_CHK");
  assert.equal(chkMerge.movedTransactions, 1, "the October payment the new Item doesn't report moved over");
  assert.equal(chkMerge.removedDuplicates, 3, "two overlapping copies + the pending ghost of the posted Zelle");

  const snap = await (await bankGet(authedCtx(env, device)(undefined, "GET", BANK))).json();
  assert.deepEqual(snap.accounts.map((a) => a.id).sort(), ["G2_CHK", "G2_SAV"], "one account per real account");
  assert.deepEqual(snap.transactions.map((t) => t.id).sort(), ["g1_old", "g2_posted", "g2_rent", "g2_sav", "g2_zelle_in"], "every real payment once");
  assert.equal(snap.transactions.find((t) => t.id === "g1_old").accountId, "G2_CHK", "history sits on the new account");
  assert.equal(snap.reviews.g2_zelle_in, "income", "the review mark moved to the copy that stays");
  assert.equal(snap.reviews.g2_posted, "income", "the pending ghost's mark moved to its posted payment");
  assert.equal(snap.reviews.g1_zelle_in, undefined);
  assert.deepEqual(snap.ignoreRules, [{ accountId: "G2_CHK", direction: "out", name: "RENT PAYMENT PROPERTY MGMT" }], "ignore rule follows the account");
  const link = (await rows(env, "SELECT bank_tx_id FROM daily_expenses WHERE description = 'Groceries'"))[0];
  assert.equal(link.bank_tx_id, "g1_old", "an expense on a moved row keeps its link");
  const incomeAfter = (await readState(env.DB)).actuals.find((a) => a.monthKey === "2026-11").otherIncome;
  assert.equal(incomeAfter, 95, "income unchanged: each mark moved, none was dropped");
  const notes = await rows(env, "SELECT title, body FROM notifications WHERE kind = 'sync'");
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Chase Everyday Checking ••1111: 1 older payments kept, 3 duplicates removed/);

  /* The next push is a no-op. */
  const again = await post({ syncedAt: "2026-11-19T07:00:00.000Z", accounts: [chk("G2_CHK"), sav("G2_SAV")], transactions: [] });
  assert.deepEqual(again.relink, { merged: [], ambiguous: [] });
  console.log("push relink ok");
}

/* ---------- an expense on the old copy follows it; a duplicate income mark comes out of actuals ---------- */
{
  const env = { DB: new FakeD1() };
  const device = await setupTestAuth(env);
  const sync = await pairedSyncToken(env, device);
  const post = async (body) => (await bankPost(authedCtx(env, sync)(body, "POST", BANK))).json();
  const acct = (id) => ({ plaidAccountId: id, institution: "Wells Fargo", name: "Checking", subtype: "checking", mask: "6404", currentBalance: 1 });
  const txs = (p) => [
    { id: p + "_cafe", accountId: p.toUpperCase(), date: "2026-11-11", name: "CAFE LUNA 99", amount: 12.75 },
    { id: p + "_in", accountId: p.toUpperCase(), date: "2026-11-12", name: "Zelle payment from JO DOE 111", amount: -50 }
  ];
  /* Both generations in the snapshot at once, as a push before this
     fix left them (the second push here has the old account too, so
     nothing is folded yet). */
  await post({ syncedAt: "2026-11-18T14:48:00.000Z", accounts: [acct("A1")], transactions: txs("a1") });
  await env.DB.prepare("INSERT INTO bank_accounts (plaid_account_id, institution, name, subtype, mask, updated_at) VALUES ('A2', 'Wells Fargo', 'Checking', 'checking', '6404', '2026-11-18T14:59:00.000Z')").run();
  await env.DB.prepare("INSERT INTO bank_transactions (plaid_transaction_id, account_id, date, name, amount_cents) VALUES ('a2_cafe', 'A2', '2026-11-11', 'CAFE LUNA 99', 1275), ('a2_in', 'A2', '2026-11-12', 'Zelle payment from JO DOE 111', -5000)").run();
  await env.DB.prepare("INSERT INTO daily_expenses (date, description, amount, category, bank_tx_id) VALUES ('2026-11-11', 'Lunch', 12.75, 'Eating Out', 'a1_cafe')").run();
  const patch = async (b) => assert.equal((await bankPatch(authedCtx(env, device)(b, "PATCH", BANK))).status, 200);
  await patch({ txId: "a1_in", kind: "income" });
  await patch({ txId: "a2_in", kind: "income" });
  assert.equal((await readState(env.DB)).actuals.find((a) => a.monthKey === "2026-11").otherIncome, 100, "one payment counted twice");

  const out = await post({ syncedAt: "2026-11-19T07:00:00.000Z", accounts: [acct("A2")], transactions: [] });
  assert.equal(out.relink.merged.length, 1);
  assert.equal((await rows(env, "SELECT bank_tx_id FROM daily_expenses WHERE description = 'Lunch'"))[0].bank_tx_id, "a2_cafe", "expense link moved to the copy that stays");
  assert.equal((await rows(env, "SELECT * FROM bank_transactions")).length, 2);
  assert.equal((await readState(env.DB)).actuals.find((a) => a.monthKey === "2026-11").otherIncome, 50, "the duplicate income mark came back out");
  console.log("links + income ok");
}

/* ---------- two live look-alikes are left alone and flagged once ---------- */
{
  const env = { DB: new FakeD1() };
  const device = await setupTestAuth(env);
  const sync = await pairedSyncToken(env, device);
  const post = async (body) => (await bankPost(authedCtx(env, sync)(body, "POST", BANK))).json();
  const a = (id) => ({ id, institution: "Chase", name: "Checking", subtype: "checking", mask: "1111", currentBalance: 1 });
  const body = { syncedAt: "2026-11-18T15:00:00.000Z", accounts: [a("X1"), a("X2")], transactions: [] };
  let out = await post(body);
  assert.equal(out.relink.merged.length, 0);
  assert.equal(out.relink.ambiguous.length, 1);
  out = await post(body);
  assert.equal(out.relink.ambiguous.length, 1);
  assert.equal((await rows(env, "SELECT * FROM bank_accounts")).length, 2, "nothing merged");
  assert.equal((await rows(env, "SELECT * FROM notifications WHERE title = 'Some bank accounts look alike'")).length, 1, "flagged once, not on every push");
  console.log("ambiguous ok");
}

/* ---------- v2 duplicates: planning ---------- */
{
  const r = (id, created, hidden, inc, extra) => Object.assign({ id, institution: "Chase", mask: "6543", type: "credit", name: "Chase", created_at: created, hidden, include_in_net_worth: inc }, extra || {});
  let plan = planV2Duplicates([r("old", "2026-11-01", 1, 0), r("new", "2026-11-18", 0, 1)]);
  assert.deepEqual(plan.merges.map((m) => [m.toId, m.fromIds, m.hidden, m.includeInNetWorth]), [["new", ["old"], 0, 1]]);
  /* The owner left the OLD copy visible: the newest still stays (it's
     what the sync updates) but takes the visible copy's settings. */
  plan = planV2Duplicates([r("old", "2026-11-01", 0, 0), r("new", "2026-11-18", 1, 1)]);
  assert.deepEqual(plan.merges.map((m) => [m.toId, m.hidden, m.includeInNetWorth]), [["new", 0, 0]]);
  plan = planV2Duplicates([r("a", "2026-11-18", 0, 1), r("b", "2026-11-18", 1, 0)]);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  console.log("v2 planning ok");
}

/* ---------- repair_relinked_accounts: data from before this fix ---------- */
{
  const env = { DB: new FakeD1() };
  const device = await setupTestAuth(env);
  const mint = await authPost(makeCtx(env, { action: "mcp-create", label: "Test MCP" }, "POST", AUTH, authHeaders(device)));
  const mcpToken = (await mint.json()).token;
  const call = async (name, args) => {
    const res = await mcpPost(makeCtx(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args || {} } }, "POST", MCP, authHeaders(mcpToken)));
    const out = (await res.json()).result;
    assert.ok(!out.isError, name + ": " + JSON.stringify(out));
    return JSON.parse(out.content[0].text);
  };
  await call("list_accounts", {});
  const ins = async (sql, ...b) => { await env.DB.prepare(sql).bind(...b).run(); };
  /* Bank tab: both generations, as a push before this fix left them. */
  await ins("INSERT INTO bank_accounts (plaid_account_id, institution, name, subtype, mask, updated_at) VALUES ('OLD', 'Chase', 'College', 'checking', '8798', '2026-11-18T14:48:36.385Z'), ('NEW', 'Chase', 'College', 'checking', '8798', '2026-11-18T14:59:50.208Z')");
  await ins("INSERT INTO bank_transactions (plaid_transaction_id, account_id, date, name, amount_cents) VALUES ('t_old_hist', 'OLD', '2026-08-01', 'PAYROLL ACME CORP', -100000), ('t_old_dup', 'OLD', '2026-11-16', 'Zelle payment from CHRIS EXAMPLE 316287', -4000), ('t_new_dup', 'NEW', '2026-11-16', 'Zelle payment from CHRIS EXAMPLE 316287', -4000)");
  /* Money model: the old card was hidden by hand and holds the due dates. */
  await ins("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, source, statement_start, statement_end, due_date, hidden, include_in_net_worth, created_at) VALUES ('acc_old_card', 'me', 'plaid:OLDCARD', 'Chase', 'Chase', 'credit', 'credit card', '6543', 2575, 'plaid', '2026-11-14', '2026-12-13', '2026-12-10', 1, 0, '2026-10-01 00:00:00')");
  await ins("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, source, hidden, include_in_net_worth, created_at) VALUES ('acc_new_card', 'me', 'plaid:NEWCARD', 'Chase', 'Chase', 'credit', 'credit card', '6543', 2575, 'plaid', 0, 1, '2026-11-18 14:59:50')");
  await ins("INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES ('me', 'acc_old_card', '2026-11-10', 9900)");

  const dry = await call("repair_relinked_accounts", {});
  assert.equal(dry.applied, false);
  assert.equal(dry.bankTab.merges.length, 1);
  assert.equal(dry.bankTab.merges[0].removedDuplicates, 1);
  assert.equal(dry.accounts.merges.length, 1);
  assert.equal(dry.accounts.merges[0].keep, "acc_new_card");
  assert.equal((await rows(env, "SELECT * FROM bank_accounts")).length, 2, "dry run changed nothing");
  assert.equal((await rows(env, "SELECT * FROM accounts WHERE owner_id = 'me' AND type = 'credit'")).length, 2, "dry run changed nothing");

  const done = await call("repair_relinked_accounts", { apply: true });
  assert.equal(done.applied, true);
  assert.deepEqual((await rows(env, "SELECT plaid_account_id FROM bank_accounts")).map((r) => r.plaid_account_id), ["NEW"]);
  assert.deepEqual((await rows(env, "SELECT plaid_transaction_id AS id, account_id FROM bank_transactions ORDER BY id")).map((r) => [r.id, r.account_id]),
    [["t_new_dup", "NEW"], ["t_old_hist", "NEW"]]);
  const cards = await rows(env, "SELECT * FROM accounts WHERE owner_id = 'me' AND type = 'credit'");
  assert.equal(cards.length, 1, "one card left in the money model");
  assert.equal(cards[0].id, "acc_new_card");
  assert.equal(cards[0].due_date, "2026-12-10", "due date carried over");
  assert.equal(cards[0].statement_start, "2026-11-14");
  assert.equal(cards[0].hidden, 0);
  assert.equal(cards[0].include_in_net_worth, 1);
  assert.equal((await rows(env, "SELECT * FROM balance_snapshots WHERE owner_id = 'me' AND account_id = 'acc_new_card'")).length, 1, "history moved");

  const rerun = await call("repair_relinked_accounts", { apply: true });
  assert.equal(rerun.bankTab.merges.length + rerun.accounts.merges.length, 0, "nothing left to do");
  console.log("repair tool ok");
}

/* ---------- mirror: a card's due dates go to the visible, newest copy ---------- */
{
  const env = { DB: new FakeD1() };
  await setupTestAuth(env);
  await mirrorV1(env.DB); /* schema */
  const ins = async (sql, ...b) => { await env.DB.prepare(sql).bind(...b).run(); };
  await ins("INSERT INTO credit_cards (name, statement_start, statement_end, due_date) VALUES ('Amex', '2026-11-11', '2026-12-10', '2026-12-05')");
  await ins("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, mask, source, hidden, created_at) VALUES ('acc_a_old', 'me', 'plaid:A_OLD', 'Amex', 'American Express', 'credit', '4007', 'plaid', 1, '2026-10-01 00:00:00')");
  await ins("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, mask, source, hidden, created_at) VALUES ('acc_a_new', 'me', 'plaid:A_NEW', 'Amex', 'American Express', 'credit', '4007', 'plaid', 0, '2026-11-18 14:59:50')");
  await mirrorV1(env.DB, { force: true });
  const byId = Object.fromEntries((await rows(env, "SELECT id, due_date FROM accounts WHERE owner_id = 'me' AND source = 'plaid'")).map((r) => [r.id, r.due_date]));
  assert.equal(byId.acc_a_new, "2026-12-05", "the copy that's shown gets the due date");
  console.log("mirror card dates ok");
}

console.log("relink.test.mjs: all passed");
