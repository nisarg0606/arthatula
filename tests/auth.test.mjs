/*
 * Access-code sign-in + session management tests (v6).
 * Covers: setup mode (403 on every data route, setup happy path, second
 * setup 409, short code 400, SETUP_SECRET required, racing setups ->
 * exactly one winner, pre-setup sessions wiped), login (wrong 401,
 * 5 failures -> 429 lockout, success after the window, counter reset on
 * success, a parallel burst gets no extra guesses, per-IP + global
 * limits), PBKDF2 storage + upgrade of a v6.x SHA-256 hash, the guard on
 * EVERY data route (401 without / with a bad token, X-Session-Token
 * accepted), sessions list / revoke / logout, change-code (revokes
 * other sessions, old code dies), sync-session scope (expense/card
 * routes only, 180-day life, revocable), sliding expiry, and the code
 * hash never appearing in any response.
 * Run: node tests/auth.test.mjs — dummy codes only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, TEST_SETUP_SECRET } from "./_fake-d1.mjs";
import { onRequestGet as authGet, onRequestPost as authPost } from "../functions/api/auth.js";
import {
  onRequestGet as budgetGet, onRequestPut as budgetPut, onRequestPatch as budgetPatch,
  verifyAccessCode, sha256Hex, createSessionForTokenHash
} from "../functions/api/budget.js";
import { onRequestPut as actualsPut } from "../functions/api/actuals.js";
import {
  onRequestGet as expGet, onRequestPost as expPost,
  onRequestPut as expPut, onRequestDelete as expDel
} from "../functions/api/expenses.js";
import { onRequestPost as categorizePost } from "../functions/api/categorize.js";
import { onRequestGet as settingsGet, onRequestPut as settingsPut } from "../functions/api/settings.js";
import {
  onRequestGet as cardsGet, onRequestPost as cardsPost,
  onRequestPut as cardsPut, onRequestDelete as cardsDel
} from "../functions/api/cards.js";

const AUTH = "http://local/api/auth";
const CODE = "correct horse 9";
/* Setup calls get the test SETUP_SECRET unless a test passes its own. */
const post = (env, body, headers) => authPost(makeCtx(env,
  body && body.action === "setup" && body.setupSecret === undefined ? { ...body, setupSecret: TEST_SETUP_SECRET } : body,
  "POST", AUTH, headers));
const newEnv = () => ({ DB: new FakeD1(), SETUP_SECRET: TEST_SETUP_SECRET });
const getStatus = (env, headers) => authGet(makeCtx(env, undefined, "GET", AUTH + "?action=status", headers));
const getSessions = (env, token) => authGet(makeCtx(env, undefined, "GET", AUTH + "?action=sessions", authHeaders(token)));

/* Every data route, as [name, call(env, headers)] — used for both the
   pre-setup 403 sweep and the post-setup 401 sweep. */
