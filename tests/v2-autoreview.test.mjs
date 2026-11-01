/*
 * Auto-review tests: the name matching, the strict no-Gemini rule, the
 * Gemini prompt and answer checks (Gemini can only pick a category its
 * similar past rows used), the full run against a database with a fake
 * Gemini, "Not right" / confirm, the auto=1 filter, the summary count,
 * and "Mark all reviewed".
 * Run: node tests/v2-autoreview.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { ensureV2, scope, OWNER_ID } from "../functions/api/_v2db.js";
import {
  nameKey, similarity, evidenceFor, ruleDecision, buildReviewPrompt, parseReviewAnswer, runAutoReview, BATCH
} from "../functions/api/_v2autoreview.js";
import * as transactions from "../functions/api/v2/transactions.js";
import * as autoreview from "../functions/api/v2/autoreview.js";
import * as reports from "../functions/api/v2/reports.js";

/* ---------- names ---------- */
assert.equal(nameKey("TRADER JOE'S #552 SEATTLE"), "trader joe seattle");
assert.equal(nameKey("POS DEBIT Netflix.com 8443"), "netflix com");
assert.equal(similarity("NETFLIX.COM 123", "Netflix.com 999"), 1);
assert.equal(similarity("AMAZON MKTPL", "UBER TRIP"), 0, "different first word never matches");
assert.ok(similarity("SPOTIFY USA", "SPOTIFY P1234 USA") === 1, "digits drop out");
assert.ok(similarity("COMCAST CABLE", "COMCAST XFINITY CABLE") >= 0.6);
assert.equal(similarity("SQ *CORNER BAKERY", "SQ *TACO CART"), 0, "card-reader prefixes don't count as a name");

/* ---------- evidence + the strict rule ---------- */
const hist = [
  { id: "h1", source: "v1bank", date: "2026-09-03", merchant: "NETFLIX.COM", amountCents: -1599, categoryId: "c_sub" },
  { id: "h2", source: "v1bank", date: "2026-10-03", merchant: "NETFLIX.COM", amountCents: -1599, categoryId: "c_sub" },
  { id: "h3", source: "v1exp", date: "2026-11-04", merchant: "Farm stand", amountCents: -2310, categoryId: "c_groc" },
  { id: "h4", source: "v1bank", date: "2026-10-10", merchant: "NETFLIX.COM", amountCents: 1599, categoryId: "c_refund" }
];
const tNet = { id: "n1", date: "2026-11-03", merchant: "NETFLIX.COM 4412", amountCents: -1599 };
let ev = evidenceFor(tNet, hist);
assert.deepEqual(ev.similar.map((x) => x.id), ["h2", "h1"], "same direction only, newest first");
assert.equal(ev.duplicates.length, 0);
assert.equal(ruleDecision(tNet, ev).decision, "seen");
assert.equal(ruleDecision(tNet, ev).categoryId, "c_sub");
assert.equal(ruleDecision(tNet, evidenceFor(tNet, hist.slice(0, 1))).decision, "ask", "one past row isn't enough without Gemini");
assert.equal(ruleDecision(tNet, evidenceFor(tNet, [hist[0], Object.assign({}, hist[1], { categoryId: "c_other" })])).decision, "ask", "mixed past categories: ask");
const tDup = { id: "d1", date: "2026-11-06", merchant: "SQ *FARM STAND", amountCents: -2310 };
ev = evidenceFor(tDup, hist);
assert.equal(ev.duplicates.length, 1);
assert.equal(ruleDecision(tDup, ev).decision, "duplicate");
assert.equal(evidenceFor({ id: "d2", date: "2026-11-12", merchant: "X", amountCents: -2310 }, hist).duplicates.length, 0, "more than 3 days apart");
assert.equal(evidenceFor({ id: "d3", date: "2026-11-05", merchant: "X", amountCents: 2310 }, hist).duplicates.length, 0, "money in never matches a logged expense");

