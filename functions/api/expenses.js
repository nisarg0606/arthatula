/*
 * Arthatula — daily expense log.
 *
 * Routes (this file serves /api/expenses):
 *   GET    /api/expenses[?month=YYYY-MM] -> { expenses: [...] }
 *   POST   /api/expenses { date, description, amount, category?, card?, myShare? }
 *          Without a category, the expense is auto-categorized first
 *          (Gemini when configured, otherwise keyword rules — see
 *          categorize.js) and categorization_source records which.
 *          A category supplied by the user is source "manual".
 *          `card` (optional) is the name of the credit card the expense
 *          was charged to; empty/absent stores NULL. The monthly rollup
 *          ignores it entirely — rollups stay category-based.
 *          `myShare` (optional) is his portion of a shared expense, in
 *          dollars: when present it must be a finite number with
 *          0 <= myShare <= amount, else the request is a 400. Absent,
 *          null or "" stores NULL (the full amount is his). The monthly
 *          rollup sums COALESCE(my_share, amount), so actuals reflect
 *          his portion only; the amount itself is never changed.
 *          `bankTxId` (optional) links the expense to the Plaid bank
 *          transaction that paid it. Without one, an exact match (same
 *          date, name and amount) is linked automatically. If that bank
 *          transaction is already linked to an expense, nothing is
 *          inserted: the response is 200 { expense, duplicate: true }
 *          with the existing expense, so a re-import is a no-op.
 *          `pendingTxId` (optional, the app's "Count it now") counts a
 *          Plaid PENDING charge as an expense right away, tagged with the
 *          pending charge's id (one expense per pending charge).
 *          `pendingTransactionId` (optional, from the sync: Plaid's
 *          pending_transaction_id on a POSTED charge) settles the
 *          expense counted from that pending charge instead of adding a
 *          new one: its amount becomes the posted amount, and the reply
 *          is 200 { expense, duplicate: true, settled: true }. Until the
 *          sync sends it, a sync import on the same card with the same
 *          merchant name within 5 days settles the counted expense.
 *          `note` (optional) is the owner's own comment, up to 500
 *          characters.
 *   PUT    /api/expenses { id, patch } — update any field; a patch that
 *          includes category is a manual override (source "manual").
 *          patch.bankTxId links (or with null unlinks) a bank
 *          transaction; one already linked elsewhere is a 409 that
 *          names the other expense.
 *   DELETE /api/expenses?id=<id>  (or a JSON body { id })
 *
 * Sync tokens (the Plaid script) may GET and POST here; editing and
 * deleting stay device-only.
 *
 * After every create/update/delete, the affected month's actuals are
 * re-synced from the daily log (see syncDailyRollup in budget.js) so the
 * planned-vs-actual comparison always reflects the log, exactly once.
 */
