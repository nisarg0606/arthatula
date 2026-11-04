/*
 * Live price streaming: the pure client helpers (js/core/v2/live.js),
 * the server helpers (functions/api/_stream.js: stream tickets, the
 * symbols list, quote fetching) and the three routes end to end on a
 * fake D1 (functions/api/v2/quotes.js, stream-ticket.js, stream.js —
 * the WebSocket relay itself needs the Workers runtime, so the tests
 * stop at its auth gates). Run: node tests/live.test.mjs — made-up
 * tickers and quotes only.
 */
import assert from "node:assert/strict";
import { FakeD1, setupTestAuth, authedCtx, makeCtx } from "./_fake-d1.mjs";
import { isStreamableTicker, streamSymbols, nySession, seedQuote, applyTrade, parseStreamMessage, liveValueCents, dayTotals } from "../js/core/v2/live.js";
import { makeStreamTicket, verifyStreamTicket, parseSymbolsParam, fetchQuotes, STREAM_TICKET_TTL_MS } from "../functions/api/_stream.js";
import { getAccessCodeHash } from "../functions/api/budget.js";
import * as quotesRoute from "../functions/api/v2/quotes.js";
import * as ticketRoute from "../functions/api/v2/stream-ticket.js";
import * as streamRoute from "../functions/api/v2/stream.js";

/* ---- tickers ---- */
assert.equal(isStreamableTicker("AAPL"), true);
assert.equal(isStreamableTicker("BRK.B"), true);
assert.equal(isStreamableTicker("BF-B"), true);
assert.equal(isStreamableTicker("CUR:USD"), false);
assert.equal(isStreamableTicker("btc"), false, "lowercase is not a US ticker");
assert.equal(isStreamableTicker(""), false);
assert.equal(isStreamableTicker(null), false);
assert.deepEqual(streamSymbols([
  { ticker: "AAPL", kind: "stock" }, { ticker: "AAPL", kind: "stock" },
  { ticker: "Cash", kind: "cash" }, { ticker: "CUR:USD", kind: "other" },
  { ticker: "BRK.B", kind: "stock" }, { ticker: null, kind: "stock" }
]), ["AAPL", "BRK.B"], "deduped, cash and pseudo-tickers skipped");

/* ---- New York sessions (Nov = EST, Jul = EDT) ---- */
const at = (iso) => Date.parse(iso);
assert.equal(nySession(at("2026-11-04T15:00:00Z")), "open", "Wed 10:00 EST");
assert.equal(nySession(at("2026-11-04T13:00:00Z")), "pre", "Wed 8:00 EST");
assert.equal(nySession(at("2026-11-04T22:30:00Z")), "post", "Wed 17:30 EST");
assert.equal(nySession(at("2026-11-04T06:00:00Z")), "closed", "Wed 1:00 EST");
assert.equal(nySession(at("2026-11-07T15:00:00Z")), "closed", "Saturday");
assert.equal(nySession(at("2026-07-15T14:00:00Z")), "open", "Wed 10:00 EDT");

/* ---- quote seeding and trades ---- */
{
  const st = {};
  seedQuote(st, "AAPL", { c: 150.25, pc: 148.0, dp: 1.52, t: 1793900000 });
  assert.deepEqual(st.AAPL, { priceCents: 15025, prevCloseCents: 14800, dayPct: 1.52, t: 1793900000000, live: false });
  applyTrade(st, "AAPL", 155, 1793900060000);
  assert.equal(st.AAPL.priceCents, 15500);
  assert.equal(st.AAPL.dayPct, 4.73, "day change re-anchors to the seeded previous close");
  assert.equal(st.AAPL.live, true);
  seedQuote(st, "MSFT", { c: 110, pc: 100 }); /* no dp from the feed: computed */
  assert.equal(st.MSFT.dayPct, 10);
  seedQuote(st, "JUNK", { c: "x" });
  assert.equal(st.JUNK, undefined, "a nonsense quote seeds nothing");
  applyTrade(st, "NEW", 42.5, 1793900060000); /* a trade before any seed */
  assert.equal(st.NEW.priceCents, 4250);
  assert.equal(st.NEW.dayPct, null, "no previous close, no day change");
}

/* ---- stream frames ---- */
assert.deepEqual(parseStreamMessage('{"type":"trade","data":[{"s":"AAPL","p":155.25,"t":1793900060000,"v":10},{"s":"BAD","p":"x"}]}'),
  [{ symbol: "AAPL", price: 155.25, t: 1793900060000 }]);
assert.deepEqual(parseStreamMessage('{"type":"ping"}'), []);
assert.deepEqual(parseStreamMessage("not json"), []);

