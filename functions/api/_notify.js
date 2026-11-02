/*
 * Notifications: the rows behind the bell in the app header, each also
 * sent to Telegram when a bot is connected (Settings → Notifications).
 * Written by the server wherever news lands — a sync import, a new
 * pending charge, a pairing request, a failed sync — so the app only
 * has to poll /api/notifications to stay current. (Files starting with
 * "_" are not Pages routes.)
 *
 * notify() never throws: a notification must not fail the write that
 * caused it. The Telegram bot token and chat id live in budget_settings
 * like the other keys, and never go back to the browser.
 */
export const KEEP = 200; /* older rows are dropped */

async function ensure(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, " +
    "title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT)"
  ).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS budget_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
}
async function getSetting(db, key) {
  const row = await db.prepare("SELECT value FROM budget_settings WHERE key = ?").bind(key).first();
  return row ? row.value : "";
}
async function setSetting(db, key, value) {
  await db.prepare(
    "INSERT INTO budget_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, String(value)).run();
}

export function usd(n) {
  return (n < 0 ? "-$" : "$") + Math.abs(Number(n) || 0).toFixed(2);
}

/* kind: "transaction" | "pending" | "pairing" | "sync" — the app uses it
   to refresh the right data when the row arrives. */
export async function notify(db, kind, title, body) {
  try {
    await ensure(db);
    title = String(title || "").slice(0, 200);
    body = String(body || "").slice(0, 1000);
    await db.prepare("INSERT INTO notifications (kind, title, body) VALUES (?, ?, ?)").bind(kind, title, body).run();
    await db.prepare("DELETE FROM notifications WHERE id <= (SELECT MAX(id) FROM notifications) - ?").bind(KEEP).run();
    const token = await getSetting(db, "telegram_bot_token"), chat = await getSetting(db, "telegram_chat_id");
    if (token && chat) await telegram(token, "sendMessage", { chat_id: chat, text: body ? title + "\n" + body : title });
  } catch (e) { /* best-effort */ }
}

async function telegram(token, method, payload) {
  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || "Telegram answered " + res.status);
  return data.result;
}

export async function listNotifications(db, afterId) {
  await ensure(db);
  const after = Number(afterId) || 0;
  const { results } = await db.prepare(
    "SELECT * FROM notifications WHERE id > ? ORDER BY id DESC LIMIT 50"
  ).bind(after).all();
  const unread = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").first();
  return {
    notifications: (results || []).map((r) => ({
      id: r.id, kind: r.kind, title: r.title, body: r.body, createdAt: r.created_at, read: !!r.read_at
    })),
    unread: unread ? Number(unread.n) : 0,
    telegram: await telegramStatus(db)
  };
}

export async function markAllRead(db) {
  await ensure(db);
  await db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL").run();
}

async function telegramStatus(db) {
  return { connected: !!(await getSetting(db, "telegram_chat_id")), bot: await getSetting(db, "telegram_bot_username") };
}

/* Connect a bot: check the token, then take the chat from the newest
   message sent to the bot (the owner sends it /start first). Without
   one yet, the token is kept and { needsStart } tells the app to ask
   for that message and try again. */
export async function connectTelegram(db, botToken) {
  await ensure(db);
  const token = String(botToken || "").trim() || await getSetting(db, "telegram_bot_token");
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("That doesn't look like a bot token (it's like 123456:ABC-...).");
  const me = await telegram(token, "getMe");
  await setSetting(db, "telegram_bot_token", token);
  await setSetting(db, "telegram_bot_username", me.username || "");
  const updates = await telegram(token, "getUpdates", { allowed_updates: ["message"] });
  const msg = (updates || []).map((u) => u.message).filter((m) => m && m.chat).pop();
  if (!msg) {
    await setSetting(db, "telegram_chat_id", "");
    return { connected: false, needsStart: true, bot: me.username || "" };
  }
  await setSetting(db, "telegram_chat_id", String(msg.chat.id));
  await telegram(token, "sendMessage", { chat_id: msg.chat.id, text: "Arthatula is connected. Charges and sync news will show up here." });
  return { connected: true, bot: me.username || "" };
}

export async function disconnectTelegram(db) {
  await ensure(db);
  for (const k of ["telegram_bot_token", "telegram_bot_username", "telegram_chat_id"]) await setSetting(db, k, "");
}
