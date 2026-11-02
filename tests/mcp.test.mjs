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
    "add_account", "add_card", "add_expense", "add_goal",
    "add_recurring", "add_rule", "add_transaction", "apply_rule",
    "categorize_expense", "copy_budget", "create_category", "create_group",
    "delete_account", "delete_card", "delete_category", "delete_expense",
    "delete_goal", "delete_group", "delete_recurring", "delete_rule",
    "delete_transaction", "export_data", "fill_budget", "get_bank_snapshot",
    "get_budget", "get_budget_status", "get_checklist", "get_investments",
    "get_layout", "get_market_recap", "get_merchant_rules", "get_net_worth",
    "get_reports", "get_settings", "get_splitwise", "get_sync_status",
    "import_transactions", "list_accounts", "list_cards", "list_categories",
    "list_expenses", "list_goals", "list_pending_charges", "list_recurring",
    "list_rules", "list_transactions", "request_sync", "resolve_recurring_suggestion",
    "review_all_transactions", "review_bank_transaction", "run_auto_review", "send_feedback",
    "set_actuals", "set_budget", "set_ignore_rules", "set_layout",
    "set_merchant_rules", "update_account", "update_card", "update_category",
    "update_checklist", "update_expense", "update_goal", "update_group",
    "update_plan", "update_recurring", "update_rule", "update_transaction"
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

  /* ---------- 7b. send_feedback: a link, nothing filed ------------- */
  const fb = await call(env, mcpToken, "send_feedback", {
    kind: "bug", title: "Chart & legend overlap?", details: "Paid $1,234.56 to me@example.com\ncard 4111 1111 1111 1111"
  });
  assert.ok(!fb.isError, "send_feedback ok");
  const u = new URL(fb.structuredContent.url);
  assert.equal(u.origin + u.pathname, "https://github.com/nisarg0606/arthatula/issues/new");
  assert.equal(u.searchParams.get("template"), "bug_report.yml");
  assert.equal(u.searchParams.get("title"), "Chart & legend overlap?", "title survives URL encoding");
  assert.ok(fb.structuredContent.url.includes("title=Chart+%26+legend"), "title is encoded");
  const sent = u.searchParams.get("what-happened");
  assert.ok(sent.includes("\n"), "details go to the bug form's field, newlines kept");
  assert.ok(!/1,234|example\.com|4111/.test(sent + fb.structuredContent.body), "amounts, emails and card numbers are blanked");
  assert.match(fb.structuredContent.body, /\[amount\][\s\S]*\[email\][\s\S]*\[number\]/);
  assert.match(fb.structuredContent.instructions, /nisarg0606\/arthatula/);
  const feat = await call(env, mcpToken, "send_feedback", { kind: "feature", title: "Idea", details: "Dark charts" });
  assert.equal(new URL(feat.structuredContent.url).searchParams.get("problem"), "Dark charts");
  for (const [args, re] of [
    [{ kind: "bug", title: "  ", details: "x" }, /title/],
    [{ kind: "rant", title: "t", details: "x" }, /kind/],
    [{ kind: "bug", title: "t", details: "" }, /details/],
    [{ kind: "bug", title: "t".repeat(121), details: "x" }, /120/],
    [{ kind: "bug", title: "t", details: "x".repeat(4001) }, /4000/]
  ]) {
    const bad = await call(env, mcpToken, "send_feedback", args);
    assert.equal(bad.isError, true, "send_feedback rejects " + JSON.stringify(args).slice(0, 60));
    assert.match(bad.content[0].text, re);
  }

  /* ---------- 7b. Categories + budgets via MCP ----------------------- */
  const cats0 = okText(await call(env, mcpToken, "list_categories"));
  const baseCount = cats0.categories.length;
  assert.ok(cats0.groups.length >= 8, "seeded groups listed");
  const fam = await call(env, mcpToken, "create_category", { name: "Family", icon: "F" });
  assert.ok(!fam.isError, "create_category ok");
  assert.equal(fam.structuredContent.created, true);
  assert.equal(fam.structuredContent.category.name, "Family");
  assert.equal(fam.structuredContent.category.kind, "expense", "filed under an expense group");
  const famAgain = await call(env, mcpToken, "create_category", { name: "family" });
  assert.equal(famAgain.structuredContent.created, false, "same name (any case) returns the existing category");
  assert.equal(famAgain.structuredContent.category.id, fam.structuredContent.category.id);
  const cats1 = okText(await call(env, mcpToken, "list_categories"));
  assert.equal(cats1.categories.length, baseCount + 1, "exactly one category added");
  for (const [args, re] of [
    [{}, /name/],
    [{ name: "X", group: "No such group" }, /group not found/]
  ]) {
    const bad = await call(env, mcpToken, "create_category", args);
    assert.equal(bad.isError, true, "create_category rejects " + JSON.stringify(args));
    assert.match(bad.content[0].text, re);
  }
  const set1 = await call(env, mcpToken, "set_budget", { month: "2026-11", category: "Family", amountCents: 120000 });
  assert.ok(!set1.isError, "set_budget ok");
  const famRow = set1.structuredContent.rows.find((r) => r.categoryName === "Family");
  assert.ok(famRow, "budget status shows the Family row");
  assert.equal(famRow.plannedCents, 120000);
  const statusAfter = okText(await call(env, mcpToken, "get_budget_status", { month: "2026-11" }));
  assert.equal(statusAfter.rows.find((r) => r.categoryName === "Family").plannedCents, 120000, "budget persists");
  for (const [args, re] of [
    [{ month: "Nov 2026", category: "Family", amountCents: 100 }, /YYYY-MM/],
    [{ month: "2026-11", category: "Family", amountCents: -5 }, /amountCents/],
    [{ month: "2026-11", category: "Atlantis", amountCents: 100 }, /unknown category/],
    [{ month: "2026-11", amountCents: 100 }, /category/]
  ]) {
    const bad = await call(env, mcpToken, "set_budget", args);
    assert.equal(bad.isError, true, "set_budget rejects " + JSON.stringify(args));
    assert.match(bad.content[0].text, re);
  }
  const set0 = await call(env, mcpToken, "set_budget", { month: "2026-11", categoryId: fam.structuredContent.category.id, amountCents: 0 });
  assert.ok(!set0.isError, "set_budget 0 ok");
  const famRow0 = set0.structuredContent.rows.find((r) => r.categoryName === "Family");
  assert.ok(!famRow0 || famRow0.plannedCents === 0, "amountCents 0 removes the line");

  /* ---------- 7c. Full app parity: plan, cards, bank review, v2 CRUD -- */
  const gbNow = okText(await call(env, mcpToken, "get_budget"));
  const mk1 = gbNow.months[1].monthKey;
  const plan1 = await call(env, mcpToken, "update_plan", { monthKey: mk1, patch: { oneOffs: 123.45, oneOffNote: "parity test" } });
  assert.ok(!plan1.isError, "update_plan ok");
  assert.equal(plan1.structuredContent.month.oneOffs, 123.45);
  assert.equal(plan1.structuredContent.month.oneOffNote, "parity test");
  const act1 = await call(env, mcpToken, "set_actuals", { monthKey: mk1, patch: { takeHomePay: 4321 } });
  assert.ok(!act1.isError, "set_actuals ok");
  assert.equal(act1.structuredContent.actual.takeHomePay, 4321);
  const mr1 = await call(env, mcpToken, "set_merchant_rules", { rules: [{ match: "Parity Mart", category: "Groceries" }] });
  assert.ok(!mr1.isError && mr1.structuredContent.rules.some((r) => r.match === "parity mart"), "merchant rules set");
  const mr2 = okText(await call(env, mcpToken, "get_merchant_rules"));
  assert.ok(mr2.rules.some((r) => r.match === "parity mart"), "merchant rules read back");
  await call(env, mcpToken, "set_merchant_rules", { rules: [] });

  const card1 = await call(env, mcpToken, "add_card", { name: "Parity Visa", statementStart: "2026-11-01", statementEnd: "2026-11-30", dueDate: "2026-12-20" });
  assert.ok(!card1.isError, "add_card ok");
  const cardId = card1.structuredContent.card.id;
  const card2 = await call(env, mcpToken, "update_card", { id: cardId, patch: { dueDate: "2026-12-21" } });
  assert.equal(card2.structuredContent.card.dueDate, "2026-12-21");
  const card3 = await call(env, mcpToken, "delete_card", { id: cardId });
  assert.equal(card3.structuredContent.deleted, cardId);

  const settings1 = okText(await call(env, mcpToken, "get_settings"));
  assert.ok(settings1.ai && settings1.splitwise && settings1.finnhub, "settings flags shape");
  assert.ok(!JSON.stringify(settings1).includes("apiKey"), "no key material in settings");

  await upsertBankData(env.DB, {
    accounts: [{ plaidAccountId: "acc-chk", institution: "Test Bank", name: "Checking", subtype: "checking", mask: "0001", currentBalance: 1234.5 }],
    transactions: [{ id: "bank-tx-par", accountId: "acc-chk", date: "2026-11-03", name: "Inflow from a friend", amount: -250, pfc: "TRANSFER_IN" }]
  });
  const rev1 = await call(env, mcpToken, "review_bank_transaction", { txId: "bank-tx-par", kind: "income" });
  assert.ok(!rev1.isError, "review_bank_transaction ok");
  assert.equal(rev1.structuredContent.reviews["bank-tx-par"], "income");
  const rev2 = await call(env, mcpToken, "review_bank_transaction", { txId: "bank-tx-par", kind: null });
  assert.equal(rev2.structuredContent.reviews["bank-tx-par"], undefined, "review cleared");
  const ign1 = await call(env, mcpToken, "set_ignore_rules", { rules: [{ accountId: "acc-chk", direction: "out", name: "Some Payment" }] });
  assert.equal(ign1.structuredContent.ignoreRules.length, 1, "ignore rules set");
  await call(env, mcpToken, "set_ignore_rules", { rules: [] });

  const cats2 = okText(await call(env, mcpToken, "list_categories"));
  const groceries = cats2.categories.find((c) => c.name === "Groceries");
  const eatingOut = cats2.categories.find((c) => c.name === "Eating Out");
  const grp1 = await call(env, mcpToken, "create_group", { name: "Parity Group" });
  assert.ok(!grp1.isError, "create_group ok");
  const grp = grp1.structuredContent.groups.find((g) => g.name === "Parity Group");
  const grp2 = await call(env, mcpToken, "update_group", { id: grp.id, patch: { name: "Parity Group 2" } });
  assert.ok(grp2.structuredContent.groups.some((g) => g.id === grp.id && g.name === "Parity Group 2"), "group renamed");
  const tmpCat = await call(env, mcpToken, "create_category", { name: "Parity Temp", group: "Parity Group 2" });
  assert.equal(tmpCat.structuredContent.category.groupId, grp.id, "category filed under the new group");
  const catUpd = await call(env, mcpToken, "update_category", { id: tmpCat.structuredContent.category.id, patch: { icon: "T" } });
  assert.equal(catUpd.structuredContent.categories.find((c) => c.id === tmpCat.structuredContent.category.id).icon, "T");
  const catDel = await call(env, mcpToken, "delete_category", { id: tmpCat.structuredContent.category.id, moveTo: groceries.id });
  assert.ok(!catDel.structuredContent.categories.some((c) => c.name === "Parity Temp"), "category deleted");
  const grp3 = await call(env, mcpToken, "delete_group", { id: grp.id });
  assert.ok(!grp3.structuredContent.groups.some((g) => g.id === grp.id), "group deleted");

  const acc1 = await call(env, mcpToken, "add_account", { name: "Cash Stash", type: "cash", balanceCents: 5000 });
  assert.ok(!acc1.isError, "add_account ok");
  const accId = acc1.structuredContent.account.id;
  const acc2 = await call(env, mcpToken, "update_account", { id: accId, patch: { balanceCents: 6000 } });
  assert.equal(acc2.structuredContent.account.balanceCents, 6000);
  const acc3 = await call(env, mcpToken, "delete_account", { id: accId });
  assert.equal(acc3.structuredContent.deleted, accId);

  const tx1p = await call(env, mcpToken, "add_transaction", { date: "2026-11-05", merchant: "Parity Manual", amountCents: -2500, categoryId: groceries.id });
  assert.ok(!tx1p.isError, "add_transaction ok");
  const pTxId = tx1p.structuredContent.transaction.id;
  const tx2p = await call(env, mcpToken, "update_transaction", { id: pTxId, patch: { splits: [{ categoryId: groceries.id, amountCents: -1500 }, { categoryId: eatingOut.id, amountCents: -1000 }] } });
  assert.ok(!tx2p.isError, "update_transaction splits ok");
  assert.equal(tx2p.structuredContent.transaction.splits.length, 2);
  const tx3p = await call(env, mcpToken, "update_transaction", { id: pTxId, patch: { splits: [], notes: "parity note" } });
  assert.equal(tx3p.structuredContent.transaction.notes, "parity note");
  const rall = await call(env, mcpToken, "review_all_transactions");
  assert.equal(typeof rall.structuredContent.updated, "number");
  const tx4p = await call(env, mcpToken, "delete_transaction", { id: pTxId });
  assert.equal(tx4p.structuredContent.deleted, pTxId);

  await call(env, mcpToken, "set_budget", { month: "2026-11", category: "Groceries", amountCents: 50000 });
  const cp1 = await call(env, mcpToken, "copy_budget", { from: "2026-11", to: "2026-12" });
  assert.ok(!cp1.isError, "copy_budget ok");
  assert.equal(cp1.structuredContent.rows.find((r) => r.categoryName === "Groceries").plannedCents, 50000);
  const fl1 = await call(env, mcpToken, "fill_budget", { from: "2026-12", through: "2027-03" });
  assert.ok(Array.isArray(fl1.structuredContent.months), "fill_budget returns months");

  const goal1 = await call(env, mcpToken, "add_goal", { name: "Parity Trip", targetCents: 100000, savedCents: 2500 });
  assert.ok(!goal1.isError, "add_goal ok");
  const goal = goal1.structuredContent.goals.find((g) => g.name === "Parity Trip");
  assert.ok(goal && goal.progress, "goal has progress");
  const goal2 = await call(env, mcpToken, "update_goal", { id: goal.id, patch: { savedCents: 3000 } });
  assert.equal(goal2.structuredContent.goals.find((g) => g.id === goal.id).savedCents, 3000);
  const goal3 = await call(env, mcpToken, "delete_goal", { id: goal.id });
  assert.ok(!goal3.structuredContent.goals.some((g) => g.id === goal.id), "goal deleted");

  const rec1 = await call(env, mcpToken, "add_recurring", { name: "Parity Gym", amountCents: -8800, cadence: "monthly", nextDate: "2026-12-01" });
  assert.ok(!rec1.isError, "add_recurring ok");
  const recItem = rec1.structuredContent.items.find((r) => r.name === "Parity Gym");
  assert.ok(recItem, "recurring item listed");
  const rec2 = await call(env, mcpToken, "update_recurring", { id: recItem.id, patch: { amountCents: -9000 } });
  assert.equal(rec2.structuredContent.items.find((r) => r.id === recItem.id).amountCents, -9000);
  const rec3 = await call(env, mcpToken, "delete_recurring", { id: recItem.id });
  assert.ok(!rec3.structuredContent.items.some((r) => r.id === recItem.id), "recurring deleted");
  const recBad = await call(env, mcpToken, "resolve_recurring_suggestion", { detectKey: "nope", action: "confirm" });
  assert.equal(recBad.isError, true, "bogus suggestion rejected");

  const rule1 = await call(env, mcpToken, "add_rule", { matchText: "Parity Manual", setCategoryId: groceries.id });
  assert.ok(!rule1.isError, "add_rule ok");
  const rule = rule1.structuredContent.rules.find((r) => r.matchText === "Parity Manual");
  const rule2 = await call(env, mcpToken, "apply_rule", { id: rule.id });
  assert.equal(typeof rule2.structuredContent.changed, "number");
  const rule3 = await call(env, mcpToken, "update_rule", { id: rule.id, patch: { addTag: "parity" } });
  assert.equal(rule3.structuredContent.rules.find((r) => r.id === rule.id).addTag, "parity");
  const rule4 = await call(env, mcpToken, "delete_rule", { id: rule.id });
  assert.ok(!rule4.structuredContent.rules.some((r) => r.id === rule.id), "rule deleted");
  const rules1 = okText(await call(env, mcpToken, "list_rules"));
  assert.ok(Array.isArray(rules1.rules), "list_rules shape");

  const auto1 = await call(env, mcpToken, "run_auto_review");
  assert.ok(auto1.isError || typeof auto1.structuredContent.reviewed === "number", "auto review answers (needs an AI key to actually review)");

  const rep1 = okText(await call(env, mcpToken, "get_reports", { kind: "summary", month: "2026-11" }));
  assert.equal(rep1.month, "2026-11");
  assert.equal(typeof rep1.spendingCents, "number");
  const rep2 = okText(await call(env, mcpToken, "get_reports", { kind: "cashflow", from: "2026-10", to: "2026-11" }));
  assert.ok(rep2.months || rep2.rows || rep2.series, "cashflow shape");
  const rep3 = okText(await call(env, mcpToken, "get_reports", { kind: "forecast", months: 3 }));
  assert.equal(rep3.months.length, 3);
  const nw1 = okText(await call(env, mcpToken, "get_net_worth"));
  assert.equal(typeof nw1.current.netWorthCents, "number");
  const inv1 = okText(await call(env, mcpToken, "get_investments"));
  assert.ok(Array.isArray(inv1.accounts) && Array.isArray(inv1.holdings), "investments shape");
  const mkt1 = okText(await call(env, mcpToken, "get_market_recap"));
  assert.equal(typeof mkt1.status, "string");
  const sw1 = okText(await call(env, mcpToken, "get_splitwise"));
  assert.equal(sw1.connected, false, "no Splitwise key in the test env");
  const exp1j = okText(await call(env, mcpToken, "export_data", { format: "json" }));
  assert.equal(exp1j.version, 1);
  assert.ok(Array.isArray(exp1j.transactions), "export json has transactions");
  const exp2c = okText(await call(env, mcpToken, "export_data", { format: "csv" }));
  assert.ok(exp2c.csv.startsWith("Date,Merchant,Amount"), "export csv header");
  const lay1 = okText(await call(env, mcpToken, "get_layout"));
  assert.ok(lay1.order.includes("overview"), "layout default");
  const lay2 = await call(env, mcpToken, "set_layout", { order: ["month", "overview", "market", "ask", "trends"], hidden: ["ask"] });
  assert.equal(lay2.structuredContent.order[0], "month");
  assert.ok(lay2.structuredContent.hidden.includes("ask"), "layout saved");
  const chk1 = okText(await call(env, mcpToken, "get_checklist"));
  assert.ok(chk1.items && typeof chk1.items.balance === "boolean", "checklist shape");
  const chk2 = await call(env, mcpToken, "update_checklist", { dismissed: true });
  assert.equal(chk2.structuredContent.dismissed, true);

  const imp1 = await call(env, mcpToken, "import_transactions", {
    newAccount: { name: "Parity Old Bank", type: "depository" },
    rows: [
      { date: "2026-10-01", description: "Opening deposit", amountCents: 10000, balanceCents: 10000 },
      { date: "2026-10-02", description: "Coffee", amountCents: -500, balanceCents: 9500 }
    ]
  });
  assert.ok(!imp1.isError, "import_transactions ok");
  assert.equal(imp1.structuredContent.added, 2);
  const imp2 = await call(env, mcpToken, "import_transactions", {
    accountId: imp1.structuredContent.accountId,
    rows: [
      { date: "2026-10-01", description: "Opening deposit", amountCents: 10000, balanceCents: 10000 },
      { date: "2026-10-02", description: "Coffee", amountCents: -500, balanceCents: 9500 }
    ]
  });
  assert.equal(imp2.structuredContent.added, 0, "re-import dedupes");

  /* ---------- 8. Revoke kills the token ------------------------------ */
  const revoke = await authPost(makeCtx(env, { action: "revoke", id: mcpSessionId }, "POST", "http://local/api/auth", authHeaders(device)));
  assert.equal(revoke.status, 200);
  const afterRevoke = await rpc(env, mcpToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(afterRevoke.status, 401, "revoked mcp token is dead");
}

console.log("mcp.test.mjs: all assertions passed");
