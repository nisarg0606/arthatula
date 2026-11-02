/*
 * Arthatula — MCP server (Model Context Protocol), /api/mcp.
 *
 * Lets an AI assistant (Claude, ChatGPT, Cursor, ...) work with this
 * budget through standard MCP tools instead of the raw HTTP API:
 *
 *   Read (classic): get_budget, list_expenses, list_cards,
 *          get_bank_snapshot, list_pending_charges, get_sync_status,
 *          categorize_expense
 *   Read (v2 money model, cents): list_accounts, list_transactions,
 *          get_budget_status, list_categories
 *   Write: add_expense, update_expense, delete_expense, request_sync,
 *          create_category, set_budget (money-model categories/budgets,
 *          the same rows the app's Manage and Budgets screens edit)
 *   About the app itself: send_feedback (builds a GitHub issue link for
 *          the maintainer; files nothing and reads no budget data)
 *
 * Transport: stateless Streamable HTTP — POST JSON-RPC 2.0 messages,
 * get JSON back. No server-side session: every request carries the
 * token, so there is nothing to initialize beyond the handshake.
 *
 * Auth: an 'mcp' session token, minted by the owner in
 * Settings -> Security -> AI assistant (POST /api/auth action
 * "mcp-create", device session only). requireAuth refuses 'mcp'
 * sessions on every other route, so this token can ONLY use the tools
 * below — never the raw API, settings, or session management. Device
 * tokens also work here (they are strictly more powerful everywhere
 * else anyway); sync tokens are refused. Revoke the token any time from
 * the sessions list; it slides on a 90-day window like a device.
 *
 * Expense writes run the shared cores in expenses.js, so validation,
 * auto-categorization, bank auto-linking, dedupe and the monthly
 * rollup behave exactly as they do in the app (and the v2 screens pick
 * the change up through the usual v1 mirror). Tool results return the
 * expense only (not the full app state the HTTP routes return) to keep
 * AI context small.
 */
import {
  ensureTables, requireAuth, readState, listDailyExpenses, listCards,
  getBankSnapshot, getPendingSnapshot, requestSync, getLatestSyncRequest
} from "./budget.js";
import { createExpense, updateExpense, deleteExpense } from "./expenses.js";
import { categorize } from "./categorize.js";
import { CATEGORIES } from "./_categories.js";
import { ensureV2, scope, ownerFor, OWNER_ID, newId } from "./_v2db.js";
import { mirrorV1 } from "./_v2mirror.js";
import { loadAccounts, loadTransactions, loadCategories } from "./_v2store.js";
import { netWorthNow } from "./v2/accounts.js";
import { FEEDBACK_KINDS, FEEDBACK_REPO, TITLE_MAX, DETAILS_MAX, scrub, feedbackUrl } from "../../js/core/feedback.js";
import { monthView } from "./v2/budgets.js";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "arthatula", version: "1.0.0" };
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "No database bound. Bind a D1 database as DB (see README)." } }, 503);
}
function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, status) {
  return json({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }, status || 200);
}
/* MCP tool result: the payload as JSON text plus structuredContent so
   clients can consume either. */
