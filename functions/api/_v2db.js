/*
 * v2 data model — tables and the ONE scoped query helper every v2 query
 * goes through. (Files starting with "_" are not Pages routes.)
 *
 * This is a personal tracker: one owner, you (id "me"). Every v2 row
 * still carries owner_id so your data stays separate if the app is ever
 * opened to someone else, with no second migration. The helper below
 * refuses SQL
 * that does not pin `owner_id = ?1`, and always binds ?1 itself, so
 * no handler can forget the filter or pass someone else's id.
 *
 * Money is integer cents. Transaction amounts are signed: negative =
 * money out, positive = money in (see js/core/v2/money.js).
 */
import { ensureTables } from "./budget.js";

export const OWNER_ID = "me";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS v2_settings (
    owner_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (owner_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    external_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    institution TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'depository',
    subtype TEXT NOT NULL DEFAULT '',
    mask TEXT NOT NULL DEFAULT '',
    balance_cents INTEGER,
    available_cents INTEGER,
    balance_at TEXT,
    statement_start TEXT,
    statement_end TEXT,
    due_date TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    include_in_net_worth INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS accounts_ext ON accounts (owner_id, external_id) WHERE external_id IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS balance_snapshots (
    owner_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    date TEXT NOT NULL,
    balance_cents INTEGER NOT NULL,
    PRIMARY KEY (owner_id, account_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS category_groups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'expense',
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'expense',
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS categories_name ON categories (owner_id, name)",
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    external_id TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    account_id TEXT,
    date TEXT NOT NULL,
    merchant TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL,
    my_share_cents INTEGER,
    category_id TEXT,
    category_locked INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    pending INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    exclude_reports INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    v1_expense_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS transactions_ext ON transactions (owner_id, external_id) WHERE external_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS transactions_date ON transactions (owner_id, date)",
  `CREATE TABLE IF NOT EXISTS transaction_splits (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    category_id TEXT,
    amount_cents INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS splits_tx ON transaction_splits (owner_id, transaction_id)",
  `CREATE TABLE IF NOT EXISTS budgets (
    owner_id TEXT NOT NULL,
    month TEXT NOT NULL,
    category_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    rollover INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'user',
    PRIMARY KEY (owner_id, month, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    match_text TEXT NOT NULL DEFAULT '',
    match_account_id TEXT,
    min_cents INTEGER,
    max_cents INTEGER,
    set_category_id TEXT,
    add_tag TEXT,
    set_hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS recurring (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    detect_key TEXT,
    name TEXT NOT NULL DEFAULT '',
    merchant TEXT NOT NULL DEFAULT '',
    category_id TEXT,
    account_id TEXT,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    cadence TEXT NOT NULL DEFAULT 'monthly',
    next_date TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS recurring_key ON recurring (owner_id, detect_key) WHERE detect_key IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    target_cents INTEGER NOT NULL DEFAULT 0,
    target_date TEXT,
    account_id TEXT,
    saved_cents INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`
];

/* Default categories for a new owner. The 13 v1 expense categories
   keep their exact names so an edit made on the new screens can be
   written back to the classic daily log. */
export const DEFAULT_GROUPS = [
  { key: "income", name: "Income", kind: "income", cats: ["Paycheck", "Other income", "Interest"] },
  { key: "bills", name: "Housing & bills", kind: "expense", cats: ["Rent", "Utilities", "Phone & Internet", "Insurance", "Subscriptions"] },
  { key: "food", name: "Food", kind: "expense", cats: ["Groceries", "Eating Out"] },
  { key: "transport", name: "Transportation", kind: "expense", cats: ["Fuel/Transport"] },
  { key: "lifestyle", name: "Lifestyle", kind: "expense", cats: ["Shopping/Personal", "Gym"] },
  { key: "debt", name: "Debt", kind: "expense", cats: ["Loan/Debt Payment"] },
  { key: "other", name: "Other", kind: "expense", cats: ["One-off", "Misc/Other"] },
  { key: "transfers", name: "Transfers", kind: "transfer", cats: ["Transfer", "Credit card payment", "Repayment"] }
];

export function newId(prefix) {
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 20)
    : Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("");
  return (prefix || "") + id;
}

const ready = new WeakMap();
/* Create the v2 tables (and the v1 ones they read from) once per DB
   binding per isolate, and seed your default categories. */
export async function ensureV2(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => {
      await ensureTables(db);
      await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
      await ensureOwner(db, OWNER_ID);
    })().catch((e) => { ready.delete(db); throw e; }));
  }
  return ready.get(db);
}

export async function ensureOwner(db, ownerId) {
  const s = scope(db, ownerId);
  const have = await s.first("SELECT COUNT(*) AS n FROM category_groups WHERE owner_id = ?1");
  if (have && have.n > 0) return;
  const stmts = [];
  DEFAULT_GROUPS.forEach((g, gi) => {
    const gid = "grp_" + g.key + "_" + ownerId;
    stmts.push(["INSERT OR IGNORE INTO category_groups (id, owner_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5)", gid, g.name, g.kind, gi]);
    g.cats.forEach((c, ci) => {
      stmts.push(["INSERT OR IGNORE INTO categories (id, owner_id, group_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5, ?6)",
        newId("cat_"), gid, c, g.kind, ci]);
    });
  });
  await s.batch(stmts);
}

const PIN = /owner_id\s*=\s*\?1\b/;
/* The scoped helper. Every statement must contain `owner_id = ?1`;
   ?1 is always the scope's owner, the caller's params are ?2, ?3…
   (INSERTs name ?1 in their VALUES the same way). */
export function scope(db, ownerId) {
  if (typeof ownerId !== "string" || !ownerId) throw new Error("scope needs an owner id");
  function prep(sql, params) {
    const pinnedInsert = /^\s*INSERT/i.test(sql) && /owner_id/.test(sql) && /\?1\b/.test(sql);
    if (!PIN.test(sql) && !pinnedInsert) throw new Error("v2 query is not pinned to an owner: " + sql.slice(0, 80));
    return db.prepare(sql).bind(ownerId, ...params.map((p) => (p === undefined ? null : p)));
  }
  return {
    ownerId,
    async all(sql, ...params) { const r = await prep(sql, params).all(); return (r && r.results) || []; },
    async first(sql, ...params) { return prep(sql, params).first(); },
    async run(sql, ...params) { return prep(sql, params).run(); },
    async batch(list) {
      if (!list.length) return [];
      const out = [];
      for (let i = 0; i < list.length; i += 50) {
        out.push(...await db.batch(list.slice(i, i + 50).map(([sql, ...params]) => prep(sql, params))));
      }
      return out;
    },
    async getSetting(key) {
      const r = await prep("SELECT value FROM v2_settings WHERE owner_id = ?1 AND key = ?2", [key]).first();
      return r ? r.value : null;
    },
    async setSetting(key, value) {
      await prep("INSERT INTO v2_settings (owner_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value", [key, String(value)]).run();
    }
  };
}

/* Whose data a request acts on: always yours, for both device and sync
   sessions. */
export function ownerFor(session) {
  return (session && session.owner_id) || OWNER_ID;
}

export function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/* Error with an HTTP status, for messages meant for the user. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function errorResponse(err) {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return json({ error: "Body must be JSON." }, 400);
  console.error(err);
  return json({ error: "Internal error" }, 500);
}
export async function readJson(request, max = 512 * 1024) {
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "Request too large.");
  return text ? JSON.parse(text) : {};
}