function dataRoutes() {
  return [
    ["budget GET", (env, h) => budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", h))],
    ["budget PUT", (env, h) => budgetPut(makeCtx(env, { startingBalance: 0, months: [] }, "PUT", "http://local/api/budget", h))],
    ["budget PATCH", (env, h) => budgetPatch(makeCtx(env, { monthKey: "2026-11", field: "rent", value: 1 }, "PATCH", "http://local/api/budget", h))],
    ["actuals PUT", (env, h) => actualsPut(makeCtx(env, { monthKey: "2026-11", patch: { entered: true } }, "PUT", "http://local/api/actuals", h))],
    ["expenses GET", (env, h) => expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", h))],
    ["expenses POST", (env, h) => expPost(makeCtx(env, { date: "2026-11-03", description: "Guard probe", amount: 1 }, "POST", "http://local/api/expenses", h))],
    ["expenses PUT", (env, h) => expPut(makeCtx(env, { id: 1, patch: { amount: 2 } }, "PUT", "http://local/api/expenses", h))],
    ["expenses DELETE", (env, h) => expDel(makeCtx(env, undefined, "DELETE", "http://local/api/expenses?id=1", h))],
    ["categorize POST", (env, h) => categorizePost(makeCtx(env, { description: "Guard probe" }, "POST", "http://local/api/categorize", h))],
    ["settings GET", (env, h) => settingsGet(makeCtx(env, undefined, "GET", "http://local/api/settings", h))],
    ["settings PUT", (env, h) => settingsPut(makeCtx(env, { geminiModel: "x" }, "PUT", "http://local/api/settings", h))],
    ["cards GET", (env, h) => cardsGet(makeCtx(env, undefined, "GET", "http://local/api/cards", h))],
    ["cards POST", (env, h) => cardsPost(makeCtx(env, { name: "Guard Card", statementStart: "2026-11-01", statementEnd: "2026-11-30" }, "POST", "http://local/api/cards", h))],
    ["cards PUT", (env, h) => cardsPut(makeCtx(env, { id: 1, patch: { name: "Renamed" } }, "PUT", "http://local/api/cards", h))],
    ["cards DELETE", (env, h) => cardsDel(makeCtx(env, undefined, "DELETE", "http://local/api/cards?id=1", h))]
  ];
}

/* ---------- 1. Setup mode: everything 403s, status says so ---------- */
{
  const env = newEnv();
  const st = await (await getStatus(env)).json();
  assert.deepEqual(st, { setupRequired: true, authed: false });

  for (const [name, call] of dataRoutes()) {
    const res = await call(env, undefined);
    assert.equal(res.status, 403, name + " before setup -> 403");
    const body = await res.json();
    assert.equal(body.setupRequired, true, name + " flags setupRequired");
  }
  /* Login before setup -> 403 setupRequired, not a code check. */
  let res = await post(env, { action: "login", code: CODE });
  assert.equal(res.status, 403);
  /* Sessions list before setup -> 403. */
  res = await getSessions(env, "anything");
  assert.equal(res.status, 403);

  /* Short code rejected (12+ characters now); nothing gets set. */
  res = await post(env, { action: "setup", code: "12345" });
  assert.equal(res.status, 400);
  res = await post(env, { action: "setup", code: "eleven-char" });
  assert.equal(res.status, 400, "11 characters is too short");
  assert.equal((await (await getStatus(env)).json()).setupRequired, true);

  /* Wrong setup secret -> 401, and no code gets set. */
  res = await post(env, { action: "setup", setupSecret: "guess", code: CODE });
  assert.equal(res.status, 401);
  assert.equal((await (await getStatus(env)).json()).setupRequired, true);

  /* Setup is impossible while SETUP_SECRET isn't configured at all. */
  res = await authPost(makeCtx({ DB: env.DB }, { action: "setup", setupSecret: "", code: CODE }, "POST", AUTH));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /SETUP_SECRET/);

  /* A session row that somehow predates setup is wiped by it. */
  env.DB.db.prepare("INSERT INTO sessions (id, token_hash, kind, label, expires_at) VALUES ('stale', ?, 'device', 'stale', NULL)")
    .run(await sha256Hex("pre-setup-token"));

  /* Happy path: sets the code, returns a token + ~90 day expiry. */
  res = await post(env, { action: "setup", code: CODE, label: "Phone · Safari" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.token === "string" && body.token.length >= 40, "raw token returned once");
  assert.ok(body.expiresAt && Date.parse(body.expiresAt.replace(" ", "T") + "Z") > Date.now() + 89 * 864e5, "device session expires ~90 days out");
  assert.equal(body.session.label, "Phone · Safari");
  const token = body.token;
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'stale'").get().n, 0, "pre-setup session wiped");
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders("pre-setup-token")))).status, 401);

  /* Only a salted PBKDF2 hash is stored... */
  const rawRow = env.DB.db.prepare("SELECT value FROM budget_settings WHERE key = 'access_code_hash'").get();
  assert.match(rawRow.value, /^pbkdf2\$100000\$/, "stored as PBKDF2 (100k iterations)");
  assert.equal((await verifyAccessCode(rawRow.value, CODE)).ok, true);
  assert.equal((await verifyAccessCode(rawRow.value, CODE + "x")).ok, false);
  const hash = rawRow.value;
  /* ...and neither it nor the raw token appears in any response. */
  for (const payload of [JSON.stringify(body), JSON.stringify(await (await getStatus(env, authHeaders(token))).json())]) {
    assert.ok(!payload.includes(hash), "code hash must never be returned");
    assert.ok(!payload.includes("access_code_hash"), "settings key name must never leak");
  }
  /* Second setup -> 409, even with a different code. */
  res = await post(env, { action: "setup", code: "another code 1" });
  assert.equal(res.status, 409);

  /* Status now: setup done; authed only with the token. */
  assert.deepEqual(await (await getStatus(env)).json(), { setupRequired: false, authed: false });
  assert.deepEqual(await (await getStatus(env, authHeaders(token))).json(), { setupRequired: false, authed: true });

  /* Guard sweep: no token -> 401, bad token -> 401, on EVERY route. */
  for (const [name, call] of dataRoutes()) {
    assert.equal((await call(env, undefined)).status, 401, name + " without token -> 401");
    assert.equal((await call(env, { Authorization: "Bearer not-a-real-token" })).status, 401, name + " with bad token -> 401");
  }
  /* ...and the setup token works, via Bearer AND X-Session-Token. */
  let ok = await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(token)));
  assert.equal(ok.status, 200);
  ok = await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", { "X-Session-Token": token }));
  assert.equal(ok.status, 200, "X-Session-Token header accepted");
  const errBody = await (await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget"))).json();
  assert.equal(errBody.error, "Sign-in required");
}

