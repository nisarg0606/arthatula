/*
 * MCP server tests (/api/mcp + the 'mcp' session kind).
 * Covers: setup-mode 403, no/bad token 401, sync token 403, minting via
 * POST /api/auth action "mcp-create" (device-only; the mcp token itself
 * can't mint or manage anything), the mcp token refused on the raw API
 * routes, the JSON-RPC handshake (initialize negotiation, ping,
 * notifications -> 202, unknown method -32601, bad JSON -32700), the
 * tool list, and every tool — including add/update/delete running the
 * shared expense cores (the month's actuals re-roll) and request_sync
 * deduping like the Sync now button; the v2 money-model reads
 * (list_accounts, list_transactions, get_budget_status) see expenses
 * added through MCP via the v1 mirror. Revoking the session kills the
 * token immediately.
 * Run: node tests/mcp.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { onRequestPost as mcpPost, onRequestGet as mcpGet } from "../functions/api/mcp.js";
import { onRequestPost as authPost, onRequestGet as authGet } from "../functions/api/auth.js";
import { onRequestGet as expGet } from "../functions/api/expenses.js";
import { onRequestGet as v2txGet } from "../functions/api/v2/transactions.js";
import { sha256Hex, createSessionForTokenHash, upsertBankData } from "../functions/api/budget.js";
import { CATEGORIES } from "../functions/api/_categories.js";

const MCP = "http://local/api/mcp";
const rpc = (env, token, msg) => mcpPost(makeCtx(env, msg, "POST", MCP, authHeaders(token)));
async function call(env, token, name, args) {
  const res = await rpc(env, token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args || {} } });
  assert.equal(res.status, 200, name + " http status");
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.ok(body.result, name + " returns a result");
  return body.result;
}
const okText = (result) => JSON.parse(result.content[0].text);

/* ---------- 1. Guards: setup mode, no token, bad token, sync token -- */
{
  const env = { DB: new FakeD1() };
  const preSetup = await rpc(env, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(preSetup.status, 403, "pre-setup: 403");
  assert.equal((await preSetup.json()).setupRequired, true);

  const device = await setupTestAuth(env);
  const noTok = await rpc(env, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(noTok.status, 401, "no token: 401");
  const badTok = await rpc(env, "not-a-real-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(badTok.status, 401, "bad token: 401");

  await createSessionForTokenHash(env.DB, { kind: "sync", label: "Test sync", tokenHash: await sha256Hex("sync-raw-token") });
  const syncTok = await rpc(env, "sync-raw-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(syncTok.status, 403, "sync token: 403 on /api/mcp");

  /* GET is refused too: 401 without a token, 405 with one. */
  assert.equal((await mcpGet(makeCtx(env, undefined, "GET", MCP))).status, 401);
  assert.equal((await mcpGet(makeCtx(env, undefined, "GET", MCP, authHeaders(device)))).status, 405);

  /* ---------- 2. Minting: device-only, token shown once, listed ------ */
  const mintRes = await authPost(makeCtx(env, { action: "mcp-create", label: "Test MCP" }, "POST", "http://local/api/auth", authHeaders(device)));
  assert.equal(mintRes.status, 200, "device can mint");
  const mint = await mintRes.json();
  assert.ok(typeof mint.token === "string" && mint.token.length >= 32, "raw token returned once");
  assert.equal(mint.session.kind, "mcp");
  assert.equal(mint.session.label, "Test MCP");
  assert.ok(!JSON.stringify(mint).includes(await sha256Hex(mint.token)), "the stored hash is never returned");
  const mcpToken = mint.token;
  const mcpSessionId = mint.session.id;

  /* An mcp token cannot mint another one (or manage anything). */
  const mintByMcp = await authPost(makeCtx(env, { action: "mcp-create" }, "POST", "http://local/api/auth", authHeaders(mcpToken)));
  assert.equal(mintByMcp.status, 403, "mcp token can't call /api/auth actions");

  /* Sessions list shows the mcp session with its kind. */
  const listRes = await authGet(makeCtx(env, undefined, "GET", "http://local/api/auth?action=sessions", authHeaders(device)));
  const sessions = (await listRes.json()).sessions;
  assert.ok(sessions.some((s) => s.id === mcpSessionId && s.kind === "mcp"), "mcp session listed");

  /* ---------- 3. Least privilege: mcp token on the raw API ---------- */
  const rawApi = await expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", authHeaders(mcpToken)));
  assert.equal(rawApi.status, 403, "mcp token refused on /api/expenses");
  assert.match((await rawApi.json()).error, /MCP tokens can only use/);
  const v2Api = await v2txGet(makeCtx(env, undefined, "GET", "http://local/api/v2/transactions", authHeaders(mcpToken)));
  assert.equal(v2Api.status, 403, "mcp token refused on /api/v2/*");
  const logoutByMcp = await authPost(makeCtx(env, { action: "logout" }, "POST", "http://local/api/auth", authHeaders(mcpToken)));
  assert.equal(logoutByMcp.status, 403, "mcp token can't even call /api/auth logout");

  /* ---------- 4. JSON-RPC handshake --------------------------------- */
  const init = await (await rpc(env, mcpToken, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } }
  })).json();
  assert.equal(init.result.protocolVersion, "2025-03-26", "negotiates a supported version");
  assert.equal(init.result.serverInfo.name, "arthatula");
  assert.ok(init.result.capabilities.tools, "tools capability advertised");

  const initNew = await (await rpc(env, mcpToken, {
    jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2999-01-01" }
  })).json();
  assert.equal(initNew.result.protocolVersion, "2025-06-18", "unknown version falls back to latest supported");

  const notif = await rpc(env, mcpToken, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif.status, 202, "notifications get 202, no body");

  const ping = await (await rpc(env, mcpToken, { jsonrpc: "2.0", id: 3, method: "ping" })).json();
  assert.deepEqual(ping.result, {});

  const unknown = await (await rpc(env, mcpToken, { jsonrpc: "2.0", id: 4, method: "foo/bar" })).json();
  assert.equal(unknown.error.code, -32601, "unknown method -> -32601");

  const badJson = await mcpPost({
    env, request: new Request(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(mcpToken) },
      body: "{oops"
    })
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, -32700, "bad JSON -> -32700");

  /* A device token may also use the MCP endpoint (it is strictly more
     powerful everywhere else anyway). */
  const listAsDevice = await rpc(env, device, { jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(listAsDevice.status, 200, "device token works on /api/mcp");

  /* ---------- 5. Tool list ------------------------------------------ */
  const list = await (await rpc(env, mcpToken, { jsonrpc: "2.0", id: 6, method: "tools/list" })).json();
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_expense", "categorize_expense", "delete_expense", "get_bank_snapshot",
    "get_budget", "get_budget_status", "get_sync_status", "list_accounts", "list_cards",
    "list_expenses", "list_pending_charges", "list_transactions", "request_sync", "update_expense"
  ]);
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, "object", t.name + " has an object schema");
    assert.ok(t.description.length > 10, t.name + " has a description");
  }
  const addTool = list.result.tools.find((t) => t.name === "add_expense");
  assert.deepEqual(addTool.inputSchema.required.sort(), ["amount", "date", "description"]);
  assert.deepEqual(addTool.inputSchema.properties.category.enum, CATEGORIES, "category enum mirrors _categories");

  /* ---------- 6. Expense tools run the shared cores ------------------ */
  const added = await call(env, mcpToken, "add_expense", {
    date: "2026-11-05", description: "Weekly groceries run", amount: 42.5, category: "Groceries"
  });
  assert.ok(!added.isError, "add_expense ok");
  const exp1 = added.structuredContent.expense;
  assert.equal(exp1.amount, 42.5);
  assert.equal(exp1.category, "Groceries");
  assert.equal(exp1.categorizationSource, "manual");
  assert.ok(Number.isInteger(exp1.id));

  const auto = await call(env, mcpToken, "add_expense", {
    date: "2026-12-01", description: "MYSTERY MERCHANT 42", amount: 10
  });
  assert.ok(!auto.isError, "auto-categorized add ok");
  assert.ok(CATEGORIES.includes(auto.structuredContent.expense.category), "auto category is a real category");

  const invalid = await call(env, mcpToken, "add_expense", { description: "No date", amount: 5 });
  assert.equal(invalid.isError, true, "validation failure is a tool error");
  assert.match(invalid.content[0].text, /date/);

  const nov = await call(env, mcpToken, "list_expenses", { month: "2026-11" });
  assert.equal(nov.structuredContent.total, 1, "month filter");
  assert.equal(nov.structuredContent.expenses[0].id, exp1.id);
  const bySearch = await call(env, mcpToken, "list_expenses", { search: "GROCERIES RUN" });
  assert.equal(bySearch.structuredContent.total, 1, "search is case-insensitive");
  const byCategory = await call(env, mcpToken, "list_expenses", { category: "Groceries" });
  assert.ok(byCategory.structuredContent.expenses.some((e) => e.id === exp1.id), "category filter");
  const badMonth = await call(env, mcpToken, "list_expenses", { month: "Nov" });
  assert.equal(badMonth.isError, true, "bad month rejected");

  /* The rollup ran: November actuals carry the grocery spend. */
  const budget1 = await call(env, mcpToken, "get_budget");
  const novActual = budget1.structuredContent.actuals.find((a) => a.monthKey === "2026-11");
  assert.equal(novActual.entered, true);
  assert.equal(novActual.groceries, 42.5);
  assert.ok(budget1.structuredContent.dailyExpenses.some((e) => e.id === exp1.id), "state includes the expense");

  const updated = await call(env, mcpToken, "update_expense", { id: exp1.id, patch: { amount: 50 } });
  assert.equal(updated.structuredContent.expense.amount, 50);
  const budget2 = await call(env, mcpToken, "get_budget");
  assert.equal(budget2.structuredContent.actuals.find((a) => a.monthKey === "2026-11").groceries, 50, "rollup follows edits");
  const updMissing = await call(env, mcpToken, "update_expense", { id: 999999, patch: { amount: 1 } });
  assert.equal(updMissing.isError, true, "updating a missing expense is a tool error");

  /* ---------- 6b. v2 money-model reads see the MCP expense ---------- */
  await upsertBankData(env.DB, {
    accounts: [{ plaidAccountId: "acc-chk", institution: "Test Bank", name: "Checking", subtype: "checking", mask: "0001", currentBalance: 1234.5 }]
  });
  const accts = await call(env, mcpToken, "list_accounts");
  assert.ok(!accts.isError, "list_accounts ok");
  assert.ok(accts.structuredContent.accounts.some((a) => a.name === "Checking" && a.balanceCents === 123450), "bank account mirrored");
  assert.equal(typeof accts.structuredContent.netWorth.netWorthCents, "number");

  const txs = await call(env, mcpToken, "list_transactions", { from: "2026-11-01", to: "2026-11-30" });
  assert.ok(!txs.isError, "list_transactions ok");
  const tx1 = txs.structuredContent.transactions.find((t) => t.v1ExpenseId === exp1.id);
  assert.ok(tx1, "the MCP expense shows up as a transaction");
  assert.equal(tx1.amountCents, -5000, "signed cents, money out");
  assert.equal(tx1.categoryName, "Groceries");
  const txSearch = await call(env, mcpToken, "list_transactions", { search: "groceries run", limit: 1 });
  assert.equal(txSearch.structuredContent.transactions.length, 1, "search + limit");
  const txByCat = await call(env, mcpToken, "list_transactions", { categoryId: tx1.categoryId });
  assert.ok(txByCat.structuredContent.transactions.every((t) => t.categoryId === tx1.categoryId), "category filter");
  const txBad = await call(env, mcpToken, "list_transactions", { from: "Nov 1" });
  assert.equal(txBad.isError, true, "bad date rejected");

  const status = await call(env, mcpToken, "get_budget_status", { month: "2026-11" });
  assert.ok(!status.isError, "get_budget_status ok");
  assert.equal(status.structuredContent.month, "2026-11");
  const groc = status.structuredContent.rows.find((r) => r.categoryName === "Groceries");
  assert.equal(groc.actualCents, 5000, "budget status counts the MCP expense");
  const statusBad = await call(env, mcpToken, "get_budget_status", { month: "2026-13" });
  assert.equal(statusBad.isError, true, "bad month rejected");

  const cat = await call(env, mcpToken, "categorize_expense", { description: "NETFLIX.COM", amount: 15 });
  assert.ok(!cat.isError && CATEGORIES.includes(cat.structuredContent.category), "categorize preview");

  const deleted = await call(env, mcpToken, "delete_expense", { id: exp1.id });
  assert.equal(deleted.structuredContent.deleted, exp1.id);
  const novAfter = await call(env, mcpToken, "list_expenses", { month: "2026-11" });
  assert.equal(novAfter.structuredContent.total, 0, "delete removes it");
  const delAgain = await call(env, mcpToken, "delete_expense", { id: exp1.id });
  assert.equal(delAgain.isError, true, "deleting twice is a tool error");

  const unknownTool = await call(env, mcpToken, "nope_tool", {});
  assert.equal(unknownTool.isError, true, "unknown tool is a tool error");

  /* ---------- 7. Read snapshots + sync queue ------------------------- */
  const bank = await call(env, mcpToken, "get_bank_snapshot");
  assert.ok(Array.isArray(bank.structuredContent.accounts), "bank snapshot shape");
  const pending = await call(env, mcpToken, "list_pending_charges");
  assert.ok(Array.isArray(pending.structuredContent.transactions), "pending snapshot shape");
  const cards = await call(env, mcpToken, "list_cards");
  assert.ok(Array.isArray(cards.structuredContent.cards), "cards shape");

  const status0 = await call(env, mcpToken, "get_sync_status");
  assert.equal(status0.structuredContent.request, null, "no sync requests yet");
  const req1 = await call(env, mcpToken, "request_sync");
  assert.equal(req1.structuredContent.created, true);
  assert.equal(req1.structuredContent.request.status, "pending");
  const req2 = await call(env, mcpToken, "request_sync");
  assert.equal(req2.structuredContent.created, false, "second request dedupes");
  assert.equal(req2.structuredContent.request.id, req1.structuredContent.request.id);
  const status1 = await call(env, mcpToken, "get_sync_status");
  assert.equal(status1.structuredContent.request.id, req1.structuredContent.request.id);

  /* ---------- 8. Revoke kills the token ------------------------------ */
  const revoke = await authPost(makeCtx(env, { action: "revoke", id: mcpSessionId }, "POST", "http://local/api/auth", authHeaders(device)));
  assert.equal(revoke.status, 200);
  const afterRevoke = await rpc(env, mcpToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(afterRevoke.status, 401, "revoked mcp token is dead");
}

console.log("mcp.test.mjs: all assertions passed");
