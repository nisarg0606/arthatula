/*
 * v2 savings goals (serves /api/v2/goals).
 *   GET -> { goals: [{ ...goal, progress }] }
 *        progress: saved so far (the linked account's balance, or the
 *        amount you keep updating by hand), what's left, and how much a
 *        month it takes to hit the target by its date.
 *   POST { name, targetCents, targetDate?, accountId?, savedCents? } -> 201 { goals }
 *   PATCH { id, patch } -> { goals }
 *   DELETE ?id=… -> { goals }
 */
import { handleV2, HttpError, cleanStr, cleanCents, cleanDate, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { loadAccounts, rowToGoal } from "../_v2store.js";
import { goalProgress, monthOf } from "../../../js/core/v2/money.js";

async function view(s) {
  const accounts = await loadAccounts(s);
  const bal = {};
  accounts.forEach((a) => { bal[a.id] = a.balanceCents; });
  const thisMonth = monthOf(new Date().toISOString());
  const rows = (await s.all("SELECT * FROM goals WHERE owner_id = ?1 ORDER BY archived, target_date IS NULL, target_date, name")).map(rowToGoal);
  return { goals: rows.map((g) => Object.assign(g, { progress: goalProgress(g, g.accountId ? bal[g.accountId] : null, thisMonth) })) };
}
async function checkAccount(s, id) {
  if (!id) return null;
  if (!(await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", String(id)))) throw new HttpError(400, "Unknown account.");
  return String(id);
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => view(s));

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const name = cleanStr(b.name, 100);
  if (!name) throw new HttpError(400, "name is required.");
  await s.run(
    "INSERT INTO goals (id, owner_id, name, target_cents, target_date, account_id, saved_cents) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)",
    newId("gol_"), name, cleanCents(b.targetCents, "targetCents", { min: 1 }), cleanDate(b.targetDate, "targetDate", true),
    await checkAccount(s, b.accountId), cleanCents(b.savedCents || 0, "savedCents", { min: 0 })
  );
  return new Response(JSON.stringify(await view(s)), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
});

export const onRequestPatch = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const row = await s.first("SELECT * FROM goals WHERE owner_id = ?1 AND id = ?2", String(b.id || ""));
  if (!row) throw new HttpError(404, "Goal not found.");
  const p = b.patch || {};
  const name = p.name !== undefined ? cleanStr(p.name, 100) : row.name;
  if (!name) throw new HttpError(400, "name can't be empty.");
  await s.run(
    "UPDATE goals SET name = ?3, target_cents = ?4, target_date = ?5, account_id = ?6, saved_cents = ?7, archived = ?8 WHERE owner_id = ?1 AND id = ?2",
    row.id, name,
    p.targetCents !== undefined ? cleanCents(p.targetCents, "targetCents", { min: 1 }) : row.target_cents,
    p.targetDate !== undefined ? cleanDate(p.targetDate, "targetDate", true) : row.target_date,
    p.accountId !== undefined ? await checkAccount(s, p.accountId) : row.account_id,
    p.savedCents !== undefined ? cleanCents(p.savedCents, "savedCents", { min: 0 }) : row.saved_cents,
    p.archived !== undefined ? (p.archived ? 1 : 0) : row.archived
  );
  return view(s);
}, { skipMirror: true });

export const onRequestDelete = (context) => handleV2(context, async ({ s, url }) => {
  await s.run("DELETE FROM goals WHERE owner_id = ?1 AND id = ?2", String(url.searchParams.get("id") || ""));
  return view(s);
}, { skipMirror: true });
