/*
 * Dashboard feed rollup tests: since the bank feed moved to the money
 * model, the classic Dashboard's stored actuals are rolled up from the
 * daily log PLUS the feed (functions/api/budget.js rollupMonth), under
 * a claim rule that leaves every month with booked take-home pay
 * exactly as it was. Covered: a feed-only month populates (paycheck
 * included); log rows and their feed twins count once; transfers,
 * card payments, hidden / pending / placeholder rows never count; his
 * share and splits are honoured; typed-in income survives a claim and
 * later feed updates flow past it; a booked month keeps the classic
 * log-only behaviour on both the server and the client; and the
 * mirror does not copy a claimed month's feed share back into the
 * money model as typed-in actuals. The marker also carries the feed's
 * spending by day and by category name for the Dashboard graphs, and
 * the client reader for those sums is covered too.
 * Run: node tests/dashboard-feed.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, setupTestAuth, authedCtx } from "./_fake-d1.mjs";
import { readState, patchActual, syncDailyRollup, refreshFeedRollups, onRequestGet } from "../functions/api/budget.js";
import { ensureV2, scope, ensureOwner, OWNER_ID } from "../functions/api/_v2db.js";
import { loadCategories, loadTransactions } from "../functions/api/_v2store.js";
import { mirrorV1 } from "../functions/api/_v2mirror.js";
import { blank } from "./_plan.mjs";
import * as app from "../js/core/index.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctx = authedCtx(env, token);
await ensureV2(env.DB);
await ensureOwner(env.DB, OWNER_ID);
const me = scope(env.DB, OWNER_ID);
const cats = (await loadCategories(me)).categories;
const catId = (name) => cats.find((c) => c.name === name).id;
/* Two categories the owner added on top of the defaults. */
await me.run("INSERT INTO categories (id, owner_id, group_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5, 99)",
  "cat_dividends", cats[0].groupId, "Dividends", "income");
await me.run("INSERT INTO categories (id, owner_id, group_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5, 99)",
  "cat_internal", cats[0].groupId, "Internal transfers", "transfer");

let seq = 0;
async function addTx(f) {
  seq += 1;
  await me.run(
    "INSERT INTO transactions (id, owner_id, source, account_id, date, merchant, amount_cents, my_share_cents, category_id, tags, pending, hidden, exclude_reports, external_id) " +
    "VALUES (?2, ?1, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    "tx_feed_" + seq, f.source || "simplefin", f.date, f.merchant || "Feed row", f.amountCents,
    f.myShareCents === undefined ? null : f.myShareCents, f.categoryId || null,
    JSON.stringify(f.tags || []), f.pending ? 1 : 0, f.hidden ? 1 : 0, f.excludeReports ? 1 : 0,
    f.externalId || null);
  return "tx_feed_" + seq;
}
async function addLog(date, amount, category) {
  await env.DB.prepare("INSERT INTO daily_expenses (date, description, amount, category) VALUES (?, ?, ?, ?)")
    .bind(date, "Log row", amount, category).run();
}
const actualOf = async (monthKey) => (await readState(env.DB)).actuals.find((a) => a.monthKey === monthKey);

/* ---------- A. feed-only month: actuals populate, paycheck included ---------- */
await addTx({ date: "2026-11-03", amountCents: 595200, categoryId: catId("Paycheck") });
await addTx({ date: "2026-11-05", amountCents: 1200, categoryId: catId("Interest") });
await addTx({ date: "2026-11-06", amountCents: 2500, categoryId: "cat_dividends" });
await addTx({ date: "2026-11-07", amountCents: 4000, categoryId: catId("Repayment") });
await addTx({ date: "2026-11-08", amountCents: -15000, categoryId: catId("Groceries") });
await addTx({ date: "2026-11-01", amountCents: -71800, categoryId: catId("Rent") });
await addTx({ date: "2026-11-09", amountCents: 20000, categoryId: catId("Credit card payment") });
await addTx({ date: "2026-11-10", amountCents: -50000, categoryId: catId("Transfer") });
/* The budget GET itself refreshes: read the month back through it. */
{
  const res = await onRequestGet(ctx(undefined, "GET", "http://local/api/budget"));
  assert.equal(res.status, 200);
  const nov = (await res.json()).actuals.find((a) => a.monthKey === "2026-11");
  assert.equal(nov.entered, true);
  assert.equal(nov.takeHomePay, 5952, "feed paycheck becomes the month's take-home pay");
  assert.equal(nov.otherIncome, 12 + 25 + 40, "interest + dividends + repayments are other income");
  assert.equal(nov.groceries, 150);
  assert.equal(nov.rent, 718);
  assert.equal(nov.creditCardPayment, 0, "card payments are transfers, never actuals");
  assert.ok(nov.feedRollup && nov.feedRollup.takeHomePay === 595200, "the month is marked feed-inclusive");
  const dec = (await readState(env.DB)).actuals.find((a) => a.monthKey === "2026-12");
  assert.equal(dec.entered, false, "an untouched month stays unentered");
  assert.equal(dec.feedRollup, null);
}
/* The mirror must not copy November's feed share back as typed actuals:
   no v1actual rows for the month, so the new app never counts it twice. */
