/*
 * Arthatula — app settings (the Gemini configuration + the Splitwise
 * connection).
 *
 * Routes (this file serves /api/settings):
 *   GET /api/settings -> { gemini: { hasKey, last4, model, source },
 *                          splitwise: { hasKey, last4, source } }
 *     Full API keys are NEVER returned — only whether one is saved and
 *     at most its last 4 characters.
 *   PUT /api/settings { geminiApiKey?, geminiModel?, clearGeminiKey?,
 *                       splitwiseApiKey?, clearSplitwiseKey? }
 *     Saves keys server-side in the D1 budget_settings table, where
 *     only the server Functions can read them. A key supplied via an
 *     environment secret (GEMINI_API_KEY / SPLITWISE_API_KEY) always
 *     takes precedence and is reported as source: "env" (it cannot be
 *     cleared from the UI).
 */
import { ensureTables, requireAuth } from "./budget.js";
import { DEFAULT_GEMINI_MODEL } from "./categorize.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Settings are stored server-side in D1 (see README)." }, 503);
}
async function getSetting(db, key) {
  const row = await db.prepare("SELECT value FROM budget_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}
async function setSetting(db, key, value) {
  await db.prepare(
    "INSERT INTO budget_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, String(value)).run();
}

/* The Splitwise personal API key (Settings-saved or the
   SPLITWISE_API_KEY env secret), or null when Splitwise is not
   connected. Server-side only — the v2 Splitwise route reads it from
   here; it is never sent to the browser. */
export async function getSplitwiseApiKey(env) {
  if (env.SPLITWISE_API_KEY) return env.SPLITWISE_API_KEY;
  await ensureTables(env.DB);
  const saved = await getSetting(env.DB, "splitwise_api_key");
  return saved || null;
}

/* The Splitwise snapshot cache lives in budget_settings too, so the
   v2 route never touches the database outside its scoped helper —
   it goes through these two functions instead. */
export async function getSplitwiseCache(db) {
  const body = await getSetting(db, "splitwise_cache");
  const at = await getSetting(db, "splitwise_cache_at");
  if (!body) return null;
  try { return { payload: JSON.parse(body), at: Number(at) || 0 }; }
  catch (e) { return null; }
}

export async function setSplitwiseCache(db, payload) {
  await setSetting(db, "splitwise_cache", JSON.stringify(payload));
  await setSetting(db, "splitwise_cache_at", String(Date.now()));
}

export async function describeSettings(env) {
  await ensureTables(env.DB);
  const envKey = env.GEMINI_API_KEY || null;
  const savedKey = await getSetting(env.DB, "gemini_api_key");
  const savedModel = await getSetting(env.DB, "gemini_model");
  const effectiveKey = envKey || savedKey;
  const swEnvKey = env.SPLITWISE_API_KEY || null;
  const swSavedKey = await getSetting(env.DB, "splitwise_api_key");
  const swKey = swEnvKey || swSavedKey;
  return {
    gemini: {
      hasKey: !!effectiveKey,
      last4: effectiveKey ? effectiveKey.slice(-4) : null,
      model: env.GEMINI_MODEL || savedModel || DEFAULT_GEMINI_MODEL,
      /* where the model comes from: "env", "saved" (Settings) or "default" */
      modelSource: env.GEMINI_MODEL ? "env" : savedModel ? "saved" : "default",
      defaultModel: DEFAULT_GEMINI_MODEL,
      source: envKey ? "env" : savedKey ? "saved" : null
    },
    splitwise: {
      hasKey: !!swKey,
      last4: swKey ? swKey.slice(-4) : null,
      source: swEnvKey ? "env" : swSavedKey ? "saved" : null
    }
  };
}

export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    return json(await describeSettings(context.env));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPut(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const body = await context.request.json();
    await ensureTables(context.env.DB);
    if (body.clearGeminiKey === true) {
      await setSetting(context.env.DB, "gemini_api_key", "");
    } else if (typeof body.geminiApiKey === "string" && body.geminiApiKey.trim()) {
      await setSetting(context.env.DB, "gemini_api_key", body.geminiApiKey.trim());
    }
    /* A model name saves it; an empty one removes the saved model, so
       the code's default applies again. */
    if (typeof body.geminiModel === "string") {
      await setSetting(context.env.DB, "gemini_model", body.geminiModel.trim().slice(0, 100));
    }
    if (body.clearSplitwiseKey === true) {
      await setSetting(context.env.DB, "splitwise_api_key", "");
    } else if (typeof body.splitwiseApiKey === "string" && body.splitwiseApiKey.trim()) {
      await setSetting(context.env.DB, "splitwise_api_key", body.splitwiseApiKey.trim().slice(0, 300));
    }
    return json(await describeSettings(context.env));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
export const onRequestPost = onRequestPut;
