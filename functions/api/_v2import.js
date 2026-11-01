/*
 * Adding bank rows that didn't come through Plaid: a statement CSV
 * (./v2/import.js) or SimpleFIN Bridge (./v2/simplefin.js). (Files
 * starting with "_" are not Pages routes.)
 *
 * importRows skips a row when
 *   - its external id is already stored (the same CSV line or SimpleFIN
 *     transaction came in before), or
 *   - a stored row has the same date and amount and a similar name
 *     (you typed it in, or another feed brought it); each stored row
 *     absorbs at most one incoming row.
 * New rows are filed like the mirror files bank rows: your rules first
 * (category + reviewed), then your own merchant rules from the daily
 * log (reviewed), then the keyword guess (left on To review, where
 * auto-review / Gemini checks it on the next app open).
 */
import { newId } from "./_v2db.js";
import { loadRules, loadCategories } from "./_v2store.js";
import { applyRules, merchantKey } from "../../js/core/v2/money.js";
import { merchantCategory } from "../../js/core/merchant.js";
import { getMerchantRules } from "./budget.js";
import { categorizeByRules } from "./_categories.js";
import { nameTokens } from "./_v2autoreview.js";

const RAILS = new Set(["upi", "neft", "imps", "rtgs", "nach", "txn", "ref", "transfer", "to", "from", "by"]);
function tokens(name) { return nameTokens(name).filter((w) => !RAILS.has(w)); }

/* Same payment, named by two different feeds: "UPI/4521/SWIGGY/okaxis"
   and "Swiggy" share a word of 3+ letters. No name on one side: the
   date and amount alone decide. */
export function similarName(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.some((w) => w.length >= 3 && long.indexOf(w) !== -1);
}

/* An id for a CSV line, stable across re-imports of an overlapping
   statement: the nth identical line of a file gets ":n". */
export function csvIds(accountId, rows) {
  const seen = {};
  return rows.map((r) => {
    const base = "csv:" + accountId + ":" + r.date + ":" + r.amountCents + ":" + merchantKey(r.description).slice(0, 80);
    seen[base] = (seen[base] || 0) + 1;
    return base + ":" + seen[base];
  });
}

/* rows: [{ date, description, amountCents, externalId }] for one account.
   -> { added, duplicates, categorized, toReview } */
export async function importRows(s, db, accountId, rows, source) {
  if (!rows.length) return { added: 0, duplicates: 0, categorized: 0, toReview: 0 };
  const dates = rows.map((r) => r.date).sort();
  const [existing, rules, cats, merchantRules] = await Promise.all([
    s.all("SELECT external_id, date, amount_cents, merchant FROM transactions WHERE owner_id = ?1 AND date >= ?2 AND date <= ?3", dates[0], dates[dates.length - 1]),
    loadRules(s), loadCategories(s), getMerchantRules(db)
  ]);
  const ext = new Set(existing.map((r) => r.external_id).filter(Boolean));
  const byDay = {};
  existing.forEach((r) => { if (!r.external_id || !r.external_id.startsWith(source === "csv" ? "csv:" : "sfin:")) (byDay[r.date + "|" + r.amount_cents] = byDay[r.date + "|" + r.amount_cents] || []).push(r.merchant); });
  const catId = {};
  cats.categories.forEach((c) => { catId[c.name.toLowerCase()] = c.id; });

  const out = { added: 0, duplicates: 0, categorized: 0, toReview: 0 };
  const stmts = [];
  for (const r of rows) {
    if (ext.has(r.externalId)) { out.duplicates++; continue; }
    const same = byDay[r.date + "|" + r.amountCents] || [];
    const hit = same.findIndex((m) => similarName(m, r.description));
    if (hit !== -1) { same.splice(hit, 1); out.duplicates++; continue; }
    ext.add(r.externalId);

    let categoryId = null, locked = 0, review = 1, hidden = 0, tags = "[]";
    const rule = applyRules(rules, { merchant: r.description, description: r.description, amountCents: r.amountCents, accountId });
    if (rule) {
      if (rule.change.categoryId) { categoryId = rule.change.categoryId; locked = 1; review = 0; }
      if (rule.change.hidden) hidden = 1;
      if (rule.change.addTag) tags = JSON.stringify([rule.change.addTag]);
    }
    if (!categoryId && r.amountCents < 0) {
      const own = catId[String(merchantCategory(merchantRules, r.description) || "").toLowerCase()];
      const guess = categorizeByRules(r.description);
      if (own) { categoryId = own; locked = 1; review = 0; }
      else if (guess !== "Misc/Other") categoryId = catId[guess.toLowerCase()] || null;
    }
    if (review) out.toReview++; else out.categorized++;
    stmts.push([
      "INSERT INTO transactions (id, owner_id, external_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked, tags, hidden, needs_review) " +
      "VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT(owner_id, external_id) WHERE external_id IS NOT NULL DO NOTHING",
      newId("tx_"), r.externalId, source, accountId, r.date, r.description, r.amountCents, categoryId, locked, tags, hidden, review
    ]);
    out.added++;
  }
  await s.batch(stmts);
  return out;
}