import { ensureTables, listDailyExpenses, syncDailyRollup, requireAuth, readState } from "./budget.js";
import { isValidCategory } from "./_categories.js";
import { categorize } from "./categorize.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
}
function cleanDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function cleanAmount(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function cleanNote(v) {
  return typeof v === "string" ? v.trim().slice(0, 500) : "";
}
function cleanCard(v) {
  if (typeof v !== "string") return null;
  const name = v.trim().slice(0, 100);
  return name ? name : null;
}
/* myShare parser: absent/null/"" -> null (full amount is his); a present
   value must be a finite number, rounded to cents, within
   [0, amount] — anything else is { ok: false } and the caller 400s. */
function cleanMyShare(v, amount) {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return { ok: false };
  const rounded = Math.round(n * 100) / 100;
  if (rounded < 0 || rounded > amount) return { ok: false };
  return { ok: true, value: rounded };
}
function cleanTxId(v) {
  if (typeof v !== "string") return null;
  const id = v.trim().slice(0, 200);
  return id ? id : null;
}
/* Merchant name without digits or punctuation, as the review list compares names. */
function nameKey(v) {
  return String(v || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
}
/* The expense a posted charge should settle, or null: by Plaid's
   pending_transaction_id when the sync sends it; otherwise (sync imports
   only) an unsettled counted expense on the same card, with the same
   merchant name, dated within 5 days. */
async function counterpartToSettle(db, body, isSync, date, amount, description) {
  const fromId = cleanTxId(body.pendingTransactionId);
  if (fromId) {
    const row = await db.prepare("SELECT * FROM daily_expenses WHERE pending_tx_id = ?").bind(fromId).first();
    return row ? rowToExpense(row) : null;
  }
  const card = cleanCard(body.card);
  if (!isSync || !card) return null;
  const { results } = await db.prepare(
    "SELECT * FROM daily_expenses WHERE pending_tx_id IS NOT NULL AND pending_settled = 0 AND card_name = ? " +
    "AND ABS(julianday(date) - julianday(?)) <= 5 ORDER BY ABS(julianday(date) - julianday(?)), id"
  ).bind(card, date, date).all();
  const key = nameKey(description);
  const hit = (results || []).find((r) => key && nameKey(r.description) === key);
  return hit ? rowToExpense(hit) : null;
}
async function expenseForTx(db, txId) {
  const row = await db.prepare("SELECT * FROM daily_expenses WHERE bank_tx_id = ?").bind(txId).first();
  return row ? rowToExpense(row) : null;
}
function rowToExpense(r) {
  return {
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
  };
}
async function getExpense(db, id) {
  const row = await db.prepare("SELECT * FROM daily_expenses WHERE id = ?").bind(id).first();
  return row ? rowToExpense(row) : null;
}

export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    const url = new URL(context.request.url);
    const month = url.searchParams.get("month");
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      return json({ error: "month must be YYYY-MM" }, 400);
    }
    return json({ expenses: await listDailyExpenses(context.env.DB, month || undefined) });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    const db = context.env.DB;
    await ensureTables(db);
    const body = await context.request.json();
    const date = cleanDate(body.date);
    const amount = cleanAmount(body.amount);
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 300) : "";
    if (!date) return json({ error: "date must be YYYY-MM-DD" }, 400);
    if (amount === null) return json({ error: "amount must be a number" }, 400);
    if (!description) return json({ error: "description is required" }, 400);
    const share = cleanMyShare(body.myShare, amount);
    if (!share.ok) return json({ error: "myShare must be a number between 0 and the amount" }, 400);

    let category, source;
    if (typeof body.category === "string" && isValidCategory(body.category)) {
      category = body.category; source = "manual";
    } else {
      const result = await categorize(context.env, description, amount);
      category = result.category; source = result.source;
    }
    /* A posted charge for an expense already counted from its pending
       charge: update that expense, never add a second one. */
    const counted = await counterpartToSettle(db, body, auth.session && auth.session.kind === "sync", date, amount, description);
    if (counted) {
      const postedTx = cleanTxId(body.bankTxId);
      const share = counted.myShare === null || counted.myShare === undefined ? null : Math.min(counted.myShare, amount);
      const takeId = postedTx && !(await expenseForTx(db, postedTx)) ? postedTx : counted.bankTxId;
      await db.prepare(
        "UPDATE daily_expenses SET amount = ?, my_share = ?, bank_tx_id = ?, pending_settled = 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(amount, share, takeId || null, counted.id).run();
      const state = await syncDailyRollup(db, counted.date.slice(0, 7));
      return json({ expense: await getExpense(db, counted.id), duplicate: true, settled: true, state });
    }
    const pendingTxId = cleanTxId(body.pendingTxId);
    if (pendingTxId) {
      const row = await db.prepare("SELECT * FROM daily_expenses WHERE pending_tx_id = ?").bind(pendingTxId).first();
      if (row) return json({ expense: rowToExpense(row), duplicate: true, state: await readState(db) });
    }
    let bankTxId = cleanTxId(body.bankTxId);
    if (!bankTxId) {
      const match = await db.prepare(
        "SELECT plaid_transaction_id AS id FROM bank_transactions WHERE date = ? AND name = ? AND amount_cents = ?"
      ).bind(date, description, Math.round(amount * 100)).first();
      if (match) bankTxId = match.id;
    }
    if (bankTxId) {
      const linked = await expenseForTx(db, bankTxId);
      if (linked) return json({ expense: linked, duplicate: true, state: await readState(db) });
    }
    const info = await db.prepare(
      "INSERT INTO daily_expenses (date, description, amount, category, categorization_source, card_name, my_share, bank_tx_id, pending_tx_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(date, description, amount, category, source, cleanCard(body.card), share.value, bankTxId, pendingTxId, cleanNote(body.note) || null).run();
    const expense = await getExpense(db, info.meta.last_row_id);
    const state = await syncDailyRollup(db, date.slice(0, 7));
    return json({ expense, state }, 201);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}

export async function onRequestPut(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const db = context.env.DB;
    await ensureTables(db);
    const body = await context.request.json();
    const id = parseInt(body && body.id, 10);
    if (!Number.isFinite(id) || !body.patch || typeof body.patch !== "object") {
      return json({ error: "PUT expects { id, patch }" }, 400);
    }
    const existing = await getExpense(db, id);
    if (!existing) return json({ error: "expense not found" }, 404);
    const patch = body.patch;
    const next = { ...existing };
    if (patch.date !== undefined) {
      const d = cleanDate(patch.date);
      if (!d) return json({ error: "date must be YYYY-MM-DD" }, 400);
      next.date = d;
    }
    if (patch.description !== undefined) next.description = String(patch.description).trim().slice(0, 300);
    if (patch.amount !== undefined) {
      const a = cleanAmount(patch.amount);
      if (a === null) return json({ error: "amount must be a number" }, 400);
      next.amount = a;
    }
    if (patch.category !== undefined) {
      if (!isValidCategory(patch.category)) return json({ error: "unknown category" }, 400);
      next.category = patch.category;
      next.categorizationSource = "manual"; /* a category patch is a manual override */
    }
    if (patch.card !== undefined) next.card = cleanCard(patch.card);
    if (patch.note !== undefined) next.note = cleanNote(patch.note);
    if (patch.bankTxId !== undefined) {
      next.bankTxId = cleanTxId(patch.bankTxId);
      if (next.bankTxId) {
        const other = await expenseForTx(db, next.bankTxId);
        if (other && other.id !== id) {
          return json({ error: "That bank transaction is already linked to another expense.", conflict: other }, 409);
        }
      }
    }
    /* "Keep" on a counted charge that never posted: treat it as final. */
    if (patch.pendingSettled === true) next.pendingSettled = true;
    if (patch.myShare !== undefined) {
      const share = cleanMyShare(patch.myShare, next.amount);
      if (!share.ok) return json({ error: "myShare must be a number between 0 and the amount" }, 400);
      next.myShare = share.value;
    } else if (next.myShare !== null && next.myShare !== undefined && next.myShare > next.amount) {
      /* An amount-only edit dropped the total below the stored share:
         clamp the share to the new amount (share == amount is the full
         amount anyway) rather than leaving an impossible state. */
      next.myShare = next.amount;
    }
    await db.prepare(
      "UPDATE daily_expenses SET date = ?, description = ?, amount = ?, category = ?, categorization_source = ?, card_name = ?, my_share = ?, bank_tx_id = ?, pending_settled = ?, note = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(next.date, next.description, next.amount, next.category, next.categorizationSource, next.card, next.myShare === undefined ? null : next.myShare, next.bankTxId || null, next.pendingSettled ? 1 : 0, next.note || null, id).run();
    const expense = await getExpense(db, id);
    /* The month may have changed — re-sync both. */
    await syncDailyRollup(db, existing.date.slice(0, 7));
    const state = await syncDailyRollup(db, next.date.slice(0, 7));
    return json({ expense, state });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
export const onRequestPatch = onRequestPut;

export async function onRequestDelete(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const db = context.env.DB;
    await ensureTables(db);
    const url = new URL(context.request.url);
    let id = parseInt(url.searchParams.get("id"), 10);
    if (!Number.isFinite(id)) {
      try {
        const body = await context.request.json();
        id = parseInt(body && body.id, 10);
      } catch (e) { /* no body */ }
    }
    if (!Number.isFinite(id)) return json({ error: "DELETE expects ?id=<id> or { id }" }, 400);
    const existing = await getExpense(db, id);
    if (!existing) return json({ error: "expense not found" }, 404);
    await db.prepare("DELETE FROM daily_expenses WHERE id = ?").bind(id).run();
    /* Re-sync the month; if that was its last expense the rollup clears
       the month's rolled-up actuals (see syncDailyRollup). */
    const state = await syncDailyRollup(db, existing.date.slice(0, 7));
    return json({ deleted: id, state });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