function toolOk(data) {
  const out = data && typeof data === "object" ? data : { value: data };
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}
function toolError(message) {
  return { content: [{ type: "text", text: String(message) }], isError: true };
}
function limitOf(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}
const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: "get_budget",
    description: "The classic budget state: starting balance, baseline date, the 13-month plan (planned amounts per month, dollars), actuals per month, all daily expenses, credit cards, and merchant rules.",
    inputSchema: NO_ARGS
  },
  {
    name: "list_expenses",
    description: "List daily-log expenses (dollars), newest first. Optionally filter by month (YYYY-MM), exact category, and/or a case-insensitive text match on the description; limit caps how many are returned.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Month filter, YYYY-MM" },
        category: { type: "string", enum: CATEGORIES, description: "Exact category filter" },
        search: { type: "string", description: "Case-insensitive substring match on the description" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Max expenses to return (default 200)" }
      },
      additionalProperties: false
    }
  },
  {
    name: "add_expense",
    description: "Add one expense to the daily log. Without a category it is auto-categorized (merchant rules, then Gemini when configured, else keyword rules). The month's actuals re-roll automatically. myShare (optional) is the owner's portion of a shared expense, in dollars.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        description: { type: "string" },
        amount: { type: "number", description: "Amount in dollars" },
        category: { type: "string", enum: CATEGORIES },
        card: { type: "string", description: "Name of the credit card charged (optional)" },
        myShare: { type: "number", description: "Owner's share in dollars, 0..amount (optional)" },
        note: { type: "string", description: "Optional note, up to 500 characters" }
      },
      required: ["date", "description", "amount"],
      additionalProperties: false
    }
  },
  {
    name: "update_expense",
    description: "Update fields of one daily-log expense by id. patch may include date, description, amount, category, card, myShare, note. Setting a category is a manual override. The affected months' actuals re-roll automatically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Expense id (from list_expenses)" },
        patch: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD" },
            description: { type: "string" },
            amount: { type: "number" },
            category: { type: "string", enum: CATEGORIES },
            card: { type: ["string", "null"] },
            myShare: { type: ["number", "null"] },
            note: { type: "string" }
          },
          additionalProperties: false
        }
      },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_expense",
    description: "Delete one daily-log expense by id. The month's actuals re-roll automatically. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Expense id (from list_expenses)" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "list_cards",
    description: "List the credit cards being tracked, with statement periods and due dates.",
    inputSchema: NO_ARGS
  },
  {
    name: "get_bank_snapshot",
    description: "The latest bank snapshot pushed by the sync: accounts with balances and recent bank transactions (Zelle, transfers, charges), including any review marks.",
    inputSchema: NO_ARGS
  },
  {
    name: "list_pending_charges",
    description: "Pending (not yet posted) card charges from the latest sync snapshot. Display-only: they are not expenses and never count toward actuals until they post.",
    inputSchema: NO_ARGS
  },
  {
    name: "categorize_expense",
    description: "Preview which category an expense description would get (merchant rules, then Gemini when configured, else keyword rules) without adding anything.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        amount: { type: "number", description: "Amount in dollars (optional)" }
      },
      required: ["description"],
      additionalProperties: false
    }
  },
  {
    name: "request_sync",
    description: "Ask the bank-sync automation to run now (the same queue as the app's Sync now button). If a sync is already queued or running, returns that request instead of queueing a second one.",
    inputSchema: NO_ARGS
  },
  {
    name: "get_sync_status",
    description: "The latest sync request (from Sync now or this tool): status pending/running/done/failed, timestamps, and the run summary when finished.",
    inputSchema: NO_ARGS
  },
  {
    name: "list_accounts",
    description: "All accounts in the money model (bank, credit, loan, manual) with balances in cents, plus net worth. Credit and loan balances are what is owed (positive).",
    inputSchema: NO_ARGS
  },
  {
    name: "list_transactions",
    description: "Transactions in the money model, newest first. Amounts are signed cents: negative = money out, positive = money in. Hidden rows are left out. Filter by date range, account, category, text, or rows still to review.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First date, YYYY-MM-DD" },
        to: { type: "string", description: "Last date, YYYY-MM-DD" },
        accountId: { type: "string", description: "Account id (from list_accounts)" },
        categoryId: { type: "string", description: "Category id (as returned on transactions / get_budget_status)" },
        search: { type: "string", description: "Case-insensitive match on merchant, description, notes and tags" },
        needsReview: { type: "boolean", description: "Only rows still on To review" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Max rows to return (default 200)" },
        offset: { type: "integer", minimum: 0, description: "Rows to skip (paging)" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_budget_status",
    description: "Budget vs. actual for one month in the money model: per category planned, rolled-over, spent and remaining cents, plus totals.",
    inputSchema: {
      type: "object",
      properties: { month: { type: "string", description: "YYYY-MM" } },
      required: ["month"],
      additionalProperties: false
    }
  },
  {
    name: "list_categories",
    description: "All category groups and categories in the money model: ids, names, kinds (income/expense/transfer), icons. Use a category's id or exact name with set_budget, and its id with list_transactions.",
    inputSchema: NO_ARGS
  },
  {
    name: "create_category",
    description: "Create a category in the money model (the same thing as adding one in the app's Manage -> Categories). It can hold budgets (set_budget), appear in reports, and be assigned to transactions in the app. If a category with that name already exists, the existing one is returned instead of a duplicate. Note: the classic daily log keeps its built-in category list, so expenses added through add_expense cannot use a money-model-only category.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Category name, up to 60 characters" },
        group: { type: "string", description: "Group to file it under, by name (case-insensitive). Defaults to the expense 'Other' group. The category takes the group's kind." },
        icon: { type: "string", description: "Optional emoji shown next to the category in the app" }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "set_budget",
    description: "Set the planned amount for one category in one month, in the money model (signed cents convention: pass amountCents as a positive integer; 0 removes the budget line). The category may be given by name or id. Once a line is set here it belongs to the new app: the classic plan stops updating it. Returns the month's budget status, same shape as get_budget_status.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "YYYY-MM" },
        category: { type: "string", description: "Category name (case-insensitive)" },
        categoryId: { type: "string", description: "Category id (from list_categories); takes precedence over category" },
        amountCents: { type: "integer", minimum: 0, description: "Planned amount in cents; 0 removes the line" },
        rollover: { type: "boolean", description: "Roll what's left into next month (default false)" }
      },
      required: ["month", "amountCents"],
      additionalProperties: false
    }
  },
  {
    name: "send_feedback",
    description: "Send feedback about the Arthatula app itself (a bug, a feature idea, or general feedback) to its maintainer as a PUBLIC GitHub issue in " + FEEDBACK_REPO + ". Not for budget questions. Never put the user's amounts, merchants, account names or other personal data in it; emails, dollar amounts, long numbers and tokens are blanked out anyway. Files nothing by itself: returns a prefilled new-issue URL plus the title and body, for you to open for the user or file with the GitHub CLI / GitHub MCP.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: Object.keys(FEEDBACK_KINDS) },
        title: { type: "string", description: "Short summary, up to " + TITLE_MAX + " characters" },
        details: { type: "string", description: "What happened / the idea, up to " + DETAILS_MAX + " characters" }
      },
      required: ["kind", "title", "details"],
      additionalProperties: false
    }
  }
];

