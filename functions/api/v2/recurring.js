/*
 * v2 recurring bills and income (serves /api/v2/recurring).
 *   GET -> { items, suggestions, cardBills, upcoming }
 *        items: saved recurring entries (confirmed or added by hand);
 *        suggestions: repeating merchants found in your transactions
 *        that you haven't confirmed or dismissed yet; cardBills: each
 *        credit card's next due date; upcoming: the next 30 days of all
 *        of them.
 *   POST { action: "confirm", detectKey } -> saves a suggestion
 *   POST { action: "dismiss", detectKey } -> hides a suggestion for good
 *   POST { name, amountCents, cadence, nextDate, categoryId?, accountId? } -> adds one by hand
 *        amountCents is signed (a bill is negative, income positive).
 *   PATCH { id, patch: { name?, amountCents?, cadence?, nextDate?, categoryId?, status? } }
 *   DELETE ?id=…
 */
import { handleV2, HttpError, cleanStr, cleanCents, cleanDate, oneOf, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { loadTransactions, loadAccounts, rowToRecurring } from "../_v2store.js";
import { detectRecurring, upcoming, addDays, CADENCES, monthOf } from "../../../js/core/v2/money.js";

function today() { return new Date().toISOString().slice(0, 10); }

/* Saved items, fresh suggestions and card due dates, shared with the
   dashboard summary. */
export async function recurringItems(s, txs, accounts) {
  const saved = (await s.all("SELECT * FROM recurring WHERE owner_id = ?1 ORDER BY next_date, name")).map(rowToRecurring);
  const known = new Set(saved.filter((r) => r.detectKey).map((r) => r.detectKey));
  const t = today();
  const suggestions = detectRecurring(txs.filter((x) => !x.hidden), t).filter((d) => !known.has(d.key));
  const cardBills = accounts.filter((a) => a.type === "credit" && a.dueDate && !a.hidden).map((a) => {
    let next = a.dueDate, guard = 0;
    /* A due date in the past rolls forward a month at a time. */
    while (next < t && guard++ < 24) {
      const d = new Date(next + "T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + 1);
      next = d.toISOString().slice(0, 10);
    }
    return { id: "card:" + a.id, name: a.name + " bill", merchant: a.name, cadence: "monthly", nextDate: next, amountCents: null, accountId: a.id, status: "active" };
  });
  return { items: saved.filter((r) => r.status !== "dismissed"), dismissed: saved.filter((r) => r.status === "dismissed"), suggestions, cardBills };
}

async function view(s) {
  const txs = await loadTransactions(s);
  const accounts = await loadAccounts(s);
  const r = await recurringItems(s, txs, accounts);
  return {
    items: r.items, suggestions: r.suggestions, cardBills: r.cardBills,
    upcoming: upcoming(r.items.concat(r.cardBills), today(), addDays(today(), 30))
  };
}

async function getItem(s, id) {
  const r = await s.first("SELECT * FROM recurring WHERE owner_id = ?1 AND id = ?2", String(id || ""));
  if (!r) throw new HttpError(404, "Recurring item not found.");
  return r;
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => view(s));

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  if (b.action === "confirm" || b.action === "dismiss") {
    const key = String(b.detectKey || "");
    const txs = await loadTransactions(s);
    const hit = detectRecurring(txs.filter((x) => !x.hidden), today()).find((d) => d.key === key);
    if (!hit) throw new HttpError(404, "That suggestion is no longer there.");
    await s.run(
      "INSERT INTO recurring (id, owner_id, detect_key, name, merchant, category_id, account_id, amount_cents, cadence, next_date, source, status) " +
      "VALUES (?2, ?1, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, 'detected', ?10) ON CONFLICT(owner_id, detect_key) WHERE detect_key IS NOT NULL DO UPDATE SET status = excluded.status",
      newId("rec_"), key, String(hit.merchant).slice(0, 120), hit.categoryId, hit.accountId, hit.amountCents, hit.cadence, hit.nextDate,
      b.action === "confirm" ? "active" : "dismissed"
    );
    return view(s);
  }
  const name = cleanStr(b.name, 120);
  if (!name) throw new HttpError(400, "name is required.");
  const amount = cleanCents(b.amountCents, "amountCents");
  const cadence = oneOf(b.cadence || "monthly", CADENCES, "cadence");
  const next = cleanDate(b.nextDate, "nextDate");
  if (b.categoryId && !(await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND id = ?2", String(b.categoryId)))) throw new HttpError(400, "Unknown category.");
  await s.run(
    "INSERT INTO recurring (id, owner_id, name, merchant, category_id, account_id, amount_cents, cadence, next_date, source) VALUES (?2, ?1, ?3, ?3, ?4, ?5, ?6, ?7, ?8, 'manual')",
    newId("rec_"), name, b.categoryId || null, b.accountId || null, amount, cadence, next
  );
  return new Response(JSON.stringify(await view(s)), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
});

export const onRequestPatch = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const row = await getItem(s, b.id);
  const p = b.patch || {};
  const name = p.name !== undefined ? cleanStr(p.name, 120) : row.name;
  if (!name) throw new HttpError(400, "name can't be empty.");
  await s.run(
    "UPDATE recurring SET name = ?3, amount_cents = ?4, cadence = ?5, next_date = ?6, category_id = ?7, status = ?8 WHERE owner_id = ?1 AND id = ?2",
    row.id, name,
    p.amountCents !== undefined ? cleanCents(p.amountCents, "amountCents") : row.amount_cents,
    p.cadence !== undefined ? oneOf(p.cadence, CADENCES, "cadence") : row.cadence,
    p.nextDate !== undefined ? cleanDate(p.nextDate, "nextDate") : row.next_date,
    p.categoryId !== undefined ? (p.categoryId || null) : row.category_id,
    p.status !== undefined ? oneOf(p.status, ["active", "dismissed"], "status") : row.status
  );
  return view(s);
});

export const onRequestDelete = (context) => handleV2(context, async ({ s, url }) => {
  const row = await getItem(s, url.searchParams.get("id"));
  await s.run("DELETE FROM recurring WHERE owner_id = ?1 AND id = ?2", row.id);
  return view(s);
});

export { monthOf };
