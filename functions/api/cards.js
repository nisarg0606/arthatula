/*
 * Arthatula — credit cards endpoint.
 *
 * Routes (this file serves /api/cards):
 *   GET    /api/cards -> { cards: [...] }
 *   POST   /api/cards { name, statementStart, statementEnd, dueDate? }
 *          -> 201 { card, cards }
 *   PUT    /api/cards { id, patch: { name?, statementStart?,
 *          statementEnd?, dueDate? } } -> { card, cards }
 *   DELETE /api/cards?id=<id>  (or a JSON body { id }) -> { cards }
 *
 * Each card stores one statement cycle (start/end, both inclusive) plus
 * an optional bill due date, because a card bill is due in a later
 * month/paycheck than the spending. The frontend groups the card's
 * daily expenses (daily_expenses.card_name = card name) inside the
 * statement window to estimate that cycle's statement balance.
 * Sync tokens (the Plaid script's Monday statement roll-forward) may
 * GET and PUT; creating and deleting cards stay device-only.
 * All storage logic lives in ./budget.js.
 */
import { ensureTables, listCards, createCard, updateCard, deleteCard, requireAuth } from "./budget.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
}

export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    await ensureTables(context.env.DB);
    return json({ cards: await listCards(context.env.DB) });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const db = context.env.DB;
    const body = await context.request.json();
    const card = await createCard(db, body || {});
    return json({ card, cards: await listCards(db) }, 201);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}

export async function onRequestPut(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    const db = context.env.DB;
    const body = await context.request.json();
    const id = parseInt(body && body.id, 10);
    if (!Number.isFinite(id) || !body.patch || typeof body.patch !== "object") {
      return json({ error: "PUT expects { id, patch }" }, 400);
    }
    const card = await updateCard(db, id, body.patch);
    if (!card) return json({ error: "card not found" }, 404);
    return json({ card, cards: await listCards(db) });
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
    const removed = await deleteCard(db, id);
    if (!removed) return json({ error: "card not found" }, 404);
    return json({ deleted: id, cards: await listCards(db) });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
