/*
 * v2 export (serves /api/v2/export) — everything in the new model.
 *   GET ?format=json -> one JSON file: accounts, categories, groups,
 *        transactions (with splits), budgets, rules, recurring, goals,
 *        balance snapshots
 *   GET ?format=csv  -> transactions as CSV (date, merchant, amount,
 *        my share, category, account, tags, notes, hidden)
 */
import { handleV2 } from "../_v2http.js";
import { loadAccounts, loadCategories, loadTransactions, loadBudgets, loadRules, rowToRecurring, rowToGoal } from "../_v2store.js";

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  /* Leading = + - @ would run as a formula in a spreadsheet. */
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export const onRequestGet = (context) => handleV2(context, async ({ s, url }) => {
  const accounts = await loadAccounts(s);
  const { groups, categories } = await loadCategories(s);
  const txs = await loadTransactions(s);
  const stamp = new Date().toISOString().slice(0, 10);
  if (url.searchParams.get("format") === "csv") {
    const cat = {}, acc = {};
    categories.forEach((c) => { cat[c.id] = c.name; });
    accounts.forEach((a) => { acc[a.id] = a.name; });
    const lines = [["Date", "Merchant", "Amount", "My share", "Category", "Account", "Tags", "Notes", "Hidden"].join(",")];
    txs.forEach((t) => lines.push([
      t.date, t.merchant, (t.amountCents / 100).toFixed(2), t.myShareCents === null ? "" : (t.myShareCents / 100).toFixed(2),
      t.splits.length ? "Split" : (cat[t.categoryId] || ""), acc[t.accountId] || "", t.tags.join(" "), t.notes, t.hidden ? "yes" : ""
    ].map(csvCell).join(",")));
    return new Response(lines.join("\r\n") + "\r\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=\"transactions-" + stamp + ".csv\"", "Cache-Control": "no-store" }
    });
  }
  const body = {
    version: 1, exportedAt: new Date().toISOString(), accounts, groups, categories, transactions: txs,
    budgets: await loadBudgets(s), rules: await loadRules(s),
    recurring: (await s.all("SELECT * FROM recurring WHERE owner_id = ?1")).map(rowToRecurring),
    goals: (await s.all("SELECT * FROM goals WHERE owner_id = ?1")).map(rowToGoal),
    balanceSnapshots: (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1 ORDER BY date"))
      .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }))
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=\"money-export-" + stamp + ".json\"", "Cache-Control": "no-store" }
  });
});
