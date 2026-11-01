/*
 * Mirror: copies the classic (v1) data into the v2 model for the owner's
 * data, idempotently. It is the migration AND the bridge while both
 * apps run side by side:
 *
 *   daily_expenses        -> transactions (source "v1exp"; the classic
 *                            daily log stays the record for these rows —
 *                            edits on the new screens are written back)
 *   bank_transactions     -> transactions (source "v1bank") for posted
 *                            bank rows NOT already an expense: income,
 *                            repayments, card payments, transfers
 *   monthly_actuals       -> transactions (source "v1actual"): typed-in
 *                            actual income, and typed-in actual expenses
 *                            for months with no daily log
 *   bank_accounts         -> accounts (+ a daily balance snapshot)
 *   credit_cards          -> accounts of type credit
 *   monthly_budgets       -> budgets (source "v1" until edited on the
 *                            Budget screen, then the new app owns them)
 *
 * It runs before every v2 read, but does work only when a cheap
 * fingerprint of the v1 tables changed. compareTotals() is the
 * migration gate: for every classic plan month, v2's income and spending
 * must equal the classic actuals to the cent.
 */
import { MONEY_FIELDS, readState } from "./budget.js";
import { OWNER_ID, ensureV2, scope, newId } from "./_v2db.js";
import { loadCategories, loadTransactions, loadRules, categoryIndex } from "./_v2store.js";
import { summarize, monthOf, applyRules, daysBetween } from "../../js/core/v2/money.js";

/* Classic plan field -> v2 category name. */
export const FIELD_CATEGORY = {
  takeHomePay: "Paycheck", otherIncome: "Other income",
  rent: "Rent", utilities: "Utilities", phoneInternet: "Phone & Internet", groceries: "Groceries",
  eatingOut: "Eating Out", gasTransport: "Fuel/Transport", insurance: "Insurance", subscriptions: "Subscriptions",
  shopping: "Shopping/Personal", credilaEmi: "Loan/Debt Payment", creditCardPayment: "Loan/Debt Payment",
  otherLoan: "Loan/Debt Payment", oneOffs: "One-off", otherExpenses: "Misc/Other"
};
const FIELD_LABEL = {
  takeHomePay: "Take-home pay", otherIncome: "Other income", rent: "Rent", utilities: "Utilities",
  phoneInternet: "Phone & internet", groceries: "Groceries", eatingOut: "Eating out", gasTransport: "Gas & transport",
  insurance: "Insurance", subscriptions: "Subscriptions", shopping: "Shopping", credilaEmi: "Loan EMI",
  creditCardPayment: "Card payment", otherLoan: "Other loan", oneOffs: "One-off", otherExpenses: "Other expenses"
};
const MIRRORED = ["v1exp", "v1bank", "v1actual"];
const MIRROR_VERSION = "4"; /* 2: rows before the baseline count in reports
                                3: unbooked months' bank inflows count as income
                               4: Cybrid outflows count as Sent to India */

async function fingerprint(db) {
  const r = await db.prepare(
    "SELECT " +
    "(SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) || ':' || IFNULL(SUM(CAST(ROUND(IFNULL(my_share, -1) * 100) AS INTEGER)), 0) || ':' || IFNULL(SUM(length(category) + length(description) + IFNULL(length(note), 0) + IFNULL(length(card_name), 0)), 0) FROM daily_expenses) || '|' || " +
    "(SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(SUM(amount_cents), 0) FROM bank_transactions) || '|' || " +
    "(SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(SUM(current_cents), 0) FROM bank_accounts) || '|' || " +
    "(SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') FROM credit_cards) || '|' || " +
    "(SELECT IFNULL(MAX(updated_at), '') FROM monthly_actuals) || '|' || " +
    "(SELECT IFNULL(MAX(updated_at), '') FROM monthly_budgets) || '|' || " +
    "(SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(SUM(length(kind)), 0) FROM bank_tx_review) || '|' || " +
    "IFNULL((SELECT value FROM budget_settings WHERE key = 'baseline_date'), '') AS fp"
  ).first();
  /* Bump MIRROR_VERSION when what the mirror writes changes, so every
     database re-mirrors once. */
  return MIRROR_VERSION + "|" + ((r && r.fp) || "");
}

/* Run the mirror if the v1 tables changed since the last run (or when
   forced). Returns { skipped } or the counts it wrote. */