await mirrorV1(env.DB, { force: true });
{
  const txs = await loadTransactions(me);
  assert.ok(!txs.some((t) => t.source === "v1actual" && t.date.slice(0, 7) === "2026-11"),
    "no v1actual rows for a feed-claimed month");
}

/* ---------- B. log rows + feed twins count once ---------- */
await addLog("2026-12-05", 80, "Groceries");
/* The mirror's own copy of that log row, plus a distinct feed charge. */
await addTx({ date: "2026-12-05", amountCents: -8000, categoryId: catId("Groceries"), source: "v1exp" });
await addTx({ date: "2026-12-06", amountCents: -2000, categoryId: catId("Groceries") });
await addTx({ date: "2026-12-03", amountCents: 100000, categoryId: catId("Paycheck") });
await syncDailyRollup(env.DB, "2026-12");
{
  const dec = await actualOf("2026-12");
  assert.equal(dec.groceries, 100, "log 80 + feed 20; the v1exp twin is not counted again");
  assert.equal(dec.takeHomePay, 1000);
  assert.ok(dec.feedRollup, "December is marked too");
}

/* ---------- C. what never counts ---------- */
await addTx({ date: "2027-01-05", amountCents: -99900, categoryId: catId("Groceries"), hidden: true });
await addTx({ date: "2027-01-06", amountCents: -55500, categoryId: catId("Groceries"), tags: ["pending-placeholder"] });
await addTx({ date: "2027-01-07", amountCents: -44400, categoryId: catId("Groceries"), pending: true });
await addTx({ date: "2027-01-08", amountCents: -33300, categoryId: catId("Groceries"), excludeReports: true });
await addTx({ date: "2027-01-09", amountCents: -30000, categoryId: catId("Investments") });
await addTx({ date: "2027-01-10", amountCents: 70000, categoryId: "cat_internal" });
await addTx({ date: "2027-01-11", amountCents: -2500, categoryId: catId("Eating Out") });
await refreshFeedRollups(env.DB);
{
  const jan = await actualOf("2027-01");
  assert.equal(jan.groceries, 0, "hidden, placeholder, pending and report-excluded rows stay out");
  assert.equal(jan.eatingOut, 25, "the one ordinary charge counts");
  assert.equal(jan.otherIncome, 0, "internal transfers are not income");
  assert.equal(jan.entered, true);
}

/* ---------- D. his share and splits ---------- */
await addTx({ date: "2027-02-10", amountCents: -19322, myShareCents: -10099, categoryId: catId("Groceries") });
const splitTx = await addTx({ date: "2027-02-11", amountCents: -10000 });
await me.run("INSERT INTO transaction_splits (id, owner_id, transaction_id, category_id, amount_cents) VALUES (?2, ?1, ?3, ?4, ?5)",
  "split_a", splitTx, catId("Groceries"), -6000);
await me.run("INSERT INTO transaction_splits (id, owner_id, transaction_id, category_id, amount_cents) VALUES (?2, ?1, ?3, ?4, ?5)",
  "split_b", splitTx, catId("Eating Out"), -4000);
await refreshFeedRollups(env.DB);
{
  const feb = await actualOf("2027-02");
  assert.equal(Math.round(feb.groceries * 100), 10099 + 6000, "his share of the shared bill + the split's grocery line");
  assert.equal(feb.eatingOut, 40, "the split's eating-out line, not the full amount again");
}