/* ---------- prompt + answer checks ---------- */
const items = [{ tx: tNet, ev: evidenceFor(tNet, hist) }, { tx: tDup, ev: evidenceFor(tDup, hist) }];
const prompt = buildReviewPrompt(items, (id) => ({ c_sub: "Subscriptions" })[id] || "?");
assert.match(prompt, /NEW id=n1 .*-\$15\.99/);
assert.match(prompt, /PAST 2026-10-03 .*categoryId=c_sub \(Subscriptions\)/);
assert.match(prompt, /DAILY LOG 2026-11-04 \| Farm stand/);
const wrap = (arr) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(arr) }] } }] });
let ans = parseReviewAnswer(wrap([
  { id: "n1", decision: "seen", categoryId: "c_sub", confidence: 0.95, reason: "Monthly Netflix." },
  { id: "d1", decision: "duplicate", confidence: 0.9, reason: "Logged as Farm stand." }
]), items);
assert.deepEqual(ans.n1, { decision: "seen", categoryId: "c_sub", reason: "Monthly Netflix." });
assert.equal(ans.d1.decision, "duplicate");
ans = parseReviewAnswer(wrap([{ id: "n1", decision: "seen", categoryId: "c_groc", confidence: 0.99 }]), items);
assert.equal(ans.n1.decision, "ask", "a category the past rows didn't use is refused");
ans = parseReviewAnswer(wrap([{ id: "n1", decision: "seen", categoryId: "c_sub", confidence: 0.5 }]), items);
assert.equal(ans.n1.decision, "ask", "low confidence is refused");
ans = parseReviewAnswer(wrap([{ id: "zz", decision: "seen", categoryId: "c_sub", confidence: 1 }]), items);
assert.deepEqual(ans, {}, "unknown ids are ignored");
assert.equal(parseReviewAnswer({ candidates: [] }, items), null);

