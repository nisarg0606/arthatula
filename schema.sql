-- Arthatula — Cloudflare D1 schema
-- Apply with:  wrangler d1 execute monthly-budget --remote --file=./schema.sql
-- (or paste into the D1 console: Cloudflare dashboard > Storage & Databases
--  > D1 SQL Database > your database > Console)
--
-- Money is stored as integer cents (100 = $1.00) to avoid float rounding.
-- The API (functions/api/budget.js) converts cents <-> dollars, and also
-- creates these tables on first request if they are missing, so applying
-- this file is a belt-and-braces convenience, not a requirement.
-- This file contains NO personal values: a fresh database starts blank.

CREATE TABLE IF NOT EXISTS budget_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON/plain-encoded setting; key 'starting_balance_cents' holds integer cents as text
);

CREATE TABLE IF NOT EXISTS monthly_budgets (
  month_key               TEXT PRIMARY KEY, -- 'YYYY-MM', one of the 12 planner months
  take_home_pay_cents     INTEGER NOT NULL DEFAULT 0,
  other_income_cents      INTEGER NOT NULL DEFAULT 0,
  rent_cents              INTEGER NOT NULL DEFAULT 0,
  utilities_cents         INTEGER NOT NULL DEFAULT 0,
  phone_internet_cents    INTEGER NOT NULL DEFAULT 0,
  groceries_cents         INTEGER NOT NULL DEFAULT 0,
  eating_out_cents        INTEGER NOT NULL DEFAULT 0,
  gas_transport_cents     INTEGER NOT NULL DEFAULT 0,
  insurance_cents         INTEGER NOT NULL DEFAULT 0,
  subscriptions_cents     INTEGER NOT NULL DEFAULT 0,
  shopping_cents          INTEGER NOT NULL DEFAULT 0,
  credila_emi_cents       INTEGER NOT NULL DEFAULT 0,
  credit_card_payment_cents INTEGER NOT NULL DEFAULT 0,
  other_loan_cents        INTEGER NOT NULL DEFAULT 0,
  one_offs_cents          INTEGER NOT NULL DEFAULT 0,
  other_expenses_cents    INTEGER NOT NULL DEFAULT 0,
  one_off_note            TEXT NOT NULL DEFAULT '',
  note                    TEXT NOT NULL DEFAULT '',
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Actuals: the real figures for each month, entered from the baseline
-- date (2026-10-26) onwards. Same money columns as the plan, plus
-- has_data: 1 once that month's actuals have been entered (a month with
-- no actuals yet is "not entered", not zero).
CREATE TABLE IF NOT EXISTS monthly_actuals (
  month_key               TEXT PRIMARY KEY,
  has_data                INTEGER NOT NULL DEFAULT 0,
  take_home_pay_cents     INTEGER NOT NULL DEFAULT 0,
  other_income_cents      INTEGER NOT NULL DEFAULT 0,
  rent_cents              INTEGER NOT NULL DEFAULT 0,
  utilities_cents         INTEGER NOT NULL DEFAULT 0,
  phone_internet_cents    INTEGER NOT NULL DEFAULT 0,
  groceries_cents         INTEGER NOT NULL DEFAULT 0,
  eating_out_cents        INTEGER NOT NULL DEFAULT 0,
  gas_transport_cents     INTEGER NOT NULL DEFAULT 0,
  insurance_cents         INTEGER NOT NULL DEFAULT 0,
  subscriptions_cents     INTEGER NOT NULL DEFAULT 0,
  shopping_cents          INTEGER NOT NULL DEFAULT 0,
  credila_emi_cents       INTEGER NOT NULL DEFAULT 0,
  credit_card_payment_cents INTEGER NOT NULL DEFAULT 0,
  other_loan_cents        INTEGER NOT NULL DEFAULT 0,
  one_offs_cents          INTEGER NOT NULL DEFAULT 0,
  other_expenses_cents    INTEGER NOT NULL DEFAULT 0,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily expense log (workflow starts 2026-10-26; earlier dates are not
-- blocked). amount is REAL dollars. categorization_source records how the
-- category was chosen: 'gemini', 'rules', or 'manual' (user override).
-- my_share (nullable, REAL dollars) is the user's own portion of a shared
-- expense (splits themselves are tracked in Splitwise); NULL means the
-- full amount is his. The monthly rollup sums COALESCE(my_share, amount),
-- while card statement totals keep using the full amount.
-- On every write the API re-syncs that month's monthly_actuals expense
-- fields from this log (see syncDailyRollup in functions/api/budget.js).
CREATE TABLE IF NOT EXISTS daily_expenses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL, -- YYYY-MM-DD
  description           TEXT NOT NULL DEFAULT '',
  amount                REAL NOT NULL DEFAULT 0,
  category              TEXT NOT NULL DEFAULT 'Misc/Other',
  categorization_source TEXT NOT NULL DEFAULT 'rules',
  card_name             TEXT, -- nullable: the credit card this expense was charged to (matches credit_cards.name); NULL = not a card expense
  my_share              REAL, -- nullable: his portion of a shared expense; NULL = the full amount is his
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_expenses_date ON daily_expenses(date);

-- Credit cards with their statement cycles. A card bill is due in a later
-- month/paycheck than the spending, so each card records its statement
-- period (start/end) and the app groups that card's daily expenses whose
-- date falls inside the window to estimate the statement balance.
-- (For databases created before this table existed, ensureTables in
-- functions/api/budget.js creates it and adds daily_expenses.card_name.)
CREATE TABLE IF NOT EXISTS credit_cards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  statement_start TEXT NOT NULL, -- YYYY-MM-DD, first day of the statement period (inclusive)
  statement_end   TEXT NOT NULL, -- YYYY-MM-DD, last day of the statement period (inclusive)
  due_date        TEXT,          -- YYYY-MM-DD, nullable: when this statement's bill is due
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sign-in sessions for the access code. Only the SHA-256 of a session
-- token is stored. kind 'device' expires 90 days after last activity
-- (sliding); kind 'sync' (the paired Plaid script) lasts 180 days from
-- pairing and is revocable. The access code itself is stored only as a
-- salted PBKDF2-SHA256 hash in budget_settings under 'access_code_hash'.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'device',
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT
);

