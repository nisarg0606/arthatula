/*
 * Arthatula — newest manual sync request (see ../sync-requests.js
 * for the queue design).
 *
 * Routes (this file serves /api/sync-requests/latest):
 *   GET /api/sync-requests/latest -> { request }
 *        Device sessions only. request is the newest sync request
 *        { id, status, requestedAt, finishedAt, result } — result is
 *        the parsed run summary once the request has finished — or
 *        null when no sync has ever been requested. The Daily tab
 *        polls this while a request is active and reads it once on
 *        load to resume an in-flight request's state.
 */
import { ensureTables, getLatestSyncRequest, requireAuth } from "../budget.js";

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
       the automation writes outcomes via complete, it never reads
       the latest-request view. */
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    await ensureTables(context.env.DB);
    return json({ request: await getLatestSyncRequest(context.env.DB) });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
