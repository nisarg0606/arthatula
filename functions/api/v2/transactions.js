/*
 * v2 transactions (serves /api/v2/transactions). Amounts are signed
 * cents: negative = money out, positive = money in.
 *   GET ?from=&to=&accountId=&categoryId=&q=&review=1&hidden=1&limit=&offset=
 *        -> { transactions, total }   newest first; limit ≤ 500 (default 200)
 *   POST { date, merchant, amountCents, accountId?, categoryId?, notes?, tags? } -> 201 { transaction }
 *   PATCH { id, patch } -> { transaction }
 *        patch: categoryId, merchant, notes, tags, hidden, needsReview,
 *        excludeReports, amountCents, myShareCents (null = all mine),
 *        date, accountId, splits ([{ categoryId, amountCents }] summing
 *        to the transaction's amount — or my share when set; [] removes).
 *        Rows from the classic daily log (source "v1exp") are written
 *        back to it, so both apps agree; a category the classic app
 *        doesn't have stays on the new app only.
 *   DELETE ?id=… -> { deleted }  (your own rows and classic daily-log rows)
 */
import { handleV2, HttpError, cleanStr, cleanCents, cleanDate, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { loadTransactions, rowToTransaction, rowToSplit } from "../_v2store.js";
import { mirrorV1 } from "../_v2mirror.js";
import { isValidCategory } from "../_categories.js";
import { onRequestPut as v1Put, onRequestDelete as v1Delete } from "../expenses.js";

async function getTx(s, id) {
  const r = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND id = ?2", String(id || ""));
  if (!r) throw new HttpError(404, "Transaction not found.");
  const splits = (await s.all("SELECT * FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", r.id)).map(rowToSplit);
  return rowToTransaction(r, splits);
}
async function checkCategory(s, id) {
  if (id === null) return null;
  const c = await s.first("SELECT id, name FROM categories WHERE owner_id = ?1 AND id = ?2", String(id || ""));
  if (!c) throw new HttpError(400, "Unknown category.");
  return c;
}
async function checkAccount(s, id) {
  if (id === null || id === undefined || id === "") return null;
  const a = await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", String(id));
  if (!a) throw new HttpError(400, "Unknown account.");
  return a.id;
}
function cleanTags(v) {
  if (!Array.isArray(v)) throw new HttpError(400, "tags must be a list.");
  const out = [];
  v.forEach((t) => { const x = cleanStr(t, 40); if (x && out.indexOf(x) === -1) out.push(x); });
  return out.slice(0, 20);
}

/* Call the classic daily-log handler with this request's credentials. */
async function classic(context, handler, method, url, body) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const auth = context.request.headers.get("Authorization");
  if (auth) headers.set("Authorization", auth);
  const res = await handler({ env: context.env, request: new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined }) });
  if (!res.ok) {
    let msg = "The classic daily log refused the change.";
    try { msg = (await res.json()).error || msg; } catch (e) { /* keep default */ }
    throw new HttpError(res.status === 404 ? 404 : 400, msg);
  }
}

export const onRequestGet = (context) => handleV2(context, async ({ s, url }) => {
  const p = url.searchParams;
  const limit = Math.min(Math.max(parseInt(p.get("limit") || "200", 10) || 200, 1), 500);
  const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);
  let list = await loadTransactions(s, { from: p.get("from") || undefined, to: p.get("to") || undefined });
  if (p.get("accountId")) list = list.filter((t) => t.accountId === p.get("accountId"));
  if (p.get("categoryId")) {
    const c = p.get("categoryId");
    list = list.filter((t) => t.categoryId === c || t.splits.some((x) => x.categoryId === c));
  }
  if (p.get("review") === "1") list = list.filter((t) => t.needsReview && !t.hidden);
  if (p.get("hidden") !== "1") list = list.filter((t) => !t.hidden);
  const q = (p.get("q") || "").trim().toLowerCase();
  if (q) list = list.filter((t) => (t.merchant + " " + t.description + " " + t.notes + " " + t.tags.join(" ")).toLowerCase().indexOf(q) !== -1);
  return { transactions: list.slice(offset, offset + limit), total: list.length };
});

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const date = cleanDate(b.date);
  const merchant = cleanStr(b.merchant, 300);
  if (!merchant) throw new HttpError(400, "merchant is required.");
  const amount = cleanCents(b.amountCents, "amountCents");
  if (amount === 0) throw new HttpError(400, "amountCents can't be zero.");
  const cat = b.categoryId ? await checkCategory(s, b.categoryId) : null;
  const accountId = await checkAccount(s, b.accountId);
  const id = newId("tx_");
  await s.run(
    "INSERT INTO transactions (id, owner_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked, notes, tags, needs_review) " +
    "VALUES (?2, ?1, 'manual', ?3, ?4, ?5, ?5, ?6, ?7, 1, ?8, ?9, ?10)",
    id, accountId, date, merchant, amount, cat ? cat.id : null, cleanStr(b.notes, 500), JSON.stringify(b.tags ? cleanTags(b.tags) : []), cat ? 0 : 1
  );
  return new Response(JSON.stringify({ transaction: await getTx(s, id) }), {
    status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
});

