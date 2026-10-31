/*
 * Arthatula — complete a claimed manual sync request (see
 * ../../sync-requests.js for the queue design).
 *
 * Routes (this file serves /api/sync-requests/:id/complete):
 *   POST /api/sync-requests/:id/complete -> { ok: true, request }
 *        SYNC sessions only (the paired Plaid automation's VM poller):
 *        body { status: "done" | "failed", result: {...} } finishes
 *        the request the poller claimed — the result (the sync
 *        engine's run summary) is stored as JSON and shown by the
 *        Daily tab. Only a request still in "running" can complete:
 *        an unknown, unclaimed or already-finished id answers 404,
 *        so a late completion for an expired request changes nothing.
 *        Device sessions are refused with 403.
 */
import { ensureTables, completeSyncRequest, requireAuth } from "../../budget.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
}
function requestId(context) {
  if (context.params && context.params.id) return String(context.params.id);
  const parts = new URL(context.request.url).pathname.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  try {
    /* allowSync lets the guard resolve a sync session; the kind check
       right after keeps the route sync-ONLY (same pattern as bank). */
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    if (!auth.session || auth.session.kind !== "sync") {
      return json({ error: "Only the paired sync automation can complete sync requests." }, 403);
    }
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return json({ error: "POST expects a JSON body: { status, result }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        (body.status !== "done" && body.status !== "failed")) {
      return json({ error: "POST expects { status: \"done\" | \"failed\", result: {...} }" }, 400);
    }
    await ensureTables(context.env.DB);
    const updated = await completeSyncRequest(context.env.DB, requestId(context), body.status, body.result);
    if (!updated) return json({ error: "No running sync request with that id." }, 404);
    return json({ ok: true, request: updated });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
