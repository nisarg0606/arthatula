/*
 * Local test for the Pages Function in functions/api/budget.js.
 * Runs the real handlers against an in-memory SQLite database wrapped in
 * a minimal D1-style shim. Run with:  node tests/api.test.mjs
 * Uses only generic dummy amounts — no real budget data.
 */
import assert from "node:assert/strict";
import {
  onRequestGet, onRequestPatch, onRequestPut, planMonthKeys, ensureTables, readState
} from "../functions/api/budget.js";
import { onRequestPut as actualsPut } from "../functions/api/actuals.js";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";

const MONTH_KEYS = planMonthKeys("2026-10", "2026-10");

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctx = (body, method) => makeCtx(env, body, method, undefined, authHeaders(token));

// 1. Fresh GET seeds twelve blank months and a zero balance.
let res = await onRequestGet(ctx(undefined, "GET"));
assert.equal(res.status, 200);
let state = await res.json();
assert.equal(state.startingBalance, 0);
assert.equal(state.months.length, MONTH_KEYS.length);
assert.deepEqual(state.months.map((m) => m.monthKey), MONTH_KEYS);
assert.ok(state.months.every((m) => m.takeHomePay === 0 && m.oneOffs === 0 && m.note === ""));

// 2. PATCH the starting balance and one month.
res = await onRequestPatch(ctx({ startingBalance: 100 }, "PATCH"));
assert.equal((await res.json()).startingBalance, 100);
res = await onRequestPatch(ctx(
  { monthKey: "2026-11", patch: { takeHomePay: 1000, rent: 400, oneOffs: 25.5, oneOffNote: "dummy" } },
  "PATCH"
));
state = await res.json();
const nov = state.months.find((m) => m.monthKey === "2026-11");
assert.equal(nov.takeHomePay, 1000);
assert.equal(nov.rent, 400);
assert.equal(nov.oneOffs, 25.5, "cents round-trip keeps two decimals");
assert.equal(nov.oneOffNote, "dummy");
assert.equal(state.months.find((m) => m.monthKey === "2026-12").takeHomePay, 0, "other months untouched");

// 2b. Baseline defaults: actuals are anchored to the baseline date, and
// a fresh state has twelve actuals rows, none entered yet.
assert.equal(state.baselineDate, "2026-10-26");
assert.equal(state.actuals.length, MONTH_KEYS.length);
assert.ok(state.actuals.every((a) => a.entered === false && a.takeHomePay === 0));

// 2c. Actuals round-trip via PATCH /api/budget { actualMonthKey, patch }.
res = await onRequestPatch(ctx(
  { actualMonthKey: "2026-11", patch: { takeHomePay: 900, rent: 400 } },
  "PATCH"
));
state = await res.json();
let novActual = state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(novActual.entered, true, "entering an actual marks the month entered");
assert.equal(novActual.takeHomePay, 900);
assert.equal(novActual.rent, 400);
assert.equal(state.actuals.find((a) => a.monthKey === "2026-12").entered, false);

// 2d. Actuals round-trip via PUT /api/actuals, incl. explicit entered flag
// on an otherwise-zero month (a real zero month is entered, not blank).
const actx = (body) => ({
  env,
  request: new Request("http://local/api/actuals", {
    method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify(body)
  })
});
res = await actualsPut(actx({ monthKey: "2026-12", patch: { entered: true } }));
state = await res.json();
assert.equal(state.actuals.find((a) => a.monthKey === "2026-12").entered, true);
assert.equal(state.months.find((m) => m.monthKey === "2026-11").takeHomePay, 1000,
  "actuals writes do not touch the planned figures");

// 3. PUT replaces the whole state (the Import / Reset path), actuals too.
const blank = { startingBalance: 0, months: MONTH_KEYS.map((monthKey) => ({ monthKey })) };
res = await onRequestPut(ctx(blank, "PUT"));
state = await res.json();
assert.equal(state.startingBalance, 0);
assert.ok(state.months.every((m) => m.takeHomePay === 0 && m.oneOffs === 0));
assert.ok(state.actuals.every((a) => a.entered === false && a.takeHomePay === 0),
  "a PUT without actuals resets actuals to blank");

// 4. No DB bound -> 503, which is what flips the frontend to local mode.
res = await onRequestGet({ env: {}, request: new Request("http://local/api/budget") });
assert.equal(res.status, 503);

// 5. ensureTables runs on every request, so on an up-to-date database
//    it must be a single D1 round trip (it was ~36 sequential ones).
{
  const db = new FakeD1();
  await ensureTables(db); // first call creates everything
  let calls = 0;
  const origPrepare = db.prepare.bind(db), origBatch = db.batch.bind(db);
  db.batch = (s) => { calls++; return origBatch(s); };
  db.prepare = (sql) => {
    const st = origPrepare(sql);
    for (const m of ["run", "first", "all"]) { const f = st[m].bind(st); st[m] = (...a) => { calls++; return f(...a); }; }
    return st;
  };
  await ensureTables(db);
  assert.equal(calls, 1, "ensureTables should make exactly one round trip");
}

// The plan window: 13 months from plan_start, on through the current month.
assert.equal(MONTH_KEYS.length, 13);
assert.equal(MONTH_KEYS[12], "2027-10");
assert.deepEqual(planMonthKeys("2026-10", "2028-01").slice(-3), ["2027-11", "2027-12", "2028-01"],
  "the plan runs on through the current month");
assert.deepEqual(planMonthKeys("2026-11", "2026-11").slice(0, 3), ["2026-11", "2026-12", "2027-01"]);
{
  const today = new Date().toISOString().slice(0, 10);
  // A new database starts the plan this month, anchored today.
  const fresh = new FakeD1({ fresh: true });
  const st = await readState(fresh);
  assert.equal(st.months[0].monthKey, today.slice(0, 7));
  assert.equal(st.months.length, 13);
  assert.equal(st.baselineDate, today);
  // A database from before plan_start keeps its months and baseline.
  const old = new FakeD1({ fresh: true });
  old.db.exec("CREATE TABLE budget_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.db.exec("INSERT INTO budget_settings VALUES ('baseline_date', '2026-10-26')");
  old.db.exec("CREATE TABLE monthly_budgets (month_key TEXT PRIMARY KEY)");
  old.db.exec("INSERT INTO monthly_budgets VALUES ('2026-10'), ('2026-11'), ('2027-10')");
  const ost = await readState(old);
  assert.equal(ost.months[0].monthKey, "2026-10", "existing data keeps its first month");
  assert.equal(ost.baselineDate, "2026-10-26");
}

console.log("api.test.mjs: all assertions passed");
