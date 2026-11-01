/* The AI provider choice (functions/api/_ai.js): config precedence, the
   request each provider gets, and replies from either response shape.
   No real API key is used. Run: node tests/ai.test.mjs */
import assert from "node:assert/strict";
import { aiRequest, getAiConfig, responseText } from "../functions/api/_ai.js";
import { categorize } from "../functions/api/categorize.js";
import { onRequestGet as settingsGet, onRequestPut as settingsPut } from "../functions/api/settings.js";
import { FakeD1, setupTestAuth, authedCtx } from "./_fake-d1.mjs";

// Defaults: Gemini; env picks the provider, its key and model.
assert.equal((await getAiConfig({})).provider, "gemini");
let cfg = await getAiConfig({ AI_PROVIDER: "grok", XAI_API_KEY: "xai-test" });
assert.deepEqual(cfg, { provider: "grok", key: "xai-test", model: "grok-4.20-0309-non-reasoning", baseUrl: "https://api.x.ai/v1" });
cfg = await getAiConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", AI_MODEL: "gpt-x", OPENAI_BASE_URL: "https://openrouter.ai/api/v1/" });
assert.equal(cfg.baseUrl, "https://openrouter.ai/api/v1");
assert.equal(cfg.model, "gpt-x");
assert.equal((await getAiConfig({ AI_PROVIDER: "nope" })).provider, "gemini");

// Requests: Gemini's own endpoint vs chat completions with a Bearer key.
const [gUrl, gInit] = aiRequest({ provider: "gemini", key: "g", model: "m1" }, "hi", { asJson: true });
assert.match(gUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/m1:generateContent$/);
assert.equal(gInit.headers["x-goog-api-key"], "g");
assert.equal(JSON.parse(gInit.body).generationConfig.responseMimeType, "application/json");
const [xUrl, xInit] = aiRequest(cfg = { provider: "grok", key: "x", model: "grok-a", baseUrl: "https://api.x.ai/v1" }, "hi");
assert.equal(xUrl, "https://api.x.ai/v1/chat/completions");
assert.equal(xInit.headers.Authorization, "Bearer x");
assert.deepEqual(JSON.parse(xInit.body).messages, [{ role: "user", content: "hi" }]);

// Replies: either shape, or nothing.
assert.equal(responseText({ candidates: [{ content: { parts: [{ text: " a" }, { text: "b " }] } }] }), "ab");
assert.equal(responseText({ choices: [{ message: { content: " ok " } }] }), "ok");
assert.equal(responseText({}), "");

// End to end: categorize through Grok with a mocked API.
let seen = null;
const out = await categorize({ AI_PROVIDER: "grok", XAI_API_KEY: "xai-test" }, "Weekly supermarket run", 42, async (url, init) => {
  seen = { url, auth: init.headers.Authorization };
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"category":"Groceries","confidence":0.8}' } }] }) };
});
assert.deepEqual(seen, { url: "https://api.x.ai/v1/chat/completions", auth: "Bearer xai-test" });
assert.equal(out.category, "Groceries");
assert.equal(out.confidence, 0.8);

// Settings: switch to Grok, save its key; Gemini's key is kept apart.
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctx = authedCtx(env, token);
await settingsPut(ctx({ aiApiKey: "gem-key-1234" }, "PUT", "http://local/api/settings"));
let res = await (await settingsPut(ctx({ aiProvider: "grok", aiApiKey: "xai-key-5678" }, "PUT", "http://local/api/settings"))).json();
assert.equal(res.ai.provider, "grok");
assert.equal(res.ai.last4, "5678");
assert.equal(res.ai.label, "xAI Grok");
assert.equal((await getAiConfig(env)).key, "xai-key-5678");
res = await (await settingsPut(ctx({ aiProvider: "gemini" }, "PUT", "http://local/api/settings"))).json();
assert.equal(res.ai.last4, "1234");
res = await (await settingsPut(ctx({ aiProvider: "openai", aiBaseUrl: "javascript:alert(1)" }, "PUT", "http://local/api/settings"))).json();
assert.match(res.error, /base URL/);
res = await (await settingsGet(ctx(undefined, "GET", "http://local/api/settings"))).json();
assert.deepEqual(res.ai.providers.map((p) => p.id), ["gemini", "grok", "openai"]);
assert.equal(JSON.stringify(res).includes("xai-key-5678"), false, "keys never come back");
console.log("ai provider tests passed");