/* ---------- 2. Login lockout: 5 wrong -> 429, window, counter reset --- */
{
  const env = newEnv();
  await post(env, { action: "setup", code: CODE });

  for (let i = 1; i <= 4; i++) {
    const res = await post(env, { action: "login", code: "wrong code " + i });
    assert.equal(res.status, 401, "wrong login #" + i + " -> 401");
  }
  const fifth = await post(env, { action: "login", code: "wrong code 5" });
  assert.equal(fifth.status, 429, "5th consecutive failure locks login");
  assert.match((await fifth.json()).error, /locked/i);

  /* Even the CORRECT code is refused while locked. */
  const during = await post(env, { action: "login", code: CODE });
  assert.equal(during.status, 429, "correct code during lockout -> 429");

  /* Simulate the 10 minutes passing (age the attempt log). */
  env.DB.db.prepare("UPDATE auth_attempts SET at = at - 11 * 60 * 1000").run();
  const after = await post(env, { action: "login", code: CODE, label: "Laptop · Chrome" });
  assert.equal(after.status, 200, "login succeeds after the lockout window");
  assert.ok((await after.json()).token);

  /* Counter reset on success: 4 wrong, 1 right, 4 wrong -> still no lock. */
  for (let i = 1; i <= 4; i++) assert.equal((await post(env, { action: "login", code: "nope " + i })).status, 401);
  assert.equal((await post(env, { action: "login", code: CODE })).status, 200);
  for (let i = 1; i <= 4; i++) assert.equal((await post(env, { action: "login", code: "nope again " + i })).status, 401);
  assert.equal((await post(env, { action: "login", code: CODE })).status, 200, "counter was reset by the intervening success");
}

