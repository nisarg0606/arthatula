/*
 * Arthatula — claim a queued manual sync request (see
 * ../sync-requests.js for the queue design).
 *
 * Routes (this file serves /api/sync-requests/claim):
 *   GET /api/sync-requests/claim -> { request }
 *        SYNC sessions only (the paired Plaid automation's VM poller):
 *        atomically claims the oldest pending request — it comes back
 *        with status "running" — or answers { request: null } when
 *        the queue is empty. Device sessions are refused with 403.
 *        Claiming is the poller's 30-second heartbeat, so an empty
 *        answer is the normal case, not an error.
 */
import { ensureTables, claimSyncRequest, requireAuth } from "../budget.js";

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
    /* allowSync lets the guard resolve a sync session; the kind check
       right after keeps the route sync-ONLY (same pattern as bank). */
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    if (!auth.session || auth.session.kind !== "sync") {
      return json({ error: "Only the paired sync automation can claim sync requests." }, 403);
    }
    await ensureTables(context.env.DB);
    return json({ request: await claimSyncRequest(context.env.DB) });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
