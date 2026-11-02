/*
 * Arthatula — notifications (serves /api/notifications).
 *
 *   GET  /api/notifications[?after=<id>]
 *        -> { notifications: [{ id, kind, title, body, createdAt, read }],
 *             unread, telegram: { connected, bot } }
 *        Newest first, at most 50; `after` returns only rows newer than
 *        that id (what the app's poll asks for).
 *   POST { action: "read" }                      -> marks every row read
 *   POST { action: "telegram", botToken? }       -> connect a bot (see _notify.js)
 *   POST { action: "telegram-test" }             -> sends a test notification
 *   POST { action: "telegram-off" }              -> forgets the bot
 *
 * Device sessions only: the sync automation writes notifications as a
 * side effect of its own routes and never reads them.
 */
import { requireAuth } from "./budget.js";
import { listNotifications, markAllRead, connectTelegram, disconnectTelegram, notify } from "./_notify.js";

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
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    return json(await listNotifications(context.env.DB, new URL(context.request.url).searchParams.get("after")));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  try {
    const auth = await requireAuth(db, context.request);
    if (auth.response) return auth.response;
    const body = await context.request.json().catch(() => ({}));
    const action = body && body.action;
    if (action === "read") { await markAllRead(db); return json({ ok: true }); }
    if (action === "telegram") return json(await connectTelegram(db, body.botToken));
    if (action === "telegram-off") { await disconnectTelegram(db); return json({ ok: true }); }
    if (action === "telegram-test") {
      await notify(db, "test", "Test notification", "If you can read this, notifications work.");
      return json({ ok: true });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