export async function mirrorV1(db, opts) {
  await ensureV2(db);
  const s = scope(db, OWNER_ID);
  const fp = await fingerprint(db);
  if (!(opts && opts.force) && fp === (await s.getSetting("mirror_fp"))) return { skipped: true };

  const state = await readState(db);
  const baseline = state.baselineDate;
  const { categories } = await loadCategories(s);
  const catByName = {};
  categories.forEach((c) => { catByName[c.name.toLowerCase()] = c.id; });
  const cat = (name) => catByName[String(name || "").toLowerCase()] || catByName["misc/other"];

  /* ---- accounts ---- */
  const bankAccounts = ((await db.prepare("SELECT * FROM bank_accounts").all()).results) || [];
  const cards = ((await db.prepare("SELECT * FROM credit_cards").all()).results) || [];
  const acctStmts = [];
  for (const a of bankAccounts) {
    const isCard = /credit/i.test(a.subtype || "");
    acctStmts.push([
      "INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, available_cents, balance_at, source) " +
      "VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'plaid') " +
      "ON CONFLICT(owner_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET institution = excluded.institution, " +
      "subtype = excluded.subtype, mask = excluded.mask, " +
      /* The sync's own account push (/api/v2/sync) may carry a newer
         balance: the classic snapshot only wins when it is newer. */
      "balance_cents = CASE WHEN excluded.balance_at > IFNULL(accounts.balance_at, '') THEN excluded.balance_cents ELSE accounts.balance_cents END, " +
      "available_cents = CASE WHEN excluded.balance_at > IFNULL(accounts.balance_at, '') THEN excluded.available_cents ELSE accounts.available_cents END, " +
      "balance_at = MAX(excluded.balance_at, IFNULL(accounts.balance_at, '')), updated_at = datetime('now')",
      newId("acc_"), "plaid:" + a.plaid_account_id, a.name || a.institution || "Account", a.institution || "",
      isCard ? "credit" : "depository", a.subtype || "", a.mask || "",
      a.current_cents, a.available_cents, String(a.updated_at || "").slice(0, 10) || null
    ]);
  }
  /* A classic card whose name matches a synced credit account (pushed by
     the sync through /api/v2/sync) is the same card: its statement dates
     go onto the synced account instead of making a second account. */
  const syncedCredit = {};
  (await s.all("SELECT id, name FROM accounts WHERE owner_id = ?1 AND source = 'plaid' AND type = 'credit'"))
    .forEach((r) => { syncedCredit[String(r.name).toLowerCase()] = r.id; });
  const mergedCards = [];
  for (const c of cards) {
    const twin = syncedCredit[String(c.name).toLowerCase()];
    if (twin) {
      mergedCards.push(c.id);
      acctStmts.push(["UPDATE accounts SET statement_start = ?3, statement_end = ?4, due_date = ?5, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2",
        twin, c.statement_start, c.statement_end, c.due_date || null]);
      continue;
    }
    acctStmts.push([
      "INSERT INTO accounts (id, owner_id, external_id, name, type, statement_start, statement_end, due_date, source) " +
      "VALUES (?2, ?1, ?3, ?4, 'credit', ?5, ?6, ?7, 'v1card') " +
      "ON CONFLICT(owner_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = excluded.name, " +
      "statement_start = excluded.statement_start, statement_end = excluded.statement_end, due_date = excluded.due_date, updated_at = datetime('now')",
      newId("acc_"), "card:" + c.id, c.name, c.statement_start, c.statement_end, c.due_date || null
    ]);
  }
  await s.batch(acctStmts);
  const cardIds = cards.filter((c) => mergedCards.indexOf(c.id) === -1).map((c) => "card:" + c.id);
  const staleCards = (await s.all("SELECT id, external_id FROM accounts WHERE owner_id = ?1 AND source = 'v1card'"))
    .filter((r) => cardIds.indexOf(r.external_id) === -1);
  await s.batch(staleCards.flatMap((r) => [
    ["UPDATE transactions SET account_id = NULL WHERE owner_id = ?1 AND account_id = ?2", r.id],
    ["UPDATE goals SET account_id = NULL WHERE owner_id = ?1 AND account_id = ?2", r.id],
    ["DELETE FROM accounts WHERE owner_id = ?1 AND id = ?2", r.id]
  ]));
  const acctRows = await s.all("SELECT id, external_id, name, type, balance_cents, balance_at FROM accounts WHERE owner_id = ?1");
  const acctByExt = {}, cardByName = {};
  acctRows.forEach((r) => {
    if (r.external_id) acctByExt[r.external_id] = r.id;
    /* Prefer the synced account when a name appears twice. */
    if (r.type === "credit" && (!cardByName[String(r.name).toLowerCase()] || r.external_id && r.external_id.indexOf("plaid:") === 0)) cardByName[String(r.name).toLowerCase()] = r.id;
  });
  await s.batch(acctRows.filter((r) => r.balance_cents !== null && r.balance_at).map((r) => [
    "INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4) " +
    "ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents",
    r.id, r.balance_at, r.balance_cents
  ]));

  /* ---- transactions ---- */
  const bankTx = ((await db.prepare("SELECT * FROM bank_transactions").all()).results) || [];
  const reviews = {};
  (((await db.prepare("SELECT plaid_transaction_id AS id, kind FROM bank_tx_review").all()).results) || [])
    .forEach((r) => { reviews[r.id] = r.kind; });
  const bankAcctOf = {};
  bankTx.forEach((t) => { bankAcctOf[t.plaid_transaction_id] = t.account_id; });
  const linked = {};
  const desired = [];
  for (const e of state.dailyExpenses) {
    if (e.bankTxId) linked[e.bankTxId] = true;
    const acctExt = e.bankTxId && bankAcctOf[e.bankTxId] ? "plaid:" + bankAcctOf[e.bankTxId] : null;
    desired.push({
      ext: "exp:" + e.id, source: "v1exp", date: e.date, merchant: e.description, description: e.description,
      amount: -Math.round(e.amount * 100),
      share: e.myShare === null || e.myShare === undefined ? null : -Math.round(e.myShare * 100),
      categoryId: cat(e.category),
      accountId: acctExt ? acctByExt[acctExt] || null : (e.card ? cardByName[String(e.card).toLowerCase()] || null : null),
      notes: e.note || "", pending: 0, hidden: 0, exclude: 0, review: 0, v1: e.id
    });
  }
  /* Months whose income is already on record through the classic
     actuals (an entered month with take-home pay booked): bank
     inflows there stay neutral transfers, so a paycheck is never
     counted twice — once in the actuals, once at the bank. Every
     other month has NO income record in the classic app (its planner
     starts at the baseline), so an unlinked bank inflow there is the
     only income record there is: default it to Other income, or
     cash flow pits months of (backfilled) spending against zero
     income and every net reads deeply negative. */
  const incomeBooked = {};
  for (const a of state.actuals) {
    if (a.entered && Math.round((a.takeHomePay || 0) * 100) > 0) incomeBooked[a.monthKey] = true;
  }
  /* Moves between his own accounts pair up even when the name gives
     nothing away: an inflow matched by an equal outflow from a
     DIFFERENT account within 3 days is a transfer, not income. */
  const ownOutflows = bankTx.filter((t) => !t.pending && t.amount_cents > 0 && !linked[t.plaid_transaction_id]);
  const pairsWithOwnOutflow = (inflow) => ownOutflows.some((o) =>
    o.account_id !== inflow.account_id && o.amount_cents === -inflow.amount_cents &&
    Math.abs(daysBetween(o.date, inflow.date)) <= 3);
  const SELF_MOVE_NAME = /zelle payment from nisarg|requested transfer|internal transfer|online transfer|internet transfer|acct transfer|account transfer|xfer|funds transfer|americanexpress transfer|external transfer|ext trnsfr/i;
  const P2P_NAME = /zelle payment from|venmo|cash app/i;
  /* Is this unlinked bank inflow income? Only asked in months whose
     income is not already booked in the classic actuals. His pay
     arrives in two halves: a "…PAYROLL…" credit Plaid tags INCOME,
     and an "Online Transfer / Payment: Credit" Plaid tags
     TRANSFER_IN into his Amex checking — the second half counts
     unless it pairs with an outflow of his own (a real move).
     Settlements from other people count on the cash basis; moves
     between his own accounts never do; anything unrecognized stays
     a neutral transfer rather than inflating income. */
  const inflowIsIncome = (t, amount) => {
    if (amount <= 0 || incomeBooked[monthOf(t.date)]) return false;
    const name = t.name || "";
    if (t.pfc === "INCOME" || /payroll/i.test(name)) return true;
    const paired = pairsWithOwnOutflow(t);
    if (/online transfer \/ payment: credit/i.test(name)) return !paired;
    if (paired || SELF_MOVE_NAME.test(name)) return false;
    return P2P_NAME.test(name);
  };

  const reviewedIncome = {};
  for (const t of bankTx) {
    if (t.pending || linked[t.plaid_transaction_id]) continue;
    const kind = reviews[t.plaid_transaction_id] || null;
    const amount = -t.amount_cents;
    if (kind === "income") reviewedIncome[monthOf(t.date)] = (reviewedIncome[monthOf(t.date)] || 0) + amount;
    let defaultCat = cat("Transfer");
    if (!kind && inflowIsIncome(t, amount)) defaultCat = cat("Other income");
    /* CYBRID-CROBO debits are money he sends to India: real outflows
       the sync deliberately never logs as expenses, so reports count
       them here, under their own category, in every month. Other
       unlinked outflows stay Transfer — that spending is already in
       the daily log via the card charges. */
    else if (!kind && amount < 0 && /cybrid/i.test(t.name || "")) defaultCat = cat("Sent to India");
    desired.push({
      ext: "bank:" + t.plaid_transaction_id, source: "v1bank", date: t.date, merchant: t.name, description: t.name,
      amount: amount, share: null,
      categoryId: kind === "income" ? cat("Other income") : kind === "repayment" ? cat("Repayment") : defaultCat,
      accountId: acctByExt["plaid:" + t.account_id] || null, notes: "",
      pending: 0, hidden: kind === "ignore" ? 1 : 0, exclude: 0, review: kind ? 0 : 1, v1: null
    });
  }
  const loggedMonths = {};
  state.dailyExpenses.forEach((e) => { if (e.date >= baseline) loggedMonths[monthOf(e.date)] = true; });
  for (const a of state.actuals) {
    if (!a.entered) continue;
    const m = a.monthKey;
    const push = (field, cents, label) => {
      if (!cents) return;
      desired.push({
        ext: "act:" + m + ":" + field, source: "v1actual", date: m + "-01", merchant: label, description: label + " (entered in the Month editor)",
        amount: cents, share: null, categoryId: cat(FIELD_CATEGORY[field]), accountId: null, notes: "",
        pending: 0, hidden: 0, exclude: 0, review: 0, v1: null
      });
    };
    push("takeHomePay", Math.round(a.takeHomePay * 100), FIELD_LABEL.takeHomePay);
    push("otherIncome", Math.round(a.otherIncome * 100) - (reviewedIncome[m] || 0), FIELD_LABEL.otherIncome);
    if (!loggedMonths[m]) {
      for (const [field] of MONEY_FIELDS) {
        if (field === "takeHomePay" || field === "otherIncome") continue;
        push(field, -Math.round(a[field] * 100), FIELD_LABEL[field]);
      }
    }
  }

  const existing = await s.all("SELECT id, external_id, source FROM transactions WHERE owner_id = ?1 AND external_id IS NOT NULL");
  const existingExt = {};
  existing.forEach((r) => { existingExt[r.external_id] = r; });
  const rules = await loadRules(s);
  const txStmts = [];
  const wanted = {};
  for (const d of desired) {
    wanted[d.ext] = true;
    let categoryId = d.categoryId, hidden = d.hidden, tags = "[]", locked = 0;
    if (!existingExt[d.ext]) {
      const hit = applyRules(rules, { merchant: d.merchant, description: d.description, amountCents: d.amount, accountId: d.accountId });
      if (hit) {
        if (hit.change.categoryId && d.source !== "v1exp") { categoryId = hit.change.categoryId; locked = 1; }
        if (hit.change.hidden) hidden = 1;
        if (hit.change.addTag) tags = JSON.stringify([hit.change.addTag]);
      }
    }
    txStmts.push([
      "INSERT INTO transactions (id, owner_id, external_id, source, account_id, date, merchant, description, amount_cents, my_share_cents, " +
      "category_id, category_locked, notes, tags, pending, hidden, exclude_reports, needs_review, v1_expense_id) " +
      "VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19) " +
      "ON CONFLICT(owner_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET " +
      "source = excluded.source, account_id = excluded.account_id, date = excluded.date, merchant = excluded.merchant, " +
      "description = excluded.description, amount_cents = excluded.amount_cents, my_share_cents = excluded.my_share_cents, " +
      "category_id = CASE WHEN transactions.category_locked = 1 THEN transactions.category_id ELSE excluded.category_id END, " +
      "notes = CASE WHEN excluded.source = 'v1exp' THEN excluded.notes ELSE transactions.notes END, " +
      "pending = excluded.pending, " +
      "hidden = CASE WHEN transactions.category_locked = 1 OR excluded.source <> 'v1bank' THEN transactions.hidden ELSE excluded.hidden END, " +
      "needs_review = CASE WHEN transactions.category_locked = 1 OR excluded.source <> 'v1bank' THEN transactions.needs_review ELSE excluded.needs_review END, " +
      "exclude_reports = excluded.exclude_reports, v1_expense_id = excluded.v1_expense_id, updated_at = datetime('now')",
      newId("tx_"), d.ext, d.source, d.accountId, d.date, String(d.merchant || "").slice(0, 300), String(d.description || "").slice(0, 500),
      d.amount, d.share, categoryId, locked, d.notes, tags, d.pending, hidden, d.exclude, d.review, d.v1
    ]);
  }
  await s.batch(txStmts);
  const stale = existing.filter((r) => MIRRORED.indexOf(r.source) !== -1 && !wanted[r.external_id]);
  await s.batch(stale.flatMap((r) => [
    ["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", r.id],
    ["DELETE FROM transactions WHERE owner_id = ?1 AND id = ?2", r.id]
  ]));

  /* ---- budgets ---- */
  const budgetStmts = [];
  for (const m of state.months) {
    const totals = {};
    for (const [field] of MONEY_FIELDS) {
      const cid = cat(FIELD_CATEGORY[field]);
      totals[cid] = (totals[cid] || 0) + Math.round((m[field] || 0) * 100);
    }
    for (const cid of Object.keys(totals)) {
      if (totals[cid]) {
        budgetStmts.push([
          "INSERT INTO budgets (owner_id, month, category_id, amount_cents, source) VALUES (?1, ?2, ?3, ?4, 'v1') " +
          "ON CONFLICT(owner_id, month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents WHERE budgets.source = 'v1'",
          m.monthKey, cid, totals[cid]
        ]);
      } else {
        budgetStmts.push(["DELETE FROM budgets WHERE owner_id = ?1 AND month = ?2 AND category_id = ?3 AND source = 'v1'", m.monthKey, cid]);
      }
    }
  }
  await s.batch(budgetStmts);

  await s.setSetting("mirror_fp", fp);
  await s.setSetting("mirrored_at", new Date().toISOString());
  return { skipped: false, accounts: acctStmts.length, transactions: desired.length, removed: stale.length, budgets: budgetStmts.length };
}

