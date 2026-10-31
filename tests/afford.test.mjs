/*
 * Ask box: the forecast and affordability math (js/core/afford.js) and
 * POST /api/ask with a fake Gemini. Run: node tests/afford.test.mjs —
 * dummy data only, no network.
 */
import assert from "node:assert/strict";
import * as core from "../js/core/index.js";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { answerQuestion, followUpPurchase, onRequestPost } from "../functions/api/ask.js";

/* A plan that saves 500 a month from a 1,000 start. */
function planState() {
  const s = core.blankState();
  s.startingBalance = 1000;
  s.months.forEach((m) => { m.takeHomePay = 3000; m.rent = 2500; });
  return s;
}

// 1. Forecast: plan months add their net; finished months use actuals.
let st = planState();
let rows = core.forecast(st, "2026-11");
assert.equal(rows[0].source, "plan", "a month without actuals uses the plan");
assert.equal(rows[0].balance, 1500);
assert.equal(rows[2].balance, 2500, "Dec 2026");
const oct = st.actuals.find((a) => a.monthKey === "2026-10");
Object.assign(oct, { entered: true, takeHomePay: 3000, rent: 3200 });
rows = core.forecast(st, "2026-11");
assert.equal(rows[0].source, "actual", "a finished, entered month uses its actuals");
assert.equal(rows[0].balance, 800);
assert.equal(rows[1].source, "plan", "the current month uses the plan");
assert.equal(core.forecast(st, "2026-10")[0].source, "plan", "the current month is never treated as finished");

// 2. Affordability verdicts against the 1,000 cushion.
st = planState();
let a = core.affordCheck(st, { amount: 1200, monthKey: "2026-12", todayKey: "2026-11" });
assert.equal(a.balanceBefore, 2500);
assert.equal(a.balanceAfter, 1300);
assert.equal(a.verdict, "comfortable");
assert.equal(a.endingAfter, a.endingBefore - 1200);
assert.equal(core.affordCheck(st, { amount: 2000, monthKey: "2026-12", todayKey: "2026-11" }).verdict, "tight");
a = core.affordCheck(st, { amount: 3000, monthKey: "2026-12", todayKey: "2026-11" });
assert.equal(a.verdict, "no");
assert.deepEqual(a.monthsBelowZero, ["Dec 2026"]);
assert.equal(a.lowestAfter.month, "Dec 2026");
// A monthly cost repeats: 600 a month for 3 months from December.
a = core.affordCheck(st, { amount: 600, months: 3, monthKey: "2026-12", todayKey: "2026-11" });
assert.equal(a.totalCost, 1800);
assert.equal(a.endingAfter, a.endingBefore - 1800);
assert.ok(core.affordCheck(st, { amount: 10, monthKey: "2030-01", todayKey: "2026-11" }).error, "outside the plan");

// 3. The app reads the purchase out of the question (no AI call).
const pp = (q) => core.parsePurchase(q, "2026-10-28");
assert.deepEqual(pp("Can I afford a $1,300 iPhone in December?"), { amount: 1300, monthKey: "2026-12", monthly: false, months: 1 });
assert.equal(pp("could I buy a 2.5k laptop next month").amount, 2500);
assert.equal(pp("could I buy a 2.5k laptop next month").monthKey, "2026-11");
assert.equal(pp("Can I spend 400 dollars on a trip in January?").monthKey, "2027-01", "January means the next one");
assert.equal(pp("Can I afford $60.50 for dinner?").monthKey, "2026-10", "no month: this month");
let gym = pp("Can I afford a $40 per month gym for 6 months starting in December?");
assert.deepEqual([gym.amount, gym.monthly, gym.months, gym.monthKey], [40, true, 6, "2026-12"]);
assert.equal(pp("Can I afford $50 a month for a streaming plan?").months, 13, "monthly without a length: to the end of the plan");
assert.equal(pp("Can I afford a $900 trip in 3 months?").monthKey, "2027-01");
assert.equal(pp("Where did my money go this month?"), null, "not a purchase");
assert.equal(pp("Can I afford a new phone?"), null, "no amount: answered generally");
assert.equal(pp("Can I buy a $10 thing in may 2027").monthKey, "2027-05");
assert.equal(pp("May I afford a $10 snack?").monthKey, "2026-10", "'May I' is not the month");
assert.equal(pp("Can I afford $5,000 in December 2030?").monthKey, "2026-10", "outside the plan falls back to this month");

