/*
 * The nightly market recap (functions/api/_market.js) and the
 * investments screen's numbers (investmentSeries / changeOver in
 * js/core/v2/money.js), plus the two routes end to end on a fake D1.
 * Run: node tests/market.test.mjs — made-up quotes and balances only.
 */
import assert from "node:assert/strict";
import { FakeD1, setupTestAuth, authedCtx } from "./_fake-d1.mjs";
import { ensureV2, scope, OWNER_ID } from "../functions/api/_v2db.js";
import { newYork, expectedSession, plainSummary, buildPrompt, ensureMarket, marketHistory } from "../functions/api/_market.js";
import { investmentSeries, changeOver } from "../js/core/v2/money.js";
import * as investmentsRoute from "../functions/api/v2/investments.js";
import * as marketRoute from "../functions/api/v2/market.js";
import * as settingsRoute from "../functions/api/settings.js";

/* ---- New York trading days ---- */
const at = (iso) => Date.parse(iso);
assert.equal(newYork(at("2026-11-02T21:30:00Z")).date, "2026-11-02", "4:30 pm EST Monday");
assert.equal(expectedSession(at("2026-11-02T21:30:00Z")), "2026-11-02", "after Monday's close: Monday");
assert.equal(expectedSession(at("2026-11-02T20:00:00Z")), "2026-10-30", "3 pm Monday: still Friday's");
assert.equal(expectedSession(at("2026-11-01T15:00:00Z")), "2026-10-30", "Sunday: Friday's");
assert.equal(expectedSession(at("2026-11-03T01:30:00Z")), "2026-11-02", "the cron, 8:30 pm Monday EST");
assert.equal(expectedSession(at("2026-07-14T20:15:00Z")), "2026-07-14", "4:15 pm EDT counts in summer");

/* ---- summaries ---- */
const day = {
  date: "2026-11-02",
  quotes: [
    { symbol: "SPY", name: "S&P 500", close: 612.34, change: 4.1, changePct: 0.67 },
    { symbol: "QQQ", name: "Nasdaq 100", close: 530.1, change: -2.2, changePct: -0.41 },
    { symbol: "DIA", name: "Dow", close: 455, change: 0, changePct: 0 }
  ],
  news: [{ headline: "Made-up headline about chips", source: "Example" }]
};
assert.equal(plainSummary(day), "US stocks on 2026-11-02: S&P 500 rose 0.67% to 612.34, Nasdaq 100 fell 0.41% to 530.10, Dow rose 0.00% to 455.00.");
const prompt = buildPrompt(day);
assert.match(prompt, /SPY \(S&P 500\) 612\.34, \+0\.67%/);
assert.match(prompt, /Made-up headline about chips \(Example\)/);
assert.match(prompt, /No investment advice/);

/* ---- investments maths ---- */
{
  const accounts = [{ id: "a", type: "investment" }, { id: "b", type: "investment" }, { id: "c", type: "depository" }, { id: "d", type: "investment", hidden: true }];
  const snaps = [
    { accountId: "a", date: "2026-10-01", balanceCents: 100000 },
    { accountId: "c", date: "2026-10-01", balanceCents: 999999 },
    { accountId: "b", date: "2026-10-15", balanceCents: 50000 },
    { accountId: "d", date: "2026-10-20", balanceCents: 777777 },
    { accountId: "a", date: "2026-10-31", balanceCents: 110000 },
    { accountId: "a", date: "2026-11-01", balanceCents: 104500 }
  ];
  const series = investmentSeries(accounts, snaps);
  assert.deepEqual(series.map((p) => [p.date, p.valueCents]), [
    ["2026-10-01", 100000], ["2026-10-15", 150000], ["2026-10-31", 160000], ["2026-11-01", 154500]
  ], "checking and hidden accounts left out; b carried forward");
  assert.deepEqual(changeOver(series, 1), { cents: -5500, pct: -3.44, since: "2026-10-31" });
  assert.deepEqual(changeOver(series, 30), { cents: 54500, pct: 54.5, since: "2026-10-01" }, "30 days back lands before the first point: from the start");
  assert.deepEqual(changeOver(series, 7), { cents: 4500, pct: 3, since: "2026-10-15" });
  assert.equal(changeOver(series.slice(0, 1), 1), null);
}