export const onRequestPatch = (context) => handleV2(context, async ({ s, db, request }) => {
  const b = await bodyOf(request);
  const tx = await getTx(s, b.id);
  const p = b.patch && typeof b.patch === "object" ? b.patch : {};
  const sets = [];
  const add = (col, v) => sets.push([col, v]);
  const v1 = {};
  const fromClassic = tx.source === "v1exp" && tx.v1ExpenseId;
  const readOnly = tx.source === "v1bank" || tx.source === "v1actual";

  if (p.merchant !== undefined) {
    const m = cleanStr(p.merchant, 300);
    if (!m) throw new HttpError(400, "merchant can't be empty.");
    if (readOnly) throw new HttpError(409, "This row comes from your bank or the Month editor; rename it there.");
    if (fromClassic) v1.description = m; else { add("merchant", m); add("description", m); }
  }
  if (p.date !== undefined) {
    const d = cleanDate(p.date);
    if (readOnly) throw new HttpError(409, "This row's date comes from your bank or the Month editor.");
    if (fromClassic) v1.date = d; else add("date", d);
  }
  if (p.amountCents !== undefined) {
    const a = cleanCents(p.amountCents, "amountCents");
    if (readOnly) throw new HttpError(409, "This row's amount comes from your bank or the Month editor.");
    if (fromClassic) {
      if (a >= 0) throw new HttpError(400, "A daily-log expense is money out: amountCents must be negative.");
      v1.amount = -a / 100;
    } else add("amount_cents", a);
  }
  if (p.myShareCents !== undefined) {
    const sh = cleanCents(p.myShareCents, "myShareCents", { nullable: true });
    const amount = p.amountCents !== undefined ? p.amountCents : tx.amountCents;
    if (sh !== null && (Math.sign(sh) !== Math.sign(amount) && sh !== 0 || Math.abs(sh) > Math.abs(amount))) {
      throw new HttpError(400, "myShareCents must have the transaction's sign and be no larger than it.");
    }
    if (fromClassic) v1.myShare = sh === null ? null : -sh / 100; else add("my_share_cents", sh);
  }
  if (p.notes !== undefined) {
    const n = cleanStr(p.notes, 500);
    if (fromClassic) v1.note = n; else add("notes", n);
  }
  if (p.categoryId !== undefined) {
    const c = await checkCategory(s, p.categoryId);
    if (fromClassic && c && isValidCategory(c.name)) {
      v1.category = c.name;
      add("category_locked", 0);
    } else {
      add("category_id", c ? c.id : null);
      add("category_locked", 1);
    }
    add("needs_review", 0);
  }
  if (p.accountId !== undefined) {
    if (tx.source !== "manual") throw new HttpError(409, "Only rows you added by hand can move between accounts.");
    add("account_id", await checkAccount(s, p.accountId));
  }
  if (p.tags !== undefined) add("tags", JSON.stringify(cleanTags(p.tags)));
  /* A bank row's hidden / to-review flags follow the classic review list
     until changed here; locking it keeps this choice from then on. */
  const lockBank = () => { if (tx.source === "v1bank") add("category_locked", 1); };
  if (p.hidden !== undefined) { add("hidden", p.hidden ? 1 : 0); lockBank(); }
  if (p.needsReview !== undefined) { add("needs_review", p.needsReview ? 1 : 0); lockBank(); }
  if (p.excludeReports !== undefined) add("exclude_reports", p.excludeReports ? 1 : 0);

  let splitStmts = null;
  if (p.splits !== undefined) {
    if (!Array.isArray(p.splits)) throw new HttpError(400, "splits must be a list.");
    splitStmts = [["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", tx.id]];
    if (p.splits.length) {
      if (p.splits.length < 2 || p.splits.length > 20) throw new HttpError(400, "A split needs 2 to 20 parts.");
      const base = p.myShareCents !== undefined ? p.myShareCents : (tx.myShareCents !== null ? tx.myShareCents : (p.amountCents !== undefined ? p.amountCents : tx.amountCents));
      const target = base === null ? (p.amountCents !== undefined ? p.amountCents : tx.amountCents) : base;
      let sum = 0;
      for (const part of p.splits) {
        const amt = cleanCents(part && part.amountCents, "split amountCents");
        const c = await checkCategory(s, part.categoryId);
        sum += amt;
        splitStmts.push(["INSERT INTO transaction_splits (id, owner_id, transaction_id, category_id, amount_cents, notes) VALUES (?2, ?1, ?3, ?4, ?5, ?6)",
          newId("spl_"), tx.id, c.id, amt, cleanStr(part.notes, 200)]);
      }
      if (sum !== target) throw new HttpError(400, "The split parts must add up to " + target + " cents (they add up to " + sum + ").");
    }
  }

  if (Object.keys(v1).length) {
    await classic(context, v1Put, "PUT", "http://internal/api/expenses", { id: tx.v1ExpenseId, patch: v1 });
    await mirrorV1(db, { force: true });
  }
  if (sets.length) {
    const cols = sets.map(([c], i) => c + " = ?" + (i + 3)).join(", ");
    await s.run("UPDATE transactions SET " + cols + ", updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", tx.id, ...sets.map(([, v]) => v));
  }
  if (splitStmts) await s.batch(splitStmts);
  return { transaction: await getTx(s, tx.id) };
});

export const onRequestDelete = (context) => handleV2(context, async ({ s, db, url }) => {
  const tx = await getTx(s, url.searchParams.get("id"));
  if (tx.source === "v1exp" && tx.v1ExpenseId) {
    await classic(context, v1Delete, "DELETE", "http://internal/api/expenses?id=" + tx.v1ExpenseId);
    await mirrorV1(db, { force: true });
  } else if (tx.source === "manual") {
    await s.batch([
      ["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", tx.id],
      ["DELETE FROM transactions WHERE owner_id = ?1 AND id = ?2", tx.id]
    ]);
  } else {
    throw new HttpError(409, "Rows from your bank or the Month editor can't be deleted here; hide them instead.");
  }
  return { deleted: tx.id };
});