/* The migration gate: classic actual income and spending per plan month
   vs the same months summed from v2 transactions. */
export async function compareTotals(db) {
  await mirrorV1(db);
  const state = await readState(db);
  const s = scope(db, OWNER_ID);
  const { categories } = await loadCategories(s);
  const idx = categoryIndex(categories);
  const txs = await loadTransactions(s);
  const months = state.months.map(({ monthKey: m }) => {
    const a = state.actuals.find((x) => x.monthKey === m) || {};
    let v1Income = 0, v1Spending = 0;
    if (a.entered) {
      for (const [field] of MONEY_FIELDS) {
        const c = Math.round((a[field] || 0) * 100);
        if (field === "takeHomePay" || field === "otherIncome") v1Income += c; else v1Spending += c;
      }
    }
    const inMonth = txs.filter((t) => monthOf(t.date) === m);
    /* The gate compares the COPIED rows; rows added on the new screens
       exist only there and are reported separately. So is a bank row you
       (or auto-review) filed on the new screens (category_locked): its
       category was decided there, not copied from the classic app. */
    const copied = (t) => MIRRORED.indexOf(t.source) !== -1 && !(t.source === "v1bank" && t.categoryLocked);
    /* Classic actuals count the daily log from the baseline date; earlier
       expenses are history (they count in reports) and stay out of the gate. */
    const v2 = summarize(inMonth.filter((t) => copied(t) && !(t.source === "v1exp" && t.date < state.baselineDate)), idx);
    const added = summarize(inMonth.filter((t) => !copied(t)), idx);
    return {
      month: m, v1IncomeCents: v1Income, v2IncomeCents: v2.incomeCents, v1SpendingCents: v1Spending, v2SpendingCents: v2.spendingCents,
      newOnlyIncomeCents: added.incomeCents, newOnlySpendingCents: added.spendingCents,
      match: v1Income === v2.incomeCents && v1Spending === v2.spendingCents
    };
  });
  return { match: months.every((x) => x.match), months };
}
