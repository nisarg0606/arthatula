/*
 * Categorize handler tests with a fake fetch. Run: node tests/categorize.test.mjs
 * No real API key is used or needed.
 */
import assert from "node:assert/strict";
import { categorize, onRequestPost } from "../functions/api/categorize.js";
import { onRequestGet as settingsGet, onRequestPut as settingsPut } from "../functions/api/settings.js";
import { FakeD1, makeCtx, setupTestAuth, authedCtx } from "./_fake-d1.mjs";

function geminiFetch(categoryJson, ok = true) {
  return async () => ({
    ok,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(categoryJson) }] } }]
    })
  });
}

// 1. Valid Gemini JSON category -> source "gemini", confidence kept.
let out = await categorize(
  { GEMINI_API_KEY: "test-key" }, "Weekly supermarket run", 42,
  geminiFetch({ category: "Groceries", confidence: 0.9 })
);
assert.equal(out.category, "Groceries");
assert.equal(out.source, "gemini");
assert.equal(out.confidence, 0.9);

// 2. Invalid category from Gemini -> keyword-rules fallback.
out = await categorize(
  { GEMINI_API_KEY: "test-key" }, "Shell petrol station", 30,
  geminiFetch({ category: "Travel & Fun", confidence: 0.5 })
);
assert.equal(out.source, "rules");
assert.equal(out.category, "Fuel/Transport");

// 3. Gemini HTTP failure -> rules fallback.
out = await categorize(
  { GEMINI_API_KEY: "test-key" }, "Netflix monthly", 15,
  geminiFetch({}, false)
);
assert.deepEqual(out, { category: "Subscriptions", source: "rules" });

// 4. No key anywhere -> rules, and fetch is never called.
let fetchCalled = false;
out = await categorize({ DB: new FakeD1() }, "Walmart groceries", 25, async () => {
  fetchCalled = true; throw new Error("should not be called");
});
assert.equal(fetchCalled, false);
assert.deepEqual(out, { category: "Groceries", source: "rules" });

// 5. POST handler shape + a saved-in-D1 key is picked up (masked in settings).
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctxA = authedCtx(env, token);
let res = await settingsPut(ctxA(
  { geminiApiKey: "saved-key-1234567890wxyz", geminiModel: "gemini-3.6-flash" }, "PUT",
  "http://local/api/settings"));
let settings = await res.json();
assert.equal(settings.gemini.hasKey, true);
assert.equal(settings.gemini.last4, "wxyz");
assert.ok(!JSON.stringify(settings).includes("saved-key-1234567890"),
  "settings GET/PUT responses must never contain the full key");

res = await onRequestPost(ctxA(
  { description: "Monthly rent payment" }, "POST", "http://local/api/categorize"));
out = await res.json();
assert.equal(out.category, "Rent"); /* no network in tests: rules ran, key lookup did not crash */

// 6. Clearing the saved key works and is reflected masked.
// A saved model shows as "saved"; an empty model box goes back to the default.
assert.equal(settings.gemini.modelSource, "saved");
assert.equal(settings.gemini.model, "gemini-3.6-flash");
res = await settingsPut(ctxA({ geminiModel: "" }, "PUT", "http://local/api/settings"));
settings = await res.json();
assert.equal(settings.gemini.modelSource, "default", "a blank model removes the saved one");
assert.equal(settings.gemini.model, settings.gemini.defaultModel);
assert.equal(settings.gemini.hasKey, true, "resetting the model keeps the key");
res = await settingsPut(ctxA({ geminiApiKey: "another-key-000000000abcd" }, "PUT", "http://local/api/settings"));
assert.equal((await res.json()).gemini.modelSource, "default", "saving only a key leaves the model alone");

res = await settingsPut(ctxA( { clearGeminiKey: true }, "PUT", "http://local/api/settings"));
settings = await res.json();
assert.equal(settings.gemini.hasKey, false);
assert.equal(settings.gemini.last4, null);
res = await settingsGet(ctxA( undefined, "GET", "http://local/api/settings"));
assert.equal((await res.json()).gemini.hasKey, false);

console.log("categorize.test.mjs: all assertions passed");
