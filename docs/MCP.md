# ArthaTula MCP server — full reference

ArthaTula is an MCP server (Model Context Protocol, stateless Streamable
HTTP) at **`/api/mcp`**. An AI assistant — Claude, ChatGPT, Cursor, Grok,
or any other MCP client — can work with the budget through tools instead
of the raw HTTP API.

**The tool surface mirrors everything the owner can do in the app.**
If a screen in the app can do it, there is a tool for it below — with a
short, deliberate list of exceptions under
[What is not exposed](#what-is-not-exposed-and-why).

## Connect a client

There are two ways in, matching how the client authenticates:

- **Clients that accept a header** (Claude Code, Cursor, config
  files): hand them a minted token, below.
- **Claude's apps (web / mobile / Desktop custom connector)**: those
  only speak **OAuth 2.1** — there is no token/header field in their
  connector form. ArthaTula runs a small OAuth server for exactly
  that; see the next section. No token to mint or paste.

### With a token (header clients)

1. In the app: Settings → Advanced → **Connect an AI app (MCP)** →
   *Create MCP token*. The token is shown **once**, together with the
   endpoint and a ready-to-paste config.
2. Give the client the endpoint `https://<your-app>/api/mcp` and the
   header `Authorization: Bearer <token>`.

Claude Code / Cursor (`.mcp.json`, `.cursor/mcp.json`):

```json
{ "mcpServers": { "arthatula": {
  "type": "http",
  "url": "https://<your-app>/api/mcp",
  "headers": { "Authorization": "Bearer <token>" }
} } }
```

Claude Code one-liner:

```
claude mcp add --transport http arthatula https://<your-app>/api/mcp --header "Authorization: Bearer <token>"
```

Claude Desktop only starts local servers, so bridge with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in
`claude_desktop_config.json`:

```json
{ "mcpServers": { "arthatula": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://<your-app>/api/mcp", "--header", "Authorization:${ARTHATULA_AUTH}"],
  "env": { "ARTHATULA_AUTH": "Bearer <token>" }
} } }
```

Any other header-capable client: **Streamable HTTP** transport, the
URL above, and the same `Authorization` header. The server is
stateless — every request carries the token — so `GET` (SSE) and
`DELETE` answer 405; everything is a JSON-RPC `POST` (`initialize`,
`tools/list`, `tools/call`, `ping`). Supported protocol versions:
`2025-06-18`, `2025-03-26`, `2024-11-05`.

### Claude app / custom connector (OAuth)

For Claude on the web, on your phone, or in Claude Desktop's
Connectors screen — clients whose only auth is an OAuth sign-in:

1. In Claude: **Settings / Customize → Connectors → Add custom
   connector**.
2. Name: `ArthaTula`. URL: `https://<your-app>/api/mcp` — exactly
   that; no token anywhere.
3. **Connect**. Claude discovers ArthaTula's OAuth endpoints
   (`/.well-known/oauth-protected-resource` →
   `/.well-known/oauth-authorization-server`), registers itself, and
   opens ArthaTula's consent page in your browser.
4. The page names the client asking. Type **your app access code**
   and **Approve**. (That code check is the authentication — it uses
   the same attempt limiter as sign-in. Deny sends Claude back an
   `access_denied` and issues nothing.)
5. On the phone, connectors follow your Claude account: open a chat,
   tap **+ → Connectors**, and toggle **ArthaTula** on for that chat.

Under the hood (RFC 6749 / 7591 / 7636 / 8414 / 8707 / 9728, public
clients only): authorization-code flow with **PKCE S256 mandatory**,
dynamic client registration at `/oauth/register`, codes single-use
and ≤10 minutes, and the access token Claude receives is an ordinary
**`mcp` session** — labelled `OAuth: <client name>` in Settings →
sessions, revocable there like any token. Refresh tokens rotate on
every use: the old one dies and the previous OAuth session is revoked,
so one grant chain keeps exactly one live session. `POST
/oauth/revoke` revokes a refresh token (and its session) or an access
token. A 401 from `/api/mcp` carries
`WWW-Authenticate: Bearer resource_metadata="…"` pointing clients at
the discovery document. Before an access code exists, the metadata
docs still answer (they are public and origin-derived) while
`/oauth/authorize` and `/oauth/token` refuse with `setupRequired`.

## Security model

The token is an **`mcp` session** — a least-privilege session kind next
to *device* and *sync* sessions:

- `requireAuth` refuses `mcp` sessions on **every route except
  `/api/mcp`**. The token can never open the app UI, call the raw API
  (including `/api/v2/*`), read or change settings or the access code,
  or manage devices — no matter what a tool is asked to do.
- Only a signed-in **device** can mint one. It appears in the sessions
  list with an **MCP** badge; revoke it there at any time. Changing the
  access code signs it out like every other session.
- Its 90-day window slides as it is used, like a device session.
- Device tokens also work on `/api/mcp` (they are strictly more
  powerful everywhere else anyway). **Sync tokens are refused.**
- Tool errors mirror the app's own validations — a tool can never do
  something the corresponding screen would reject.

## What is not exposed, and why

Everything credential-shaped stays owner-only, by design:

| Not exposed | Why |
| --- | --- |
| Saving API keys (AI provider, Splitwise, Finnhub, SimpleFIN) | Keys are write-only secrets entered in Settings; `get_settings` reports only whether one is saved (provider, last 4 for AI). |
| Changing the access code | Owner-only account control. |
| Session / device management (list, revoke, rename) | A token must not be able to manage other sessions. |
| Pairing the sync / minting sync tokens | Owner-initiated, one-time codes. |
| Sync snapshot ingestion (`POST /api/bank`, `/api/pending`, `/api/v2/sync`) | Machine-to-machine writes for the paired sync automation (sync session), not assistant actions. |
| Loading / wiping demo data | A destructive one-click dataset swap; stays a deliberate in-app action. |
| SimpleFIN connect / disconnect | Connecting hands the app a new credential token; stays in Settings. |
| One-time data-migration acknowledgement | Internal, destructive-adjacent, already done. |

## Money conventions — read this first

The app keeps **two models over one database**, and the tools follow
the model they belong to:

- **Classic model — dollars.** The 13-month plan, manually entered
  actuals, the daily expense log, cards, merchant rules and the bank
  snapshot. Amounts are dollar numbers (`42.50`). Expense categories
  here are the built-in names (`Groceries`, `Rent`, …).
- **Money model (v2) — signed integer cents.** Accounts, transactions,
  categories, budgets, goals, recurring, rules and reports. Amounts are
  integer cents and **signed: negative = money out, positive = money
  in** (`-4250` is a $42.50 spend). Categories here are rows with ids
  (`list_categories`), including ones you create yourself.

The two stay in sync: an expense added with `add_expense` appears in
`list_transactions`, and money-model edits to it flow back. A few rules
worth knowing:

- **Plan vs. actual:** the plan is a forecast by *pay month* (cash);
  the expense log records spending by *charge date*. Never add the two
  together.
- **Pending charges are display-only** (`list_pending_charges`): they
  are not expenses and never count in spent/actuals/balances until
  they post.
- **Baseline:** classic actuals only count expenses on/after the
  budget's baseline date (see `get_budget`).
- Months are `YYYY-MM`, dates are `YYYY-MM-DD`.

## Tool reference

### Classic budget — plan & actuals

- **`get_budget`** — The classic budget state: starting balance,
  baseline date, the 13-month plan, actuals, the daily expense log,
  cards and merchant rules (dollars).
- **`update_plan`** — Patch one plan month's fields (dollars; keys from
  `get_budget`, e.g. `rent`, `oneOffs`, `oneOffNote`). Returns the
  updated state.
