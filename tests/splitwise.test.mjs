/*
 * Splitwise tests: the /api/v2/splitwise route is signed-in only and
 * read-only; with no API key it reports connected:false; the Settings
 * round-trip stores the key server-side and only ever shows its last
 * 4; the normalization of Splitwise payloads (friends, groups,
 * expenses, USD totals, sign convention) is exact; and the route's
 * 5-minute cache serves repeat opens without re-calling Splitwise
 * while ?refresh=1 forces a live pull.
 * Run: node tests/splitwise.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import * as splitwise from "../functions/api/v2/splitwise.js";
import { onRequestGet as settingsGet, onRequestPut as settingsPut } from "../functions/api/settings.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const B = "http://local/api/v2/";

async function callGet(mod, route, tok) {
  const res = await mod.onRequestGet(makeCtx(env, undefined, "GET", B + route, authHeaders(tok === undefined ? token : tok)));
  return { status: res.status, data: JSON.parse(await res.text()) };
}
async function callSettings(method, body) {
  const fn = method === "GET" ? settingsGet : settingsPut;
  const res = await fn(makeCtx(env, body, method, "http://local/api/settings", authHeaders(token)));
  return { status: res.status, data: JSON.parse(await res.text()), raw: JSON.stringify(res) };
}

/* ---------- guards ---------- */
assert.equal((await callGet(splitwise, "splitwise", null)).status, 401, "no token -> 401");
assert.equal((await callGet(splitwise, "splitwise", "nope")).status, 401, "bad token -> 401");

/* ---------- not connected ---------- */
{
  const r = await callGet(splitwise, "splitwise");
  assert.equal(r.status, 200);
  assert.equal(r.data.connected, false, "no key saved -> connected:false");
  assert.equal(r.data.error, undefined, "no error when simply not connected");
}

/* ---------- pure normalization ---------- */
assert.equal(splitwise.toCents("754.26"), 75426);
assert.equal(splitwise.toCents("-439.90"), -43990);
assert.equal(splitwise.toCents("0.00"), 0);
assert.equal(splitwise.toCents("junk"), 0);
assert.equal(splitwise.personName({ first_name: "Anjali", last_name: "Patel" }), "Anjali Patel");
assert.equal(splitwise.personName({ email: "x@y.z" }), "x@y.z");

const friends = splitwise.normalizeFriends([
  { id: 2, first_name: "Mihir", last_name: "Patel", balance: [{ currency_code: "USD", amount: "-439.90" }] },
  { id: 3, first_name: "Anjali", last_name: "Patel", balance: [{ currency_code: "USD", amount: "754.26" }] },
  { id: 4, first_name: "Settled", last_name: "Up", balance: [{ currency_code: "USD", amount: "0.00" }] },
  { id: 5, first_name: "Euro", last_name: "Pal", balance: [{ currency_code: "EUR", amount: "12.00" }] }
]);
assert.equal(friends.length, 3, "settled-up friend is omitted");
assert.equal(friends[0].name, "Anjali Patel", "sorted by absolute USD balance");
assert.equal(friends[0].usdCents, 75426, "positive = friend owes the owner");
assert.equal(friends[1].usdCents, -43990, "negative = owner owes the friend");
assert.equal(friends[2].usdCents, 0, "non-USD-only friend keeps a zero USD figure");
assert.deepEqual(friends[2].balances, [{ currency: "EUR", amountCents: 1200 }]);

const groups = splitwise.normalizeGroups([
  { id: 0, name: "Non-group", members: [] },
  { id: 9, name: "Skye 3056", members: [
    { id: 1, first_name: "Nisarg", balance: [{ currency_code: "USD", amount: "-415.30" }] },
    { id: 2, first_name: "Mihir", last_name: "Patel", balance: [{ currency_code: "USD", amount: "500.00" }] }
  ] }
], 1);
assert.equal(groups.length, 1, "pseudo-group 0 is skipped");
assert.equal(groups[0].myUsdCents, -41530, "owner's own group balance is picked out");
assert.equal(groups[0].members[1].usdCents, 50000, "positive member balance = group owes them");