/* The owner's v2 scope, brought up to date with the classic data first
   (the same steps as handleV2 in _v2http.js). */
async function v2Scope(db, session) {
  await ensureV2(db);
  const ownerId = ownerFor(session);
  if (ownerId === OWNER_ID) await mirrorV1(db);
  return scope(db, ownerId);
}
async function categoryNames(s) {
  const names = {};
  (await loadCategories(s)).categories.forEach((c) => { names[c.id] = c.name; });
  return names;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function callTool(db, env, session, name, args) {
  args = args && typeof args === "object" ? args : {};
  switch (name) {
    case "get_budget":
      return toolOk(await readState(db));
    case "list_expenses": {
      if (args.month !== undefined && !/^\d{4}-\d{2}$/.test(String(args.month))) {
        return toolError("month must be YYYY-MM");
      }
      let rows = await listDailyExpenses(db, args.month ? String(args.month) : undefined);
      if (args.category) rows = rows.filter((e) => e.category === args.category);
      if (args.search) {
        const q = String(args.search).toLowerCase();
        rows = rows.filter((e) => (e.description || "").toLowerCase().includes(q));
      }
      const limit = limitOf(args.limit);
      return toolOk({ expenses: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit });
    }
    case "add_expense": {
      const r = await createExpense(db, env, args, false);
      if (r.status >= 400) return toolError(r.data.error || ("add_expense failed (" + r.status + ")"));
      return toolOk({ expense: r.data.expense, duplicate: !!r.data.duplicate, settled: !!r.data.settled });
    }
    case "update_expense": {
      const r = await updateExpense(db, args);
      if (r.status >= 400) return toolError(r.data.error || ("update_expense failed (" + r.status + ")"));
      return toolOk({ expense: r.data.expense });
    }
    case "delete_expense": {
      const id = parseInt(args.id, 10);
      if (!Number.isFinite(id)) return toolError("id must be an integer expense id");
      const r = await deleteExpense(db, id);
      if (r.status >= 400) return toolError(r.data.error || ("delete_expense failed (" + r.status + ")"));
      return toolOk({ deleted: r.data.deleted });
    }
    case "list_cards":
      return toolOk({ cards: await listCards(db) });
    case "get_bank_snapshot":
      return toolOk(await getBankSnapshot(db));
    case "list_pending_charges":
      return toolOk(await getPendingSnapshot(db));
    case "categorize_expense": {
      const description = typeof args.description === "string" ? args.description.trim() : "";
      if (!description) return toolError("description is required");
      return toolOk(await categorize(env, description, args.amount));
    }
    case "request_sync": {
      const r = await requestSync(db);
      return toolOk({ request: r.request, created: r.created });
    }
    case "get_sync_status":
      return toolOk({ request: await getLatestSyncRequest(db) });
    case "list_accounts": {
      const accounts = await loadAccounts(await v2Scope(db, session));
      return toolOk({ accounts, netWorth: netWorthNow(accounts) });
    }
    case "list_transactions": {
      for (const k of ["from", "to"]) {
        if (args[k] !== undefined && !DATE.test(String(args[k]))) return toolError(k + " must be YYYY-MM-DD");
      }
      const s = await v2Scope(db, session);
      let list = (await loadTransactions(s, { from: args.from, to: args.to })).filter((t) => !t.hidden);
      if (args.accountId) list = list.filter((t) => t.accountId === args.accountId);
      if (args.categoryId) list = list.filter((t) => t.categoryId === args.categoryId || t.splits.some((x) => x.categoryId === args.categoryId));
      if (args.needsReview) list = list.filter((t) => t.needsReview);
      const q = typeof args.search === "string" ? args.search.trim().toLowerCase() : "";
      if (q) list = list.filter((t) => (t.merchant + " " + t.description + " " + t.notes + " " + t.tags.join(" ")).toLowerCase().includes(q));
      const limit = limitOf(args.limit);
      const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
      const names = await categoryNames(s);
      const page = list.slice(offset, offset + limit).map((t) => ({ ...t, categoryName: t.categoryId ? names[t.categoryId] || null : null }));
      return toolOk({ transactions: page, total: list.length, truncated: offset + limit < list.length });
    }
    case "get_budget_status": {
      const month = String(args.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return toolError("month must be YYYY-MM");
      const s = await v2Scope(db, session);
      const view = await monthView(s, month);
      const names = await categoryNames(s);
      view.rows = view.rows.map((r) => ({ ...r, categoryName: names[r.categoryId] || null }));
      return toolOk(view);
    }
    case "list_categories": {
      const s = await v2Scope(db, session);
      return toolOk(await loadCategories(s));
    }
    case "create_category": {
      const name = typeof args.name === "string" ? args.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      if (!name) return toolError("name is required");
      const s = await v2Scope(db, session);
      const { groups, categories } = await loadCategories(s);
      const existing = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) return toolOk({ category: existing, created: false });
      let group = null;
      if (typeof args.group === "string" && args.group.trim()) {
        group = groups.find((g) => g.name.toLowerCase() === args.group.trim().toLowerCase()) || null;
        if (!group) return toolError("group not found: " + args.group.trim() + " (groups: " + groups.map((g) => g.name).join(", ") + ")");
      }
      if (!group) group = groups.find((g) => g.kind === "expense" && g.name.toLowerCase() === "other") || groups.find((g) => g.kind === "expense") || null;
      if (!group) return toolError("no group to file the category under");
      const icon = typeof args.icon === "string" ? args.icon.trim().slice(0, 8) : "";
      const max = await s.first("SELECT IFNULL(MAX(sort), 0) AS m FROM categories WHERE owner_id = ?1 AND group_id = ?2", group.id);
      const id = newId("cat_");
      await s.run(
        "INSERT INTO categories (id, owner_id, group_id, name, kind, sort, icon) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)",
        id, group.id, name, group.kind, (max ? max.m : 0) + 1, icon
      );
      const after = await loadCategories(s);
      return toolOk({ category: after.categories.find((c) => c.id === id), created: true });
    }
    case "set_budget": {
      const month = String(args.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return toolError("month must be YYYY-MM");
      const amount = args.amountCents;
      if (!Number.isInteger(amount) || amount < 0) return toolError("amountCents must be a non-negative integer (cents); 0 removes the budget line");
      const s = await v2Scope(db, session);
      const { categories } = await loadCategories(s);
      let cat = null;
      if (args.categoryId) cat = categories.find((c) => c.id === args.categoryId) || null;
      else if (typeof args.category === "string" && args.category.trim()) cat = categories.find((c) => c.name.toLowerCase() === args.category.trim().toLowerCase()) || null;
      else return toolError("category (name) or categoryId is required");
      if (!cat) return toolError("unknown category — call list_categories to see what exists, or create_category to add it");
      if (cat.kind === "transfer") return toolError("transfers aren't budgeted");
      if (amount === 0 && !args.rollover) {
        await s.run("DELETE FROM budgets WHERE owner_id = ?1 AND month = ?2 AND category_id = ?3", month, cat.id);
      } else {
        await s.run(
          "INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) VALUES (?1, ?2, ?3, ?4, ?5, 'user') " +
          "ON CONFLICT(owner_id, month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents, rollover = excluded.rollover, source = 'user'",
          month, cat.id, amount, args.rollover ? 1 : 0
        );
      }
      const view = await monthView(s, month);
      const names = await categoryNames(s);
      view.rows = view.rows.map((r) => ({ ...r, categoryName: names[r.categoryId] || null }));
      return toolOk(view);
    }
    case "send_feedback": {
      if (!FEEDBACK_KINDS[args.kind]) return toolError("kind must be one of: " + Object.keys(FEEDBACK_KINDS).join(", "));
      const rawTitle = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : "";
      const rawDetails = typeof args.details === "string" ? args.details.trim() : "";
      if (!rawTitle) return toolError("title is required");
      if (!rawDetails) return toolError("details is required");
      if (rawTitle.length > TITLE_MAX) return toolError("title is over " + TITLE_MAX + " characters");
      if (rawDetails.length > DETAILS_MAX) return toolError("details is over " + DETAILS_MAX + " characters");
      const title = scrub(rawTitle), details = scrub(rawDetails);
      const context = "Sent from an AI agent via the Arthatula MCP server (send_feedback).";
      return toolOk({
        url: feedbackUrl(args.kind, title, details, context),
        repo: FEEDBACK_REPO,
        title,
        body: details + "\n\n---\n" + context,
        instructions: "Open this link for the user so they can review and submit it, or if you can use the GitHub CLI or GitHub MCP, create the issue in " + FEEDBACK_REPO + " with this title and body. It will be public."
      });
    }
    default:
      return toolError("Unknown tool: " + name);
  }
}

async function handleMessage(db, env, session, msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return rpcError(null, -32600, "Invalid Request: expected a JSON-RPC object");
  }
  const isNotification = msg.id === undefined || msg.id === null || (typeof msg.method === "string" && msg.method.startsWith("notifications/"));
  const method = msg.method;
  if (typeof method !== "string") {
    return isNotification ? null : rpcError(msg.id, -32600, "Invalid Request: method must be a string");
  }
  if (isNotification) return null; /* notifications need no reply */
  try {
    switch (method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
        return rpcResult(msg.id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: "Personal budget for one owner, in USD. The classic tools (expenses, get_budget, cards, bank snapshot) use dollars; the money-model tools (list_accounts, list_transactions, get_budget_status) use signed integer cents (negative = money out). Expenses added here appear in both. Pending charges are display-only until they post."
        });
      }
      case "ping":
        return rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, { tools: TOOLS });
      case "tools/call": {
        const params = msg.params || {};
        if (typeof params.name !== "string") return rpcError(msg.id, -32602, "Invalid params: tool name is required");
        return rpcResult(msg.id, await callTool(db, env, session, params.name, params.arguments));
      }
      default:
        return rpcError(msg.id, -32601, "Method not found: " + method);
    }
  } catch (err) {
    return rpcError(msg.id, -32603, String((err && err.message) || err));
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  try {
    const auth = await requireAuth(db, context.request, { allowMcp: true });
    if (auth.response) return auth.response;
    await ensureTables(db);
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return rpcError(null, -32700, "Parse error: request body must be JSON", 400);
    }
    const accepted = () => new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    if (Array.isArray(body)) {
      const replies = [];
      for (const msg of body) {
        const r = await handleMessage(db, context.env, auth.session, msg);
        if (r) replies.push(await r.json());
      }
      return replies.length ? json(replies) : accepted();
    }
    return (await handleMessage(db, context.env, auth.session, body)) || accepted();
  } catch (err) {
    return rpcError(null, -32603, String((err && err.message) || err), 500);
  }
}

/* Stateless server: there is no server-initiated stream to GET and no
   session to DELETE. */
export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  const auth = await requireAuth(context.env.DB, context.request, { allowMcp: true });
  if (auth.response) return auth.response;
  return rpcError(null, -32600, "This MCP server is stateless: POST JSON-RPC messages instead.", 405);
}
export const onRequestDelete = onRequestGet;
