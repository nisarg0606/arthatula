/*
 * Sample data route (functions/api/v2/demo.js): status, seed on an
 * empty database, refused with data of your own, and a clear that
 * removes only the sample rows.
 * Run: node tests/demo.test.mjs
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import * as demo from "../functions/api/v2/demo.js";
import * as txs from "../functions/api/v2/transactions.js";
import * as inv from "../functions/api/v2/investments.js";
import * as market from "../functions/api/v2/market.js";
import { compareTotals } from "../functions/api/_v2mirror.js";

async function setup() {
  const env = { DB: new FakeD1() };
  const token = await setupTestAuth(env);
  const call = async (mod, method, path, body) => {
    const res = await mod["onRequest" + method[0] + method.slice(1).toLowerCase()](makeCtx(env, body, method, "http://local/api/v2/" + path, authHeaders(token)));
    return { status: res.status, data: await res.json() };
  };
  const count = (sql) => env.DB.db.prepare(sql).get().n;
  return { env, call, count };
}

{
  const { env, call, count } = await setup();
  assert.equal((await demo.onRequestGet(makeCtx(env, undefined, "GET", "http://local/api/v2/demo"))).status, 401);
  assert.deepEqual((await call(demo, "GET", "demo")).data, { demo: false, empty: true, dismissed: false });

  const seeded = await call(demo, "POST", "demo", {});
  assert.equal(seeded.status, 200);
  assert.deepEqual(seeded.data, { demo: true, empty: true, dismissed: false }, "sample rows don't count as yours");
  assert.ok(count("SELECT COUNT(*) AS n FROM transactions") > 50);
  assert.equal(count("SELECT COUNT(*) AS n FROM transactions WHERE id NOT GLOB 'demo_*' OR source <> 'demo'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL"), 0, "every sample row has a category");
  assert.equal((await call(demo, "POST", "demo", {})).status, 200, "seeding twice is a no-op");

  const i = (await call(inv, "GET", "investments")).data;
  assert.equal(i.accounts.length, 1);
  assert.ok(i.series.length > 150, "about six months of balances");
  assert.ok((await call(market, "GET", "market")).data.latest, "a market recap shows");
  assert.ok((await compareTotals(env.DB)).match, "the migration check ignores sample rows");

  /* Something you add yourself while looking around, on a sample account. */
  const mine = await call(txs, "POST", "transactions", { date: "2026-10-30", merchant: "My real coffee", amountCents: -450, accountId: "demo_acc_card" });
  assert.equal(mine.status, 201);
  await env.DB.db.exec("INSERT INTO v2_settings (owner_id, key, value) VALUES ('me', 'market:2020-01-02', '{\"date\":\"2020-01-02\"}')");
  assert.deepEqual((await call(demo, "GET", "demo")).data, { demo: true, empty: false, dismissed: false });

  const cleared = await call(demo, "DELETE", "demo");
  assert.deepEqual(cleared.data, { demo: false, empty: false, dismissed: false });
  for (const t of ["accounts", "budgets", "recurring", "goals", "balance_snapshots"]) assert.equal(count("SELECT COUNT(*) AS n FROM " + t), 0, t + " cleared");
  assert.equal(count("SELECT COUNT(*) AS n FROM v2_settings WHERE value LIKE '%\"sample\":true%'"), 0, "sample recaps cleared");
  assert.equal(count("SELECT COUNT(*) AS n FROM v2_settings WHERE key = 'market:2020-01-02'"), 1, "a real recap stays");
  const left = (await call(txs, "GET", "transactions")).data.transactions;
  assert.deepEqual(left.map((t) => [t.merchant, t.accountId]), [["My real coffee", null]], "your row stays, unlinked from the gone account");

  assert.equal((await call(demo, "POST", "demo", {})).status, 409, "refused once you have data");
  assert.equal((await call(demo, "POST", "demo", { action: "dismiss" })).data.dismissed, true);
}
console.log("demo tests passed");