/* ---- live values ---- */
{
  const st = {};
  seedQuote(st, "AAPL", { c: 155, pc: 148 });
  seedQuote(st, "MSFT", { c: 400, pc: 410 });
  const holdings = [
    { ticker: "AAPL", kind: "stock", quantity: 10 },
    { ticker: "MSFT", kind: "stock", quantity: 5 },
    { ticker: "Cash", kind: "cash", quantity: 900 }
  ];
  assert.equal(liveValueCents(holdings[0], st), 155000);
  assert.equal(liveValueCents(holdings[2], st), null, "cash never reprices");
  assert.equal(liveValueCents({ ticker: "NONE", kind: "stock", quantity: 3 }, st), null);
  assert.deepEqual(dayTotals(holdings, st), { cents: 2000, pct: 0.57 });
  assert.equal(dayTotals([{ ticker: "NONE", kind: "stock", quantity: 3 }], st), null);
}

/* ---- stream tickets ---- */
{
  const hash = "a".repeat(64), now = 1793900000000;
  const { ticket, expiresAt } = await makeStreamTicket(hash, now);
  assert.equal(expiresAt, now + STREAM_TICKET_TTL_MS);
  assert.equal(await verifyStreamTicket(hash, ticket, now), true);
  assert.equal(await verifyStreamTicket(hash, ticket, now + STREAM_TICKET_TTL_MS + 1), false, "expired");
  assert.equal(await verifyStreamTicket("b".repeat(64), ticket, now), false, "wrong secret");
  assert.equal(await verifyStreamTicket(hash, ticket.slice(0, -2) + "zz", now), false, "tampered");
  assert.equal(await verifyStreamTicket(hash, "garbage", now), false);
  assert.equal(await verifyStreamTicket(hash, "", now), false);
  assert.equal(await verifyStreamTicket(null, ticket, now), false);
}

/* ---- symbols param + quote fetching ---- */
assert.deepEqual(parseSymbolsParam("aapl, msft,,AAPL, bad!,BRK.B,toolongtickerx"), ["AAPL", "MSFT", "BRK.B"]);
assert.deepEqual(parseSymbolsParam(""), []);
{
  const fakeFetch = async (url) => {
    assert.match(url, /token=test-key/);
    const sym = /symbol=([A-Z]+)/.exec(url)[1];
    if (sym === "MSFT") return { ok: false, status: 500, json: async () => ({}) };
    if (sym === "GOOG") return { ok: true, json: async () => ({ c: "nope" }) };
    return { ok: true, json: async () => ({ c: 250.5, d: 2.5, dp: 1.01, pc: 248, t: 1793900000 }) };
  };
  const q = await fetchQuotes("test-key", fakeFetch, ["AAPL", "MSFT", "GOOG"]);
  assert.deepEqual(Object.keys(q), ["AAPL"], "failed and nonsense symbols drop out");
  assert.equal(q.AAPL.c, 250.5);
}

/* ---- the routes ---- */
{
  const db = new FakeD1();
  const env = { DB: db, FINNHUB_API_KEY: "test-key" };
  const token = await setupTestAuth(env);
  const ctx = authedCtx(env, token);

  const noAuth = await quotesRoute.onRequestGet(makeCtx(env, undefined, "GET", "http://local/api/v2/quotes?symbols=AAPL"));
  assert.equal(noAuth.status, 401, "quotes need a session");

  const bad = await quotesRoute.onRequestGet(ctx(undefined, "GET", "http://local/api/v2/quotes?symbols=!!!"));
  assert.equal(bad.status, 400, "no valid symbol, no quote");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ c: 250.5, d: 2.5, dp: 1.01, pc: 248, t: 1793900000 }) });
  try {
    const ready = await (await quotesRoute.onRequestGet(ctx(undefined, "GET", "http://local/api/v2/quotes?symbols=ZZTEST"))).json();
    assert.equal(ready.status, "ready");
    assert.equal(ready.quotes.ZZTEST.c, 250.5);
  } finally { globalThis.fetch = realFetch; }

  const nk = await (await quotesRoute.onRequestGet(authedCtx({ DB: db }, token)(undefined, "GET", "http://local/api/v2/quotes?symbols=AAPL"))).json();
  assert.equal(nk.status, "nokey", "no env key and none saved");

  const tk = await (await ticketRoute.onRequestPost(ctx(undefined, "POST", "http://local/api/v2/stream-ticket"))).json();
  const codeHash = await getAccessCodeHash(db);
  assert.equal(await verifyStreamTicket(codeHash, tk.ticket, Date.now()), true, "the minted ticket verifies");

  const s1 = await streamRoute.onRequestGet(makeCtx(env, undefined, "GET", "http://local/api/v2/stream?ticket=" + encodeURIComponent(tk.ticket)));
  assert.equal(s1.status, 426, "no upgrade header, no stream");
  const s2 = await streamRoute.onRequestGet(makeCtx(env, undefined, "GET", "http://local/api/v2/stream?ticket=nope", { Upgrade: "websocket" }));
  assert.equal(s2.status, 401, "a bad ticket gets no stream");
}

console.log("live.test.mjs: all assertions passed");
