/*
 * Arthatula — pending charges snapshot endpoint.
 *
 * Routes (this file serves /api/pending):
 *   GET  /api/pending -> { transactions: [...], syncedAt }
 *        Device sessions only. Transactions are newest-first, capped
 *        at 200. Amounts are positive spend dollars.
 *   POST /api/pending -> { ok: true, transactions: n }
 *        SYNC sessions only (the paired Plaid automation): body
 *        { transactions: [...], syncedAt } REPLACES the stored set —
 *        it is the charges Plaid reports as pending right now, so a
 *        charge that posts (or a hold that vanishes) drops out on the
 *        next push. Device sessions are refused with 403.
 *
 * Display only: pending charges are never expenses and never touch
 * the rollup or any balance; when one posts, the normal expense
 * import adds it. All storage logic lives in ./budget.js.
 */
import { ensureTables, getPendingSnapshot, replacePendingData, requireAuth } from "./budget.js";

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
    /* No allowSync: sync sessions are refused (403) by requireAuth —
       the automation writes the snapshot, it never reads it back. */
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    await ensureTables(context.env.DB);
    return json(await getPendingSnapshot(context.env.DB));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  try {
    /* allowSync lets the guard resolve a sync session; the kind check
       right after keeps the route sync-ONLY (same pattern as bank). */
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    if (!auth.session || auth.session.kind !== "sync") {
      return json({ error: "Only the paired sync automation can write pending data." }, 403);
    }
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return json({ error: "POST expects a JSON body: { transactions, syncedAt }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "POST expects { transactions, syncedAt }" }, 400);
    }
    const counts = await replacePendingData(context.env.DB, body);
    return json({ ok: true, transactions: counts.transactions });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