/* ---------- F. typed-in income survives a claim; feed updates flow past it ---------- */
await patchActual(env.DB, "2027-03", { otherIncome: 50 });
await addTx({ date: "2027-03-05", amountCents: 1000, categoryId: catId("Interest") });
await addTx({ date: "2027-03-06", amountCents: -3000, categoryId: catId("Groceries") });
await refreshFeedRollups(env.DB);
{
  const mar = await actualOf("2027-03");
  assert.equal(mar.otherIncome, 60, "typed 50 + feed interest 10");
  assert.equal(mar.groceries, 30);
  assert.equal(mar.feedRollup.otherIncome, 1000, "the marker remembers only the feed's share");
}
await addTx({ date: "2027-03-20", amountCents: 500, categoryId: catId("Interest") });
await refreshFeedRollups(env.DB);
{
  const mar = await actualOf("2027-03");
  assert.equal(mar.otherIncome, 65, "typed 50 + feed interest now 15: updates flow, the typed part stays");
}

/* ---------- E. a month with booked pay is never claimed ---------- */
await patchActual(env.DB, "2026-10", { takeHomePay: 2050 });
await addLog("2026-10-28", 10, "Groceries");
await addTx({ date: "2026-10-27", amountCents: 99900, categoryId: catId("Paycheck") });
await addTx({ date: "2026-10-27", amountCents: -77700, categoryId: catId("Groceries") });
await refreshFeedRollups(env.DB);
await syncDailyRollup(env.DB, "2026-10");
{
  const oct = await actualOf("2026-10");
  assert.equal(oct.takeHomePay, 2050, "booked pay stands; the feed's paycheck is not added");
  assert.equal(oct.groceries, 10, "the classic log-only rollup still owns a booked month's expenses");
  assert.equal(oct.feedRollup, null, "a booked month is never marked");
}

/* ---------- G. client: the overlay skips marked months only ---------- */
{
  const marked = blank();
  const a = marked.actuals.find((x) => x.monthKey === "2026-11");
  a.entered = true; a.takeHomePay = 5952; a.groceries = 150;
  a.feedRollup = { takeHomePay: 595200, groceries: 15000 };
  marked.dailyExpenses.push({ id: 1, date: "2026-11-05", description: "Log row", amount: 80, category: "Groceries", categorizationSource: "rules" });
  const row = app.computeComparison(marked).rows.find((r) => r.monthKey === "2026-11");
  assert.equal(row.actualExpenses, 150, "marked: stored (log + feed) stands, no log overlay");
  assert.equal(row.actualIncome, 5952);
  const dash = app.computeDashboard(marked, false);
  assert.equal(dash.totals.income, 5952, "the dashboard totals use the stored feed-inclusive figures");

  const plain = blank();
  const b = plain.actuals.find((x) => x.monthKey === "2026-11");
  b.entered = true; b.takeHomePay = 5952; b.groceries = 150;
  plain.dailyExpenses.push({ id: 1, date: "2026-11-05", description: "Log row", amount: 80, category: "Groceries", categorizationSource: "rules" });
  const row2 = app.computeComparison(plain).rows.find((r) => r.monthKey === "2026-11");
  assert.equal(row2.actualExpenses, 80, "unmarked: the log overlay applies exactly as before");

  const clean = app.sanitizeState({ months: [], actuals: [{ monthKey: "2026-11", takeHomePay: 100, feedRollup: { takeHomePay: 10000 } }] });
  assert.deepEqual(clean.actuals.find((x) => x.monthKey === "2026-11").feedRollup, { takeHomePay: 10000 },
    "the marker survives a load/save round trip");
}

/* ---------- H. reviewed bank-mirror rows stay out; unreviewed ones count ---------- */
/* The classic Bank tab already accounts for a reviewed bank row itself
   (an "income" review is booked into the month's actuals), so the feed
   side of the rollup must skip it — but an unreviewed snapshot row is
   feed data like any other and counts. */
