/*
 * Arthatula — app settings (the AI provider + the Splitwise connection).
 *
 * Routes (this file serves /api/settings):
 *   GET /api/settings -> { ai: { provider, label, providers, hasKey, last4,
 *                          model, modelSource, defaultModel, baseUrl, source },
 *                          gemini: (same as ai, for older clients),
 *                          splitwise: { hasKey, last4, source } }
 *     Full API keys are NEVER returned — only whether one is saved and
 *     at most its last 4 characters.
 *   PUT /api/settings { aiProvider?, aiApiKey?, aiModel?, aiBaseUrl?,
 *                       clearAiKey?, splitwiseApiKey?, clearSplitwiseKey? }
 *     The ai* fields apply to aiProvider (or the current provider).
 *     The older geminiApiKey / geminiModel / clearGeminiKey still work.
 *     Keys are saved server-side in the D1 budget_settings table, one
 *     per provider, where only the server can read them. A key in an
 *     environment secret (GEMINI_API_KEY, XAI_API_KEY, OPENAI_API_KEY,
 *     SPLITWISE_API_KEY) always wins and is reported as source: "env"
 *     (it cannot be cleared from the UI). See _ai.js.
 */
import { ensureTables, requireAuth } from "./budget.js";
import { PROVIDERS, getAiConfig } from "./_ai.js";

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
  const cfg = await getAiConfig(env);
  const p = PROVIDERS[cfg.provider];
  const envKey = env[p.envKey] || null;
  const savedKey = await getSetting(env.DB, cfg.provider + "_api_key");
  const savedModel = await getSetting(env.DB, cfg.provider + "_model");
  const envModel = cfg.provider === "gemini" ? env.GEMINI_MODEL : env.AI_MODEL;
  const ai = {
    provider: cfg.provider,
    label: p.label,
    providers: Object.keys(PROVIDERS).map((id) => ({ id, label: PROVIDERS[id].label, defaultModel: PROVIDERS[id].defaultModel, keyUrl: PROVIDERS[id].keyUrl })),
    hasKey: !!cfg.key,
    last4: cfg.key ? cfg.key.slice(-4) : null,
    model: cfg.model,
    /* where the model comes from: "env", "saved" (Settings) or "default" */
    modelSource: envModel ? "env" : savedModel ? "saved" : "default",
    defaultModel: p.defaultModel,
    baseUrl: cfg.provider === "openai" ? cfg.baseUrl : null,
    source: envKey ? "env" : savedKey ? "saved" : null
  };
  const swEnvKey = env.SPLITWISE_API_KEY || null;
  const swSavedKey = await getSetting(env.DB, "splitwise_api_key");
  const swKey = swEnvKey || swSavedKey;
  return {
    ai,
    gemini: ai,
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
    const db = context.env.DB;
    const url = typeof body.aiBaseUrl === "string" ? body.aiBaseUrl.trim() : null;
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) return json({ error: "The base URL must start with https:// (or http:// for a local server)." }, 400);
    if (typeof body.aiProvider === "string") {
      if (!PROVIDERS[body.aiProvider]) return json({ error: "Unknown AI provider." }, 400);
      await setSetting(db, "ai_provider", body.aiProvider);
    }
    /* Older clients sent gemini* fields: they mean the Gemini provider. */
    const legacy = body.geminiApiKey !== undefined || body.geminiModel !== undefined || body.clearGeminiKey !== undefined;
    const provider = legacy ? "gemini" : (await getAiConfig(context.env)).provider;
    const key = legacy ? body.geminiApiKey : body.aiApiKey;
    const model = legacy ? body.geminiModel : body.aiModel;
    if ((legacy ? body.clearGeminiKey : body.clearAiKey) === true) {
      await setSetting(db, provider + "_api_key", "");
    } else if (typeof key === "string" && key.trim()) {
      await setSetting(db, provider + "_api_key", key.trim().slice(0, 500));
    }
    /* A model name saves it; an empty one removes the saved model, so
       the provider's default applies again. */
    if (typeof model === "string") await setSetting(db, provider + "_model", model.trim().slice(0, 100));
    if (provider === "openai" && url !== null) await setSetting(db, "openai_base_url", url.slice(0, 300));
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