/* ---------- 3. Sessions: list, revoke, logout ------------------------ */
{
  const env = newEnv();
  const setupBody = await (await post(env, { action: "setup", code: CODE, label: "Phone · Safari" })).json();
  const phone = setupBody.token;
  const laptop = (await (await post(env, { action: "login", code: CODE, label: "Laptop · Chrome" })).json()).token;

  let sessions = (await (await getSessions(env, phone)).json()).sessions;
  assert.equal(sessions.length, 2);
  const mine = sessions.find((s) => s.current);
  assert.equal(mine.label, "Phone · Safari");
  assert.equal(mine.kind, "device");
  assert.equal(sessions.filter((s) => s.current).length, 1, "exactly one session is flagged current");
  assert.ok(sessions.every((s) => !("token_hash" in s) && !("tokenHash" in s) && !("token" in s)), "session list never carries tokens or hashes");
  const laptopSession = sessions.find((s) => !s.current);

  /* Sessions list itself requires auth. */
  assert.equal((await authGet(makeCtx(env, undefined, "GET", AUTH + "?action=sessions"))).status, 401);

  /* Revoke the laptop: its token dies immediately, the phone's lives. */
  let res = await post(env, { action: "revoke", id: laptopSession.id }, authHeaders(phone));
  assert.equal(res.status, 200);
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(laptop)))).status, 401, "revoked token rejected");
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(phone)))).status, 200);
  sessions = (await (await getSessions(env, phone)).json()).sessions;
  assert.equal(sessions.length, 1);

  /* Logout kills the current session. */
  res = await post(env, { action: "logout" }, authHeaders(phone));
  assert.equal(res.status, 200);
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(phone)))).status, 401, "logged-out token rejected");
  assert.equal((await (await getStatus(env, authHeaders(phone))).json()).authed, false);
}

/* ---------- 4. Change code: revokes others, old code dies ------------ */
{
  const env = newEnv();
  const first = (await (await post(env, { action: "setup", code: CODE, label: "Phone" })).json()).token;
  const second = (await (await post(env, { action: "login", code: CODE, label: "Tablet" })).json()).token;

  /* Wrong current code -> 401; short new code -> 400. */
  assert.equal((await post(env, { action: "change-code", currentCode: "not the code", newCode: "brand new code 1" }, authHeaders(first))).status, 401);
  assert.equal((await post(env, { action: "change-code", currentCode: CODE, newCode: "short" }, authHeaders(first))).status, 400);

  const res = await post(env, { action: "change-code", currentCode: CODE, newCode: "brand new code 1" }, authHeaders(first));
  assert.equal(res.status, 200);
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(first)))).status, 200, "the changing device stays signed in");
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(second)))).status, 401, "every other session was revoked");
  assert.equal((await post(env, { action: "login", code: CODE })).status, 401, "old code no longer works");
  assert.equal((await post(env, { action: "login", code: "brand new code 1" })).status, 200, "new code works");
}

