/*
 * v2 reports (serves /api/v2/reports).
 *   GET ?kind=summary[&month=YYYY-MM]  the dashboard: this month's income,
 *        spending and budget, net worth now and 30 days ago, upcoming
 *        bills (14 days), transactions to review, top spending categories.
 *   GET ?kind=cashflow&from=YYYY-MM&to=YYYY-MM  income vs spending by month
 *        and by category over the range (at most 60 months).
 *   GET ?kind=forecast[&months=12]  cash today (checking + savings +
 *        cash accounts) carried forward by each month's planned income
 *        minus planned spending; a month with no budget repeats the last
 *        budgeted month without its one-off lines.
 */
import { handleV2, HttpError, cleanMonth } from "../_v2http.js";
import { loadTransactions, loadCategories, loadBudgets, loadAccounts, categoryIndex } from "../_v2store.js";
import { summarize, cashFlow, forecast, budgetMonth, monthRange, monthOf, addDays, netWorthSeries, upcoming, isLiability } from "../../../js/core/v2/money.js";
import { recurringItems } from "./recurring.js";

function today() { return new Date().toISOString().slice(0, 10); }

export function cashNow(accounts) {
  return accounts.filter((a) => !a.hidden && (a.type === "depository" || a.type === "cash") && a.balanceCents !== null)
    .reduce((sum, a) => sum + a.balanceCents, 0);
}

export const onRequestGet = (context) => handleV2(context, async ({ s, url }) => {
  const kind = url.searchParams.get("kind") || "summary";
  const { groups, categories } = await loadCategories(s);
  const idx = categoryIndex(categories);
  if (kind === "cashflow") {
    const from = cleanMonth(url.searchParams.get("from"), "from"), to = cleanMonth(url.searchParams.get("to"), "to");
    if (from > to) throw new HttpError(400, "from is after to.");
    if (monthRange(from, to).length > 60) throw new HttpError(400, "At most 60 months.");
    const txs = await loadTransactions(s, { from: from + "-01", to: to + "-31" });
    return Object.assign({ from, to }, cashFlow(txs, idx, from, to));
  }
  if (kind === "forecast") {
    const count = Math.min(Math.max(parseInt(url.searchParams.get("months") || "12", 10) || 12, 1), 36);
    const month = monthOf(today());
    const accounts = await loadAccounts(s);
    const txs = await loadTransactions(s, { from: month + "-01", to: month + "-31" });
    const oneOff = categories.filter((c) => c.name === "One-off").map((c) => c.id);
    return {
      cashCents: cashNow(accounts),
      months: forecast({ cashCents: cashNow(accounts), month, count, budgets: await loadBudgets(s), categories: idx, transactions: txs, oneOffCategoryIds: oneOff })
    };
  }
  if (kind === "summary") {
    const month = url.searchParams.get("month") ? cleanMonth(url.searchParams.get("month")) : monthOf(today());
    const accounts = await loadAccounts(s);
    const txAll = await loadTransactions(s);
    const monthTx = txAll.filter((t) => monthOf(t.date) === month);
    const sum = summarize(monthTx, idx);
    const budget = budgetMonth(month, await loadBudgets(s), txAll, idx);
    const acctIdx = {};
    accounts.forEach((a) => { acctIdx[a.id] = a; });
    const snaps = (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1"))
      .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }));
    const series = netWorthSeries(acctIdx, snaps);
    let now = 0;
    accounts.forEach((a) => {
      if (a.hidden || !a.includeInNetWorth || a.balanceCents === null) return;
      now += isLiability(a.type) ? -a.balanceCents : a.balanceCents;
    });
    const monthAgo = addDays(today(), -30);
    const past = series.filter((p) => p.date <= monthAgo).pop();
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
      upcoming: upcoming(rec.items.concat(rec.cardBills), today(), addDays(today(), 14)),
      reviewCount: txAll.filter((t) => t.needsReview && !t.hidden).length,
      topCategories: top, groups, categories
    };
  }
  throw new HttpError(400, "kind must be summary, cashflow or forecast.");
});
