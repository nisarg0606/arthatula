/*
 * Arthatula — manual sync requests (the Daily tab "Sync now"
 * button). The app cannot pull Plaid itself, so syncing on demand is
 * a queue: this route records the request, the VM poller claims it
 * (./sync-requests/claim.js), runs the real Plaid sync engine, and
 * completes it (./sync-requests/[id]/complete.js). The page polls
 * ./sync-requests/latest.js for the outcome. Storage logic lives in
 * ./budget.js.
 *
 * Routes (this file serves /api/sync-requests):
 *   POST /api/sync-requests -> { id, status }
 *        Device sessions only (sync sessions are refused with 403 —
 *        the automation answers requests, it never files them). If a
 *        pending or running request younger than 10 minutes already
 *        exists it is returned as-is (200) instead of inserting a
 *        duplicate; a fresh request answers 201.
 */
import { ensureTables, requestSync, requireAuth } from "./budget.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  try {
    /* No allowSync: sync sessions are refused (403) by requireAuth. */
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    await ensureTables(context.env.DB);
    const { request, created } = await requestSync(context.env.DB);
    return json({ id: request.id, status: request.status }, created ? 201 : 200);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