/* ---------- full run on a database ---------- */
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
await ensureV2(env.DB);
const s = scope(env.DB, OWNER_ID);
const catId = async (name) => (await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND name = ?2", name)).id;
const ent = await catId("Entertainment").catch(() => null) || (await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND kind = 'expense'")).id;
const transfer = await catId("Transfer");
let n = 0;
async function addTx(source, date, merchant, cents, opts) {
  const o = opts || {};
  const id = "tx_t" + (++n);
  await s.run(
    "INSERT INTO transactions (id, owner_id, source, date, merchant, description, amount_cents, category_id, needs_review, hidden) VALUES (?2, ?1, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9)",
    id, source, date, merchant, cents, o.cat || null, o.review ? 1 : 0, o.hidden ? 1 : 0
  );
  return id;
}
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
await addTx("v1bank", daysAgo(60), "STREAMCO 111", -1299, { cat: ent });
await addTx("v1bank", daysAgo(30), "STREAMCO 222", -1299, { cat: ent });
await addTx("v1exp", daysAgo(2), "Corner bakery", -845, { cat: ent });
const wNew = await addTx("v1bank", today, "STREAMCO 333", -1299, { cat: transfer, review: true });
const wDup = await addTx("v1bank", daysAgo(1), "SQ *CORNER BAKERY", -845, { cat: transfer, review: true });
const wFirst = await addTx("v1bank", today, "BRAND NEW PAYEE", -50000, { cat: transfer, review: true });
const wHidden = await addTx("v1bank", today, "STREAMCO 444", -1299, { cat: transfer, review: true, hidden: true });

/* With no Gemini key: the strict rule. */
let r = await runAutoReview(s, {}, () => { throw new Error("no fetch without a key"); });
assert.deepEqual(r, { reviewed: 1, duplicates: 1, asked: 1, remaining: 0, by: "rules" });
const row = async (id) => s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND id = ?2", id);
assert.equal((await row(wNew)).needs_review, 0);
assert.equal((await row(wNew)).category_id, ent, "seen: gets the past category, so it is counted");
assert.equal((await row(wNew)).category_locked, 1, "locked so the classic mirror keeps it");
assert.equal((await row(wDup)).needs_review, 0);
assert.equal((await row(wDup)).category_id, transfer, "duplicate: stays not counted (it's in the daily log)");
assert.equal((await row(wFirst)).needs_review, 1, "a first-time payee waits for you");
assert.equal((await row(wHidden)).needs_review, 1, "hidden rows are left alone");
r = await runAutoReview(s, {});
assert.deepEqual(r, { reviewed: 0, duplicates: 0, asked: 0, remaining: 0, by: null }, "each row is looked at once");

/* With Gemini: one batched call, only for rows that have evidence. */
const wGem = await addTx("v1bank", today, "STREAMCO ANNUAL", -1299, { cat: transfer, review: true });
const wNone = await addTx("v1bank", today, "ZEBRA TOURS", -7000, { cat: transfer, review: true });
let calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  const body = JSON.parse(init.body);
  assert.match(body.contents[0].parts[0].text, /NEW id=tx_t\d+ .*STREAMCO ANNUAL/);
  assert.doesNotMatch(body.contents[0].parts[0].text, /ZEBRA/, "rows with nothing to compare skip Gemini");
  return new Response(JSON.stringify(wrap([{ id: wGem, decision: "seen", categoryId: ent, confidence: 0.92, reason: "Same streaming service as before." }])), { status: 200 });
};
r = await runAutoReview(s, { GEMINI_API_KEY: "test-key" }, fakeFetch);
assert.equal(calls.length, 1);
assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key");
assert.equal(r.by, "gemini");
assert.equal(r.reviewed, 1);
assert.equal(r.asked, 1);
assert.equal((await row(wGem)).needs_review, 0);
assert.equal((await row(wNone)).needs_review, 1);

/* Gemini down: the strict rule still applies. */
const wDown = await addTx("v1bank", today, "STREAMCO 555", -1299, { cat: transfer, review: true });
r = await runAutoReview(s, { GEMINI_API_KEY: "test-key" }, async () => new Response("busy", { status: 503 }));
assert.equal(r.by, "rules");
assert.equal((await row(wDown)).needs_review, 0);

/* Batches of BATCH. */
for (let i = 0; i < BATCH + 3; i++) await addTx("v1bank", today, "NEWCO " + i + " X" + i, -100 - i, { review: true });
r = await runAutoReview(s, {});
assert.equal(r.remaining, 3);
r = await runAutoReview(s, {});
assert.equal(r.remaining, 0);

/* ---------- the routes ---------- */
const B = "http://local/api/v2/";
async function call(mod, method, route, body) {
  const fn = mod["onRequest" + method[0] + method.slice(1).toLowerCase()];
  const res = await fn(makeCtx(env, body, method, B + route, authHeaders(token)));
  return { status: res.status, data: await res.json() };
}
assert.equal((await call(autoreview, "POST", "autoreview", {})).status, 200);
const auto = (await call(transactions, "GET", "transactions?auto=1")).data.transactions;
assert.deepEqual(auto.map((t) => t.id).sort(), [wNew, wDup, wGem, wDown].sort());
const gem = auto.find((t) => t.id === wGem);
assert.deepEqual([gem.autoReview.by, gem.autoReview.decision, gem.autoReview.reason], ["gemini", "seen", "Same streaming service as before."]);
assert.equal((await call(reports, "GET", "reports?kind=summary")).data.autoReviewedCount, 4);

/* "Not right": back on To review, never auto-reviewed again. */
let p = await call(transactions, "PATCH", "transactions", { id: wGem, patch: { needsReview: true } });
assert.equal(p.data.transaction.needsReview, true);
assert.equal(p.data.transaction.autoReview, null);
await runAutoReview(s, {});
assert.equal((await row(wGem)).needs_review, 1, "a rejected row stays with you");
/* Agreeing with one: the badge goes, it now counts as your own decision. */
p = await call(transactions, "PATCH", "transactions", { id: wNew, patch: { needsReview: false } });
assert.equal(p.data.transaction.autoReview, null);
assert.equal((await call(reports, "GET", "reports?kind=summary")).data.autoReviewedCount, 2);

/* Mark all reviewed: every visible To review row, hidden ones untouched. */
const before = (await call(transactions, "GET", "transactions?review=1")).data.total;
assert.ok(before > 3);
const all = await call(transactions, "PATCH", "transactions", { reviewAll: true });
assert.equal(all.data.updated, before);
assert.equal((await call(transactions, "GET", "transactions?review=1")).data.total, 0);
assert.equal((await row(wHidden)).needs_review, 1, "hidden rows are not touched");
assert.equal((await row(wFirst)).category_locked, 1, "bank rows are locked so the classic list can't flip them back");
assert.equal((await call(transactions, "PATCH", "transactions", { reviewAll: true })).data.updated, 0);

console.log("v2-autoreview.test.mjs: all assertions passed");