- **`set_actuals`** — Patch one month's manually entered actuals
  (e.g. `takeHomePay`, `otherIncome`, `entered: true`). Expense-derived
  fields re-roll from the log and are ignored.
- **`get_merchant_rules`** — The "always file this merchant under …"
  rules used to auto-categorize daily-log expenses.
- **`set_merchant_rules`** — Replace the merchant rules
  (`[{ match, category }]`; matching is a case-insensitive substring of
  the description). Saving re-files existing expenses whose rule is new
  or changed.

### Daily expense log (classic, dollars)

- **`list_expenses`** — List expenses, newest first. Optional filters:
  `month`, exact `category`, `search` text. Capped at 400.
- **`add_expense`** — Add one expense (`date`, `description`, positive
  `amount`). Without a category it is auto-categorized (merchant rules,
  then the saved AI provider, else keywords). Optional: `category`,
  `card` name, `myShare` (0–1, your share of a split), `note`.
  Duplicates (same date+description+amount that day) are refused.
- **`update_expense`** — Patch an expense by `id`: any of `date`,
  `description`, `amount`, `category`, `card`, `myShare`, `note`.
  A category you set sticks (source `manual`).
- **`delete_expense`** — Delete one expense by `id`. The month's
  actuals re-roll automatically. Cannot be undone.
- **`categorize_expense`** — Preview which category a description would
  get, without saving anything.

### Cards (classic)

- **`list_cards`** — Tracked credit cards with statement periods and
  due dates.
- **`add_card`** — Add a card: `name`, `statementStart`,
  `statementEnd`, optional `dueDate`.
