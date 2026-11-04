/*
 * Arthatula — sync failure alerts endpoint (Phase 2 failure alerting).
 *
 * Routes (this file serves /api/sync-alerts):
 *   POST /api/sync-alerts -> { sent: true } | { deduped: true }
 *        SYNC sessions only (the paired Plaid automation). Body:
 *          { signature, title, body, recovered?, clears? }
 *        The sync engine calls this when a run's failure signature set
 *        changes — a new push/import failure, or a clean run after
 *        failures (recovered: true, clears: [signatures that healed]).
 *        The alert lands in the bell and on Telegram via notify()
 *        (kind "sync"), so a failure on the VM is visible in the app
 *        itself, not just in the VM's logs.
 *
 *        Dedupe is server-side, keyed by signature: the last-sent
 *        timestamp per signature lives in budget_settings under
 *        "sync_alert:<signature>". A repeat of the same signature
 *        within DEDUPE_WINDOW_MS answers { deduped: true } without
 *        notifying again; a recovery always sends and deletes the
 *        cleared signatures' stamps. The dedupe store is best-effort:
 *        if reading or writing it hiccups, the route degrades to
 *        sending the notification rather than failing the alert.
 */
import { ensureTables, requireAuth } from "./budget.js";
import { notify } from "./_notify.js";

const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; /* 6 hours */
const KEY_PREFIX = "sync_alert:";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
}

/* budget_settings helpers, same shape as _notify.js (the table is
   shared; notify() keeps its own copy for the Telegram settings). */
async function ensureSettings(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS budget_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
}
async function getStamp(db, key) {
  const row = await db.prepare("SELECT value FROM budget_settings WHERE key = ?").bind(key).first();
  return row ? row.value : "";
}
async function setStamp(db, key, value) {
  await db.prepare(
    "INSERT INTO budget_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, String(value)).run();
}
async function deleteStamp(db, key) {
  await db.prepare("DELETE FROM budget_settings WHERE key = ?").bind(key).run();
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  try {
    /* allowSync lets the guard resolve a sync session; the kind check
       right after keeps the route sync-ONLY (same pattern as bank /
       pending). Unauthenticated -> 401 from requireAuth; a device or
       mcp session -> 403 here. */
    const auth = await requireAuth(db, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    if (!auth.session || auth.session.kind !== "sync") {
      return json({ error: "Only the paired sync automation can post sync alerts." }, 403);
    }
    await ensureTables(db);

    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return json({ error: "POST expects a JSON body: { signature, title, body, recovered?, clears? }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "POST expects { signature, title, body, recovered?, clears? }" }, 400);
    }
    const signature = typeof body.signature === "string" ? body.signature.trim().slice(0, 500) : "";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    const text = body.body === undefined || body.body === null ? "" : (typeof body.body === "string" ? body.body.slice(0, 1000) : null);
    if (!signature || !title || text === null) {
      return json({ error: "signature and title are required strings; body must be a string." }, 400);
    }
    if (body.recovered !== undefined && typeof body.recovered !== "boolean") {
      return json({ error: "recovered must be a boolean." }, 400);
    }
    if (body.clears !== undefined && (!Array.isArray(body.clears) || body.clears.some((c) => typeof c !== "string"))) {
      return json({ error: "clears must be a list of signature strings." }, 400);
    }
    const recovered = body.recovered === true;
    const clears = [...new Set([signature, ...(body.clears || []).map((c) => c.trim().slice(0, 500)).filter(Boolean)])];

    if (recovered) {
      /* A recovery always sends; the healed signatures' dedupe stamps
         are deleted so a future failure with the same signature alerts
         immediately instead of hiding inside the window. Stamp
         cleanup is best-effort — the notification matters more. */
      try {
        await ensureSettings(db);
        for (const sig of clears) await deleteStamp(db, KEY_PREFIX + sig);
      } catch (e) { /* best-effort */ }
      await notify(db, "sync", title, text);
      return json({ sent: true });
    }

    /* Dedupe: same signature alerted within the window -> stay quiet.
       Any store trouble degrades to sending (an alert duplicated
       beats an alert lost). */
    let deduped = false;
    try {
      await ensureSettings(db);
      const last = Number(await getStamp(db, KEY_PREFIX + signature));
      if (Number.isFinite(last) && last > 0 && Date.now() - last < DEDUPE_WINDOW_MS) deduped = true;
    } catch (e) { /* degrade to sending */ }
    if (deduped) return json({ deduped: true });

    await notify(db, "sync", title, text);
    try {
      await ensureSettings(db);
      await setStamp(db, KEY_PREFIX + signature, String(Date.now()));
    } catch (e) { /* best-effort */ }
    return json({ sent: true });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
