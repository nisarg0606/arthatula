/*
 * The AI provider behind categorizing, "Ask about your budget" and
 * auto-review. Pick one in Settings (or with env vars):
 *
 *   gemini  Google Gemini (default)          key: GEMINI_API_KEY
 *   grok    xAI Grok                         key: XAI_API_KEY
 *   openai  any OpenAI-compatible API        key: OPENAI_API_KEY,
 *           (OpenAI, OpenRouter, Groq,       base URL: OPENAI_BASE_URL
 *           a local Ollama, ...)
 *
 * Grok and the OpenAI-compatible ones share one request shape
 * (POST {base}/chat/completions, Bearer key). Callers build the request
 * with aiRequest() and read the reply with responseText(), whichever
 * provider answered. Env vars win over values saved in Settings; with
 * no key the app keeps working on keyword rules.
 */
import { ensureTables } from "./budget.js";

export const PROVIDERS = {
  gemini: { label: "Google Gemini", envKey: "GEMINI_API_KEY", defaultModel: "gemini-3.6-flash", keyUrl: "https://aistudio.google.com/apikey" },
  grok: { label: "xAI Grok", envKey: "XAI_API_KEY", defaultModel: "grok-4.20-0309-non-reasoning", baseUrl: "https://api.x.ai/v1", keyUrl: "https://console.x.ai" },
  openai: { label: "OpenAI-compatible", envKey: "OPENAI_API_KEY", defaultModel: "", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" }
};
export const DEFAULT_PROVIDER = "gemini";

async function saved(db, key) {
  const row = await db.prepare("SELECT value FROM budget_settings WHERE key = ?").bind(key).first();
  return row && row.value ? row.value : null;
}

/* { provider, key, model, baseUrl }: env first, then Settings, then defaults. */
export async function getAiConfig(env) {
  env = env || {};
  let ready = null;
  const read = async (k) => {
    if (!env.DB) return null;
    try { await (ready = ready || ensureTables(env.DB)); return await saved(env.DB, k); } catch (e) { return null; }
  };
  let provider = env.AI_PROVIDER || (await read("ai_provider")) || DEFAULT_PROVIDER;
  if (!PROVIDERS[provider]) provider = DEFAULT_PROVIDER;
  const p = PROVIDERS[provider];
  const key = env[p.envKey] || (await read(provider + "_api_key"));
  const model = (provider === "gemini" ? env.GEMINI_MODEL : env.AI_MODEL) || (await read(provider + "_model")) || p.defaultModel;
  const baseUrl = String((provider === "openai" && (env.OPENAI_BASE_URL || (await read("openai_base_url")))) || p.baseUrl || "").replace(/\/+$/, "");
  return { provider, key: key || null, model, baseUrl };
}

/* [url, fetch init] for one prompt. asJson asks for a JSON-only reply
   (the prompts also say so; replies are parsed leniently either way). */
export function aiRequest(cfg, prompt, opts) {
  const temperature = opts && typeof opts.temperature === "number" ? opts.temperature : 0;
  if (cfg.provider === "gemini") {
    return ["https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(cfg.model) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: opts && opts.asJson ? { responseMimeType: "application/json", temperature } : { temperature }
      })
    }];
  }
  return [cfg.baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
    body: JSON.stringify({ model: cfg.model, temperature, messages: [{ role: "user", content: prompt }] })
  }];
}

/* The reply's text from a Gemini or chat-completions response body. */
export function responseText(payload) {
  if (!payload) return "";
  if (Array.isArray(payload.candidates)) {
    const parts = (payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts) || [];
    return parts.map((p) => p.text || "").join("").trim();
  }
  if (Array.isArray(payload.choices)) {
    const msg = payload.choices[0] && payload.choices[0].message;
    return String((msg && msg.content) || "").trim();
  }
  return "";
}

/* A provider's own error text (bad key, quota, unknown model...); it
   never contains the key. */
export function errorText(payload) {
  const err = (payload && payload.error) || {};
  if (typeof err === "string") return err.slice(0, 200);
  return [err.status || err.type || err.code, err.message].filter(Boolean).join(": ").slice(0, 200);
}