await addTx({ date: "2027-04-05", amountCents: 30000, categoryId: catId("Other income"), source: "v1bank", externalId: "bank:bv_rev" });
await env.DB.prepare("INSERT INTO bank_tx_review (plaid_transaction_id, kind, updated_at) VALUES (?, 'income', datetime('now'))")
  .bind("bv_rev").run();
await addTx({ date: "2027-04-06", amountCents: -4500, categoryId: catId("Groceries"), source: "v1bank", externalId: "bank:bv_plain" });
await refreshFeedRollups(env.DB);
{
  const apr = await actualOf("2027-04");
  assert.equal(apr.otherIncome, 0, "a bank row reviewed as income is already booked by the classic flow");
  assert.equal(apr.groceries, 45, "an unreviewed bank-mirror row still counts as feed");
  assert.ok(apr.feedRollup, "April is marked");
}

/* ---------- I. booking pay by hand hands a claimed month back ---------- */
await addTx({ date: "2027-05-03", amountCents: 100000, categoryId: catId("Paycheck") });
await refreshFeedRollups(env.DB);
{
  const may = await actualOf("2027-05");
  assert.equal(may.takeHomePay, 1000, "the feed claims May first");
  assert.ok(may.feedRollup, "May is marked");
}
await patchActual(env.DB, "2027-05", { takeHomePay: 1500 });
await refreshFeedRollups(env.DB);
{
  const may = await actualOf("2027-05");
  assert.equal(may.feedRollup, null, "booking pay by hand clears the marker");
  assert.equal(may.takeHomePay, 1500, "the booked figure stands, feed share backed out");
}
await addTx({ date: "2027-05-20", amountCents: 50000, categoryId: catId("Paycheck") });
await refreshFeedRollups(env.DB);
{
  const may = await actualOf("2027-05");
  assert.equal(may.takeHomePay, 1500, "once handed back, the feed no longer flows into the month");
  assert.equal(may.feedRollup, null);
}

/* ---------- J. the marker also carries the feed's spending by day and category ---------- */
/* The Dashboard graphs draw from the log alone, so the marker also
   carries the feed's spending sums — same rows, same rules as the
   field totals above — for the graphs to add on top of the log's. */
await addTx({ date: "2027-06-03", amountCents: -10332, categoryId: catId("Groceries") });
await addTx({ date: "2027-06-04", amountCents: -5000, categoryId: catId("Groceries") });
await addTx({ date: "2027-06-04", amountCents: 2000, categoryId: catId("Groceries") }); /* a refund nets against its day */
await addTx({ date: "2027-06-05", amountCents: -19322, myShareCents: -10099, categoryId: catId("Eating Out") });
const splitTx2 = await addTx({ date: "2027-06-06", amountCents: -10000 });
await me.run("INSERT INTO transaction_splits (id, owner_id, transaction_id, category_id, amount_cents) VALUES (?2, ?1, ?3, ?4, ?5)",
  "split_c", splitTx2, catId("Groceries"), -6000);
await me.run("INSERT INTO transaction_splits (id, owner_id, transaction_id, category_id, amount_cents) VALUES (?2, ?1, ?3, ?4, ?5)",
  "split_d", splitTx2, catId("Eating Out"), -4000);
await addTx({ date: "2027-06-09", amountCents: -99900, categoryId: catId("Groceries"), tags: ["pending-placeholder"] });
await addTx({ date: "2027-06-10", amountCents: -50000, categoryId: catId("Transfer") });
await addTx({ date: "2027-06-11", amountCents: -88800, categoryId: catId("Groceries"), hidden: true });
await addTx({ date: "2027-06-12", amountCents: -77700, categoryId: catId("Groceries"), source: "v1exp" });
await addTx({ date: "2027-06-13", amountCents: -66600, categoryId: catId("Groceries"), source: "v1bank", externalId: "bank:fc_rev" });
await env.DB.prepare("INSERT INTO bank_tx_review (plaid_transaction_id, kind, updated_at) VALUES (?, 'expense', datetime('now'))")
  .bind("fc_rev").run();