const expenses = splitwise.normalizeExpenses([
  { id: 11, date: "2026-10-30T05:00:00Z", description: "Groceries", cost: "60.00", currency_code: "USD", group_id: 9, payment: false,
    users: [{ user: { id: 1, first_name: "Nisarg" }, paid_share: "60.00", owed_share: "20.00", net_balance: "40.00" },
            { user: { id: 2, first_name: "Mihir", last_name: "Patel" }, paid_share: "0.00", owed_share: "40.00", net_balance: "-40.00" }] },
  { id: 12, date: "2026-10-31T05:00:00Z", description: "Settle up", cost: "100.00", currency_code: "USD", group_id: null, payment: true,
    users: [{ user: { id: 2, first_name: "Mihir", last_name: "Patel" }, paid_share: "100.00", owed_share: "0.00", net_balance: "100.00" },
            { user: { id: 1, first_name: "Nisarg" }, paid_share: "0.00", owed_share: "100.00", net_balance: "-100.00" }] },
  { id: 13, date: "2026-10-31T05:00:00Z", description: "Deleted row", cost: "5.00", deleted_at: "2026-10-31T06:00:00Z", users: [] }
], 1);
assert.equal(expenses.length, 2, "deleted expenses are dropped");
assert.equal(expenses[0].myNetCents, 4000, "owner net = paid - owed");
assert.equal(expenses[0].paidBy, "You");
assert.equal(expenses[1].payment, true, "settlements are flagged");
assert.equal(expenses[1].paidBy, "Mihir Patel");
assert.equal(expenses[1].myNetCents, -10000);

/* ---------- fetchSplitwise composes totals ---------- */
const canned = {
  "/get_current_user": { user: { id: 1, first_name: "Nisarg", last_name: "P" } },
  "/get_friends": { friends: [
    { id: 3, first_name: "Anjali", last_name: "Patel", balance: [{ currency_code: "USD", amount: "754.26" }] },
    { id: 2, first_name: "Mihir", last_name: "Patel", balance: [{ currency_code: "USD", amount: "-439.90" }] }
  ] },
  "/get_groups": { groups: [] },
  "/get_expenses?limit=25": { expenses: [] }
};
let seenAuth = null;
const fakeFetch = async (url, opts) => {
  seenAuth = opts.headers.Authorization;
  const path = url.replace(splitwise.SPLITWISE_API, "");
  return { ok: true, status: 200, json: async () => canned[path] };
};
{
  const out = await splitwise.fetchSplitwise("secret-key-1234", fakeFetch);
  assert.equal(seenAuth, "Bearer secret-key-1234", "key sent as Bearer, only to Splitwise");
  assert.equal(out.connected, true);
  assert.equal(out.me.name, "Nisarg P");
  assert.equal(out.netUsdCents, 75426 - 43990, "net = sum of friend USD balances");
  assert.equal(out.owedToYouCents, 75426);
  assert.equal(out.youOweCents, 43990);
}

/* ---------- settings round-trip: key masked, never returned ---------- */
{
  const put = await callSettings("PUT", { splitwiseApiKey: "sw-live-key-9988" });
  assert.equal(put.status, 200);
  assert.equal(put.data.splitwise.hasKey, true);
  assert.equal(put.data.splitwise.last4, "9988");
  assert.equal(put.data.splitwise.source, "saved");
  assert.ok(!JSON.stringify(put.data).includes("sw-live-key"), "full key never appears in a response");
  const get = await callSettings("GET");
  assert.equal(get.data.splitwise.hasKey, true);
  const cleared = await callSettings("PUT", { clearSplitwiseKey: true });
  assert.equal(cleared.data.splitwise.hasKey, false);
}

/* ---------- route: live pull, cache, refresh, bad key ---------- */
{
  await callSettings("PUT", { splitwiseApiKey: "sw-live-key-9988" });
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls++; return fakeFetch(url, opts); };
  try {
    const live = await callGet(splitwise, "splitwise");
    assert.equal(live.data.connected, true);
    assert.equal(live.data.netUsdCents, 31436);
    assert.equal(calls, 4, "one pull = 4 Splitwise calls");
    const cached = await callGet(splitwise, "splitwise");
    assert.equal(cached.data.cached, true, "second open inside 5 minutes is cached");
    assert.equal(calls, 4, "cache hit makes no new Splitwise calls");
    const refreshed = await callGet(splitwise, "splitwise?refresh=1");
    assert.equal(refreshed.data.cached, undefined);
    assert.equal(calls, 8, "refresh forces a live pull");
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const rejected = await callGet(splitwise, "splitwise?refresh=1");
    assert.equal(rejected.data.connected, false);
    assert.match(rejected.data.error, /didn't accept/, "a 401 from Splitwise explains the key is the problem");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("splitwise.test.mjs: all assertions passed");
