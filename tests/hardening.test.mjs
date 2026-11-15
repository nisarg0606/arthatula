/*
 * Security and efficiency hardening: request-size caps on the routes
 * anyone can reach, the OAuth registration limit, https-only AI base
 * URLs, expired-session cleanup, the session and daily-log indexes,
 * and the notification table check running once per isolate.
 * Run: node --test tests/hardening.test.mjs — dummy data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authedCtx, setupTestAuth } from "./_fake-d1.mjs";
import { onRequestPost as authPost, MAX_AUTH_BODY } from "../functions/api/auth.js";
import { handleOAuthRequest, MAX_REGISTRATIONS_PER_HOUR } from "../functions/api/_oauth.js";
import { onRequestPut as settingsPut } from "../functions/api/settings.js";
import { listDailyExpenses, ensureTables } from "../functions/api/budget.js";
import { notify, listNotifications } from "../functions/api/_notify.js";

const ORIGIN = "https://example.test";

test("POST /api/auth refuses oversized bodies before anything else", async () => {
  const env = { DB: new FakeD1() };
  await setupTestAuth(env);
  const big = { action: "login", code: "x".repeat(MAX_AUTH_BODY) };
  const res = await authPost(makeCtx(env, big, "POST", "http://local/api/auth"));
  assert.equal(res.status, 413);
  /* A normal wrong-code login still gets the usual answer. */
  const wrong = await authPost(makeCtx(env, { action: "login", code: "not-the-code-1" }, "POST", "http://local/api/auth"));
  assert.equal(wrong.status, 401);
});

test("OAuth client registration is size-capped and limited per hour", async () => {
  const env = { DB: new FakeD1() };
  await setupTestAuth(env);
  const register = (body) => handleOAuthRequest({
    env,
    request: new Request(ORIGIN + "/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    })
  });
  const ok = { client_name: "Test", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" };
  assert.equal((await register({ ...ok, client_name: "x".repeat(20000) })).status, 413);
  for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) assert.equal((await register(ok)).status, 201);
  const limited = await register(ok);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "3600");
});

test("the AI base URL must be https", async () => {
  const env = { DB: new FakeD1() };
  const ctx = authedCtx(env, await setupTestAuth(env));
  const http = await (await settingsPut(ctx({ aiProvider: "openai", aiBaseUrl: "http://example.com/v1" }, "PUT", "http://local/api/settings"))).json();
  assert.match(http.error, /https/);
  const https = await (await settingsPut(ctx({ aiProvider: "openai", aiBaseUrl: "https://openrouter.ai/api/v1" }, "PUT", "http://local/api/settings"))).json();
  assert.equal(https.ai.baseUrl, "https://openrouter.ai/api/v1");
});

test("signing in clears sessions that have expired", async () => {
  const env = { DB: new FakeD1() };
  await setupTestAuth(env);
  env.DB.db.exec("INSERT INTO sessions (id, token_hash, kind, label, expires_at) VALUES ('old', 'h', 'device', 'old phone', '2000-01-01 00:00:00')");
  const res = await authPost(makeCtx(env, { action: "login", code: "test-code-123" }, "POST", "http://local/api/auth"));
  assert.equal(res.status, 200);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'old'").get().n, 0);
  assert.ok(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n >= 2, "live sessions stay");
});

test("session and daily-log lookups use indexes, with month filtering unchanged", async () => {
  const env = { DB: new FakeD1() };
  await ensureTables(env.DB);
  const names = env.DB.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(names.includes("sessions_token_hash"));
  assert.ok(names.includes("idx_daily_expenses_date"));
  const plan = env.DB.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE token_hash = ?").all("x").map((r) => r.detail).join(" ");
  assert.match(plan, /sessions_token_hash/);
  for (const [id, date] of [[1, "2026-10-31"], [2, "2026-11-01"], [3, "2026-11-30"], [4, "2026-12-01"], [5, "2026-12-31"], [6, "2027-01-01"]]) {
    env.DB.db.prepare("INSERT INTO daily_expenses (id, date, description, amount) VALUES (?, ?, 'x', 1)").run(id, date);
  }
  assert.deepEqual((await listDailyExpenses(env.DB, "2026-11")).map((e) => e.id).sort(), [2, 3]);
  assert.deepEqual((await listDailyExpenses(env.DB, "2026-12")).map((e) => e.id).sort(), [4, 5]);
  assert.equal((await listDailyExpenses(env.DB)).length, 6);
});

test("the notification tables are checked once per database, not on every poll", async () => {
  const fake = new FakeD1();
  let creates = 0;
  const db = {
    prepare(sql) { if (/CREATE TABLE/i.test(sql)) creates++; return fake.prepare(sql); },
    batch(list) { return fake.batch(list); }
  };
  await notify(db, "sync", "First", "body");
  await notify(db, "sync", "Second", "");
  for (let i = 0; i < 3; i++) await listNotifications(db, 0);
  assert.equal(creates, 2, "two CREATE TABLE statements, once");
  const out = await listNotifications(db, 0);
  assert.deepEqual(out.notifications.map((n) => n.title), ["Second", "First"]);
  assert.equal(out.unread, 2);
});