/* ---------- 5. Sync sessions: least privilege, finite life ---------- */
{
  const env = newEnv();
  const device = (await (await post(env, { action: "setup", code: CODE })).json()).token;

  /* The old code -> non-expiring-token shortcut is gone. */
  assert.equal((await post(env, { action: "create-sync-token", code: CODE })).status, 401, "no session -> 401");
  assert.equal((await post(env, { action: "create-sync-token", code: CODE }, authHeaders(device))).status, 400, "unknown action");

  /* A paired sync session (pairing itself is covered in pairing.test.mjs). */
  const sync = "sync-script-local-token";
  await createSessionForTokenHash(env.DB, { kind: "sync", label: "Plaid sync", tokenHash: await sha256Hex(sync) });
  const h = authHeaders(sync);

  /* Allowed: what the nightly sync needs. */
  assert.equal((await expPost(makeCtx(env, { date: "2026-11-03", description: "Sync probe", amount: 3 }, "POST", "http://local/api/expenses", h))).status, 201, "sync can add expenses");
  assert.equal((await expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", h))).status, 200, "sync can list expenses");
  const card = await (await cardsPost(makeCtx(env, { name: "Probe", statementStart: "2026-11-01", statementEnd: "2026-11-30" }, "POST", "http://local/api/cards", authHeaders(device)))).json();
  assert.equal((await cardsGet(makeCtx(env, undefined, "GET", "http://local/api/cards", h))).status, 200, "sync can read cards");
  assert.equal((await cardsPut(makeCtx(env, { id: card.card.id, patch: { statementStart: "2026-12-01", statementEnd: "2026-12-31" } }, "PUT", "http://local/api/cards", h))).status, 200, "sync can roll statement periods");

  /* Refused: everything else, including all account management. */
  const forbidden = [
    ["budget GET", budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", h))],
    ["budget PUT", budgetPut(makeCtx(env, { startingBalance: 0, months: [] }, "PUT", "http://local/api/budget", h))],
    ["expenses PUT", expPut(makeCtx(env, { id: 1, patch: { amount: 2 } }, "PUT", "http://local/api/expenses", h))],
    ["expenses DELETE", expDel(makeCtx(env, undefined, "DELETE", "http://local/api/expenses?id=1", h))],
    ["cards DELETE", cardsDel(makeCtx(env, undefined, "DELETE", "http://local/api/cards?id=" + card.card.id, h))],
    ["settings GET", settingsGet(makeCtx(env, undefined, "GET", "http://local/api/settings", h))],
    ["sessions GET", authGet(makeCtx(env, undefined, "GET", AUTH + "?action=sessions", h))],
    ["pairing GET", authGet(makeCtx(env, undefined, "GET", AUTH + "?action=pairing", h))]
  ];
  for (const [name, p] of forbidden) assert.equal((await p).status, 403, "sync " + name + " -> 403");
  const deviceRow = (await (await getSessions(env, device)).json()).sessions.find((s) => s.kind === "device");
  for (const body of [{ action: "revoke", id: deviceRow.id }, { action: "pair-open" }, { action: "pair-approve", fingerprint: "x" },
    { action: "change-code", currentCode: CODE, newCode: "taken over code 1" }, { action: "sessions" }]) {
    assert.equal((await post(env, body, h)).status, 403, "sync " + body.action + " -> 403");
  }
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(device)))).status, 200, "the owner's device is untouched");

  /* Listed with a ~180-day life, revocable; logout works for it. */
  const syncRow = (await (await getSessions(env, device)).json()).sessions.find((s) => s.kind === "sync");
  assert.equal(syncRow.label, "Plaid sync");
  const life = Date.parse(syncRow.expiresAt.replace(" ", "T") + "Z") - Date.now();
  assert.ok(life > 179 * 864e5 && life < 181 * 864e5, "sync sessions expire 180 days after pairing");
  assert.equal((await post(env, { action: "revoke", id: syncRow.id }, authHeaders(device))).status, 200);
  assert.equal((await expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", h))).status, 401, "revoked sync token rejected");

  /* A pre-v7 sync row with no expiry gets one on first use. */
  const legacySync = "legacy-sync-token";
  env.DB.db.prepare("INSERT INTO sessions (id, token_hash, kind, label, expires_at) VALUES ('legacy-sync', ?, 'sync', 'old', NULL)").run(await sha256Hex(legacySync));
  assert.equal((await expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", authHeaders(legacySync)))).status, 200);
  assert.ok(env.DB.db.prepare("SELECT expires_at FROM sessions WHERE id = 'legacy-sync'").get().expires_at, "legacy sync row now has an expiry");
}

/* ---------- 5b. Attack regressions: setup race, parallel guessing ----- */
{
  /* Two setups at once: exactly one wins; the loser holds no session. */
  const env = newEnv();
  const [a, b] = await Promise.all([
    post(env, { action: "setup", code: "attacker code 123", label: "A" }),
    post(env, { action: "setup", code: "owner code 12345", label: "B" })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], "racing setups: one 200, one 409");
  const winner = a.status === 200 ? await a.json() : await b.json();
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1, "only the winner has a session");
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(winner.token)))).status, 200);
}
{
  /* 60 parallel guesses from one IP: only 5 are ever checked, so a
     correct code late in the burst does not get through. */
  const env = newEnv();
  await post(env, { action: "setup", code: CODE });
  const guesses = Array.from({ length: 60 }, (_, i) => (i === 59 ? CODE : "guess number " + i));
  const res = await Promise.all(guesses.map((code) => post(env, { action: "login", code }, { "CF-Connecting-IP": "203.0.113.9" })));
  const counts = {};
  res.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  assert.equal(counts[200] || 0, 0, "the burst never reaches the correct code");
  assert.ok((counts[401] || 0) <= 4, "at most 4 plain wrong answers (5th trips the lock)");
  assert.equal((counts[401] || 0) + (counts[429] || 0), 60);
  assert.equal(Number(res.find((r) => r.status === 429).headers.get("Retry-After")) > 0, true, "429 carries Retry-After");
}
{
  /* Per-IP limit: another IP still gets its own attempts; the global
     cap (20 / 10 min) stops a many-IP spray. */
  const env = newEnv();
  await post(env, { action: "setup", code: CODE });
  const ip = (n) => ({ "CF-Connecting-IP": "198.51.100." + n });
  for (let i = 0; i < 5; i++) await post(env, { action: "login", code: "wrong " + i }, ip(1));
  assert.equal((await post(env, { action: "login", code: CODE }, ip(1))).status, 429, "IP 1 is locked");
  assert.equal((await post(env, { action: "login", code: CODE }, ip(2))).status, 200, "IP 2 is not");
  /* Success cleared the log; now spray 20 wrong guesses from 20 IPs. */
  for (let i = 0; i < 20; i++) await post(env, { action: "login", code: "spray " + i }, ip(10 + i));
  assert.equal((await post(env, { action: "login", code: CODE }, ip(99))).status, 429, "global cap reached");
}
{
  /* A v6.x SHA-256 hash still signs in, and is upgraded to PBKDF2. */
  const env = newEnv();
  await post(env, { action: "setup", code: CODE });
  const legacy = await sha256Hex("monthly-budget-access-code:" + CODE);
  env.DB.db.prepare("UPDATE budget_settings SET value = ? WHERE key = 'access_code_hash'").run(legacy);
  assert.equal((await post(env, { action: "login", code: "not it at all" })).status, 401);
  assert.equal((await post(env, { action: "login", code: CODE })).status, 200, "legacy hash accepted");
  const after = env.DB.db.prepare("SELECT value FROM budget_settings WHERE key = 'access_code_hash'").get().value;
  assert.match(after, /^pbkdf2\$/, "upgraded to PBKDF2 on sign-in");
  assert.equal((await post(env, { action: "login", code: CODE })).status, 200, "and still works after the upgrade");
}

