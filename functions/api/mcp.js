/*
 * Arthatula — MCP server (Model Context Protocol), /api/mcp.
 *
 * Lets an AI assistant (Claude, ChatGPT, Cursor, ...) work with this
 * budget through standard MCP tools instead of the raw HTTP API:
 *
 * The tool surface mirrors everything the owner can do in the app
 * (see docs/MCP.md for the full reference). Deliberately NOT exposed:
 * anything credential-shaped — writing API keys (AI/Splitwise/
 * Finnhub/SimpleFIN), the access code, session/device management,
 * pairing/sync tokens — plus sync-only snapshot ingestion, the
 * demo-data load/wipe, and SimpleFIN connect/disconnect. Those stay
 * owner-only by the app's own routes (device or sync sessions); the
 * mcp session kind is refused everywhere except here.
 *
 *   Classic model: get_budget, update_plan, set_actuals, expenses
 *          (list/add/update/delete, categorize_expense), cards
 *          (list/add/update/delete), merchant rules (get/set),
 *          bank snapshot + review + ignore rules, pending charges,
 *          get_settings (flags only), request_sync, get_sync_status
 *   Money model (cents): accounts (list/add/update/delete),
 *          transactions (list/add/update/delete, review_all),
 *          categories + groups (list/create/update/delete),
 *          budgets (get status, set, copy, fill), goals, recurring,
 *          rules (+ apply), auto-review, reports (summary/cashflow/
 *          forecast), net worth, investments, market recap,
 *          Splitwise, import, export, home layout, checklist
 *   About the app itself: send_feedback (builds a GitHub issue link
 *          for the maintainer; files nothing, reads no budget data)
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
  getBankSnapshot, getPendingSnapshot, requestSync, getLatestSyncRequest,
  patchState, patchActual, getMerchantRules, createCard, updateCard, deleteCard,
  setBankReview, setIgnoreRules, REVIEW_KINDS
} from "./budget.js";
import { describeSettings, getSplitwiseApiKey, getSplitwiseCache, setSplitwiseCache } from "./settings.js";
import { HttpError, cleanStr, cleanCents, cleanDate, cleanMonth, oneOf } from "./_v2http.js";
import { createExpense, updateExpense, deleteExpense } from "./expenses.js";
import { categorize } from "./categorize.js";
import { CATEGORIES } from "./_categories.js";
import { ensureV2, scope, ownerFor, OWNER_ID, newId } from "./_v2db.js";
import { mirrorV1 } from "./_v2mirror.js";
import {
  loadAccounts, loadTransactions, loadCategories, loadBudgets, loadRules,
  rowToAccount, rowToGoal, rowToRecurring, categoryIndex
} from "./_v2store.js";
import {
  ACCOUNT_TYPES, CADENCES, summarize, cashFlow, forecast, budgetMonth, monthRange,
  monthOf, addMonths, addDays, netWorthSeries, upcoming, isLiability, largeExpenses,
  goalProgress, ruleMatches, investmentSeries, changeOver, detectRecurring
} from "../../js/core/v2/money.js";
import { recurringItems } from "./v2/recurring.js";
import { runAutoReview } from "./_v2autoreview.js";
import { ensureMarket, marketHistory } from "./_market.js";
import { fetchSplitwise } from "./v2/splitwise.js";
import { SECTIONS, normalize as normalizeLayout } from "./v2/layout.js";
import { status as demoStatus } from "./v2/demo.js";
import { getAiConfig } from "./_ai.js";
import { importRows, csvIds } from "./_v2import.js";
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
    name: "update_plan",
    description: "Edit the classic plan: patch one plan month's fields (dollars; fields are the plan keys from get_budget, e.g. rent, groceries, shopping, oneOffs, oneOffNote, note), and/or set the starting balance or the baseline note. The baseline date itself is fixed by design and cannot be changed here.",
    inputSchema: {
      type: "object",
      properties: {
        monthKey: { type: "string", description: "Plan month, YYYY-MM" },
        patch: { type: "object", description: "Plan fields to change for that month (dollars)" },
        startingBalance: { type: "number", description: "New starting balance in dollars" },
        baselineNote: { type: "string", description: "Note stored with the baseline" }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_actuals",
    description: "Patch one month's manually entered actuals (dollars; e.g. takeHomePay, otherIncome, or entered: true). Expense fields of months that have daily-log expenses are re-rolled from the log and overwrite manual entries, exactly as in the app.",
    inputSchema: {
      type: "object",
      properties: {
        monthKey: { type: "string", description: "Month, YYYY-MM" },
        patch: { type: "object", description: "Actual fields to change (dollars)" }
      },
      required: ["monthKey", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "get_merchant_rules",
    description: "The classic 'always file this merchant under ...' rules used to auto-categorize daily-log expenses.",
    inputSchema: NO_ARGS
  },
  {
    name: "set_merchant_rules",
    description: "Replace the classic merchant rules (an array of { match, category } — expenses whose description contains match are filed under category). Existing expenses from those merchants are re-filed, as in the app.",
    inputSchema: {
      type: "object",
      properties: { rules: { type: "array", items: { type: "object" }, description: "The full replacement list of rules" } },
      required: ["rules"],
      additionalProperties: false
    }
  },
  {
    name: "add_card",
    description: "Add a credit card to the classic Cards page (name + statement period + optional due date).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        statementStart: { type: "string", description: "YYYY-MM-DD" },
        statementEnd: { type: "string", description: "YYYY-MM-DD" },
        dueDate: { type: ["string", "null"], description: "YYYY-MM-DD (optional)" }
      },
      required: ["name", "statementStart", "statementEnd"],
      additionalProperties: false
    }
  },
  {
    name: "update_card",
    description: "Patch a classic credit card (name, statementStart, statementEnd, dueDate) by id (from list_cards).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_card",
    description: "Delete a classic credit card by id. Its expenses keep the card name as text.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "review_bank_transaction",
    description: "Record the Daily review decision for one bank transaction (txId from get_bank_snapshot): kind repayment, income or ignore — or null to clear the mark. Marking money in as income counts it in that month's actual other income while the mark stands. Returns the bank snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        txId: { type: "string", description: "Bank transaction id (Plaid transaction id)" },
        kind: { type: ["string", "null"], enum: ["repayment", "income", "ignore", null] }
      },
      required: ["txId", "kind"],
      additionalProperties: false
    }
  },
  {
    name: "set_ignore_rules",
    description: "Replace the bank review 'always ignore payments like this' rules: an array of { accountId, direction: in|out, name }. Returns the bank snapshot.",
    inputSchema: {
      type: "object",
      properties: { rules: { type: "array", items: { type: "object" } } },
      required: ["rules"],
      additionalProperties: false
    }
  },
  {
    name: "get_settings",
    description: "Settings status, exactly as the app's Settings screen shows it: which integrations have a key saved (AI provider, Splitwise, Finnhub), each key's last 4 and whether it came from the environment or the app. Key values themselves are never returned — and cannot be set through the MCP (see docs/MCP.md).",
    inputSchema: NO_ARGS
  },
  {
    name: "add_account",
    description: "Add a manual account to the money model (a house, car, cash, or a loan your bank connection can't see). Balances of credit and loan accounts are what is owed (positive cents).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", description: "Account type (default depository)" },
        balanceCents: { type: ["integer", "null"], description: "Current balance in cents (optional)" },
        institution: { type: "string" }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "update_account",
    description: "Patch a money-model account: name, hidden, includeInNetWorth, or balanceCents (balance only for manual accounts; it also records today's balance snapshot).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_account",
    description: "Delete a manual money-model account by id. Synced accounts can't be deleted (hide them instead); its transactions keep their history with no account.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "add_transaction",
    description: "Add a transaction directly in the money model (signed cents: negative = money out). With no categoryId it lands on To review. For a classic daily-log expense, add_expense is usually the better fit.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        merchant: { type: "string" },
        amountCents: { type: "integer" },
        accountId: { type: "string" },
        categoryId: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["date", "merchant", "amountCents"],
      additionalProperties: false
    }
  },
  {
    name: "update_transaction",
    description: "Patch a money-model transaction by id (from list_transactions). patch may include merchant, date, amountCents, myShareCents (null = all mine), categoryId (null clears), accountId (hand-added rows only), notes, tags, hidden, needsReview, excludeReports, and splits ([{ categoryId, amountCents, notes? }] summing to the amount — or to my share when set; [] removes the split). Rows from the classic daily log are written back to it, so both apps agree; bank rows' amounts/dates can't change here.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_transaction",
    description: "Delete a money-model transaction by id: hand-added, imported and classic daily-log rows can be deleted (daily-log rows are deleted from the log too); bank and Month-editor rows can't — hide them with update_transaction instead.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "review_all_transactions",
    description: "Mark every visible row on To review as reviewed, as it is (the app's 'Review all' action).",
    inputSchema: NO_ARGS
  },
  {
    name: "update_category",
    description: "Patch a money-model category by id: name, icon, groupId (moves it; it takes the group's kind), archived, sort.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_category",
    description: "Delete a money-model category by id, moving its transactions, splits, budgets, rules and recurring items to the moveTo category (budgets for the same month are added together). Returns the category list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, moveTo: { type: "string", description: "Category id to move everything to" } },
      required: ["id", "moveTo"],
      additionalProperties: false
    }
  },
  {
    name: "create_group",
    description: "Create a category group in the money model (kind: income, expense or transfer; default expense). Returns the category list.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, kind: { type: "string", enum: ["income", "expense", "transfer"] } },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "update_group",
    description: "Patch a category group by id: name and/or sort. Returns the category list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_group",
    description: "Delete a category group by id (only when it holds no categories). Returns the category list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "copy_budget",
    description: "Copy every budget line of one month onto another month (overwriting the target month's lines). Returns the target month's budget status.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: "YYYY-MM" }, to: { type: "string", description: "YYYY-MM" } },
      required: ["from", "to"],
      additionalProperties: false
    }
  },
  {
    name: "fill_budget",
    description: "Repeat one month's budget lines into every later month up to 'through' that has no budget yet (at most 36 months). Returns the months filled.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: "YYYY-MM" }, through: { type: "string", description: "YYYY-MM" } },
      required: ["from", "through"],
      additionalProperties: false
    }
  },
  {
    name: "list_goals",
    description: "Savings goals in the money model, each with its progress: saved so far, what's left, and the monthly pace needed to hit the target date.",
    inputSchema: NO_ARGS
  },
  {
    name: "add_goal",
    description: "Create a savings goal. Link an account (its balance counts as saved) or track savedCents by hand.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        targetCents: { type: "integer", minimum: 1 },
        targetDate: { type: ["string", "null"], description: "YYYY-MM-DD (optional)" },
        accountId: { type: "string" },
        savedCents: { type: "integer", minimum: 0 }
      },
      required: ["name", "targetCents"],
      additionalProperties: false
    }
  },
  {
    name: "update_goal",
    description: "Patch a savings goal by id: name, targetCents, targetDate, accountId, savedCents, archived. Returns the goals list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_goal",
    description: "Delete a savings goal by id. Returns the goals list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "list_recurring",
    description: "Recurring bills and subscriptions in the money model: saved items, fresh suggestions detected from transactions, card bills with their next due dates, and what's due in the next 30 days.",
    inputSchema: NO_ARGS
  },
  {
    name: "add_recurring",
    description: "Add a recurring item by hand (name, signed amountCents, cadence, nextDate; category/account optional). Returns the recurring view.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        amountCents: { type: "integer" },
        cadence: { type: "string", description: "weekly, biweekly, monthly, quarterly or yearly" },
        nextDate: { type: "string", description: "YYYY-MM-DD" },
        categoryId: { type: "string" },
        accountId: { type: "string" }
      },
      required: ["name", "amountCents", "nextDate"],
      additionalProperties: false
    }
  },
  {
    name: "resolve_recurring_suggestion",
    description: "Confirm or dismiss a detected recurring suggestion by its detectKey (from list_recurring's suggestions). Returns the recurring view.",
    inputSchema: {
      type: "object",
      properties: { detectKey: { type: "string" }, action: { type: "string", enum: ["confirm", "dismiss"] } },
      required: ["detectKey", "action"],
      additionalProperties: false
    }
  },
  {
    name: "update_recurring",
    description: "Patch a recurring item by id: name, amountCents, cadence, nextDate, categoryId, status (active|dismissed). Returns the recurring view.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_recurring",
    description: "Delete a recurring item by id. Returns the recurring view.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "list_rules",
    description: "The money-model auto-rules: match on text/account/amount range, then set a category, add a tag, and/or hide. Applied to mirrored and imported rows and on demand with apply_rule.",
    inputSchema: NO_ARGS
  },
  {
    name: "add_rule",
    description: "Create an auto-rule. It needs something to match (matchText, matchAccountId, minCents and/or maxCents — amounts are positive magnitudes in cents) and something to do (setCategoryId, addTag and/or setHidden). Returns the rules list.",
    inputSchema: {
      type: "object",
      properties: {
        matchText: { type: "string" },
        matchAccountId: { type: "string" },
        minCents: { type: ["integer", "null"] },
        maxCents: { type: ["integer", "null"] },
        setCategoryId: { type: "string" },
        addTag: { type: "string" },
        setHidden: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_rule",
    description: "Patch an auto-rule by id (same fields as add_rule, plus sort). Returns the rules list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_rule",
    description: "Delete an auto-rule by id. Returns the rules list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "apply_rule",
    description: "Apply one auto-rule to all existing transactions now (the app's Apply action): matching rows get its category (except classic-log rows), tag and/or hidden flag. Returns the rules list and how many updates were queued.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "run_auto_review",
    description: "Run the AI auto-review over rows still on To review (the app's auto-review pass; needs an AI key saved in Settings). Returns the run's counts.",
    inputSchema: NO_ARGS
  },
  {
    name: "get_reports",
    description: "Money-model reports. kind summary (default): one month's income/spending/net, budget comparison, net worth now vs 30 days ago, upcoming bills, review counts, top categories, over-budget lines and large expenses. kind cashflow: per-month income/spending/net between from and to (YYYY-MM, at most 60 months). kind forecast: projected cash by month from budgets (months ahead, 1-36, default 12).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["summary", "cashflow", "forecast"] },
        month: { type: "string", description: "summary month, YYYY-MM (default: current month)" },
        from: { type: "string", description: "cashflow start, YYYY-MM" },
        to: { type: "string", description: "cashflow end, YYYY-MM" },
        months: { type: "integer", minimum: 1, maximum: 36, description: "forecast horizon (default 12)" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_net_worth",
    description: "Net worth in the money model: current assets/liabilities/net, the daily series from balance snapshots, and balances grouped by account type (signed cents).",
    inputSchema: NO_ARGS
  },
  {
    name: "get_investments",
    description: "Investments in the money model: investment accounts with day/month changes, the total value series, day/week/month/year changes, the SPY benchmark line, and every holding (quantity, price, value, cost basis) with the date prices are as of.",
    inputSchema: NO_ARGS
  },
  {
    name: "get_market_recap",
    description: "The daily market recap (SPY/QQQ/DIA closes, news summary): status (nokey when no Finnhub key is saved), the latest recap and up to 14 earlier ones. Asking may write the newest closed session's recap first, as in the app.",
    inputSchema: NO_ARGS
  },
  {
    name: "get_splitwise",
    description: "Splitwise balances and recent activity (needs the Splitwise key saved in Settings): net balance, who owes you, whom you owe, friends, groups and recent expenses, in cents. Cached for 5 minutes; pass refresh: true to refetch.",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean" } },
      additionalProperties: false
    }
  },
  {
    name: "export_data",
    description: "Export the money model. format json (default): everything (accounts, categories, transactions, budgets, rules, recurring, goals, balance snapshots) as one object. format csv: the transactions CSV as text (same columns as the app's download).",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["json", "csv"] } },
      additionalProperties: false
    }
  },
  {
    name: "get_layout",
    description: "The dashboard layout: which Home cards show and in what order (sections: overview, market, month, ask, trends).",
    inputSchema: NO_ARGS
  },
  {
    name: "set_layout",
    description: "Save the dashboard layout: order (section keys in display order; missing ones are appended) and hidden (section keys to hide).",
    inputSchema: {
      type: "object",
      properties: {
        order: { type: "array", items: { type: "string" } },
        hidden: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_checklist",
    description: "The first-run setup checklist state: whether it shows, whether it was dismissed, and which steps are done (balance, expense, budget, ai, homescreen).",
    inputSchema: NO_ARGS
  },
  {
    name: "update_checklist",
    description: "Update the setup checklist: { dismissed: true|false } or { done: \"homescreen\" }. Returns the checklist state.",
    inputSchema: {
      type: "object",
      properties: { dismissed: { type: "boolean" }, done: { type: "string", enum: ["homescreen"] } },
      additionalProperties: false
    }
  },
  {
    name: "import_transactions",
    description: "Import statement rows into a money-model account (the app's bank CSV import, with rows already parsed): each row is { date (YYYY-MM-DD), description, amountCents (signed: negative = money out), balanceCents? }. Give accountId, or newAccount { name, type? } to create the account. Duplicates (same account, date, amount and similar name) are skipped by the importer. For a manual depository account, the newest row's balance updates the account balance.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        newAccount: { type: "object", properties: { name: { type: "string" }, type: { type: "string" } } },
        rows: { type: "array", items: { type: "object" }, description: "Up to 3000 parsed statement rows" }
      },
      required: ["rows"],
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
async function goalsView(s) {
  const accounts = await loadAccounts(s);
  const bal = {};
  accounts.forEach((a) => { bal[a.id] = a.balanceCents; });
  const thisMonth = monthOf(new Date().toISOString());
  const rows = (await s.all("SELECT * FROM goals WHERE owner_id = ?1 ORDER BY archived, target_date IS NULL, target_date, name")).map(rowToGoal);
  return { goals: rows.map((g) => Object.assign(g, { progress: goalProgress(g, g.accountId ? bal[g.accountId] : null, thisMonth) })) };
}
async function recurringView(s) {
  const txs = await loadTransactions(s);
  const accounts = await loadAccounts(s);
  const r = await recurringItems(s, txs, accounts);
  const today = new Date().toISOString().slice(0, 10);
  return {
    items: r.items, suggestions: r.suggestions, cardBills: r.cardBills,
    upcoming: upcoming(r.items.concat(r.cardBills), today, addDays(today, 30))
  };
}
async function cleanRuleArgs(s, b) {
  const r = {
    matchText: cleanStr(b.matchText, 120),
    matchAccountId: b.matchAccountId ? String(b.matchAccountId) : null,
    minCents: cleanCents(b.minCents === undefined ? null : b.minCents, "minCents", { nullable: true, min: 0 }),
    maxCents: cleanCents(b.maxCents === undefined ? null : b.maxCents, "maxCents", { nullable: true, min: 0 }),
    setCategoryId: b.setCategoryId ? String(b.setCategoryId) : null,
    addTag: cleanStr(b.addTag, 40) || null,
    setHidden: !!b.setHidden
  };
  if (!r.matchText && !r.matchAccountId && r.minCents === null && r.maxCents === null) throw new HttpError(400, "A rule needs something to match.");
  if (!r.setCategoryId && !r.addTag && !r.setHidden) throw new HttpError(400, "A rule needs something to do.");
  if (r.minCents !== null && r.maxCents !== null && r.minCents > r.maxCents) throw new HttpError(400, "minCents is above maxCents.");
  if (r.setCategoryId && !(await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND id = ?2", r.setCategoryId))) throw new HttpError(400, "Unknown category.");
  if (r.matchAccountId && !(await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", r.matchAccountId))) throw new HttpError(400, "Unknown account.");
  return r;
}
async function checklistState(s, env) {
  const DEMO = "demo_*";
  const [r, home, dismissed, demo, ai] = await Promise.all([
    s.first(
      "SELECT (SELECT COUNT(*) FROM accounts WHERE owner_id = ?1 AND id NOT GLOB ?2) AS accounts, " +
      "(SELECT COUNT(*) FROM transactions WHERE owner_id = ?1 AND id NOT GLOB ?2 AND amount_cents < 0) AS spent, " +
      "(SELECT COUNT(*) FROM budgets WHERE owner_id = ?1 AND source <> 'demo') AS budgets, " +
      "(SELECT value FROM budget_settings WHERE key = 'starting_balance_cents') AS start", DEMO),
    s.getSetting("checklist:homescreen"), s.getSetting("checklist:dismissed"), demoStatus(s), getAiConfig(env)
  ]);
  const items = {
    balance: !!(r && r.accounts) || !!(r && Number(r.start)),
    expense: !!(r && r.spent),
    budget: !!(r && r.budgets),
    ai: !!ai.key,
    homescreen: home === "1"
  };
  const off = dismissed === "1";
  const todo = Object.keys(items).some((k) => !items[k]);
  return { show: !off && todo && !demo.demo && (demo.dismissed || !demo.empty), dismissed: off, items };
}
async function categoryNames(s) {
  const names = {};
  (await loadCategories(s)).categories.forEach((c) => { names[c.id] = c.name; });
  return names;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/* The v2 routes throw HttpError for bad input; turn any throw into a
   tool error, like the classic cores' { status >= 400 } results. */
