/*
 * Arthatula — Gemini auto-categorization.
 *
 * Route (this file serves /api/categorize):
 *   POST /api/categorize { description, amount? }
 *     -> { category, confidence?, source: "gemini" | "rules" }
 *
 * Key lookup order (never hardcode a key here):
 *   1. GEMINI_API_KEY Pages environment secret
 *   2. the key saved server-side in D1 by the Settings UI
 *      (budget_settings key 'gemini_api_key')
 * Model: GEMINI_MODEL env var, then the saved 'gemini_model' setting,
 * then the default below (a free-tier Flash-Lite model).
 *
 * Any failure — no key, network/API error, unparseable answer, or a
 * category outside the fixed list — falls back to keyword rules and
 * reports source: "rules". The user can always override manually.
 */
import { CATEGORIES, categorizeByRules, isValidCategory } from "./_categories.js";
import { ensureTables, getMerchantRules, requireAuth } from "./budget.js";
import { merchantCategory } from "../../js/core/merchant.js";

export { CATEGORIES, categorizeByRules };
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function getGeminiConfig(env) {
  let key = env.GEMINI_API_KEY || null;
  let model = env.GEMINI_MODEL || null;
  if (env.DB && (!key || !model)) {
    try {
      await ensureTables(env.DB);
      if (!key) {
        const row = await env.DB.prepare(
          "SELECT value FROM budget_settings WHERE key = 'gemini_api_key'"
        ).first();
        if (row && row.value) key = row.value;
      }
      if (!model) {
        const row = await env.DB.prepare(
          "SELECT value FROM budget_settings WHERE key = 'gemini_model'"
        ).first();
        if (row && row.value) model = row.value;
      }
    } catch (e) { /* settings unavailable — env/defaults still apply */ }
  }
  return { key, model: model || DEFAULT_GEMINI_MODEL };
}

export function buildPrompt(description, amount) {
  return [
    "You categorize a personal expense into exactly ONE category.",
    "Reply with JSON only, no other text, in exactly this shape:",
    '{"category": "<one category>", "confidence": <0 to 1>}',
    "The category must be exactly one of:",
    CATEGORIES.join(" | "),
    "Expense description: " + String(description || "").slice(0, 300),
    amount !== undefined && amount !== null ? "Amount (USD): " + amount : ""
  ].filter(Boolean).join("\n");
}

export function parseGeminiResponse(payload) {
  try {
    const text = payload.candidates[0].content.parts
      .map((p) => p.text || "").join("").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!isValidCategory(parsed.category)) return null;
    const confidence = typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence)) : undefined;
    return { category: parsed.category, confidence };
  } catch (e) {
    return null;
  }
}

export async function categorize(env, description, amount, fetchImpl) {
  if (env && env.DB) {
    try {
      await ensureTables(env.DB);
      const own = merchantCategory(await getMerchantRules(env.DB), description);
      if (own) return { category: own, source: "merchant" };
    } catch (e) { /* fall through to Gemini / keywords */ }
  }
  const rulesResult = { category: categorizeByRules(description), source: "rules" };
  const { key, model } = await getGeminiConfig(env || {});
  if (!key) return rulesResult;
  const doFetch = fetchImpl || fetch;
  try {
    const res = await doFetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(description, amount) }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 }
        })
      }
    );
    if (!res.ok) return rulesResult;
    const parsed = parseGeminiResponse(await res.json());
    if (!parsed) return rulesResult;
    const out = { category: parsed.category, source: "gemini" };
    if (parsed.confidence !== undefined) out.confidence = parsed.confidence;
    return out;
  } catch (e) {
    return rulesResult;
  }
}

export async function onRequestPost(context) {
  try {
    /* Guarded like every data endpoint when a database is bound (the
       categorization itself also works DB-less for local dev, where no
       access code can exist). */
    if (context.env.DB) {
      const auth = await requireAuth(context.env.DB, context.request);
      if (auth.response) return auth.response;
    }
    const body = await context.request.json();
    if (!body || typeof body.description !== "string" || !body.description.trim()) {
      return json({ error: "POST expects { description, amount? }" }, 400);
    }
    return json(await categorize(context.env, body.description, body.amount));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
