/*
 * Arthatula — app settings (currently the Gemini configuration).
 *
 * Routes (this file serves /api/settings):
 *   GET /api/settings -> { gemini: { hasKey, last4, model, source } }
 *     The full API key is NEVER returned — only whether one is saved and
 *     at most its last 4 characters.
 *   PUT /api/settings { geminiApiKey?, geminiModel?, clearGeminiKey? }
 *     Saves the key server-side in the D1 budget_settings table, where
 *     only the categorize Function can read it. A key supplied via the
 *     GEMINI_API_KEY environment secret always takes precedence and is
 *     reported as source: "env" (it cannot be cleared from the UI).
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

export async function describeSettings(env) {
  await ensureTables(env.DB);
  const envKey = env.GEMINI_API_KEY || null;
  const savedKey = await getSetting(env.DB, "gemini_api_key");
  const savedModel = await getSetting(env.DB, "gemini_model");
  const effectiveKey = envKey || savedKey;
  return {
    gemini: {
      hasKey: !!effectiveKey,
      last4: effectiveKey ? effectiveKey.slice(-4) : null,
      model: env.GEMINI_MODEL || savedModel || DEFAULT_GEMINI_MODEL,
      /* where the model comes from: "env", "saved" (Settings) or "default" */
      modelSource: env.GEMINI_MODEL ? "env" : savedModel ? "saved" : "default",
      defaultModel: DEFAULT_GEMINI_MODEL,
      source: envKey ? "env" : savedKey ? "saved" : null
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
    return json(await describeSettings(context.env));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
export const onRequestPost = onRequestPut;