async function attempt(fn) {
  try { return toolOk(await fn()); }
  catch (err) { return toolError(String((err && err.message) || err)); }
}
async function txById(s, id) {
  const all = await loadTransactions(s, {});
  return all.find((t) => t.id === id) || null;
}
function cashNow(accounts) {
  return accounts.filter((a) => !a.hidden && (a.type === "depository" || a.type === "cash") && a.balanceCents !== null)
    .reduce((sum, a) => sum + a.balanceCents, 0);
}

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
    case "update_plan": {
      const body = {};
      if (args.startingBalance !== undefined) body.startingBalance = args.startingBalance;
      if (typeof args.baselineNote === "string") body.baselineNote = args.baselineNote;
      if (args.monthKey !== undefined) {
        if (!MONTH.test(String(args.monthKey))) return toolError("monthKey must be YYYY-MM");
        if (!args.patch || typeof args.patch !== "object") return toolError("patch is required with monthKey");
        body.monthKey = String(args.monthKey); body.patch = args.patch;
      }
      if (!Object.keys(body).length) return toolError("nothing to update: pass monthKey + patch, startingBalance, or baselineNote");
      return attempt(async () => {
        const state = await patchState(db, body);
        const out = {};
        if (body.monthKey) out.month = state.months.find((m) => m.monthKey === body.monthKey) || null;
        if (body.startingBalance !== undefined) out.startingBalance = state.startingBalance;
        if (body.baselineNote !== undefined) out.baselineNote = state.baselineNote;
        return out;
      });
    }
    case "set_actuals": {
      if (!MONTH.test(String(args.monthKey || ""))) return toolError("monthKey must be YYYY-MM");
      if (!args.patch || typeof args.patch !== "object") return toolError("patch is required");
      return attempt(async () => {
        const state = await patchActual(db, String(args.monthKey), args.patch);
        return { actual: state.actuals.find((a) => a.monthKey === String(args.monthKey)) || null };
      });
    }
    case "get_merchant_rules":
      return toolOk({ rules: await getMerchantRules(db) });
    case "set_merchant_rules": {
      if (!Array.isArray(args.rules)) return toolError("rules must be an array");
      return attempt(async () => {
        const state = await patchState(db, { merchantRules: args.rules });
        return { rules: state.merchantRules };
      });
    }
    case "add_card":
      return attempt(async () => ({ card: await createCard(db, args) }));
    case "update_card": {
      const id = parseInt(args.id, 10);
      if (!Number.isFinite(id)) return toolError("id must be an integer card id");
      if (!args.patch || typeof args.patch !== "object") return toolError("patch is required");
      return attempt(async () => {
        const card = await updateCard(db, id, args.patch);
        if (!card) throw new Error("card not found");
        return { card };
      });
    }
    case "delete_card": {
      const id = parseInt(args.id, 10);
      if (!Number.isFinite(id)) return toolError("id must be an integer card id");
      return attempt(async () => {
        if (!(await deleteCard(db, id))) throw new Error("card not found");
        return { deleted: id };
      });
    }
    case "review_bank_transaction": {
      if (typeof args.txId !== "string" || !args.txId) return toolError("txId is required");
      if (args.kind !== null && !REVIEW_KINDS.includes(args.kind)) return toolError("kind must be one of " + REVIEW_KINDS.join(", ") + ", or null");
      return attempt(async () => {
        await setBankReview(db, args.txId, args.kind);
        return getBankSnapshot(db);
      });
    }
    case "set_ignore_rules": {
      if (!Array.isArray(args.rules)) return toolError("rules must be an array");
      return attempt(() => setIgnoreRules(db, args.rules));
    }
    case "get_settings":
      return attempt(() => describeSettings(env));
    case "add_account": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const name = cleanStr(args.name, 100);
        if (!name) throw new HttpError(400, "name is required.");
        const type = oneOf(args.type || "depository", ACCOUNT_TYPES, "type");
        const balance = cleanCents(args.balanceCents === undefined ? null : args.balanceCents, "balanceCents", { nullable: true, min: 0 });
        const id = newId("acc_");
        const today = new Date().toISOString().slice(0, 10);
        await s.run(
          "INSERT INTO accounts (id, owner_id, name, institution, type, balance_cents, balance_at, source) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'manual')",
          id, name, cleanStr(args.institution, 100), type, balance, balance === null ? null : today
        );
        if (balance !== null) {
          await s.run("INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4)", id, today, balance);
        }
        const row = await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", id);
        return { account: rowToAccount(row) };
      });
    }
    case "update_account": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const row = await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!row) throw new HttpError(404, "Account not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        if (patch.name !== undefined) {
          const name = cleanStr(patch.name, 100);
          if (!name) throw new HttpError(400, "name can't be empty.");
          await s.run("UPDATE accounts SET name = ?3, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", row.id, name);
        }
        if (patch.hidden !== undefined) await s.run("UPDATE accounts SET hidden = ?3 WHERE owner_id = ?1 AND id = ?2", row.id, patch.hidden ? 1 : 0);
        if (patch.includeInNetWorth !== undefined) await s.run("UPDATE accounts SET include_in_net_worth = ?3 WHERE owner_id = ?1 AND id = ?2", row.id, patch.includeInNetWorth ? 1 : 0);
        if (patch.balanceCents !== undefined) {
          if (row.source !== "manual") throw new HttpError(409, "This balance comes from your bank sync; it can't be edited here.");
          const bal = cleanCents(patch.balanceCents, "balanceCents", { min: 0 });
          const today = new Date().toISOString().slice(0, 10);
          await s.batch([
            ["UPDATE accounts SET balance_cents = ?3, balance_at = ?4, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", row.id, bal, today],
            ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents", row.id, today, bal]
          ]);
        }
        return { account: rowToAccount(await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", row.id)) };
      });
    }
    case "delete_account": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const row = await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!row) throw new HttpError(404, "Account not found.");
        if (row.source !== "manual") throw new HttpError(409, "Only accounts you added by hand can be deleted; hide synced accounts instead.");
        await s.batch([
          ["UPDATE transactions SET account_id = NULL WHERE owner_id = ?1 AND account_id = ?2", row.id],
          ["DELETE FROM balance_snapshots WHERE owner_id = ?1 AND account_id = ?2", row.id],
          ["UPDATE goals SET account_id = NULL WHERE owner_id = ?1 AND account_id = ?2", row.id],
          ["DELETE FROM accounts WHERE owner_id = ?1 AND id = ?2", row.id]
        ]);
        return { deleted: row.id };
      });
    }
    case "add_transaction": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const date = cleanDate(args.date);
        const merchant = cleanStr(args.merchant, 300);
        if (!merchant) throw new HttpError(400, "merchant is required.");
        const amount = cleanCents(args.amountCents, "amountCents");
        if (amount === 0) throw new HttpError(400, "amountCents can't be zero.");
        let catId = null;
        if (args.categoryId) {
          const c = await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND id = ?2", String(args.categoryId));
          if (!c) throw new HttpError(400, "Unknown category.");
          catId = c.id;
        }
        let accountId = null;
        if (args.accountId) {
          const a = await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", String(args.accountId));
          if (!a) throw new HttpError(400, "Unknown account.");
          accountId = a.id;
        }
        let tags = [];
        if (args.tags !== undefined) {
          if (!Array.isArray(args.tags)) throw new HttpError(400, "tags must be a list.");
          args.tags.forEach((t) => { const x = cleanStr(t, 40); if (x && tags.indexOf(x) === -1) tags.push(x); });
          tags = tags.slice(0, 20);
        }
        const id = newId("tx_");
        await s.run(
          "INSERT INTO transactions (id, owner_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked, notes, tags, needs_review) " +
          "VALUES (?2, ?1, 'manual', ?3, ?4, ?5, ?5, ?6, ?7, 1, ?8, ?9, ?10)",
          id, accountId, date, merchant, amount, catId, cleanStr(args.notes, 500), JSON.stringify(tags), catId ? 0 : 1
        );
        return { transaction: await txById(s, id) };
      });
    }
    case "update_transaction": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const tx = await txById(s, String(args.id || ""));
        if (!tx) throw new HttpError(404, "Transaction not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        const sets = [];
        const add = (col, v) => sets.push([col, v]);
        const v1 = {};
        const fromClassic = tx.source === "v1exp" && tx.v1ExpenseId;
        const readOnly = tx.source === "v1bank" || tx.source === "v1actual";
        const checkCategory = async (id) => {
          if (id === null) return null;
          const c = await s.first("SELECT id, name FROM categories WHERE owner_id = ?1 AND id = ?2", String(id || ""));
          if (!c) throw new HttpError(400, "Unknown category.");
          return c;
        };
        if (patch.merchant !== undefined) {
          const m = cleanStr(patch.merchant, 300);
          if (!m) throw new HttpError(400, "merchant can't be empty.");
          if (readOnly) throw new HttpError(409, "This row comes from your bank or the Month editor; rename it there.");
          if (fromClassic) v1.description = m; else { add("merchant", m); add("description", m); }
        }
        if (patch.date !== undefined) {
          const d = cleanDate(patch.date);
          if (readOnly) throw new HttpError(409, "This row's date comes from your bank or the Month editor.");
          if (fromClassic) v1.date = d; else add("date", d);
        }
        if (patch.amountCents !== undefined) {
          const a = cleanCents(patch.amountCents, "amountCents");
          if (readOnly) throw new HttpError(409, "This row's amount comes from your bank or the Month editor.");
          if (fromClassic) {
            if (a >= 0) throw new HttpError(400, "A daily-log expense is money out: amountCents must be negative.");
            v1.amount = -a / 100;
          } else add("amount_cents", a);
        }
        if (patch.myShareCents !== undefined) {
          const sh = cleanCents(patch.myShareCents, "myShareCents", { nullable: true });
          const amount = patch.amountCents !== undefined ? patch.amountCents : tx.amountCents;
          if (sh !== null && ((Math.sign(sh) !== Math.sign(amount) && sh !== 0) || Math.abs(sh) > Math.abs(amount))) {
            throw new HttpError(400, "myShareCents must have the transaction's sign and be no larger than it.");
          }
          if (fromClassic) v1.myShare = sh === null ? null : -sh / 100; else add("my_share_cents", sh);
        }
        if (patch.notes !== undefined) {
          const n = cleanStr(patch.notes, 500);
          if (fromClassic) v1.note = n; else add("notes", n);
        }
        if (patch.categoryId !== undefined) {
          const c = await checkCategory(patch.categoryId);
          if (fromClassic && c && CATEGORIES.includes(c.name)) {
            v1.category = c.name;
            add("category_locked", 0);
          } else {
            add("category_id", c ? c.id : null);
            add("category_locked", 1);
          }
          add("needs_review", 0);
        }
        if (patch.accountId !== undefined) {
          if (tx.source !== "manual") throw new HttpError(409, "Only rows you added by hand can move between accounts.");
          let accountId = null;
          if (patch.accountId) {
            const a = await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", String(patch.accountId));
            if (!a) throw new HttpError(400, "Unknown account.");
            accountId = a.id;
          }
          add("account_id", accountId);
        }
        if (patch.tags !== undefined) {
          if (!Array.isArray(patch.tags)) throw new HttpError(400, "tags must be a list.");
          const tags = [];
          patch.tags.forEach((t) => { const x = cleanStr(t, 40); if (x && tags.indexOf(x) === -1) tags.push(x); });
          add("tags", JSON.stringify(tags.slice(0, 20)));
        }
        const lockBank = () => { if (tx.source === "v1bank") add("category_locked", 1); };
        if (patch.hidden !== undefined) { add("hidden", patch.hidden ? 1 : 0); lockBank(); }
        if (patch.needsReview !== undefined) { add("needs_review", patch.needsReview ? 1 : 0); lockBank(); }
        if (patch.excludeReports !== undefined) add("exclude_reports", patch.excludeReports ? 1 : 0);
        let splitStmts = null;
        if (patch.splits !== undefined) {
          if (!Array.isArray(patch.splits)) throw new HttpError(400, "splits must be a list.");
          splitStmts = [["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", tx.id]];
          if (patch.splits.length) {
            if (patch.splits.length < 2 || patch.splits.length > 20) throw new HttpError(400, "A split needs 2 to 20 parts.");
            const base = patch.myShareCents !== undefined ? patch.myShareCents : (tx.myShareCents !== null ? tx.myShareCents : (patch.amountCents !== undefined ? patch.amountCents : tx.amountCents));
            const target = base === null ? (patch.amountCents !== undefined ? patch.amountCents : tx.amountCents) : base;
            let sum = 0;
            for (const part of patch.splits) {
              const amt = cleanCents(part && part.amountCents, "split amountCents");
              const c = await checkCategory(part && part.categoryId);
              if (!c) throw new HttpError(400, "Unknown category.");
              sum += amt;
              splitStmts.push(["INSERT INTO transaction_splits (id, owner_id, transaction_id, category_id, amount_cents, notes) VALUES (?2, ?1, ?3, ?4, ?5, ?6)",
                newId("spl_"), tx.id, c.id, amt, cleanStr(part.notes, 200)]);
            }
            if (sum !== target) throw new HttpError(400, "The split parts must add up to " + target + " cents (they add up to " + sum + ").");
          }
        }
        if (Object.keys(v1).length) {
          const r = await updateExpense(db, { id: tx.v1ExpenseId, patch: v1 });
          if (r.status >= 400) throw new HttpError(400, (r.data && r.data.error) || "The classic daily log refused the change.");
          await mirrorV1(db, { force: true });
        }
        if (sets.length) {
          const cols = sets.map(([c], i) => c + " = ?" + (i + 3)).join(", ");
          await s.run("UPDATE transactions SET " + cols + ", updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", tx.id, ...sets.map(([, v]) => v));
        }
        if (splitStmts) await s.batch(splitStmts);
        if (patch.needsReview === true) {
          await s.run("UPDATE auto_reviews SET verdict = 'rejected' WHERE owner_id = ?1 AND transaction_id = ?2", tx.id);
        } else if (patch.needsReview === false || patch.categoryId !== undefined) {
          await s.run("UPDATE auto_reviews SET verdict = 'confirmed' WHERE owner_id = ?1 AND transaction_id = ?2 AND verdict = 'reviewed'", tx.id);
        }
        return { transaction: await txById(s, tx.id) };
      });
    }
    case "delete_transaction": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const tx = await txById(s, String(args.id || ""));
        if (!tx) throw new HttpError(404, "Transaction not found.");
        if (tx.source === "v1exp" && tx.v1ExpenseId) {
          const r = await deleteExpense(db, tx.v1ExpenseId);
          if (r.status >= 400) throw new HttpError(400, (r.data && r.data.error) || "The classic daily log refused the change.");
          await mirrorV1(db, { force: true });
        } else if (tx.source === "manual" || tx.source === "demo" || tx.source === "csv") {
          await s.batch([
            ["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", tx.id],
            ["DELETE FROM transactions WHERE owner_id = ?1 AND id = ?2", tx.id]
          ]);
        } else {
          throw new HttpError(409, "Rows from your bank or the Month editor can't be deleted here; hide them instead.");
        }
        return { deleted: tx.id };
      });
    }
    case "review_all_transactions": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const ids = await s.all("SELECT id, source FROM transactions WHERE owner_id = ?1 AND needs_review = 1 AND hidden = 0");
        await s.batch(ids.map((r) => [
          "UPDATE transactions SET needs_review = 0" + (r.source === "v1bank" ? ", category_locked = 1" : "") + ", updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", r.id
        ]));
        return { updated: ids.length };
      });
    }
    case "update_category": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const c = await s.first("SELECT * FROM categories WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!c) throw new HttpError(404, "Category not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        if (patch.name !== undefined) {
          const name = cleanStr(patch.name, 60);
          if (!name) throw new HttpError(400, "name can't be empty.");
          const clash = await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND lower(name) = lower(?2)", name);
          if (clash && clash.id !== c.id) throw new HttpError(409, "A category named \"" + name + "\" already exists.");
          await s.run("UPDATE categories SET name = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, name);
        }
        if (patch.groupId !== undefined) {
          const g = await s.first("SELECT * FROM category_groups WHERE owner_id = ?1 AND id = ?2", String(patch.groupId || ""));
          if (!g) throw new HttpError(404, "Group not found.");
          await s.run("UPDATE categories SET group_id = ?3, kind = ?4 WHERE owner_id = ?1 AND id = ?2", c.id, g.id, g.kind);
        }
        if (patch.icon !== undefined) await s.run("UPDATE categories SET icon = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, cleanStr(patch.icon, 8));
        if (patch.archived !== undefined) await s.run("UPDATE categories SET archived = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, patch.archived ? 1 : 0);
        if (patch.sort !== undefined) await s.run("UPDATE categories SET sort = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, Number(patch.sort) || 0);
        return loadCategories(s);
      });
    }
    case "delete_category": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const c = await s.first("SELECT * FROM categories WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!c) throw new HttpError(404, "Category not found.");
        const to = await s.first("SELECT * FROM categories WHERE owner_id = ?1 AND id = ?2", String(args.moveTo || ""));
        if (!to) throw new HttpError(404, "moveTo category not found.");
        if (to.id === c.id) throw new HttpError(400, "moveTo must be a different category.");
        await s.batch([
          ["UPDATE transactions SET category_id = ?3 WHERE owner_id = ?1 AND category_id = ?2", c.id, to.id],
          ["UPDATE transaction_splits SET category_id = ?3 WHERE owner_id = ?1 AND category_id = ?2", c.id, to.id],
          ["INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) SELECT owner_id, month, ?3, amount_cents, rollover, 'user' FROM budgets WHERE owner_id = ?1 AND category_id = ?2 " +
           "ON CONFLICT(owner_id, month, category_id) DO UPDATE SET amount_cents = budgets.amount_cents + excluded.amount_cents, source = 'user'", c.id, to.id],
          ["DELETE FROM budgets WHERE owner_id = ?1 AND category_id = ?2", c.id],
          ["UPDATE rules SET set_category_id = ?3 WHERE owner_id = ?1 AND set_category_id = ?2", c.id, to.id],
          ["UPDATE recurring SET category_id = ?3 WHERE owner_id = ?1 AND category_id = ?2", c.id, to.id],
          ["DELETE FROM categories WHERE owner_id = ?1 AND id = ?2", c.id]
        ]);
        return loadCategories(s);
      });
    }
    case "create_group": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const name = cleanStr(args.name, 60);
        if (!name) throw new HttpError(400, "name is required.");
        const kind = oneOf(args.kind || "expense", ["income", "expense", "transfer"], "kind");
        const max = await s.first("SELECT IFNULL(MAX(sort), 0) AS m FROM category_groups WHERE owner_id = ?1");
        await s.run("INSERT INTO category_groups (id, owner_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5)", newId("grp_"), name, kind, max.m + 1);
        return loadCategories(s);
      });
    }
    case "update_group": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const g = await s.first("SELECT * FROM category_groups WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!g) throw new HttpError(404, "Group not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        if (patch.name !== undefined) {
          const name = cleanStr(patch.name, 60);
          if (!name) throw new HttpError(400, "name can't be empty.");
          await s.run("UPDATE category_groups SET name = ?3 WHERE owner_id = ?1 AND id = ?2", g.id, name);
        }
        if (patch.sort !== undefined) await s.run("UPDATE category_groups SET sort = ?3 WHERE owner_id = ?1 AND id = ?2", g.id, Number(patch.sort) || 0);
        return loadCategories(s);
      });
    }
    case "delete_group": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const g = await s.first("SELECT * FROM category_groups WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!g) throw new HttpError(404, "Group not found.");
        const n = await s.first("SELECT COUNT(*) AS n FROM categories WHERE owner_id = ?1 AND group_id = ?2", g.id);
        if (n.n) throw new HttpError(409, "Move or delete this group's categories first.");
        await s.run("DELETE FROM category_groups WHERE owner_id = ?1 AND id = ?2", g.id);
        return loadCategories(s);
      });
    }
    case "copy_budget": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const from = cleanMonth(args.from, "from");
        const to = cleanMonth(args.to, "to");
        const lines = await s.all("SELECT * FROM budgets WHERE owner_id = ?1 AND month = ?2", from);
        if (!lines.length) throw new HttpError(400, from + " has no budget to copy.");
        await s.batch([["DELETE FROM budgets WHERE owner_id = ?1 AND month = ?2", to]].concat(lines.map((l) => [
          "INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) VALUES (?1, ?2, ?3, ?4, ?5, 'user')",
          to, l.category_id, l.amount_cents, l.rollover
        ])));
        const view = await monthView(s, to);
        const names = await categoryNames(s);
        view.rows = view.rows.map((r) => ({ ...r, categoryName: names[r.categoryId] || null }));
        return view;
      });
    }
    case "fill_budget": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const from = cleanMonth(args.from, "from");
        const through = cleanMonth(args.through, "through");
        const lines = await s.all("SELECT * FROM budgets WHERE owner_id = ?1 AND month = ?2", from);
        if (!lines.length) throw new HttpError(400, from + " has no budget to copy.");
        const months = monthRange(addMonths(from, 1), through);
        if (months.length > 36) throw new HttpError(400, "Fill at most 36 months at a time.");
        const have = new Set((await s.all("SELECT DISTINCT month FROM budgets WHERE owner_id = ?1")).map((r) => r.month));
        const target = months.filter((m) => !have.has(m));
        const stmts = [];
        target.forEach((m) => lines.forEach((l) => stmts.push([
          "INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) VALUES (?1, ?2, ?3, ?4, ?5, 'user')",
          m, l.category_id, l.amount_cents, l.rollover
        ])));
        await s.batch(stmts);
        return { months: target };
      });
    }
    case "list_goals": {
      const s = await v2Scope(db, session);
      return attempt(async () => goalsView(s));
    }
    case "add_goal": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const name = cleanStr(args.name, 100);
        if (!name) throw new HttpError(400, "name is required.");
        let accountId = null;
        if (args.accountId) {
          if (!(await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", String(args.accountId)))) throw new HttpError(400, "Unknown account.");
          accountId = String(args.accountId);
        }
        await s.run(
          "INSERT INTO goals (id, owner_id, name, target_cents, target_date, account_id, saved_cents) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)",
          newId("gol_"), name, cleanCents(args.targetCents, "targetCents", { min: 1 }), cleanDate(args.targetDate || null, "targetDate", true),
          accountId, cleanCents(args.savedCents || 0, "savedCents", { min: 0 })
        );
        return goalsView(s);
      });
    }
    case "update_goal": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const row = await s.first("SELECT * FROM goals WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!row) throw new HttpError(404, "Goal not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        const name = patch.name !== undefined ? cleanStr(patch.name, 100) : row.name;
        if (!name) throw new HttpError(400, "name can't be empty.");
        let accountId = row.account_id;
        if (patch.accountId !== undefined) {
          if (!patch.accountId) accountId = null;
          else {
            if (!(await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", String(patch.accountId)))) throw new HttpError(400, "Unknown account.");
            accountId = String(patch.accountId);
          }
        }
        await s.run(
          "UPDATE goals SET name = ?3, target_cents = ?4, target_date = ?5, account_id = ?6, saved_cents = ?7, archived = ?8 WHERE owner_id = ?1 AND id = ?2",
          row.id, name,
          patch.targetCents !== undefined ? cleanCents(patch.targetCents, "targetCents", { min: 1 }) : row.target_cents,
          patch.targetDate !== undefined ? cleanDate(patch.targetDate || null, "targetDate", true) : row.target_date,
          accountId,
          patch.savedCents !== undefined ? cleanCents(patch.savedCents, "savedCents", { min: 0 }) : row.saved_cents,
          patch.archived !== undefined ? (patch.archived ? 1 : 0) : row.archived
        );
        return goalsView(s);
      });
    }
    case "delete_goal": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        await s.run("DELETE FROM goals WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        return goalsView(s);
      });
    }
    case "list_recurring": {
      const s = await v2Scope(db, session);
      return attempt(async () => recurringView(s));
    }
    case "add_recurring": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const name = cleanStr(args.name, 120);
        if (!name) throw new HttpError(400, "name is required.");
        const amount = cleanCents(args.amountCents, "amountCents");
        const cadence = oneOf(args.cadence || "monthly", CADENCES, "cadence");
        const next = cleanDate(args.nextDate, "nextDate");
        if (args.categoryId && !(await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND id = ?2", String(args.categoryId)))) throw new HttpError(400, "Unknown category.");
        await s.run(
          "INSERT INTO recurring (id, owner_id, name, merchant, category_id, account_id, amount_cents, cadence, next_date, source) VALUES (?2, ?1, ?3, ?3, ?4, ?5, ?6, ?7, ?8, 'manual')",
          newId("rec_"), name, args.categoryId || null, args.accountId || null, amount, cadence, next
        );
        return recurringView(s);
      });
    }
    case "resolve_recurring_suggestion": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        if (args.action !== "confirm" && args.action !== "dismiss") throw new HttpError(400, "action must be confirm or dismiss.");
        const key = String(args.detectKey || "");
        const txs = await loadTransactions(s);
        const today = new Date().toISOString().slice(0, 10);
        const hit = detectRecurring(txs.filter((x) => !x.hidden), today).find((d) => d.key === key);
        if (!hit) throw new HttpError(404, "That suggestion is no longer there.");
        await s.run(
          "INSERT INTO recurring (id, owner_id, detect_key, name, merchant, category_id, account_id, amount_cents, cadence, next_date, source, status) " +
          "VALUES (?2, ?1, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, 'detected', ?10) ON CONFLICT(owner_id, detect_key) WHERE detect_key IS NOT NULL DO UPDATE SET status = excluded.status",
          newId("rec_"), key, String(hit.merchant).slice(0, 120), hit.categoryId, hit.accountId, hit.amountCents, hit.cadence, hit.nextDate,
          args.action === "confirm" ? "active" : "dismissed"
        );
        return recurringView(s);
      });
    }
    case "update_recurring": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const row = await s.first("SELECT * FROM recurring WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!row) throw new HttpError(404, "Recurring item not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        const name = patch.name !== undefined ? cleanStr(patch.name, 120) : row.name;
        if (!name) throw new HttpError(400, "name can't be empty.");
        await s.run(
          "UPDATE recurring SET name = ?3, amount_cents = ?4, cadence = ?5, next_date = ?6, category_id = ?7, status = ?8 WHERE owner_id = ?1 AND id = ?2",
          row.id, name,
          patch.amountCents !== undefined ? cleanCents(patch.amountCents, "amountCents") : row.amount_cents,
          patch.cadence !== undefined ? oneOf(patch.cadence, CADENCES, "cadence") : row.cadence,
          patch.nextDate !== undefined ? cleanDate(patch.nextDate, "nextDate") : row.next_date,
          patch.categoryId !== undefined ? (patch.categoryId || null) : row.category_id,
          patch.status !== undefined ? oneOf(patch.status, ["active", "dismissed"], "status") : row.status
        );
        return recurringView(s);
      });
    }
    case "delete_recurring": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const row = await s.first("SELECT * FROM recurring WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        if (!row) throw new HttpError(404, "Recurring item not found.");
        await s.run("DELETE FROM recurring WHERE owner_id = ?1 AND id = ?2", row.id);
        return recurringView(s);
      });
    }
    case "list_rules": {
      const s = await v2Scope(db, session);
      return toolOk({ rules: await loadRules(s) });
    }
    case "add_rule": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const r = await cleanRuleArgs(s, args);
        const max = await s.first("SELECT IFNULL(MAX(sort), 0) AS m FROM rules WHERE owner_id = ?1");
        await s.run(
          "INSERT INTO rules (id, owner_id, sort, match_text, match_account_id, min_cents, max_cents, set_category_id, add_tag, set_hidden) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
          newId("rul_"), max.m + 1, r.matchText, r.matchAccountId, r.minCents, r.maxCents, r.setCategoryId, r.addTag, r.setHidden ? 1 : 0
        );
        return { rules: await loadRules(s) };
      });
    }
    case "update_rule": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const cur = (await loadRules(s)).find((r) => r.id === args.id);
        if (!cur) throw new HttpError(404, "Rule not found.");
        const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
        const r = await cleanRuleArgs(s, Object.assign({}, cur, patch));
        await s.run(
          "UPDATE rules SET match_text = ?3, match_account_id = ?4, min_cents = ?5, max_cents = ?6, set_category_id = ?7, add_tag = ?8, set_hidden = ?9, sort = ?10 WHERE owner_id = ?1 AND id = ?2",
          cur.id, r.matchText, r.matchAccountId, r.minCents, r.maxCents, r.setCategoryId, r.addTag, r.setHidden ? 1 : 0,
          patch.sort !== undefined ? Number(patch.sort) || 0 : cur.sort
        );
        return { rules: await loadRules(s) };
      });
    }
    case "delete_rule": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        await s.run("DELETE FROM rules WHERE owner_id = ?1 AND id = ?2", String(args.id || ""));
        return { rules: await loadRules(s) };
      });
    }
    case "apply_rule": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const rule = (await loadRules(s)).find((r) => r.id === args.id);
        if (!rule) throw new HttpError(404, "Rule not found.");
        const txs = await loadTransactions(s);
        const stmts = [];
        txs.forEach((t) => {
          if (!ruleMatches(rule, t)) return;
          const classic = t.source === "v1exp";
          if (rule.setCategoryId && !classic && t.categoryId !== rule.setCategoryId) {
            stmts.push(["UPDATE transactions SET category_id = ?3, category_locked = 1, needs_review = 0, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", t.id, rule.setCategoryId]);
          }
          if (rule.addTag && t.tags.indexOf(rule.addTag) === -1) {
            stmts.push(["UPDATE transactions SET tags = ?3 WHERE owner_id = ?1 AND id = ?2", t.id, JSON.stringify(t.tags.concat([rule.addTag]))]);
          }
          if (rule.setHidden && !t.hidden) stmts.push(["UPDATE transactions SET hidden = 1 WHERE owner_id = ?1 AND id = ?2", t.id]);
        });
        await s.batch(stmts);
        return { rules: await loadRules(s), changed: stmts.length };
      });
    }
    case "run_auto_review": {
      const s = await v2Scope(db, session);
      return attempt(() => runAutoReview(s, env));
    }
    case "get_reports": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const kind = args.kind || "summary";
        const { categories } = await loadCategories(s);
        const idx = categoryIndex(categories);
        const today = new Date().toISOString().slice(0, 10);
        if (kind === "cashflow") {
          const from = cleanMonth(args.from, "from"), to = cleanMonth(args.to, "to");
          if (from > to) throw new HttpError(400, "from is after to.");
          if (monthRange(from, to).length > 60) throw new HttpError(400, "At most 60 months.");
          const txs = await loadTransactions(s, { from: from + "-01", to: to + "-31" });
          return Object.assign({ from, to }, cashFlow(txs, idx, from, to));
        }
        if (kind === "forecast") {
          const count = Math.min(Math.max(parseInt(args.months || "12", 10) || 12, 1), 36);
          const month = monthOf(today);
          const accounts = await loadAccounts(s);
          const txs = await loadTransactions(s, { from: month + "-01", to: month + "-31" });
          const oneOff = categories.filter((c) => c.name === "One-off").map((c) => c.id);
          return {
            cashCents: cashNow(accounts),
            months: forecast({ cashCents: cashNow(accounts), month, count, budgets: await loadBudgets(s), categories: idx, transactions: txs, oneOffCategoryIds: oneOff })
          };
        }
        if (kind === "summary") {
          const month = args.month ? cleanMonth(args.month) : monthOf(today);
          const [accounts, txAll, budgets, snapRows] = await Promise.all([loadAccounts(s), loadTransactions(s), loadBudgets(s),
            s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1")]);
          const monthTx = txAll.filter((t) => monthOf(t.date) === month);
          const sum = summarize(monthTx, idx);
          const budget = budgetMonth(month, budgets, txAll, idx);
          const acctIdx = {};
          accounts.forEach((a) => { acctIdx[a.id] = a; });
          const snaps = snapRows.map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }));
          const series = netWorthSeries(acctIdx, snaps);
          let now = 0;
          accounts.forEach((a) => {
            if (a.hidden || !a.includeInNetWorth || a.balanceCents === null) return;
            now += isLiability(a.type) ? -a.balanceCents : a.balanceCents;
          });
          const monthAgo = addDays(today, -30);
          const past = series.filter((pt) => pt.date <= monthAgo).pop();
          const rec = await recurringItems(s, txAll, accounts);
          const top = Object.keys(sum.byCategory)
            .filter((cid) => cid && idx[cid] && idx[cid].kind === "expense")
            .map((cid) => ({ categoryId: cid, cents: sum.byCategory[cid] }))
            .sort((a, b) => b.cents - a.cents).slice(0, 5);
          return {
            month, incomeCents: sum.incomeCents, spendingCents: sum.spendingCents, netCents: sum.netCents,
            plannedIncomeCents: budget.plannedIncomeCents, plannedSpendingCents: budget.plannedSpendingCents,
            netWorthCents: now, netWorth30dAgoCents: past ? past.netWorthCents : null,
            cashCents: cashNow(accounts),
            upcoming: upcoming(rec.items.concat(rec.cardBills), today, addDays(today, 14)),
            reviewCount: txAll.filter((t) => t.needsReview && !t.hidden).length,
            autoReviewedCount: txAll.filter((t) => t.autoReview && !t.hidden).length,
            topCategories: top,
            overBudget: budget.rows.filter((r) => r.kind === "expense" && r.plannedCents + r.rolloverCents > 0 && r.remainingCents < 0)
              .map((r) => ({ categoryId: r.categoryId, overCents: -r.remainingCents })),
            largeExpenses: largeExpenses(txAll, today).slice(0, 5)
              .map((t) => ({ id: t.id, date: t.date, name: t.merchant || t.description, amountCents: t.amountCents, categoryId: t.categoryId }))
          };
        }
        throw new HttpError(400, "kind must be summary, cashflow or forecast.");
      });
    }
    case "get_net_worth": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const accounts = await loadAccounts(s);
        const idx = {};
        accounts.forEach((a) => { idx[a.id] = a; });
        const snaps = (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1 ORDER BY date"))
          .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }));
        const byType = {};
        accounts.forEach((a) => {
          if (a.hidden || !a.includeInNetWorth || a.balanceCents === null) return;
          byType[a.type] = (byType[a.type] || 0) + a.balanceCents;
        });
        return { current: netWorthNow(accounts), series: netWorthSeries(idx, snaps), byType };
      });
    }
    case "get_investments": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const accounts = (await loadAccounts(s)).filter((a) => a.type === "investment" && !a.hidden);
        const snaps = (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1 ORDER BY date"))
          .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }));
        const series = investmentSeries(accounts, snaps);
        const benchmark = (await marketHistory(s, 400))
          .map((m) => { const q = (m.quotes || []).find((x) => x.symbol === "SPY"); return q ? { date: m.date, close: q.close } : null; })
          .filter(Boolean).reverse();
        const invIds = new Set(accounts.map((a) => a.id));
        const holdings = (await s.all("SELECT account_id, ticker, name, quantity, cost_basis_cents, price_cents, value_cents, kind, as_of FROM holdings WHERE owner_id = ?1 ORDER BY value_cents DESC"))
          .filter((r) => invIds.has(r.account_id))
          .map((r) => ({ accountId: r.account_id, ticker: r.ticker, name: r.name, quantity: r.quantity, costBasisCents: r.cost_basis_cents, priceCents: r.price_cents, valueCents: r.value_cents, kind: r.kind, asOf: r.as_of }));
        const holdingsAsOf = holdings.reduce((m, x) => (x.asOf && x.asOf > (m || "") ? x.asOf : m), null);
        return {
          accounts: accounts.map((a) => {
            const own = investmentSeries([a], snaps);
            return { id: a.id, name: a.name, institution: a.institution, mask: a.mask, balanceCents: a.balanceCents, balanceAt: a.balanceAt, day: changeOver(own, 1), month: changeOver(own, 30) };
          }),
          series,
          change: { day: changeOver(series, 1), week: changeOver(series, 7), month: changeOver(series, 30), year: changeOver(series, 365) },
          benchmark,
          holdings,
          holdingsAsOf
        };
      });
    }
    case "get_market_recap": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const st = await ensureMarket(s, env);
        const all = await marketHistory(s, 15);
        return Object.assign(st, { latest: all[0] || null, history: all.slice(1) });
      });
    }
    case "get_splitwise": {
      return attempt(async () => {
        const key = await getSplitwiseApiKey(env);
        if (!key) return { connected: false };
        const cached = await getSplitwiseCache(db);
        const fresh = cached && Date.now() - cached.at < 5 * 60 * 1000;
        if (fresh && !args.refresh) return Object.assign({}, cached.payload, { cached: true });
        try {
          const payload = await fetchSplitwise(key);
          await setSplitwiseCache(db, payload);
          return payload;
        } catch (err) {
          if (err && (err.status === 401 || err.status === 403)) {
            return { connected: false, error: "Splitwise didn't accept the saved API key. Paste a fresh one in Settings -> Splitwise." };
          }
          if (cached) return Object.assign({}, cached.payload, { stale: true, error: "Couldn't reach Splitwise just now - showing the last good snapshot." });
          return { connected: false, error: "Couldn't reach Splitwise just now. Try Refresh in a moment." };
        }
      });
    }
    case "export_data": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const accounts = await loadAccounts(s);
        const { groups, categories } = await loadCategories(s);
        const txs = await loadTransactions(s);
        if (args.format === "csv") {
          const cat = {}, acc = {};
          categories.forEach((c) => { cat[c.id] = c.name; });
          accounts.forEach((a) => { acc[a.id] = a.name; });
          const csvCell = (v) => {
            const str = v === null || v === undefined ? "" : String(v);
            const safe = /^[=+\-@\t\r]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str) ? "'" + str : str;
            return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
          };
          const lines = [["Date", "Merchant", "Amount", "My share", "Category", "Account", "Tags", "Notes", "Hidden"].join(",")];
          txs.forEach((t) => lines.push([
            t.date, t.merchant, (t.amountCents / 100).toFixed(2), t.myShareCents === null ? "" : (t.myShareCents / 100).toFixed(2),
            t.splits.length ? "Split" : (cat[t.categoryId] || ""), acc[t.accountId] || "", t.tags.join(" "), t.notes, t.hidden ? "yes" : ""
          ].map(csvCell).join(",")));
          return { format: "csv", filename: "transactions-" + new Date().toISOString().slice(0, 10) + ".csv", csv: lines.join("\r\n") + "\r\n" };
        }
        return {
          format: "json", version: 1, exportedAt: new Date().toISOString(), accounts, groups, categories, transactions: txs,
          budgets: await loadBudgets(s), rules: await loadRules(s),
          recurring: (await s.all("SELECT * FROM recurring WHERE owner_id = ?1")).map(rowToRecurring),
          goals: (await s.all("SELECT * FROM goals WHERE owner_id = ?1")).map(rowToGoal),
          balanceSnapshots: (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1 ORDER BY date"))
            .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }))
        };
      });
    }
    case "get_layout": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const raw = await s.getSetting("dashboard_layout");
        const saved = raw ? JSON.parse(raw) : {};
        const known = (l) => (Array.isArray(l) ? l : []).filter((k) => SECTIONS.indexOf(k) !== -1);
        return normalizeLayout({ order: known(saved.order), hidden: known(saved.hidden) });
      });
    }
    case "set_layout": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        const layout = normalizeLayout({ order: args.order || [], hidden: args.hidden || [] });
        await s.setSetting("dashboard_layout", JSON.stringify(layout));
        return layout;
      });
    }
    case "get_checklist": {
      const s = await v2Scope(db, session);
      return attempt(() => checklistState(s, env));
    }
    case "update_checklist": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        if (typeof args.dismissed === "boolean") await s.setSetting("checklist:dismissed", args.dismissed ? "1" : "0");
        else if (args.done === "homescreen") await s.setSetting("checklist:homescreen", "1");
        else throw new HttpError(400, "Send { dismissed } or { done: \"homescreen\" }.");
        return checklistState(s, env);
      });
    }
    case "import_transactions": {
      const s = await v2Scope(db, session);
      return attempt(async () => {
        if (!Array.isArray(args.rows) || !args.rows.length) throw new HttpError(400, "No rows to import.");
        if (args.rows.length > 3000) throw new HttpError(413, "That's more than 3000 rows: import a shorter date range.");
        const rows = args.rows.map((r, i) => {
          const amount = cleanCents(r && r.amountCents, "Row " + (i + 1) + " amount");
          if (!amount) throw new HttpError(400, "Row " + (i + 1) + " has no amount.");
          return {
            date: cleanDate(r.date, "Row " + (i + 1) + " date"),
            description: cleanStr(r.description, 300) || "(no description)",
            amountCents: amount,
            balanceCents: cleanCents(r.balanceCents === undefined ? null : r.balanceCents, "Row " + (i + 1) + " balance", { nullable: true })
          };
        });
        let acct;
        if (args.accountId) {
          acct = await s.first("SELECT id, type, source FROM accounts WHERE owner_id = ?1 AND id = ?2", String(args.accountId));
          if (!acct) throw new HttpError(400, "Unknown account.");
        } else {
          const n = args.newAccount && typeof args.newAccount === "object" ? args.newAccount : null;
          const name = n ? cleanStr(n.name, 100) : "";
          if (!name) throw new HttpError(400, "Pick an account or name a new one.");
          acct = { id: newId("acc_"), type: oneOf(n.type || "depository", ACCOUNT_TYPES, "type"), source: "manual" };
          await s.run("INSERT INTO accounts (id, owner_id, name, type, source) VALUES (?2, ?1, ?3, ?4, 'manual')", acct.id, name, acct.type);
        }
        const ids = csvIds(acct.id, rows);
        const out = await importRows(s, db, acct.id, rows.map((r, i) => Object.assign({ externalId: ids[i] }, r)), "csv");
        let balanceUpdated = false;
        const withBal = rows.filter((r) => r.balanceCents !== null);
        if (withBal.length && acct.source === "manual" && acct.type === "depository") {
          const newestFirst = rows[0].date > rows[rows.length - 1].date;
          const latest = withBal.reduce((best, r) => (r.date > best.date || (r.date === best.date && !newestFirst) ? r : best));
          const cur = await s.first("SELECT balance_at FROM accounts WHERE owner_id = ?1 AND id = ?2", acct.id);
          if (!cur.balance_at || latest.date >= cur.balance_at) {
            await s.batch([
              ["UPDATE accounts SET balance_cents = ?3, balance_at = ?4, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", acct.id, latest.balanceCents, latest.date],
              ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents", acct.id, latest.date, latest.balanceCents]
            ]);
            balanceUpdated = true;
          }
        }
        return Object.assign(out, { accountId: acct.id, balanceUpdated });
      });
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
          instructions: "Personal budget for one owner, in USD. These tools mirror everything the owner can do in the app (full reference: docs/MCP.md in the repo). Classic tools use dollars: get_budget (plan/actuals), update_plan, set_actuals, list/add/update/delete_expense, categorize_expense, cards, merchant rules, bank snapshot/review/ignore rules, pending charges, request_sync/get_sync_status. Money-model tools use signed integer cents (negative = money out): accounts, transactions (+review_all_transactions), categories and groups, budgets (get_budget_status, set_budget, copy_budget, fill_budget), goals, recurring, rules, run_auto_review, get_reports, get_net_worth, get_investments, get_market_recap, get_splitwise, import_transactions, export_data, layout, checklist. Credentials, sessions, sync ingestion and demo data are not exposed."
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