- **`update_card`** — Patch a card by `id` (name, period, due date).
- **`delete_card`** — Delete a card by `id`; its expenses keep the
  card name as text.

### Bank snapshot & the Daily review (classic)

- **`get_bank_snapshot`** — The latest bank snapshot pushed by the
  sync: accounts with balances, recent bank transactions, the review
  decisions so far and the ignore rules.
- **`review_bank_transaction`** — Record the Daily review decision for
  one bank transaction (`txId` from the snapshot): `kind` one of
  `repayment`, `income`, `pass_through`, `already_counted`, or `null`
  to clear. Only `income` changes the numbers (that month's
  `otherIncome`).
- **`set_ignore_rules`** — Replace the "always ignore payments like
  this" rules: `[{ accountId, direction: "in"|"out", name }]`.

### Sync

- **`request_sync`** — Ask the bank-sync automation to run now (the
  same queue as the app's *Sync now* button). Deduped for 10 minutes.
  Returns immediately; poll `get_sync_status`.
- **`get_sync_status`** — The latest sync request: status
  (pending/running/done/failed), timestamps, and the run summary when
  it finished.

### Money model — accounts

- **`list_accounts`** — All accounts with balances (cents), plus net
  worth. Credit accounts come back negative (money owed).
- **`add_account`** — Add a manual account (`name`, `type`:
  depository/credit/loan/investment/property/cash/other,
  `balanceCents` signed), for things the bank connection can't see.
- **`update_account`** — Patch by `id`: name, hidden,
  includeInNetWorth, or `balanceCents` (manual accounts only — synced
  balances belong to the sync).
- **`delete_account`** — Delete a manual account by `id`. Synced
  accounts can't be deleted (hide them instead). Its transactions are
  kept, unlinked.
- **`get_investments`** — Investment accounts with day/month changes,
  the total value series, and current holdings (quantity, price,
  value, gain/loss vs. cost basis).

### Money model — transactions

- **`list_transactions`** — Newest first, signed cents. Filters:
  `from`/`to`, `accountId`, `categoryId`, `search`, `needsReview`.
  Capped at 500.
- **`add_transaction`** — Add a transaction directly in the money
  model (signed `amountCents`). With no `categoryId` it lands on
  *To review*. Optional `accountId`, `date`, `merchant`, `notes`.
- **`update_transaction`** — Patch by `id`: merchant, date,
  amountCents, categoryId, notes, needsReview, hidden, pending — or a
  full split via `splits: [{ categoryId, amountCents }]` (must sum to
  the transaction's amount; `splits: []` clears it).
- **`delete_transaction`** — Delete by `id` (hand-added, imported and
  classic daily-log rows; daily-log deletes also fix the classic
  month rollup).
- **`review_all_transactions`** — Mark every visible *To review* row
  as reviewed, as it is.
- **`run_auto_review`** — Run the AI auto-review pass over *To review*
  (needs an AI key saved in Settings).

### Money model — categories & groups

- **`list_categories`** — All groups and categories: ids, names,
  kinds (income/expense/transfer), icons. Use the ids with the other
  money-model tools.
- **`create_category`** — Create a category (the app's Manage →
  Categories). Optional `group` (an existing group name — it decides
  the kind) or `kind` when no group is given; optional `icon`.
- **`update_category`** — Patch by `id`: name, icon, groupId (moves
  it; it takes the group's kind), archived, sort.
- **`delete_category`** — Delete by `id`, moving its transactions,
  splits, budgets, rules and recurring items to the `moveTo`
  category.
- **`create_group`** / **`update_group`** / **`delete_group`** —
  Manage category groups (delete only works on an empty group).

### Money model — budgets

- **`get_budget_status`** — Budget vs. actual for one `month`: per
  category planned, rolled-over, spent and remaining (cents), plus
  totals.
- **`set_budget`** — Set one category's planned amount for one month
  (cents; set `0` to remove the line). The category is a name from
  `list_categories` or an id.
- **`copy_budget`** — Copy every budget line of one month onto another
  (overwrites the target's lines).
- **`fill_budget`** — Repeat one month's lines into every later month
  up to `through` that has no budget yet (at most 36 months).

### Money model — goals, recurring, rules

- **`list_goals`** / **`add_goal`** / **`update_goal`** /
  **`delete_goal`** — Savings goals, each with progress (saved, left,
  monthly pace). A goal can link an account (its balance counts as
  saved) or track `savedCents` by hand.
- **`list_recurring`** — Recurring bills/subscriptions: saved items,
  fresh suggestions detected from transactions, and the next month's
  expected total.
- **`add_recurring`** / **`update_recurring`** / **`delete_recurring`**
  — Manage recurring items (`amountCents` signed, cadence
  weekly/monthly/yearly, `nextDate`; `status` can dismiss).
- **`resolve_recurring_suggestion`** — Confirm (creates the item,
  optional overrides) or dismiss a detected suggestion by its
  `detectKey`.
- **`list_rules`** / **`add_rule`** / **`update_rule`** /
  **`delete_rule`** — Auto-rules: match on text/account/amount range,
  then set a category, add a tag, and/or hide. Amount bounds match the
  absolute value (either direction).
- **`apply_rule`** — Apply one auto-rule to all existing transactions
  now; returns how many rows changed.

### Reports & insights

- **`get_reports`** — `kind: "summary"` (one month's
  income/spending/net, budget comparison, biggest categories),
  `"cashflow"` (income vs. spending per month over a range), or
  `"forecast"` (projected balances from budgets, goals and recurring
  items).
- **`get_net_worth`** — Current assets/liabilities/net, the daily
  series from balance snapshots, and balances by account type.
- **`get_market_recap`** — The daily market recap (SPY/QQQ/DIA):
  `status` is `nokey` when no Finnhub key is saved, `stale` outside
  market hours.
- **`get_splitwise`** — Splitwise balances and recent activity (needs
  the Splitwise key saved in Settings): net balance, who owes you,
  whom you owe, per-friend and per-group balances.
- **`list_pending_charges`** — Pending (not yet posted) card charges
  from the latest sync snapshot. Display-only.

### Import & export

- **`import_transactions`** — Import statement rows into an account
  (the app's CSV import, with rows already parsed): `accountId` or
  `newAccount: { name, type }`, and `rows: [{ date, description,
  amountCents }]` (signed; optional `balanceCents` for
  newest-first/reversed detection). Re-importing the same rows is a
  no-op (content-hash dedupe). Returns added/duplicates/categorized/
  to-review counts.
- **`export_data`** — Export the money model: `format: "json"`
  (everything: accounts, categories, transactions, budgets, rules,
  recurring, goals) or `"csv"` (transactions).

### Home & setup

- **`get_layout`** / **`set_layout`** — The dashboard layout: which
  Home cards show (`overview`, `market`, `month`, `ask`, `trends`)
  and in what order.
- **`get_checklist`** / **`update_checklist`** — The first-run setup
  checklist state (mark steps done, dismiss).
- **`get_settings`** — Settings status exactly as the Settings screen
  shows it: which integrations have a key saved (AI provider + last 4,
  Splitwise, Finnhub) and data counts. **Never returns key material.**

### About the app

- **`send_feedback`** — Build a prefilled GitHub issue link (bug,
  feature, general) for the maintainer. Files nothing itself and
  reads no budget data; show the link to the user.

## Common workflows

**Log a purchase:** `add_expense { date, description, amount }` — it is
auto-categorized and shows up in both models. Check first with
`categorize_expense` if unsure.

**Give a trip its own budget:** `create_category { name: "India Trip",
icon: "✈️" }`, then `set_budget { month: "2026-12", category:
"India Trip", amountCents: 30000 }`. File existing charges with
`update_transaction`/`update_expense`.

**Close the month:** `get_reports { kind: "summary", month }` for the
classic+money picture, `get_budget_status { month }` for budget vs.
actual per category, `review_all_transactions` once *To review* is
clean.

**Fresh bank data:** `request_sync`, wait, `get_sync_status` until
`done`, then read as usual.

## Troubleshooting

- **401 on every call** — the token was revoked, expired (90 days
  unused), or the access code changed. Mint a fresh one in Settings →
  Advanced → Connect an AI app (MCP) and update the client config.
  For an **OAuth (Claude app) connection**, disconnect and reconnect
  the connector instead — Claude will run the consent flow again and
  get a fresh session; revoking the `OAuth: …` session in Settings
  has the same effect from ArthaTula's side.
- **Claude says it couldn't connect / no sign-in appears** — check
  the connector URL is exactly `https://<your-app>/api/mcp` and that
  `https://<your-app>/.well-known/oauth-authorization-server` returns
  JSON (not the app page) in a browser; if it returns the app page,
  that deployment predates the OAuth build.
- **A tool returns an error** — it is the app's own validation message
  (unknown category, synced account, split that doesn't sum, …). Fix
  the input the way you would in the app.
- **`get_market_recap` says `nokey` / `run_auto_review` can't run** —
  the integration's key is not saved in Settings. Keys are owner-only;
  ask the owner to add it in the app.
- **`request_sync` says already queued** — a sync is pending or ran in
  the last 10 minutes; poll `get_sync_status` instead.