-- One row per secret check (login, change-code, setup secret, pairing
-- code). The API reserves a row BEFORE checking a secret and refuses
-- the check beyond 5 per IP / 20 overall in 10 minutes.
CREATE TABLE IF NOT EXISTS auth_attempts (
  at  INTEGER NOT NULL,              -- epoch milliseconds
  ip  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS auth_attempts_at ON auth_attempts (at);

-- Bank snapshot for the Bank tab, pushed by the paired Plaid sync
-- automation (POST /api/bank, sync sessions only) and read back by
-- device sessions (GET /api/bank). Money is integer cents; amounts
-- keep the Plaid depository sign convention: positive = money OUT of
-- the account, negative = money IN (a paycheck arrives negative).
-- The API converts cents <-> dollars at the boundary.
CREATE TABLE IF NOT EXISTS bank_accounts (
  plaid_account_id TEXT PRIMARY KEY,
  institution     TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  subtype         TEXT NOT NULL DEFAULT '', -- checking | savings | ...
  mask            TEXT NOT NULL DEFAULT '', -- last digits, e.g. '1234'
  current_cents   INTEGER,                  -- NULL when Plaid reports none
  available_cents INTEGER,                  -- NULL when Plaid reports none
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  plaid_transaction_id TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL DEFAULT '',     -- bank_accounts.plaid_account_id
  date        TEXT NOT NULL DEFAULT '',     -- YYYY-MM-DD
  name        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,  -- positive = out, negative = in
  pending     INTEGER NOT NULL DEFAULT 0,
  pfc         TEXT NOT NULL DEFAULT '',     -- Plaid personal finance category (primary)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pending charges snapshot for the Daily tab "Pending" section and
-- the dashboard's pending preview line, pushed by the paired Plaid
-- sync automation (POST /api/pending, sync sessions only) and read
-- back by device sessions (GET /api/pending). Each push REPLACES the
-- whole set with the charges Plaid currently reports as pending.
-- Display only: never expenses, never in any rollup or balance.
-- Amounts are positive spend cents.
CREATE TABLE IF NOT EXISTS pending_transactions (
  plaid_transaction_id TEXT PRIMARY KEY,
  date          TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD
  name          TEXT NOT NULL DEFAULT '',
  amount_cents  INTEGER NOT NULL DEFAULT 0, -- positive = spend
  account_label TEXT NOT NULL DEFAULT '',   -- card or account the charge is on
  category      TEXT NOT NULL DEFAULT '',   -- category it will likely import as
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manual "Sync now" requests (Daily tab button). A device session
-- inserts a pending row; the paired sync automation's VM poller
-- claims it (GET /api/sync-requests/claim), runs the real Plaid sync
-- engine locally, and completes it (POST /api/sync-requests/:id/
-- complete) with the run summary stored as JSON in result. The app's
-- latest-request view polls this table. Statuses: pending, running,
-- done, failed. An active row is returned instead of inserting a
-- duplicate; a row waiting unclaimed for 10 minutes, or running 10
-- minutes past its claim, is expired to failed by the API.
CREATE TABLE IF NOT EXISTS sync_requests (
  id           TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL, -- 'YYYY-MM-DD HH:MM:SS' (UTC, like sessions)
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  result       TEXT,          -- JSON run summary once finished, else NULL
  claimed_at   TEXT,          -- when the poller claimed it (the running timeout counts from here)
  finished_at  TEXT
);

-- The Gemini API key, when saved from the app's Settings UI, is stored
-- server-side as budget_settings key 'gemini_api_key' (plus 'gemini_model').
-- It is only ever read by the categorize Function; GET /api/settings
-- returns just a masked indicator, never the key. No key is seeded here.

-- Seed: a zero starting balance, the actuals baseline date, and the
-- twelve blank planner months (planned + actuals).
INSERT OR IGNORE INTO budget_settings (key, value) VALUES ('starting_balance_cents', '0');
INSERT OR IGNORE INTO budget_settings (key, value) VALUES ('baseline_date', '2026-10-26');
INSERT OR IGNORE INTO budget_settings (key, value) VALUES ('baseline_note', '');
INSERT OR IGNORE INTO monthly_budgets (month_key) VALUES
  ('2026-10'), ('2026-11'), ('2026-12'),
  ('2027-01'), ('2027-02'), ('2027-03'), ('2027-04'),
  ('2027-05'), ('2027-06'), ('2027-07'), ('2027-08'),
  ('2027-09'), ('2027-10');
INSERT OR IGNORE INTO monthly_actuals (month_key) VALUES
  ('2026-10'), ('2026-11'), ('2026-12'),
  ('2027-01'), ('2027-02'), ('2027-03'), ('2027-04'),
  ('2027-05'), ('2027-06'), ('2027-07'), ('2027-08'),
  ('2027-09'), ('2027-10');

-- The v2 money model (accounts, transactions, splits, categories and
-- groups, budgets, rules, recurring, goals, balance snapshots, all keyed
-- by owner_id) is created by the API on first use: see
-- functions/api/_v2db.js for the tables and the scoped query helper.