await addTx({ date: "2027-06-14", amountCents: -4500, categoryId: catId("Groceries"), source: "v1bank", externalId: "bank:fc_plain" });
await addTx({ date: "2027-06-15", amountCents: 100000, categoryId: catId("Paycheck") });
await addTx({ date: "2027-06-16", amountCents: -25000, categoryId: catId("Sent to India") });
await refreshFeedRollups(env.DB);
{
  const jun = await actualOf("2027-06");
  assert.ok(jun.feedRollup, "June is marked");
  assert.deepEqual(jun.feedRollup.perDayCents,
    { "3": 10332, "4": 3000, "5": 10099, "6": 10000, "14": 4500, "16": 25000 },
    "per-day: charges land on their days, his share and splits count, the refund nets, " +
    "placeholder / transfer / off-reports / twin / reviewed rows never appear");
  assert.deepEqual(jun.feedRollup.byCategoryCents,
    { "Groceries": 23832, "Eating Out": 14099, "Sent to India": 25000 },
    "by category name, under the feed's own names");
  assert.equal(jun.feedRollup.groceries, 23832, "the field share and the category sum agree");
  assert.equal(jun.feedRollup.takeHomePay, 100000, "pay is a field share only, never chart spending");
  const sum = (o) => Object.values(o || {}).reduce((s, v) => s + v, 0);
  assert.equal(sum(jun.feedRollup.perDayCents), sum(jun.feedRollup.byCategoryCents),
    "the two sums describe the same spending");
  assert.equal(sum(jun.feedRollup.perDayCents), 23832 + 14099 + 25000);
  assert.equal(jun.groceries, 238.32);
  assert.equal(jun.oneOffs, 250, "Sent to India still files under one-offs in the fields");
}

/* ---------- K. client: the graph reader for the marker ---------- */
{
  assert.deepEqual(app.feedChartData(null), { perDay: {}, byCategory: {} }, "no actual, no feed");
  assert.deepEqual(app.feedChartData({}), { perDay: {}, byCategory: {} }, "an unclaimed month");
  assert.deepEqual(app.feedChartData({ feedRollup: { takeHomePay: 595200, groceries: 15000 } }),
    { perDay: {}, byCategory: {} }, "a marker from before the sums existed reads as log-only");
  const data = app.feedChartData({ feedRollup: {
    takeHomePay: 100000,
    perDayCents: { "3": 10332, "16": 25000 },
    byCategoryCents: { "Groceries": 23832, "Sent to India": 25000 }
  } });
  assert.deepEqual(data.perDay, { "3": 103.32, "16": 250 }, "cents become dollars, keyed by day");
  assert.deepEqual(data.byCategory, { "Groceries": 238.32, "Sent to India": 250 });
  assert.deepEqual(app.feedChartData({ feedRollup: { perDayCents: { "0": 500, "32": 500, "x": 500, "5": "700", "6": 0 } } }),
    { perDay: {}, byCategory: {} }, "stray keys and values are dropped");
  /* The merge the graphs perform: log-shaped days and categories,
     with the feed's sums added on top. */
  const perDay = [0, 0, 50, 0, 0, 0];
  Object.keys(data.perDay).forEach((k) => { perDay[Number(k) - 1] = Math.round(((perDay[Number(k) - 1] || 0) + data.perDay[k]) * 100) / 100; });
  assert.equal(perDay[2], 153.32, "the feed's day-3 charge adds onto the log's day-3 bar");
  assert.equal(perDay[15], 250, "a feed-only day appears");
  const catTotals = { "Groceries": 80 };
  Object.keys(data.byCategory).forEach((name) => { catTotals[name] = Math.round(((catTotals[name] || 0) + data.byCategory[name]) * 100) / 100; });
  assert.equal(catTotals["Groceries"], 318.32, "same-name categories merge");
  assert.equal(catTotals["Sent to India"], 250, "a feed-only category appears under its own name");
}

/* ---------- L. the mirror pays no attention to the chart sums ---------- */
/* June's stored actual is the feed alone (no log rows, nothing typed),
   so a marker whose field shares the mirror nets out leaves nothing
   to copy — the two extra keys must not leak into that arithmetic. */
await mirrorV1(env.DB, { force: true });
{
  const txs = await loadTransactions(me);
  assert.ok(!txs.some((t) => t.source === "v1actual" && t.date.slice(0, 7) === "2027-06"),
    "no v1actual rows for June: the chart sums in its marker changed nothing");
}

console.log("dashboard-feed.test.mjs: all assertions passed");
