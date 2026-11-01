/*
 * Arthatula — Cloudflare Pages Function backed by D1.
 *
 * Routes (this file serves /api/budget):
 *   GET   /api/budget  -> { startingBalance, months: [...] }
 *   PATCH /api/budget  -> partial update:
 *                         { startingBalance } and/or { monthKey, patch: {...} }
 *   POST  /api/budget  -> alias of PATCH
 *   PUT   /api/budget  -> replace the whole state: { startingBalance, months }
 *                         (used by Import JSON and by Reset, which PUTs a blank state)
 *
 * Money is stored in D1 as integer cents to avoid float rounding; the API
 * speaks dollars. No personal values live in this file — a fresh database
 * starts with blank months, a zero starting balance and today as the
 * baseline date.
 */

/* The planner's months: 13 from plan_start (kept in budget_settings),
   and on through the current month once time runs past them. A new
   database starts the plan this month; one from before plan_start
   existed keeps its first stored month (see ensureTables). */
export const PLAN_LENGTH = 13;
const todayIso = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => todayIso().slice(0, 7);
export function addMonth(key, n) {
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function planMonthKeys(start, nowKey) {
  const keys = [];
  for (let k = start; keys.length < PLAN_LENGTH || k <= nowKey; k = addMonth(k, 1)) keys.push(k);
  return keys;
}
export async function monthKeys(db) {
  return planMonthKeys((await getSetting(db, "plan_start")) || thisMonth(), thisMonth());
}

/* camelCase API field -> D1 column (all *_cents are INTEGER cents) */
export const MONEY_FIELDS = [
  ["takeHomePay", "take_home_pay_cents"],
  ["otherIncome", "other_income_cents"],
  ["rent", "rent_cents"],
  ["utilities", "utilities_cents"],
  ["phoneInternet", "phone_internet_cents"],
  ["groceries", "groceries_cents"],
  ["eatingOut", "eating_out_cents"],
  ["gasTransport", "gas_transport_cents"],
  ["insurance", "insurance_cents"],
  ["subscriptions", "subscriptions_cents"],
  ["shopping", "shopping_cents"],
  ["credilaEmi", "credila_emi_cents"],
  ["creditCardPayment", "credit_card_payment_cents"],
  ["otherLoan", "other_loan_cents"],
  ["oneOffs", "one_offs_cents"],
  ["otherExpenses", "other_expenses_cents"]
];
export const TEXT_FIELDS = [
  ["oneOffNote", "one_off_note"],
  ["note", "note"]
];

const CREATE_SETTINGS = `CREATE TABLE IF NOT EXISTS budget_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;
const CREATE_MONTHS = `CREATE TABLE IF NOT EXISTS monthly_budgets (
  month_key TEXT PRIMARY KEY,
  ${MONEY_FIELDS.map(([, col]) => `${col} INTEGER NOT NULL DEFAULT 0`).join(",\n  ")},
  one_off_note TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const CREATE_ACTUALS = `CREATE TABLE IF NOT EXISTS monthly_actuals (
  month_key TEXT PRIMARY KEY,
  has_data INTEGER NOT NULL DEFAULT 0,
  ${MONEY_FIELDS.map(([, col]) => `${col} INTEGER NOT NULL DEFAULT 0`).join(",\n  ")},
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const CREATE_DAILY = `CREATE TABLE IF NOT EXISTS daily_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Misc/Other',
  categorization_source TEXT NOT NULL DEFAULT 'rules',
  card_name TEXT,
  my_share REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const CREATE_CARDS = `CREATE TABLE IF NOT EXISTS credit_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  statement_start TEXT NOT NULL,
  statement_end TEXT NOT NULL,
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
/* Sign-in sessions (access-code auth). Only the SHA-256 of a session
   token is stored — the raw token lives solely on the device that
   signed in. kind 'device' sessions expire 90 days after last activity
   (sliding); kind 'sync' sessions (for the Plaid sync script) last
   180 days from pairing and can be revoked like any other session. */
const CREATE_SESSIONS = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'device',
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
)`;
/* One row per secret check (login, change-code, setup secret, pairing
   code) — the attempt limiter counts these per IP and overall. */
const CREATE_AUTH_ATTEMPTS = `CREATE TABLE IF NOT EXISTS auth_attempts (
  at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
)`;
/* Bank snapshot for the Bank tab: the paired Plaid sync automation
   pushes depository (checking/savings) accounts and their transactions
   (POST /api/bank); device sessions only read them back. Money is
   integer cents like the planner tables, but amounts keep the Plaid
   depository sign convention: positive = money OUT of the account,
   negative = money IN (a paycheck arrives negative). The API converts
   to dollars at the boundary; the UI flips the sign for display. */
const CREATE_BANK_ACCOUNTS = `CREATE TABLE IF NOT EXISTS bank_accounts (
  plaid_account_id TEXT PRIMARY KEY,
  institution TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  subtype TEXT NOT NULL DEFAULT '',
  mask TEXT NOT NULL DEFAULT '',
  current_cents INTEGER,
  available_cents INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const CREATE_BANK_TRANSACTIONS = `CREATE TABLE IF NOT EXISTS bank_transactions (
  plaid_transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  pfc TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
/* Pending charges snapshot (Daily tab "Pending" section + the
   dashboard's pending preview line): the paired sync REPLACES this
   table on every run with the charges Plaid currently reports as
   pending, so a charge that posts — or a hold that vanishes — drops
   out on the next push. Display only: these rows are never expenses,
   never enter the rollup or any balance. Amounts are stored as
   positive spend cents (what the charge costs if it posts as-is),
   converted from dollars at the API boundary like the bank tables. */
const CREATE_PENDING_TRANSACTIONS = `CREATE TABLE IF NOT EXISTS pending_transactions (
  plaid_transaction_id TEXT PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  account_label TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
/* What the owner decided for a bank transaction in the Daily review
   list: "repayment" (a housemate paying back a shared expense — lowers
   what they owe, never income), "income" (counted in that month's
   actual other income) or "ignore". Linked expenses need no row here:
   daily_expenses.bank_tx_id already marks those as reviewed. */
const CREATE_BANK_REVIEW = `CREATE TABLE IF NOT EXISTS bank_tx_review (
  plaid_transaction_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
/* Manual "Sync now" requests: a device session queues one from the
   Daily tab; the paired automation's VM poller claims it, runs the
   real sync engine, and completes it with the run summary as JSON.
   An active row suppresses duplicates; one that has waited unclaimed,
   or run since its claim, longer than SYNC_REQUEST_ACTIVE_MS is
   expired to failed. */
const CREATE_SYNC_REQUESTS = `CREATE TABLE IF NOT EXISTS sync_requests (
  id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  claimed_at TEXT,
  finished_at TEXT
)`;
export const REVIEW_KINDS = ["repayment", "income", "ignore"];
import { CATEGORY_TO_FIELD } from "./_categories.js";
import { merchantCategory, sanitizeMerchantRules } from "../../js/core/merchant.js";
export { CATEGORY_TO_FIELD };

function toCents(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function toDollars(cents) {
  const n = typeof cents === "number" ? cents : parseInt(cents, 10);
  return Number.isFinite(n) ? n / 100 : 0;
}
function cleanText(v) {
  return typeof v === "string" ? v.slice(0, 500) : "";
}
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README) or use the app in local-only mode." }, 503);
}

/* Runs on every API request, so it is one D1 batch (one round trip, one
   transaction) rather than ~36 sequential statements, which cost ~3s a
   request. Every statement is idempotent. */
export async function ensureTables(db) {
  const stmts = [
    db.prepare(CREATE_SETTINGS),
    db.prepare(CREATE_MONTHS),
    db.prepare(CREATE_ACTUALS),
    db.prepare(CREATE_DAILY),
    db.prepare(CREATE_CARDS),
    db.prepare(CREATE_SESSIONS),
    db.prepare(CREATE_AUTH_ATTEMPTS),
    db.prepare(CREATE_BANK_ACCOUNTS),
    db.prepare(CREATE_BANK_TRANSACTIONS),
    db.prepare(CREATE_PENDING_TRANSACTIONS),
    db.prepare(CREATE_BANK_REVIEW),
    db.prepare(CREATE_SYNC_REQUESTS),
    db.prepare("CREATE INDEX IF NOT EXISTS auth_attempts_at ON auth_attempts (at)"),
    db.prepare("PRAGMA table_info(daily_expenses)")
  ];
  const pragmaIndex = stmts.length - 1;
  /* Month rows are written on first save (upserts), so none are seeded.
     A database from before plan_start keeps its first month. */
  stmts.push(db.prepare(
    "INSERT OR IGNORE INTO budget_settings (key, value) SELECT 'plan_start', COALESCE((SELECT MIN(month_key) FROM monthly_budgets), ?)"
  ).bind(thisMonth()));
  stmts.push(db.prepare("INSERT OR IGNORE INTO budget_settings (key, value) VALUES ('starting_balance_cents', '0')"));
  stmts.push(db.prepare("INSERT OR IGNORE INTO budget_settings (key, value) VALUES ('baseline_date', ?)").bind(todayIso()));
  stmts.push(db.prepare("INSERT OR IGNORE INTO budget_settings (key, value) VALUES ('baseline_note', '')"));
  const results = await db.batch(stmts);
  /* Migrations for databases created before later features: the CREATE
     TABLE above does not add columns to an existing table, so add
     daily_expenses.card_name (Cards feature) and daily_expenses.my_share
     (shared-expense "my share" feature) explicitly when absent. Existing
     rows read back with NULL for both, i.e. no card and full amount his.
     Only an old database ever takes this second round trip, once. */
  const colNames = ((results[pragmaIndex] && results[pragmaIndex].results) || []).map((c) => c.name);
  const alters = [];
  if (!colNames.includes("card_name")) alters.push(db.prepare("ALTER TABLE daily_expenses ADD COLUMN card_name TEXT"));
  if (!colNames.includes("my_share")) alters.push(db.prepare("ALTER TABLE daily_expenses ADD COLUMN my_share REAL"));
  /* bank_tx_id links an expense to the bank_transactions row it was paid
     by. Always added here (never in CREATE TABLE) so the unique index can
     be created right after the column exists: one bank payment can back
     at most one expense, which is what stops a double import. */
  const addBankLink = !colNames.includes("bank_tx_id");
  if (addBankLink) {
    alters.push(db.prepare("ALTER TABLE daily_expenses ADD COLUMN bank_tx_id TEXT"));
    alters.push(db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS daily_expenses_bank_tx ON daily_expenses (bank_tx_id) WHERE bank_tx_id IS NOT NULL"));
  }
  /* pending_tx_id: the Plaid PENDING charge an expense was counted from
     ("Count it now"); pending_settled flips to 1 once the posted charge
     arrives and updates this same expense. One pending charge backs at
     most one expense. */
  if (!colNames.includes("pending_tx_id")) {
    alters.push(db.prepare("ALTER TABLE daily_expenses ADD COLUMN pending_tx_id TEXT"));
    alters.push(db.prepare("ALTER TABLE daily_expenses ADD COLUMN pending_settled INTEGER NOT NULL DEFAULT 0"));
    alters.push(db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS daily_expenses_pending_tx ON daily_expenses (pending_tx_id) WHERE pending_tx_id IS NOT NULL"));
  }
  /* note: the owner's own comment on an expense ("premium processing
     fee"). Only the owner writes it; imports and settling never do. */
  if (!colNames.includes("note")) alters.push(db.prepare("ALTER TABLE daily_expenses ADD COLUMN note TEXT"));
  if (alters.length) {
    try {
      await db.batch(alters);
    } catch (e) {
      /* Two first requests can race to migrate: the loser's ALTER finds
         the column already added, which is fine. */
      if (!/duplicate column/i.test(String((e && e.message) || e))) throw e;
    }
  }
  if (addBankLink) await autoLinkBankTransactions(db); /* one-time backfill */
}

/* Link unlinked expenses to the bank transaction they exactly match
   (same date, same name, same amount). The Plaid sync imports bank
   outflows verbatim, so this ties each import to its source row, in
   whichever order the expense and the bank snapshot arrive. */
export async function autoLinkBankTransactions(db) {
  const exp = await db.prepare(
    "SELECT id, date, description, amount FROM daily_expenses WHERE bank_tx_id IS NULL"
  ).all();
  const tx = await db.prepare(
    "SELECT plaid_transaction_id AS id, date, name, amount_cents FROM bank_transactions " +
    "WHERE plaid_transaction_id NOT IN (SELECT bank_tx_id FROM daily_expenses WHERE bank_tx_id IS NOT NULL)"
  ).all();
  const free = new Map();
  for (const t of tx.results || []) {
    const k = t.date + "|" + t.name + "|" + t.amount_cents;
    if (!free.has(k)) free.set(k, []);
    free.get(k).push(t.id);
  }
  const stmts = [];
  for (const e of exp.results || []) {
    const ids = free.get(e.date + "|" + e.description + "|" + Math.round((e.amount || 0) * 100));
    if (ids && ids.length) {
      stmts.push(db.prepare("UPDATE daily_expenses SET bank_tx_id = ? WHERE id = ?").bind(ids.shift(), e.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

async function setSetting(db, key, value) {
  await db
    .prepare("INSERT INTO budget_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(value))
    .run();
}
async function getSetting(db, key) {
  const row = await db.prepare("SELECT value FROM budget_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

/* ================= access-code auth + sessions =================
   The access code itself is never stored or returned — only a salted
   PBKDF2-SHA256 hash (budget_settings key 'access_code_hash', format
   "pbkdf2$<iterations>$<salt b64>$<hash b64>"). A plain SHA-256 hash
   left by v6.x is still accepted and upgraded on the next sign-in.
   Every secret check (setup secret, login, change-code, pairing code)
   first RESERVES an attempt in auth_attempts — at most 5 per IP and 20
   overall per 10 minutes. The reservation and the counts run as one D1
   batch (a transaction), so parallel requests cannot get extra guesses. */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/* Constant-time compare for equal-length strings (hex or base64 digests). */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function sqlTime(d) { return d.toISOString().slice(0, 19).replace("T", " "); }
function parseSqlTime(s) { return Date.parse(String(s || "").replace(" ", "T") + "Z"); }
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SYNC_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const MIN_CODE_LENGTH = 12;
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const PER_IP_MAX_ATTEMPTS = 5;
export const GLOBAL_MAX_ATTEMPTS = 20;
export const PBKDF2_ITERATIONS = 100000; /* the Workers runtime maximum */

export async function getAccessCodeHash(db) {
  await ensureTables(db);
  return getSetting(db, "access_code_hash");
}
export async function setAccessCodeHash(db, hash) {
  await setSetting(db, "access_code_hash", hash);
}
/* Atomically set the FIRST access code: succeeds only when no code
   exists (or it was blanked), so two racing setups cannot both win. */
export async function claimAccessCode(db, hash) {
  const res = await db.prepare(
    "INSERT INTO budget_settings (key, value) VALUES ('access_code_hash', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE budget_settings.value = ''"
  ).bind(hash).run();
  return !!(res && res.meta && res.meta.changes === 1);
}

function bytesToB64(u8) { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
function b64ToBytes(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function pbkdf2(code, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(code == null ? "" : code)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
/* Salted, slow hash for storage. */
export async function hashAccessCode(code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return "pbkdf2$" + PBKDF2_ITERATIONS + "$" + bytesToB64(salt) + "$" + bytesToB64(await pbkdf2(code, salt, PBKDF2_ITERATIONS));
}
/* -> { ok, legacy }. legacy: true means the code matched a v6.x
   SHA-256 hash and the caller should re-store it with hashAccessCode. */
export async function verifyAccessCode(stored, code) {
  if (typeof stored !== "string" || !stored) return { ok: false, legacy: false };
  if (stored.startsWith("pbkdf2$")) {
    const [, iter, salt, hash] = stored.split("$");
    const iterations = parseInt(iter, 10);
    if (!Number.isFinite(iterations) || !salt || !hash) return { ok: false, legacy: false };
    const got = bytesToB64(await pbkdf2(code, b64ToBytes(salt), iterations));
    return { ok: timingSafeEqualHex(got, hash), legacy: false };
  }
  const legacy = await sha256Hex("monthly-budget-access-code:" + String(code == null ? "" : code));
  const ok = timingSafeEqualHex(stored, legacy);
  return { ok, legacy: ok };
}

/* ---- attempt limiting (login, change-code, setup secret, pairing code) ---- */
function clientIp(request) {
  return (request && request.headers && request.headers.get("CF-Connecting-IP")) || "unknown";
}
/* Reserve one attempt BEFORE checking a secret. Returns
   { ok, perIp, global, retryAfterMs }: ok is false when this attempt
   is over either limit (the secret must then not be checked at all). */
export async function reserveAttempt(db, request) {
  await ensureTables(db);
  const ip = clientIp(request);
  const now = Date.now();
  const since = now - ATTEMPT_WINDOW_MS;
  const out = await db.batch([
    db.prepare("DELETE FROM auth_attempts WHERE at < ?").bind(now - 24 * 60 * 60 * 1000),
    db.prepare("INSERT INTO auth_attempts (at, ip) VALUES (?, ?)").bind(now, ip),
    db.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE at > ? AND ip = ?").bind(since, ip),
    db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM auth_attempts WHERE at > ?").bind(since)
  ]);
  const perIp = Number(out[2].results[0].n) || 0;
  const global = Number(out[3].results[0].n) || 0;
  const oldest = Number(out[3].results[0].oldest) || now;
  return {
    ok: perIp <= PER_IP_MAX_ATTEMPTS && global <= GLOBAL_MAX_ATTEMPTS,
    atLimit: perIp >= PER_IP_MAX_ATTEMPTS || global >= GLOBAL_MAX_ATTEMPTS,
    perIp, global,
    retryAfterMs: Math.max(60000, oldest + ATTEMPT_WINDOW_MS - now)
  };
}
/* A correct secret wipes the attempt log, so the owner is never left
   locked behind earlier typos. */
export async function clearAttempts(db) {
  await db.prepare("DELETE FROM auth_attempts").run();
}

function newSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sessionExpiry(kind, now) {
  return sqlTime(new Date(now.getTime() + (kind === "sync" ? SYNC_TTL_MS : SESSION_TTL_MS)));
}
export function publicSession(row, currentTokenHash) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label || "",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at || null,
    current: !!currentTokenHash && row.token_hash === currentTokenHash
  };
}
/* Create a session row and return the RAW token (the only place it ever
   exists server-side) plus the public session view. */
export async function createSession(db, { kind = "device", label = "" } = {}) {
  await ensureTables(db);
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : tokenHash.slice(0, 36);
  const now = new Date();
  const k = kind === "sync" ? "sync" : "device";
  const expiresAt = sessionExpiry(k, now);
  const cleanLabel = String(label || "").slice(0, 100);
  await db.prepare(
    "INSERT INTO sessions (id, token_hash, kind, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tokenHash, k, cleanLabel, sqlTime(now), sqlTime(now), expiresAt).run();
  return {
    token,
    session: { id, kind: k, label: cleanLabel, createdAt: sqlTime(now), lastSeenAt: sqlTime(now), expiresAt, current: true }
  };
}
/* Resolve a raw token to its session row, enforcing expiry and applying
   the sliding window: when the last activity is over 24h old, the
   session's last_seen_at rolls forward and a device session's
   expires_at becomes now + 90 days. 'sync' sessions have a fixed
   180-day life from pairing (a pre-v7 sync row with no expiry gets one
   on first use) — re-pair in Settings to renew. */
export async function getSessionForToken(db, token) {
  if (!token) return null;
  await ensureTables(db);
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare("SELECT * FROM sessions WHERE token_hash = ?").bind(tokenHash).first();
  if (!row) return null;
  const now = new Date();
  const nowStr = sqlTime(now);
  if (row.expires_at && row.expires_at <= nowStr) {
    await db.prepare("DELETE FROM sessions WHERE id = ?").bind(row.id).run();
    return null;
  }
  const lastSeen = parseSqlTime(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > 24 * 60 * 60 * 1000 || !row.expires_at) {
    const expiresAt = row.kind === "sync" ? (row.expires_at || sessionExpiry("sync", now)) : sessionExpiry("device", now);
    await db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
      .bind(nowStr, expiresAt, row.id).run();
    row.last_seen_at = nowStr;
    row.expires_at = expiresAt;
  }
  return row;
}
export function extractSessionToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return request.headers.get("X-Session-Token") || null;
}
/* The shared guard every data handler calls first. While no access code
   exists the app is in setup mode: data endpoints answer 403 with
   setupRequired so the frontend can show the create-code screen (the
   only write allowed then is POST /api/auth action "setup"). Once a
   code exists, a valid session token is mandatory: 401 otherwise.
   'sync' sessions (the Plaid script) are least-privilege: refused with
   403 unless the route opts in with { allowSync: true }. */
export async function requireAuth(db, request, { allowSync = false } = {}) {
  const codeHash = await getAccessCodeHash(db);
  if (!codeHash) {
    return { response: json({ error: "Access code setup required", setupRequired: true }, 403) };
  }
  const session = await getSessionForToken(db, extractSessionToken(request));
  if (!session) return { response: json({ error: "Sign-in required" }, 401) };
  if (session.kind === "sync" && !allowSync) {
    return { response: json({ error: "Sync tokens can't use this endpoint." }, 403) };
  }
  return { session };
}
export async function listSessions(db, currentTokenHash) {
  await ensureTables(db);
  const { results } = await db.prepare("SELECT * FROM sessions ORDER BY created_at ASC, id ASC").all();
  return (results || []).map((r) => publicSession(r, currentTokenHash));
}
export async function deleteSessionById(db, id) {
  const res = await db.prepare("DELETE FROM sessions WHERE id = ?").bind(String(id || "")).run();
  return !!(res && res.meta && res.meta.changes > 0);
}
export async function deleteOtherSessions(db, keepId) {
  await db.prepare("DELETE FROM sessions WHERE id != ?").bind(String(keepId || "")).run();
}
export async function deleteAllSessions(db) {
  await db.prepare("DELETE FROM sessions").run();
}

/* ================= automation pairing (v7) =================
   Device-pairing for the Plaid sync script, so no secret ever crosses
   chat AND nobody else can slip in a request:
     1. The owner taps "Pair automation" in Settings (pair-open, device
        session only) and gets a one-time 8-character pairing code that
        expires in 10 minutes.
     2. The script generates its own session token locally and sends
        { pairCode, tokenHash } (pair-request, unauthenticated). A wrong
        code counts against the attempt limit; a right one is consumed.
     3. Settings shows the request with a fingerprint (first 8 hex chars
        of the hash — the hash itself is not a credential). The script
        prints the same fingerprint; the owner compares, then approves.
        pair-approve must echo that fingerprint, so a request that was
        swapped after the owner looked can never be approved.
   Stored in budget_settings: 'pair_open' = { codeHash, until } and
   'pending_pairing' = { tokenHash, label, requestedAt }. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const PENDING_PAIRING_TTL_MS = 30 * 60 * 1000;
const PAIR_OPEN_KEY = "pair_open";
const PENDING_PAIRING_KEY = "pending_pairing";
const PAIR_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; /* no 0/O, 1/I/L */

export function isValidTokenHash(v) {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}
export function pairingFingerprint(tokenHash) {
  return String(tokenHash || "").slice(0, 8);
}
function normalizePairCode(v) {
  return typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}
/* Owner-side: open a pairing window. Returns { code, expiresAt }. */
export async function openPairing(db) {
  await ensureTables(db);
  let code = "";
  /* Rejection sampling keeps every character uniformly likely. */
  while (code.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && code.length < 8) code += PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length];
    }
  }
  const until = Date.now() + PAIR_CODE_TTL_MS;
  await setSetting(db, PAIR_OPEN_KEY, JSON.stringify({ codeHash: await sha256Hex(code), until }));
  return { code: code.slice(0, 4) + "-" + code.slice(4), expiresAt: sqlTime(new Date(until)) };
}
export async function getPairingWindow(db) {
  await ensureTables(db);
  const raw = await getSetting(db, PAIR_OPEN_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p.codeHash !== "string" || !(Number(p.until) > Date.now())) return null;
    return { codeHash: p.codeHash, until: Number(p.until) };
  } catch (e) {
    return null;
  }
}
export async function closePairingWindow(db) {
  await setSetting(db, PAIR_OPEN_KEY, "");
}
/* True when `code` matches the open window; a match closes the window
   (single use). The caller must reserveAttempt() first. */
export async function consumePairCode(db, code) {
  const open = await getPairingWindow(db);
  if (!open) return false;
  const ok = timingSafeEqualHex(await sha256Hex(normalizePairCode(code)), open.codeHash);
  if (ok) await closePairingWindow(db);
  return ok;
}
export async function getPendingPairing(db) {
  await ensureTables(db);
  const raw = await getSetting(db, PENDING_PAIRING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || !isValidTokenHash(p.tokenHash)) return null;
    const at = parseSqlTime(p.requestedAt);
    if (!Number.isFinite(at) || Date.now() - at > PENDING_PAIRING_TTL_MS) return null;
    return { tokenHash: p.tokenHash, label: String(p.label || ""), requestedAt: String(p.requestedAt || "") };
  } catch (e) {
    return null;
  }
}
/* Register the pending pairing (only reachable with a valid one-time
   pairing code, so it can only replace a request the owner opened). */
export async function setPendingPairing(db, { tokenHash, label } = {}) {
  const pending = {
    tokenHash,
    label: String(label || "").slice(0, 100) || "Plaid sync",
    requestedAt: sqlTime(new Date())
  };
  await setSetting(db, PENDING_PAIRING_KEY, JSON.stringify(pending));
  return pending;
}
export async function clearPendingPairing(db) {
  await setSetting(db, PENDING_PAIRING_KEY, "");
}
/* Create a session row for a token hash the caller already holds (the
   pairing-approval path): the raw token never exists server-side, so
   unlike createSession this returns no token — just the session view. */
export async function createSessionForTokenHash(db, { kind = "sync", label = "", tokenHash } = {}) {
  await ensureTables(db);
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(tokenHash).slice(0, 36);
  const now = new Date();
  const k = kind === "sync" ? "sync" : "device";
  const expiresAt = sessionExpiry(k, now);
  const cleanLabel = String(label || "").slice(0, 100);
  await db.prepare(
    "INSERT INTO sessions (id, token_hash, kind, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tokenHash, k, cleanLabel, sqlTime(now), sqlTime(now), expiresAt).run();
  return { id, kind: k, label: cleanLabel, createdAt: sqlTime(now), lastSeenAt: sqlTime(now), expiresAt, current: false };
}

/* ---------------- Credit cards (statement cycles) ----------------
 * A card bill is due in a later month/paycheck than the spending, so
 * each card stores its statement period and the frontend groups the
 * card's daily expenses inside that window. Cards are keyed by name in
 * daily_expenses.card_name (a plain name match, so renaming a card
 * means its older expenses keep the old name — by design, the name IS
 * the tag the user picked when logging the expense). */
export function isValidDateStr(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parts = v.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.getUTCFullYear() === parts[0] && dt.getUTCMonth() === parts[1] - 1 && dt.getUTCDate() === parts[2];
}

export function validateCardInput(input) {
  const src = input && typeof input === "object" ? input : {};
  const name = typeof src.name === "string" ? src.name.trim().slice(0, 100) : "";
  if (!name) throw new Error("card name is required");
  if (!isValidDateStr(src.statementStart)) throw new Error("statementStart must be a valid YYYY-MM-DD date");
  if (!isValidDateStr(src.statementEnd)) throw new Error("statementEnd must be a valid YYYY-MM-DD date");
  if (src.statementEnd < src.statementStart) throw new Error("statementEnd must be on or after statementStart");
  let dueDate = null;
  if (src.dueDate !== undefined && src.dueDate !== null && src.dueDate !== "") {
    if (!isValidDateStr(src.dueDate)) throw new Error("dueDate must be a valid YYYY-MM-DD date");
    dueDate = src.dueDate;
  }
  return { name, statementStart: src.statementStart, statementEnd: src.statementEnd, dueDate };
}

function rowToCard(r) {
  return {
    id: r.id, name: r.name,
    statementStart: r.statement_start, statementEnd: r.statement_end,
    dueDate: r.due_date || null,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}

export async function listCards(db) {
  const { results } = await db.prepare("SELECT * FROM credit_cards ORDER BY id").all();
  return (results || []).map(rowToCard);
}

export async function createCard(db, input) {
  await ensureTables(db);
  const card = validateCardInput(input);
  const info = await db.prepare(
    "INSERT INTO credit_cards (name, statement_start, statement_end, due_date) VALUES (?, ?, ?, ?)"
  ).bind(card.name, card.statementStart, card.statementEnd, card.dueDate).run();
  const row = await db.prepare("SELECT * FROM credit_cards WHERE id = ?")
    .bind(info.meta.last_row_id).first();
  return row ? rowToCard(row) : null;
}

export async function updateCard(db, id, patch) {
  await ensureTables(db);
  const row = await db.prepare("SELECT * FROM credit_cards WHERE id = ?").bind(id).first();
  if (!row) return null;
  const current = rowToCard(row);
  const merged = { ...current };
  if (patch && typeof patch === "object") {
    for (const f of ["name", "statementStart", "statementEnd", "dueDate"]) {
      if (patch[f] !== undefined) merged[f] = patch[f];
    }
  }
  const card = validateCardInput(merged);
  await db.prepare(
    "UPDATE credit_cards SET name = ?, statement_start = ?, statement_end = ?, due_date = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(card.name, card.statementStart, card.statementEnd, card.dueDate, id).run();
  const updated = await db.prepare("SELECT * FROM credit_cards WHERE id = ?").bind(id).first();
  return updated ? rowToCard(updated) : null;
}

export async function deleteCard(db, id) {
  await ensureTables(db);
  const row = await db.prepare("SELECT id FROM credit_cards WHERE id = ?").bind(id).first();
  if (!row) return false;
  await db.prepare("DELETE FROM credit_cards WHERE id = ?").bind(id).run();
  return true;
}

/* ================= bank snapshot (Bank tab) =================
   Written ONLY by the paired sync automation (POST /api/bank checks
   the session kind); read by device sessions via getBankSnapshot.
   Amounts cross the API in dollars and are stored as integer cents,
   keeping the Plaid depository sign convention (positive = money OUT,
   negative = money IN). */

function rowToBankAccount(r) {
  return {
    id: r.plaid_account_id,
    institution: r.institution || "",
    name: r.name || "",
    subtype: r.subtype || "",
    mask: r.mask || "",
    currentBalance: r.current_cents === null || r.current_cents === undefined ? null : toDollars(r.current_cents),
    availableBalance: r.available_cents === null || r.available_cents === undefined ? null : toDollars(r.available_cents),
    updatedAt: r.updated_at
  };
}
function rowToBankTransaction(r) {
  return {
    id: r.plaid_transaction_id,
    accountId: r.account_id || "",
    date: r.date,
    name: r.name || "",
    amount: toDollars(r.amount_cents),
    pending: !!r.pending,
    pfc: r.pfc || "",
    updatedAt: r.updated_at
  };
}

export async function getBankSnapshot(db) {
  await ensureTables(db);
  const acc = await db.prepare("SELECT * FROM bank_accounts ORDER BY institution, name").all();
  const tx = await db.prepare(
    "SELECT * FROM bank_transactions ORDER BY date DESC, plaid_transaction_id DESC LIMIT 400"
  ).all();
  const accRows = acc.results || [];
  const txRows = tx.results || [];
  let syncedAt = null;
  for (const r of accRows.concat(txRows)) {
    if (r.updated_at && (!syncedAt || r.updated_at > syncedAt)) syncedAt = r.updated_at;
  }
  return {
    accounts: accRows.map(rowToBankAccount),
    transactions: txRows.map(rowToBankTransaction),
    reviews: await getReviews(db),
    ignoreRules: await getIgnoreRules(db),
    syncedAt
  };
}

/* "Always ignore payments like this" rules for the Daily review list:
   { accountId, direction: "in"|"out", name } where name is the payment
   name with digits and punctuation stripped (the app does the
   matching). Stored as one JSON setting; replaced whole on save. */
export const IGNORE_RULES_CAP = 100;
async function getIgnoreRules(db) {
  try {
    const rules = JSON.parse((await getSetting(db, "review_ignore_rules")) || "[]");
    return Array.isArray(rules) ? rules : [];
  } catch (e) {
    return [];
  }
}
export async function setIgnoreRules(db, rules) {
  await ensureTables(db);
  if (!Array.isArray(rules)) throw new Error("ignoreRules must be an array");
  const clean = [];
  for (const r of rules.slice(0, IGNORE_RULES_CAP)) {
    if (!r || typeof r !== "object") continue;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 200) : "";
    const accountId = typeof r.accountId === "string" ? r.accountId.slice(0, 200) : "";
    if (!name || !accountId || (r.direction !== "in" && r.direction !== "out")) continue;
    clean.push({ accountId, direction: r.direction, name });
  }
  await setSetting(db, "review_ignore_rules", JSON.stringify(clean));
  return getBankSnapshot(db);
}

async function getReviews(db) {
  const { results } = await db.prepare("SELECT plaid_transaction_id AS id, kind FROM bank_tx_review").all();
  const out = {};
  for (const r of results || []) out[r.id] = r.kind;
  return out;
}

/* Record (or with kind null, clear) the review decision for one bank
   transaction. Marking money IN as "income" adds it to that month's
   actual other income; moving it off "income" takes it back out, so the
   income is only ever counted while the mark stands. */
export async function setBankReview(db, txId, kind) {
  await ensureTables(db);
  if (kind !== null && !REVIEW_KINDS.includes(kind)) throw new Error("kind must be one of " + REVIEW_KINDS.join(", ") + ", or null");
  const tx = await db.prepare("SELECT date, amount_cents FROM bank_transactions WHERE plaid_transaction_id = ?").bind(txId).first();
  if (!tx) throw new Error("bank transaction not found");
  const prev = await db.prepare("SELECT kind FROM bank_tx_review WHERE plaid_transaction_id = ?").bind(txId).first();
  const was = prev ? prev.kind : null;
  if (kind === null) {
    await db.prepare("DELETE FROM bank_tx_review WHERE plaid_transaction_id = ?").bind(txId).run();
  } else {
    await db.prepare(
      "INSERT INTO bank_tx_review (plaid_transaction_id, kind, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(plaid_transaction_id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at"
    ).bind(txId, kind).run();
  }
  const monthKey = String(tx.date).slice(0, 7);
  const delta = (was === "income" ? -1 : 0) + (kind === "income" ? 1 : 0);
  if (delta && (await monthKeys(db)).includes(monthKey)) {
    /* Money IN is negative in the Plaid convention. */
    const amount = toDollars(-tx.amount_cents) * delta;
    const current = (await readState(db)).actuals.find((a) => a.monthKey === monthKey);
    await patchActual(db, monthKey, { otherIncome: Math.round(((current.otherIncome || 0) + amount) * 100) / 100 });
  }
  return getBankSnapshot(db);
}

export const BANK_ARRAY_CAP = 500;
function cleanBankText(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}
/* Dollars -> cents, preserving null for "Plaid gave no figure" (an
   account's available balance can be absent) instead of faking a 0. */
function bankDollarsToCents(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/* Upsert one sync push. Malformed entries are skipped (never fatal —
   one odd Plaid row must not block the rest of the snapshot); returns
   the counts actually written. Every written row is stamped with the
   push's syncedAt so GET can report when the snapshot was taken. */
export async function upsertBankData(db, body) {
  await ensureTables(db);
  const src = body && typeof body === "object" ? body : {};
  const stamp = typeof src.syncedAt === "string" && src.syncedAt
    ? src.syncedAt.slice(0, 40)
    : new Date().toISOString();
  const accountsIn = Array.isArray(src.accounts) ? src.accounts.slice(0, BANK_ARRAY_CAP) : [];
  const txIn = Array.isArray(src.transactions) ? src.transactions.slice(0, BANK_ARRAY_CAP) : [];
  const stmts = [];
  let accounts = 0;
  let transactions = 0;
  for (const a of accountsIn) {
    if (!a || typeof a !== "object") continue;
    const id = cleanBankText(a.plaidAccountId !== undefined ? a.plaidAccountId : a.id, 200);
    if (!id) continue;
    stmts.push(db.prepare(
      "INSERT INTO bank_accounts (plaid_account_id, institution, name, subtype, mask, current_cents, available_cents, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plaid_account_id) DO UPDATE SET " +
      "institution = excluded.institution, name = excluded.name, subtype = excluded.subtype, mask = excluded.mask, " +
      "current_cents = excluded.current_cents, available_cents = excluded.available_cents, updated_at = excluded.updated_at"
    ).bind(
      id,
      cleanBankText(a.institution, 200),
      cleanBankText(a.name, 200),
      cleanBankText(a.subtype, 60),
      cleanBankText(a.mask, 20),
      bankDollarsToCents(a.currentBalance),
      bankDollarsToCents(a.availableBalance),
      stamp
    ));
    accounts++;
  }
  for (const t of txIn) {
    if (!t || typeof t !== "object") continue;
    const id = cleanBankText(t.plaidTransactionId !== undefined ? t.plaidTransactionId : t.id, 200);
    if (!id || !isValidDateStr(t.date)) continue;
    const cents = bankDollarsToCents(t.amount);
    if (cents === null) continue;
    stmts.push(db.prepare(
      "INSERT INTO bank_transactions (plaid_transaction_id, account_id, date, name, amount_cents, pending, pfc, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plaid_transaction_id) DO UPDATE SET " +
      "account_id = excluded.account_id, date = excluded.date, name = excluded.name, amount_cents = excluded.amount_cents, " +
      "pending = excluded.pending, pfc = excluded.pfc, updated_at = excluded.updated_at"
    ).bind(
      id,
      cleanBankText(t.accountId, 200),
      t.date,
      cleanBankText(t.name, 500),
      cents,
      t.pending ? 1 : 0,
      cleanBankText(t.pfc, 100),
      stamp
    ));
    transactions++;
  }
  if (stmts.length) await db.batch(stmts);
  await autoLinkBankTransactions(db);
  return { accounts, transactions };
}

/* ================= pending charges snapshot =================
   Written ONLY by the paired sync automation (POST /api/pending
   checks the session kind); read by device sessions. Unlike the bank
   snapshot this is a REPLACE, not an upsert: the sync pushes the full
   set of charges Plaid reports as pending right now, and anything no
   longer pending (posted, or a hold that vanished) must disappear —
   the expense import picks posted charges up through the normal
   /api/expenses path, so nothing is lost. Display only. */

function rowToPendingTransaction(r) {
  return {
    id: r.plaid_transaction_id,
    date: r.date,
    name: r.name || "",
    amount: toDollars(r.amount_cents),
    accountLabel: r.account_label || "",
    category: r.category || "",
    updatedAt: r.updated_at
  };
}

export async function getPendingSnapshot(db) {
  await ensureTables(db);
  const tx = await db.prepare(
    "SELECT * FROM pending_transactions ORDER BY date DESC, plaid_transaction_id DESC LIMIT 200"
  ).all();
  const rows = tx.results || [];
  let syncedAt = null;
  for (const r of rows) {
    if (r.updated_at && (!syncedAt || r.updated_at > syncedAt)) syncedAt = r.updated_at;
  }
  return { transactions: rows.map(rowToPendingTransaction), syncedAt };
}

export const PENDING_ARRAY_CAP = 200;

/* Replace the whole pending set with one sync push. Malformed entries
   are skipped (never fatal); returns the count actually written.
   Every row is stamped with the push's syncedAt so GET can report
   when the snapshot was taken. */
export async function replacePendingData(db, body) {
  await ensureTables(db);
  const src = body && typeof body === "object" ? body : {};
  const stamp = typeof src.syncedAt === "string" && src.syncedAt
    ? src.syncedAt.slice(0, 40)
    : new Date().toISOString();
  const txIn = Array.isArray(src.transactions) ? src.transactions.slice(0, PENDING_ARRAY_CAP) : [];
  const stmts = [db.prepare("DELETE FROM pending_transactions")];
  let transactions = 0;
  for (const t of txIn) {
    if (!t || typeof t !== "object") continue;
    const id = cleanBankText(t.plaidTransactionId !== undefined ? t.plaidTransactionId : t.id, 200);
    if (!id || !isValidDateStr(t.date)) continue;
    const cents = bankDollarsToCents(t.amount);
    if (cents === null || cents <= 0) continue;
    stmts.push(db.prepare(
      "INSERT INTO pending_transactions (plaid_transaction_id, date, name, amount_cents, account_label, category, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id,
      t.date,
      cleanBankText(t.name, 500),
      cents,
      cleanBankText(t.accountLabel, 200),
      cleanBankText(t.category, 100),
      stamp
    ));
    transactions++;
  }
  await db.batch(stmts);
  return { transactions };
}

/* ================= manual sync requests =================
   The request queue behind the Daily tab's "Sync now" button. The
   app cannot pull Plaid itself, so a device session leaves a pending
   row here; the paired automation's poller (tools/sync-poller.mjs on
   the VM) claims the oldest pending row, runs the real sync engine,
   and completes the row with the run summary. One active request at a
   time: an active row is handed back instead of inserting a
   duplicate. The 10-minute limit is measured from when the request was
   filed while it waits (the poller is gone) and from when it was
   CLAIMED once it runs (the run died), so a sync claimed late still
   gets its full run time. Either way the queue can never wedge shut. */
export const SYNC_REQUEST_ACTIVE_MS = 10 * 60 * 1000;

function rowToSyncRequest(r) {
  let result = null;
  if (r.result) {
    try { result = JSON.parse(r.result); } catch (e) { result = null; }
  }
  return {
    id: r.id,
    status: r.status,
    requestedAt: r.requested_at,
    claimedAt: r.claimed_at || null,
    finishedAt: r.finished_at || null,
    result
  };
}

async function expireStaleSyncRequests(db) {
  const cutoff = sqlTime(new Date(Date.now() - SYNC_REQUEST_ACTIVE_MS));
  await db.prepare(
    "UPDATE sync_requests SET status = 'failed', " +
    "result = ?, finished_at = ? " +
    "WHERE (status = 'pending' AND requested_at < ?) " +
    "OR (status = 'running' AND COALESCE(claimed_at, requested_at) < ?)"
  ).bind(
    JSON.stringify({ error: "Timed out — the sync automation did not finish this request. Try again." }),
    sqlTime(new Date()),
    cutoff,
    cutoff
  ).run();
}

/* Queue a sync for a device session, or return the active one.
   -> { request, created }
   Ordering note: requested_at has one-second resolution (the shared
   sqlTime format), so "newest" is decided by rowid — true insertion
   order — with requested_at only a display value. Two requests filed
   in the same second would otherwise sort by their random ids. */
export async function requestSync(db) {
  await ensureTables(db);
  await expireStaleSyncRequests(db);
  const active = await db.prepare(
    "SELECT * FROM sync_requests WHERE status IN ('pending', 'running') ORDER BY rowid DESC LIMIT 1"
  ).first();
  if (active) return { request: rowToSyncRequest(active), created: false };
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : (await sha256Hex(String(Date.now()) + ":" + Math.random())).slice(0, 36);
  const now = sqlTime(new Date());
  await db.prepare(
    "INSERT INTO sync_requests (id, requested_at, status) VALUES (?, ?, 'pending')"
  ).bind(id, now).run();
  return { request: { id, status: "pending", requestedAt: now, claimedAt: null, finishedAt: null, result: null }, created: true };
}

/* The newest request of any status, or null when none was ever made. */
export async function getLatestSyncRequest(db) {
  await ensureTables(db);
  await expireStaleSyncRequests(db);
  const row = await db.prepare(
    "SELECT * FROM sync_requests ORDER BY rowid DESC LIMIT 1"
  ).first();
  return row ? rowToSyncRequest(row) : null;
}

/* Atomically claim the oldest pending request for the sync
   automation: the conditional UPDATE is the claim — exactly one
   poller can turn a given row pending -> running. -> request | null */
export async function claimSyncRequest(db) {
  await ensureTables(db);
  await expireStaleSyncRequests(db);
  const res = await db.prepare(
    "UPDATE sync_requests SET status = 'running', claimed_at = ? " +
    "WHERE status = 'pending' AND id = (" +
    "  SELECT id FROM sync_requests WHERE status = 'pending' ORDER BY rowid ASC LIMIT 1" +
    ")"
  ).bind(sqlTime(new Date())).run();
  if (!(res && res.meta && res.meta.changes)) return null;
  const row = await db.prepare(
    "SELECT * FROM sync_requests WHERE status = 'running' ORDER BY rowid DESC LIMIT 1"
  ).first();
  return row ? rowToSyncRequest(row) : null;
}

/* Finish a claimed request. Only a running row can complete, so a
   late or replayed completion for an expired/finished request is a
   no-op (the caller gets null and answers 404). The stored result is
   capped so a runaway summary can't bloat the row.
   -> updated request | null */
export const SYNC_RESULT_CAP = 20000;
export async function completeSyncRequest(db, id, status, result) {
  await ensureTables(db);
  const cleanStatus = status === "done" ? "done" : "failed";
  const cleanResult = result && typeof result === "object" && !Array.isArray(result)
    ? result
    : { error: cleanStatus === "failed" ? "Sync failed." : "" };
  const res = await db.prepare(
    "UPDATE sync_requests SET status = ?, result = ?, finished_at = ? WHERE id = ? AND status = 'running'"
  ).bind(
    cleanStatus,
    JSON.stringify(cleanResult).slice(0, SYNC_RESULT_CAP),
    sqlTime(new Date()),
    String(id || "")
  ).run();
  if (!(res && res.meta && res.meta.changes)) return null;
  const row = await db.prepare("SELECT * FROM sync_requests WHERE id = ?").bind(String(id || "")).first();
  return row ? rowToSyncRequest(row) : null;
}

export async function readState(db) {
  await ensureTables(db);
  const startingRaw = await getSetting(db, "starting_balance_cents");
  const startingBalance = startingRaw !== null ? toDollars(parseInt(startingRaw, 10)) : 0;
  const baselineDate = (await getSetting(db, "baseline_date")) || todayIso();
  const keys = await monthKeys(db);
  const baselineNote = (await getSetting(db, "baseline_note")) || "";
  const { results } = await db.prepare("SELECT * FROM monthly_budgets ORDER BY month_key").all();
  const byKey = new Map((results || []).map((r) => [r.month_key, r]));
  const months = keys.map((key) => {
    const row = byKey.get(key) || {};
    const m = { monthKey: key };
    for (const [field, col] of MONEY_FIELDS) m[field] = toDollars(row[col] || 0);
    for (const [field, col] of TEXT_FIELDS) m[field] = row[col] || "";
    return m;
  });
  const actualsResult = await db.prepare("SELECT * FROM monthly_actuals ORDER BY month_key").all();
  const actualByKey = new Map((actualsResult.results || []).map((r) => [r.month_key, r]));
  const actuals = keys.map((key) => {
    const row = actualByKey.get(key) || {};
    const a = { monthKey: key, entered: row.has_data === 1 || row.has_data === true };
    for (const [field, col] of MONEY_FIELDS) a[field] = toDollars(row[col] || 0);
    return a;
  });
  const dailyResult = await db.prepare(
    "SELECT * FROM daily_expenses ORDER BY date DESC, id DESC"
  ).all();
  const dailyExpenses = (dailyResult.results || []).map((r) => ({
    id: r.id, date: r.date, description: r.description,
    amount: Math.round((r.amount || 0) * 100) / 100,
    category: r.category, categorizationSource: r.categorization_source,
    card: r.card_name || null,
    myShare: r.my_share === null || r.my_share === undefined
      ? null : Math.round(r.my_share * 100) / 100,
    bankTxId: r.bank_tx_id || null,
    pendingTxId: r.pending_tx_id || null,
    pendingSettled: !!r.pending_settled,
    note: r.note || "",
    createdAt: r.created_at, updatedAt: r.updated_at
  }));
  const cards = await listCards(db);
  const merchantRules = await getMerchantRules(db);
  return { baselineDate, baselineNote, startingBalance, months, actuals, dailyExpenses, cards, merchantRules };
}

/* "Always file this merchant under ..." rules (js/core/merchant.js),
   one JSON setting replaced whole on save. New expenses get them in
   categorize(); saving re-files the existing expenses matching a rule
   that is new or now points elsewhere. */
export async function getMerchantRules(db) {
  try {
    return sanitizeMerchantRules(JSON.parse((await getSetting(db, "merchant_rules")) || "[]"));
  } catch (e) {
    return [];
  }
}
async function setMerchantRules(db, rules) {
  const before = {};
  for (const r of await getMerchantRules(db)) before[r.match] = r.category;
  const clean = sanitizeMerchantRules(rules);
  await setSetting(db, "merchant_rules", JSON.stringify(clean));
  const changed = clean.filter((r) => before[r.match] !== r.category);
  if (!changed.length) return;
  const { results } = await db.prepare("SELECT id, date, description, category FROM daily_expenses").all();
  const months = new Set();
  for (const e of results || []) {
    const category = merchantCategory(changed, e.description);
    if (!category || category === e.category) continue;
    await db.prepare("UPDATE daily_expenses SET category = ?, categorization_source = 'merchant', updated_at = datetime('now') WHERE id = ?")
      .bind(category, e.id).run();
    months.add(String(e.date).slice(0, 7));
  }
  for (const mk of months) await syncDailyRollup(db, mk);
}

export async function writeActual(db, actual) {
  const cols = ["month_key", "has_data", ...MONEY_FIELDS.map(([, c]) => c)];
  const entered = actual.entered === true ||
    MONEY_FIELDS.some(([f]) => toCents(actual[f]) !== 0);
  const values = [actual.monthKey, entered ? 1 : 0, ...MONEY_FIELDS.map(([f]) => toCents(actual[f]))];
  const updates = cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
  await db
    .prepare(`INSERT INTO monthly_actuals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
              ON CONFLICT(month_key) DO UPDATE SET ${updates}, updated_at = datetime('now')`)
    .bind(...values)
    .run();
}

export async function patchActual(db, monthKey, patch) {
  await ensureTables(db);
  if (!(await monthKeys(db)).includes(monthKey) || !patch || typeof patch !== "object") {
    throw new Error("patchActual expects a valid monthKey and a patch object");
  }
  const current = (await readState(db)).actuals.find((a) => a.monthKey === monthKey);
  const merged = { ...current };
  for (const [field] of MONEY_FIELDS) if (patch[field] !== undefined) merged[field] = patch[field];
  if (patch.entered !== undefined) merged.entered = patch.entered === true;
  else if (MONEY_FIELDS.some(([f]) => patch[f] !== undefined && toCents(patch[f]) !== 0)) merged.entered = true;
  await writeActual(db, merged);
  return readState(db);
}

/*
 * ROLLUP (chosen approach): daily expenses are SYNCED into monthly_actuals.
 * If a month has any daily expenses, the daily log is authoritative for
 * that month's actual EXPENSE fields: each expense field is replaced by
 * the summed daily totals for its category (see CATEGORY_TO_FIELD), so a
 * daily expense can never be double-counted alongside a manually typed
 * actual for the same category. Per expense the rollup sums his SHARE —
 * COALESCE(my_share, amount) — so shared expenses count only his portion
 * in actuals (the full amount still shows on the Cards page, which is
 * what he owes the bank). Actual INCOME fields are untouched (the daily
 * log is expenses only), and months with no daily expenses keep their
 * manually entered actuals exactly as they are.
 *
 * Months outside the planner months have no actuals row to sync into:
 * the rollup is a no-op for them and the expense itself is simply kept
 * in the log.
 *
 * BASELINE RULE: the starting balance is a snapshot taken on the
 * baseline date (budget_settings.baseline_date, today on a new database),
 * so spending BEFORE that date is already reflected in it. The rollup
 * therefore only counts expenses dated on or after the baseline date;
 * earlier rows stay in the log as records but never enter actuals —
 * counting them would subtract the same spending twice.
 */
export async function syncDailyRollup(db, monthKey) {
  await ensureTables(db);
  if (!(await monthKeys(db)).includes(monthKey)) return readState(db);
  const baselineDate = (await getSetting(db, "baseline_date")) || todayIso();
  const { results } = await db
    .prepare("SELECT category, SUM(COALESCE(my_share, amount)) AS total, COUNT(*) AS n FROM daily_expenses WHERE substr(date, 1, 7) = ? AND date >= ? GROUP BY category")
    .bind(monthKey, baselineDate)
    .all();
  const rows = results || [];
  const totalCount = rows.reduce((s, r) => s + (r.n || 0), 0);
  const current = (await readState(db)).actuals.find((a) => a.monthKey === monthKey);
  const expenseFields = MONEY_FIELDS.map(([f]) => f)
    .filter((f) => f !== "takeHomePay" && f !== "otherIncome");
  /* Callers only sync a month that just gained or lost a row, so an empty
     log means its last expense was deleted or moved away: clear the
     rolled-up fields, and the month stops counting as entered unless it
     has manually entered actual income. */
  if (totalCount === 0) {
    const cleared = { ...current };
    for (const f of expenseFields) cleared[f] = 0;
    if (!((cleared.takeHomePay || 0) + (cleared.otherIncome || 0))) cleared.entered = false;
    await writeActual(db, cleared);
    return readState(db);
  }
  const merged = { ...current, entered: true };
  for (const f of expenseFields) merged[f] = 0;
  for (const r of rows) {
    const field = CATEGORY_TO_FIELD[r.category] || "otherExpenses";
    merged[field] = Math.round(((merged[field] || 0) + (r.total || 0)) * 100) / 100;
  }
  await writeActual(db, merged);
  return readState(db);
}

export async function listDailyExpenses(db, monthKey) {
  await ensureTables(db);
  const sql = monthKey
    ? "SELECT * FROM daily_expenses WHERE substr(date, 1, 7) = ? ORDER BY date DESC, id DESC"
    : "SELECT * FROM daily_expenses ORDER BY date DESC, id DESC";
  const stmt = db.prepare(sql);
  const { results } = monthKey ? await stmt.bind(monthKey).all() : await stmt.all();
  return (results || []).map((r) => ({
    id: r.id, date: r.date, description: r.description,
    amount: Math.round((r.amount || 0) * 100) / 100,
    category: r.category, categorizationSource: r.categorization_source,
    card: r.card_name || null,
    myShare: r.my_share === null || r.my_share === undefined
      ? null : Math.round(r.my_share * 100) / 100,
    bankTxId: r.bank_tx_id || null,
    pendingTxId: r.pending_tx_id || null,
    pendingSettled: !!r.pending_settled,
    note: r.note || "",
    createdAt: r.created_at, updatedAt: r.updated_at
  }));
}

async function writeMonth(db, month) {
  const cols = ["month_key", ...MONEY_FIELDS.map(([, c]) => c), "one_off_note", "note"];
  const values = [
    month.monthKey,
    ...MONEY_FIELDS.map(([f]) => toCents(month[f])),
    cleanText(month.oneOffNote),
    cleanText(month.note)
  ];
  const updates = cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
  await db
    .prepare(`INSERT INTO monthly_budgets (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
              ON CONFLICT(month_key) DO UPDATE SET ${updates}, updated_at = datetime('now')`)
    .bind(...values)
    .run();
}

/* Moving the baseline changes which logged expenses count, so every
   month between the old and new baseline that has daily-log rows is
   re-rolled up. Without this, a month kept the totals from the old
   baseline until one of its expenses was next edited. */
export async function setBaselineDate(db, date) {
  const old = (await getSetting(db, "baseline_date")) || todayIso();
  await setSetting(db, "baseline_date", date);
  if (old === date) return;
  const lo = (old < date ? old : date).slice(0, 7);
  const hi = (old < date ? date : old).slice(0, 7);
  const { results } = await db
    .prepare("SELECT DISTINCT substr(date, 1, 7) AS mk FROM daily_expenses WHERE substr(date, 1, 7) BETWEEN ? AND ?")
    .bind(lo, hi)
    .all();
  for (const r of results || []) await syncDailyRollup(db, r.mk);
}

export async function writeState(db, state) {
  await ensureTables(db);
  const starting = state && typeof state === "object" ? toCents(state.startingBalance) : 0;
  await setSetting(db, "starting_balance_cents", String(starting));
  if (state && typeof state.baselineDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(state.baselineDate)) {
    await setBaselineDate(db, state.baselineDate);
  }
  if (state && typeof state.baselineNote === "string") {
    await setSetting(db, "baseline_note", cleanText(state.baselineNote));
  }
  const keys = await monthKeys(db);
  const incoming = new Map();
  if (state && Array.isArray(state.months)) {
    for (const m of state.months) {
      if (m && keys.includes(m.monthKey)) incoming.set(m.monthKey, m);
    }
  }
  for (const key of keys) {
    const m = incoming.get(key) || { monthKey: key };
    await writeMonth(db, { monthKey: key, ...m });
  }
  const incomingActuals = new Map();
  if (state && Array.isArray(state.actuals)) {
    for (const a of state.actuals) {
      if (a && keys.includes(a.monthKey)) incomingActuals.set(a.monthKey, a);
    }
  }
  for (const key of keys) {
    const a = incomingActuals.get(key) || { monthKey: key, entered: false };
    await writeActual(db, { monthKey: key, ...a });
  }
  /* Cards ride along with a full-state PUT (Import / persist) ONLY when
     the payload actually carries a cards array — an older export with
     no cards field must not wipe the cards already in the database.
     Invalid entries are skipped, never fatal to the import. */
  if (state && Array.isArray(state.cards)) {
    await db.prepare("DELETE FROM credit_cards").run();
    for (const c of state.cards) {
      try {
        const card = validateCardInput(c || {});
        const keepId = c && Number.isInteger(c.id) && c.id > 0 ? c.id : null;
        if (keepId) {
          await db.prepare(
            "INSERT OR IGNORE INTO credit_cards (id, name, statement_start, statement_end, due_date) VALUES (?, ?, ?, ?, ?)"
          ).bind(keepId, card.name, card.statementStart, card.statementEnd, card.dueDate).run();
        } else {
          await db.prepare(
            "INSERT INTO credit_cards (name, statement_start, statement_end, due_date) VALUES (?, ?, ?, ?)"
          ).bind(card.name, card.statementStart, card.statementEnd, card.dueDate).run();
        }
      } catch (e) { /* skip an invalid card entry in an import */ }
    }
  }
  return readState(db);
}

export async function patchState(db, body) {
  await ensureTables(db);
  if (body && body.startingBalance !== undefined) {
    await setSetting(db, "starting_balance_cents", String(toCents(body.startingBalance)));
  }
  if (body && typeof body.baselineDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.baselineDate)) {
    await setBaselineDate(db, body.baselineDate);
  }
  if (body && typeof body.baselineNote === "string") {
    await setSetting(db, "baseline_note", cleanText(body.baselineNote));
  }
  if (body && Array.isArray(body.merchantRules)) await setMerchantRules(db, body.merchantRules);
  /* Actuals can be patched through this endpoint too:
     { actualMonthKey: "2026-11", patch: { takeHomePay: ..., entered: true } } */
  if (body && (await monthKeys(db)).includes(body.actualMonthKey) && body.patch && typeof body.patch === "object") {
    return patchActual(db, body.actualMonthKey, body.patch);
  }
  if (body && (await monthKeys(db)).includes(body.monthKey) && body.patch && typeof body.patch === "object") {
    const current = (await readState(db)).months.find((m) => m.monthKey === body.monthKey);
    const merged = { ...current };
    for (const [field] of MONEY_FIELDS) if (body.patch[field] !== undefined) merged[field] = body.patch[field];
    for (const [field] of TEXT_FIELDS) if (body.patch[field] !== undefined) merged[field] = cleanText(body.patch[field]);
    await writeMonth(db, merged);
  }
  return readState(db);
}

export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    return json(await readState(context.env.DB));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPatch(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const body = await context.request.json();
    return json(await patchState(context.env.DB, body));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
export const onRequestPost = onRequestPatch;

export async function onRequestPut(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const body = await context.request.json();
    if (!body || !Array.isArray(body.months)) {
      return json({ error: "PUT expects { startingBalance, months: [...] }" }, 400);
    }
    return json(await writeState(context.env.DB, body));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