// 4. POST /api/ask with a fake Gemini: ONE call, answering from the app's facts.
const env = { DB: new FakeD1(), GEMINI_API_KEY: "test-key" };
const device = await setupTestAuth(env);
const prompts = [];
const fakeGemini = (replies) => async (url, init) => {
  prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
  const r = replies.shift();
  if (r === 500) return new Response("{}", { status: 500 });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: r }] } }] }), { status: 200 });
};
let out = await answerQuestion(env, { question: "Can I afford a $300 bike in December?", today: "2026-11-02" },
  fakeGemini(["Yes, comfortably."]));
assert.equal(prompts.length, 1, "one Gemini call per question");
assert.equal(out.status, 200);
assert.equal(out.data.answer, "Yes, comfortably.");
assert.equal(out.data.affordability.amount, 300);
assert.equal(out.data.affordability.month, "Dec 2026");
assert.match(prompts[0], /"affordability":\{/, "the answer prompt carries the app's computed numbers");
assert.match(prompts[0], /Use ONLY the FACTS/);
// A general question: no affordability numbers.
out = await answerQuestion(env, { question: "Where did my money go?", today: "2026-11-02" },
  fakeGemini(["Mostly rent."]));
assert.equal(out.data.affordability, null);
// Gemini down: a clear error.
await assert.rejects(answerQuestion(env, { question: "Can I afford it?" }, fakeGemini([500])), (e) => e.status === 502);
// Gemini's own reason reaches the owner (never the key).
{
  const env2 = { DB: new FakeD1(), GEMINI_API_KEY: "test-key" };
  const tok = await setupTestAuth(env2);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }), { status: 429 });
  try {
    const r = await onRequestPost(makeCtx(env2, { question: "Can I afford it?" }, "POST", "http://local/api/ask", authHeaders(tok)));
    assert.equal(r.status, 502);
    const msg = (await r.json()).error;
    assert.match(msg, /RESOURCE_EXHAUSTED: Quota exceeded/);
    assert.ok(!msg.includes("test-key"));
  } finally { globalThis.fetch = realFetch; }
}
// No key, no question.
assert.equal((await answerQuestion({ DB: new FakeD1() }, { question: "x" })).status, 409);
assert.equal((await answerQuestion(env, { question: "  " })).status, 400);
// The route is for signed-in devices only.
assert.equal((await onRequestPost(makeCtx(env, { question: "x" }, "POST", "http://local/api/ask"))).status, 401);
const keyless = { DB: new FakeD1() };
const t2 = await setupTestAuth(keyless);
const res = await onRequestPost(makeCtx(keyless, { question: "x" }, "POST", "http://local/api/ask", authHeaders(t2)));
assert.equal(res.status, 409);
assert.match((await res.json()).error, /Gemini key in Settings/);

console.log("afford.test.mjs: all assertions passed");

/* Follow-ups borrow what they leave out from the earlier question. */
const prior = [{ role: "user", text: "Can I afford a $300 bike next month?" }, { role: "assistant", text: "Yes." }];
assert.deepEqual(followUpPurchase("What about in March?", prior, "2026-10-28"), { amount: 300, monthKey: "2027-03", monthly: false, months: 1 });
assert.equal(followUpPurchase("What if it was $450?", prior, "2026-10-28").amount, 450);
assert.equal(followUpPurchase("What if it was $450?", prior, "2026-10-28").monthKey, "2026-11");
assert.equal(followUpPurchase("Where did my money go in October?", prior, "2026-10-28"), null);
assert.equal(followUpPurchase("What about in March?", [], "2026-10-28"), null);