/* ---- ensureMarket with a fake Finnhub ---- */
const quote = { SPY: { c: 612.34, d: 4.1, dp: 0.67 }, QQQ: { c: 530.1, d: -2.2, dp: -0.41 }, DIA: { c: 455, d: 0, dp: 0 } };
function finnhub(tradeIso, calls) {
  return async (url) => {
    calls.push(url);
    assert.ok(!/token=$/.test(url));
    const sym = /symbol=(\w+)/.exec(url);
    if (sym) return new Response(JSON.stringify(Object.assign({ t: Date.parse(tradeIso) / 1000 }, quote[sym[1]])));
    if (/\/news/.test(url)) return new Response(JSON.stringify([{ headline: "Made-up headline", source: "Example", url: "https://example.com/a" }, { headline: "", url: "javascript:x" }]));
    throw new Error("unexpected " + url);
  };
}
{
  const db = new FakeD1();
  await ensureV2(db);
  const s = scope(db, OWNER_ID);
  const env = { DB: db };
  assert.deepEqual(await ensureMarket(s, env, finnhub("2026-11-02T21:00:00Z", []), at("2026-11-02T21:30:00Z")), { status: "nokey" });
  env.FINNHUB_API_KEY = "fh-test-key";
  /* During the day: nothing to write yet, and no refetch on the next visit. */
  let calls = [];
  assert.equal((await ensureMarket(s, env, finnhub("2026-11-02T18:00:00Z", calls), at("2026-11-02T18:05:00Z"))).status, "ready");
  assert.equal((await marketHistory(s)).length, 0, "a live quote is not a recap");
  const n = calls.length;
  await ensureMarket(s, env, finnhub("2026-11-02T18:00:00Z", calls), at("2026-11-02T19:00:00Z"));
  assert.equal(calls.length, n, "checked for this session already");
  /* After the close: one recap, built from the numbers (no AI key). */
  calls = [];
  assert.equal((await ensureMarket(s, env, finnhub("2026-11-02T21:00:00Z", calls), at("2026-11-02T21:30:00Z"))).status, "ready");
  const [rec] = await marketHistory(s);
  assert.equal(rec.date, "2026-11-02");
  assert.equal(rec.by, "numbers");
  assert.match(rec.summary, /S&P 500 rose 0\.67%/);
  assert.deepEqual(rec.news, [{ headline: "Made-up headline", source: "Example", url: "https://example.com/a" }], "empty headline and non-https link dropped");
  assert.ok(!("t" in rec.quotes[0]));
  /* A holiday: the quote still says the day before; it isn't fetched twice. */
  calls = [];
  await ensureMarket(s, env, finnhub("2026-11-02T21:00:00Z", calls), at("2026-11-03T22:00:00Z"));
  assert.equal((await marketHistory(s)).length, 1, "no duplicate for the holiday");
  assert.ok(calls.length > 0);
  const m = calls.length;
  await ensureMarket(s, env, finnhub("2026-11-02T21:00:00Z", calls), at("2026-11-03T23:00:00Z"));
  assert.equal(calls.length, m);
  /* A failure is remembered and retried after 15 minutes, not on every visit. */
  const broken = async () => new Response("{}", { status: 401 });
  const r = await ensureMarket(s, env, broken, at("2026-11-04T21:30:00Z"));
  assert.equal(r.status, "error");
  assert.match(r.error, /check the key/);
  let tried = false;
  await ensureMarket(s, env, async () => { tried = true; return broken(); }, at("2026-11-04T21:35:00Z"));
  assert.equal(tried, false, "inside the retry window");
  /* With an AI key, the AI writes it; a failed AI call falls back to the numbers. */
  env.GEMINI_API_KEY = "ai-test-key";
  const withAi = async (url, init) => {
    if (/generativelanguage/.test(url)) {
      assert.match(JSON.parse(init.body).contents[0].parts[0].text, /Closes \(index funds\)/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Made-up AI recap." }] } }] }));
    }
    return finnhub("2026-11-05T21:00:00Z", [])(url);
  };
  await ensureMarket(s, env, withAi, at("2026-11-05T21:30:00Z"));
  const latest = (await marketHistory(s))[0];
  assert.equal(latest.date, "2026-11-05");
  assert.equal(latest.summary, "Made-up AI recap.");
  assert.equal(latest.by, "gemini");
}

/* ---- the routes ---- */
{
  const db = new FakeD1();
  const env = { DB: db };
  const token = await setupTestAuth(env);
  /* Settings: save the Finnhub key, never shown back. */
  const ctx = authedCtx(env, token);
  const put = await settingsRoute.onRequestPut(ctx({ finnhubApiKey: "  fh-saved-key-1234 " }, "PUT", "http://local/api/settings"));
  const st = await put.json();
  assert.deepEqual(st.finnhub, { hasKey: true, last4: "1234", source: "saved" });
  assert.ok(!JSON.stringify(st).includes("fh-saved-key"));

  const get = (mod, path) => mod.onRequestGet(ctx(undefined, "GET", "http://local/api/v2/" + path));
  /* Investments from balance snapshots. */
  await ensureV2(db);
  const s = scope(db, OWNER_ID);
  await s.run("INSERT INTO accounts (id, owner_id, name, type, balance_cents) VALUES ('inv1', ?1, 'Brokerage', 'investment', 120000)");
  await s.run("INSERT INTO accounts (id, owner_id, name, type, balance_cents) VALUES ('chk1', ?1, 'Checking', 'depository', 5000)");
  await s.batch([
    ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, 'inv1', '2026-10-30', 100000)"],
    ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, 'inv1', '2026-11-02', 120000)"],
    ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, 'chk1', '2026-11-02', 5000)"]
  ]);
  await s.setSetting("market:2026-11-02", JSON.stringify({ date: "2026-11-02", quotes: [{ symbol: "SPY", close: 600 }], summary: "x" }));
  await s.setSetting("market:2026-10-30", JSON.stringify({ date: "2026-10-30", quotes: [{ symbol: "SPY", close: 590 }], summary: "y" }));
  const inv = await (await get(investmentsRoute, "investments")).json();
  assert.deepEqual(inv.accounts.map((a) => a.name), ["Brokerage"]);
  assert.deepEqual(inv.series, [{ date: "2026-10-30", valueCents: 100000 }, { date: "2026-11-02", valueCents: 120000 }]);
  assert.equal(inv.change.day.cents, 20000);
  assert.deepEqual(inv.benchmark, [{ date: "2026-10-30", close: 590 }, { date: "2026-11-02", close: 600 }], "oldest first");
  /* Market: the saved recaps, newest first (the fetch itself is covered above). */
  await s.setSetting("market:checked", expectedSession(Date.now())); /* no network in tests */
  const mk = await (await get(marketRoute, "market")).json();
  assert.equal(mk.status, "ready");
  assert.equal(mk.latest.date, "2026-11-02");
  assert.deepEqual(mk.history.map((d) => d.date), ["2026-10-30"]);
}

console.log("market.test.mjs: all assertions passed");
