/*
 * v2 budgets (serves /api/v2/budgets): planned cents per category per
 * month, any month, with optional rollover of what's left.
 *   GET ?month=YYYY-MM -> { month, rows, planned/actual totals } (see
 *        budgetMonth in js/core/v2/money.js)
 *   PUT { month, categoryId, amountCents, rollover? } -> the month again
 *        amountCents 0 removes the budget line. Once edited here a line
 *        belongs to the new app (the classic plan stops updating it).
 *   POST { action: "copy", from, to } -> the "to" month
 *        Copies every line of one month onto another (overwriting).
 *   POST { action: "fill", from, through } -> { months }
 *        Repeats one month's lines into every later month up to "through"
 *        that has no budget yet.
 */
import { handleV2, HttpError, cleanCents, cleanMonth, bodyOf } from "../_v2http.js";
import { loadBudgets, loadTransactions, loadCategories, categoryIndex } from "../_v2store.js";
import { budgetMonth, monthRange, addMonths } from "../../../js/core/v2/money.js";

export async function monthView(s, month) {
  const { categories } = await loadCategories(s);
  const budgets = await loadBudgets(s);
  const from = addMonths(month, -24) + "-01";
  const txs = await loadTransactions(s, { from, to: month + "-31" });
  return budgetMonth(month, budgets, txs, categoryIndex(categories));
}

export const onRequestGet = (context) => handleV2(context, async ({ s, url }) => monthView(s, cleanMonth(url.searchParams.get("month"))));

export const onRequestPut = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const month = cleanMonth(b.month);
  const amount = cleanCents(b.amountCents, "amountCents", { min: 0 });
  const c = await s.first("SELECT id, kind FROM categories WHERE owner_id = ?1 AND id = ?2", String(b.categoryId || ""));
  if (!c) throw new HttpError(400, "Unknown category.");
  if (c.kind === "transfer") throw new HttpError(400, "Transfers aren't budgeted.");
  if (amount === 0 && !b.rollover) {
    await s.run("DELETE FROM budgets WHERE owner_id = ?1 AND month = ?2 AND category_id = ?3", month, c.id);
  } else {
    await s.run(
      "INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) VALUES (?1, ?2, ?3, ?4, ?5, 'user') " +
      "ON CONFLICT(owner_id, month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents, rollover = excluded.rollover, source = 'user'",
      month, c.id, amount, b.rollover ? 1 : 0
    );
  }
  return monthView(s, month);
});

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const from = cleanMonth(b.from, "from");
  const lines = await s.all("SELECT * FROM budgets WHERE owner_id = ?1 AND month = ?2", from);
  if (!lines.length) throw new HttpError(400, from + " has no budget to copy.");
  if (b.action === "copy") {
    const to = cleanMonth(b.to, "to");
    await s.batch([["DELETE FROM budgets WHERE owner_id = ?1 AND month = ?2", to]].concat(lines.map((l) => [
      "INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) VALUES (?1, ?2, ?3, ?4, ?5, 'user')",
      to, l.category_id, l.amount_cents, l.rollover
    ])));
    return monthView(s, to);
  }
  if (b.action === "fill") {
    const through = cleanMonth(b.through, "through");
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
  }
  throw new HttpError(400, "action must be copy or fill.");
});
