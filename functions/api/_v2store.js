/*
 * v2 row mappers and loaders: database rows (snake_case, cents) <->
 * the shapes js/core/v2/money.js works on (camelCase, cents). Every read
 * goes through the scoped helper from ./_v2db.js.
 */

export function rowToAccount(r) {
  return {
    id: r.id, externalId: r.external_id || null, name: r.name, institution: r.institution || "",
    type: r.type, subtype: r.subtype || "", mask: r.mask || "",
    balanceCents: r.balance_cents === null || r.balance_cents === undefined ? null : r.balance_cents,
    availableCents: r.available_cents === null || r.available_cents === undefined ? null : r.available_cents,
    balanceAt: r.balance_at || null,
    statementStart: r.statement_start || null, statementEnd: r.statement_end || null, dueDate: r.due_date || null,
    hidden: !!r.hidden, includeInNetWorth: !!r.include_in_net_worth, source: r.source
  };
}

export function rowToTransaction(r, splits, auto) {
  let tags = [];
  try { tags = JSON.parse(r.tags || "[]"); } catch (e) { tags = []; }
  return {
    id: r.id, externalId: r.external_id || null, source: r.source, accountId: r.account_id || null,
    date: r.date, merchant: r.merchant || "", description: r.description || "",
    amountCents: r.amount_cents,
    myShareCents: r.my_share_cents === null || r.my_share_cents === undefined ? null : r.my_share_cents,
    categoryId: r.category_id || null, categoryLocked: !!r.category_locked,
    notes: r.notes || "", tags: Array.isArray(tags) ? tags : [],
    pending: !!r.pending, hidden: !!r.hidden, excludeReports: !!r.exclude_reports, needsReview: !!r.needs_review,
    v1ExpenseId: r.v1_expense_id || null,
    splits: splits || [],
    /* Set while auto-review's decision stands and you haven't confirmed it. */
    autoReview: auto && auto.verdict === "reviewed" ? { by: auto.reviewer, decision: auto.decision, reason: auto.reason || "", at: auto.checked_at } : null,
    updatedAt: r.updated_at
  };
}

export function rowToSplit(r) {
  return { id: r.id, categoryId: r.category_id || null, amountCents: r.amount_cents, notes: r.notes || "" };
}

export function rowToCategory(r) {
  return { id: r.id, groupId: r.group_id, name: r.name, kind: r.kind, icon: r.icon || "", sort: r.sort, archived: !!r.archived };
}

export function rowToBudget(r) {
  return { month: r.month, categoryId: r.category_id, amountCents: r.amount_cents, rollover: !!r.rollover, source: r.source };
}

export function rowToRule(r) {
  return {
    id: r.id, sort: r.sort, matchText: r.match_text || "", matchAccountId: r.match_account_id || null,
    minCents: r.min_cents === null || r.min_cents === undefined ? null : r.min_cents,
    maxCents: r.max_cents === null || r.max_cents === undefined ? null : r.max_cents,
    setCategoryId: r.set_category_id || null, addTag: r.add_tag || null, setHidden: !!r.set_hidden
  };
}

export function rowToRecurring(r) {
  return {
    id: r.id, detectKey: r.detect_key || null, name: r.name || "", merchant: r.merchant || "",
    categoryId: r.category_id || null, accountId: r.account_id || null, amountCents: r.amount_cents,
    cadence: r.cadence, nextDate: r.next_date || null, source: r.source, status: r.status
  };
}

export function rowToGoal(r) {
  return {
    id: r.id, name: r.name, targetCents: r.target_cents, targetDate: r.target_date || null,
    accountId: r.account_id || null, savedCents: r.saved_cents || 0, archived: !!r.archived
  };
}

export async function loadCategories(s) {
  const groups = await s.all("SELECT * FROM category_groups WHERE owner_id = ?1 ORDER BY sort, name");
  const cats = await s.all("SELECT * FROM categories WHERE owner_id = ?1 ORDER BY sort, name");
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind, sort: g.sort })),
    categories: cats.map(rowToCategory)
  };
}

/* { [id]: { kind, name, groupId } } — what the core report helpers take. */
export function categoryIndex(categories) {
  const out = {};
  categories.forEach((c) => { out[c.id] = c; });
  return out;
}

export async function loadTransactions(s, opts) {
  const o = opts || {};
  const where = ["owner_id = ?1"];
  const params = [];
  if (o.from) { params.push(o.from); where.push("date >= ?" + (params.length + 1)); }
  if (o.to) { params.push(o.to); where.push("date <= ?" + (params.length + 1)); }
  const rows = await s.all("SELECT * FROM transactions WHERE " + where.join(" AND ") + " ORDER BY date DESC, created_at DESC, id", ...params);
  const splitRows = await s.all("SELECT * FROM transaction_splits WHERE owner_id = ?1");
  const byTx = {};
  splitRows.forEach((r) => { (byTx[r.transaction_id] = byTx[r.transaction_id] || []).push(rowToSplit(r)); });
  const auto = await loadAutoReviews(s);
  return rows.map((r) => rowToTransaction(r, byTx[r.id], auto[r.id]));
}

export async function loadAccounts(s) {
  const rows = await s.all("SELECT * FROM accounts WHERE owner_id = ?1 ORDER BY type, institution, name");
  return rows.map(rowToAccount);
}

export async function loadBudgets(s, from, to) {
  const rows = from
    ? await s.all("SELECT * FROM budgets WHERE owner_id = ?1 AND month >= ?2 AND month <= ?3", from, to || "9999-12")
    : await s.all("SELECT * FROM budgets WHERE owner_id = ?1");
  return rows.map(rowToBudget);
}

export async function loadRules(s) {
  return (await s.all("SELECT * FROM rules WHERE owner_id = ?1 ORDER BY sort, created_at")).map(rowToRule);
}

export async function loadAutoReviews(s, id) {
  const rows = id
    ? await s.all("SELECT * FROM auto_reviews WHERE owner_id = ?1 AND transaction_id = ?2", id)
    : await s.all("SELECT * FROM auto_reviews WHERE owner_id = ?1 AND verdict = 'reviewed'");
  const out = {};
  rows.forEach((r) => { out[r.transaction_id] = r; });
  return out;
}