/* ---------- 6. Sliding expiry + hard expiry --------------------------- */
{
  const env = newEnv();
  const token = (await (await post(env, { action: "setup", code: CODE })).json()).token;
  /* Age the session: last activity 3 days ago, expiry was +90d from then. */
  env.DB.db.prepare("UPDATE sessions SET last_seen_at = datetime('now', '-3 days'), expires_at = datetime('now', '+87 days')").run();
  const before = env.DB.db.prepare("SELECT last_seen_at FROM sessions").get().last_seen_at;
  const res = await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(token)));
  assert.equal(res.status, 200);
  const row = env.DB.db.prepare("SELECT last_seen_at, expires_at FROM sessions").get();
  assert.ok(row.last_seen_at > before, "last_seen_at slid forward on activity");
  assert.ok(Date.parse(row.expires_at.replace(" ", "T") + "Z") > Date.now() + 89 * 864e5, "expiry extended to ~90 days from now");

  /* A session whose expiry has passed is rejected and removed. */
  env.DB.db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 hour'), last_seen_at = datetime('now', '-91 days')").run();
  assert.equal((await budgetGet(makeCtx(env, undefined, "GET", "http://local/api/budget", authHeaders(token)))).status, 401, "expired session rejected");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0, "expired session row deleted");
}

/* ---------- 7. Misc contract ------------------------------------------ */
{
  const env = newEnv();
  const tk = (await (await post(env, { action: "setup", code: CODE })).json()).token;
  assert.equal((await authPost(makeCtx(env, { action: "bogus" }, "POST", AUTH, authHeaders(tk)))).status, 400, "unknown action -> 400");
  const noDbRes = await authGet({ env: {}, request: new Request(AUTH + "?action=status") });
  assert.equal(noDbRes.status, 503, "no DB -> 503 (frontend falls back to local mode)");
}

console.log("auth.test.mjs: all assertions passed");
