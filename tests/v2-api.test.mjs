/*
 * v2 API tests: every /api/v2 route requires sign-in and refuses sync
 * tokens (except the sync push, which ONLY a sync token may call); no v2
 * route touches the database except through the scoped helper; and each
 * endpoint works: accounts (manual + net worth), transactions (list,
 * filters, search, add, edit, splits, write-back to the classic daily
 * log, delete), categories, rules (+ apply), budgets (set, rollover,
 * copy, fill), reports (summary, cash flow, forecast), recurring
 * (suggest, confirm, dismiss, manual), goals, net worth, sync push,
 * export (JSON + CSV) and the migration gate.
 * Run: node tests/v2-api.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { onRequestPost as authPost } from "../functions/api/auth.js";
import { onRequestPost as expPost, onRequestGet as expGet } from "../functions/api/expenses.js";
import { onRequestPost as cardsPost } from "../functions/api/cards.js";
import { upsertBankData, sha256Hex } from "../functions/api/budget.js";
import * as accounts from "../functions/api/v2/accounts.js";
import * as transactions from "../functions/api/v2/transactions.js";
import * as categories from "../functions/api/v2/categories.js";
import * as rules from "../functions/api/v2/rules.js";
import * as budgets from "../functions/api/v2/budgets.js";
import * as reports from "../functions/api/v2/reports.js";
import * as recurring from "../functions/api/v2/recurring.js";
import * as goals from "../functions/api/v2/goals.js";
import * as networth from "../functions/api/v2/networth.js";
import * as sync from "../functions/api/v2/sync.js";
import * as exporter from "../functions/api/v2/export.js";
import * as migration from "../functions/api/v2/migration.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const B = "http://local/api/v2/";
async function call(mod, method, route, body, tok) {
  const fn = mod["onRequest" + method[0] + method.slice(1).toLowerCase()];
  const res = await fn(makeCtx(env, body, method, B + route, authHeaders(tok === undefined ? token : tok)));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.ok(r.status >= 200 && r.status < 300, args[1] + " " + args[2] + " -> " + r.status + " " + JSON.stringify(r.data));
  return r.data;
};

/* ---------- guards ---------- */
const routes = [
  [accounts, "GET", "accounts"], [transactions, "GET", "transactions"], [categories, "GET", "categories"], [rules, "GET", "rules"],
  [budgets, "GET", "budgets?month=2026-11"], [reports, "GET", "reports?kind=summary"], [recurring, "GET", "recurring"],
  [goals, "GET", "goals"], [networth, "GET", "networth"], [exporter, "GET", "export?format=json"], [migration, "GET", "migration"],
  [transactions, "POST", "transactions"], [accounts, "PATCH", "accounts"], [budgets, "PUT", "budgets"]
];
for (const [mod, m, r] of routes) {
  assert.equal((await call(mod, m, r, m === "GET" ? undefined : {}, null)).status, 401, m + " " + r + " without a token");
  assert.equal((await call(mod, m, r, m === "GET" ? undefined : {}, "nope")).status, 401, m + " " + r + " with a bad token");
}
/* A paired sync token: refused everywhere except the sync push. */
async function pairedSyncToken() {
  const raw = "v2-api-test-sync-token-0123456789";
  let res = await authPost(makeCtx(env, { action: "pair-open" }, "POST", "http://local/api/auth", authHeaders(token)));
  const code = (await res.json()).code;
  res = await authPost(makeCtx(env, { action: "pair-request", pairCode: code, tokenHash: await sha256Hex(raw) }, "POST", "http://local/api/auth"));
  const fingerprint = (await res.json()).fingerprint;
  await authPost(makeCtx(env, { action: "pair-approve", fingerprint }, "POST", "http://local/api/auth", authHeaders(token)));
  return raw;
}
const syncTok = await pairedSyncToken();
for (const [mod, m, r] of routes) {
  assert.equal((await call(mod, m, r, m === "GET" ? undefined : {}, syncTok)).status, 403, m + " " + r + " refuses a sync token");
}
assert.equal((await call(sync, "POST", "sync", { accounts: [] })).status, 403, "a device can't push sync data");

/* No v2 module reaches the database except through the scoped helper. */
const v2dir = path.resolve("functions/api/v2");
for (const f of fs.readdirSync(v2dir)) {
  const src = fs.readFileSync(path.join(v2dir, f), "utf8");
  assert.ok(!/\bdb\.prepare\(|\.DB\.prepare\(/.test(src), f + " must use the scoped helper, not db.prepare");
}

/* ---------- seed classic data ---------- */
const EXP = "http://local/api/expenses";
const addExp = async (body) => (await (await expPost(makeCtx(env, body, "POST", EXP, authHeaders(token)))).json()).expense;
const netflixDates = ["2026-08-15", "2026-09-15", "2026-10-15"];
for (const d of netflixDates) await addExp({ date: d, description: "NETFLIX.COM", amount: 15.49, category: "Subscriptions" });
const groceries = await addExp({ date: "2026-11-03", description: "Whole Foods", amount: 82.4, category: "Groceries" });
await addExp({ date: "2026-11-04", description: "Dinner", amount: 90, myShare: 30, category: "Eating Out" });
await upsertBankData(env.DB, {
  accounts: [{ id: "chk", institution: "Test Bank", name: "Checking", subtype: "checking", currentBalance: 5000 }],
  transactions: [{ id: "b1", accountId: "chk", date: "2026-11-05", name: "AUTOPAY CARD", amount: 400 }]
});

/* ---------- categories ---------- */
let cat = await ok(categories, "GET", "categories");
assert.ok(cat.groups.length >= 8 && cat.categories.length >= 19);
const id = (name) => cat.categories.find((c) => c.name === name).id;
const lifestyle = cat.groups.find((g) => g.name === "Lifestyle").id;
cat = await ok(categories, "POST", "categories", { type: "category", name: "Coffee", groupId: lifestyle });
assert.equal(cat.categories.find((c) => c.name === "Coffee").kind, "expense", "a category takes its group's kind");
assert.equal((await call(categories, "POST", "categories", { type: "category", name: "coffee", groupId: lifestyle })).status, 409, "names are unique, case-insensitive");
cat = await ok(categories, "POST", "categories", { type: "category", name: "Temp", groupId: lifestyle });
cat = await ok(categories, "PATCH", "categories", { type: "category", id: id("Temp"), patch: { name: "Temporary" } });
assert.ok(cat.categories.some((c) => c.name === "Temporary"));

/* ---------- accounts ---------- */
let acc = await ok(accounts, "GET", "accounts");
const chk = acc.accounts.find((a) => a.externalId === "plaid:chk");
assert.equal(chk.balanceCents, 500000);
const house = (await call(accounts, "POST", "accounts", { name: "Car", type: "property", balanceCents: 1200000 })).data.account;
const loan = (await call(accounts, "POST", "accounts", { name: "Car loan", type: "loan", balanceCents: 800000 })).data.account;
acc = await ok(accounts, "GET", "accounts");
assert.equal(acc.netWorth.netWorthCents, 500000 + 1200000 - 800000, "assets minus what is owed");
await ok(accounts, "PATCH", "accounts", { id: loan.id, patch: { balanceCents: 750000 } });
assert.equal((await call(accounts, "PATCH", "accounts", { id: chk.id, patch: { balanceCents: 1 } })).status, 409, "synced balances aren't editable");
await ok(accounts, "PATCH", "accounts", { id: house.id, patch: { includeInNetWorth: false } });
acc = await ok(accounts, "GET", "accounts");
assert.equal(acc.netWorth.netWorthCents, 500000 - 750000);
assert.equal((await call(accounts, "POST", "accounts", { name: "", type: "cash" })).status, 400);
assert.equal((await call(accounts, "POST", "accounts", { name: "X", type: "boat" })).status, 400);
assert.equal((await call(accounts, "DELETE", "accounts?id=" + chk.id)).status, 409, "synced accounts can only be hidden");

/* ---------- transactions ---------- */
let list = await ok(transactions, "GET", "transactions");
assert.ok(list.total >= 6);
assert.equal((await ok(transactions, "GET", "transactions?q=whole")).total, 1, "search");
assert.equal((await ok(transactions, "GET", "transactions?review=1")).total, 1, "the unreviewed card autopay is to review");
assert.equal((await ok(transactions, "GET", "transactions?from=2026-11-01&to=2026-11-30")).transactions.every((t) => t.date >= "2026-11-01"), true);
const wf = list.transactions.find((t) => t.merchant === "Whole Foods");
assert.equal(wf.amountCents, -8240);

/* Edit a classic row: written back to the daily log. */
let t = (await ok(transactions, "PATCH", "transactions", { id: wf.id, patch: { notes: "big shop", amountCents: -9000, categoryId: id("Eating Out") } })).transaction;
assert.equal(t.amountCents, -9000);
assert.equal(t.notes, "big shop");
assert.equal(t.categoryId, id("Eating Out"));
const classic = (await (await expGet(makeCtx(env, undefined, "GET", EXP, authHeaders(token)))).json()).expenses.find((e) => e.id === groceries.id);
assert.equal(classic.amount, 90, "amount written back");
assert.equal(classic.note, "big shop", "note written back");
assert.equal(classic.category, "Eating Out", "category written back");
/* A new-app-only category stays on the new app. */
t = (await ok(transactions, "PATCH", "transactions", { id: wf.id, patch: { categoryId: id("Coffee") } })).transaction;
assert.equal(t.categoryId, id("Coffee"));
assert.equal(t.categoryLocked, true);
/* Splits must add up. */
assert.equal((await call(transactions, "PATCH", "transactions", { id: wf.id, patch: { splits: [{ categoryId: id("Groceries"), amountCents: -5000 }, { categoryId: id("Coffee"), amountCents: -3000 }] } })).status, 400);
t = (await ok(transactions, "PATCH", "transactions", { id: wf.id, patch: { splits: [{ categoryId: id("Groceries"), amountCents: -6000 }, { categoryId: id("Coffee"), amountCents: -3000 }] } })).transaction;
assert.equal(t.splits.length, 2);
/* Bank rows: categorize + clear review; their amount is the bank's. */
const autopay = list.transactions.find((x) => x.merchant === "AUTOPAY CARD");
t = (await ok(transactions, "PATCH", "transactions", { id: autopay.id, patch: { categoryId: id("Credit card payment") } })).transaction;
assert.equal(t.needsReview, false);
assert.equal((await call(transactions, "PATCH", "transactions", { id: autopay.id, patch: { amountCents: -1 } })).status, 409);
/* A row of your own: add, tag, move, delete. */
const mine = (await call(transactions, "POST", "transactions", { date: "2026-11-06", merchant: "Farmers market", amountCents: -2500, categoryId: id("Groceries"), accountId: chk.id, tags: ["cash", "cash", "weekend"] })).data.transaction;
assert.deepEqual(mine.tags, ["cash", "weekend"]);
assert.equal((await call(transactions, "POST", "transactions", { date: "2026-02-30", merchant: "x", amountCents: -1 })).status, 400, "impossible date");
assert.equal((await call(transactions, "POST", "transactions", { date: "2026-11-06", merchant: "x", amountCents: 1.5 })).status, 400, "cents are whole");
assert.equal((await call(transactions, "PATCH", "transactions", { id: mine.id, patch: { myShareCents: -3000 } })).status, 400, "share above amount");
await ok(transactions, "PATCH", "transactions", { id: mine.id, patch: { hidden: true } });
assert.ok(!(await ok(transactions, "GET", "transactions")).transactions.some((x) => x.id === mine.id), "hidden rows are left out");
assert.ok((await ok(transactions, "GET", "transactions?hidden=1")).transactions.some((x) => x.id === mine.id));
await ok(transactions, "DELETE", "transactions?id=" + mine.id);
assert.equal((await call(transactions, "DELETE", "transactions?id=" + autopay.id)).status, 409, "bank rows are hidden, not deleted");
/* Deleting a classic row deletes it from the daily log too. */
const dinner = list.transactions.find((x) => x.merchant === "Dinner");
assert.equal(dinner.myShareCents, -3000);
await ok(transactions, "DELETE", "transactions?id=" + dinner.id);
assert.ok(!(await (await expGet(makeCtx(env, undefined, "GET", EXP, authHeaders(token)))).json()).expenses.some((e) => e.description === "Dinner"));

/* Deleting a category moves its rows. */
cat = await ok(categories, "DELETE", "categories?type=category&id=" + id("Temporary") + "&moveTo=" + id("Misc/Other"));
assert.ok(!cat.categories.some((c) => c.name === "Temporary"));

/* ---------- rules ---------- */
assert.equal((await call(rules, "POST", "rules", { matchText: "", setHidden: true })).status, 400, "a rule needs a match");
let rr = (await call(rules, "POST", "rules", { matchText: "autopay", setCategoryId: id("Credit card payment"), addTag: "card" })).data;
await upsertBankData(env.DB, { transactions: [{ id: "b2", accountId: "chk", date: "2026-11-25", name: "AUTOPAY CARD", amount: 300 }] });
const b2 = (await ok(transactions, "GET", "transactions?q=autopay")).transactions.find((x) => x.externalId === "bank:b2");
assert.equal(b2.categoryId, id("Credit card payment"), "rules file new transactions");
assert.deepEqual(b2.tags, ["card"]);
rr = await ok(rules, "POST", "rules", { action: "apply", id: rr.rules[0].id });
assert.ok(rr.changed >= 1, "apply tags the earlier autopay");

/* ---------- budgets ---------- */
await ok(budgets, "PUT", "budgets", { month: "2026-11", categoryId: id("Groceries"), amountCents: 50000, rollover: true });
await ok(budgets, "PUT", "budgets", { month: "2026-11", categoryId: id("Paycheck"), amountCents: 410000 });
let bm = await ok(budgets, "PUT", "budgets", { month: "2026-12", categoryId: id("Groceries"), amountCents: 50000, rollover: true });
const g = bm.rows.find((r) => r.categoryId === id("Groceries"));
assert.equal(g.rolloverCents, 50000 - 6000 - 2500 * 0, "November's leftover (minus the split part) rolls into December");
assert.equal((await call(budgets, "PUT", "budgets", { month: "2026-13", categoryId: id("Groceries"), amountCents: 1 })).status, 400);
assert.equal((await call(budgets, "PUT", "budgets", { month: "2026-11", categoryId: id("Transfer"), amountCents: 1 })).status, 400, "transfers aren't budgeted");
bm = await ok(budgets, "POST", "budgets", { action: "copy", from: "2026-11", to: "2027-03" });
assert.equal(bm.plannedIncomeCents, 410000);
const fill = await ok(budgets, "POST", "budgets", { action: "fill", from: "2027-03", through: "2027-06" });
assert.deepEqual(fill.months, ["2027-04", "2027-05", "2027-06"]);
bm = await ok(budgets, "PUT", "budgets", { month: "2027-06", categoryId: id("Groceries"), amountCents: 0 });
assert.ok(!bm.rows.some((r) => r.categoryId === id("Groceries") && r.plannedCents), "0 removes the line");

/* ---------- reports ---------- */
const cf = await ok(reports, "GET", "reports?kind=cashflow&from=2026-08&to=2026-11");
assert.equal(cf.months.length, 4);
assert.equal(cf.months[0].spendingCents, 1549, "August is before the baseline date: it still counts as history");
assert.equal(cf.months[3].spendingCents, 9000, "November = the split Whole Foods row (card payment is a transfer)");
assert.equal((await call(reports, "GET", "reports?kind=cashflow&from=2026-12&to=2026-11")).status, 400);
const fc = await ok(reports, "GET", "reports?kind=forecast&months=6");
assert.equal(fc.months.length, 6);
assert.equal(fc.cashCents, 500000, "cash = checking (the loan and car aren't cash)");
const sm = await ok(reports, "GET", "reports?kind=summary&month=2026-11");
assert.equal(sm.month, "2026-11");
assert.ok(sm.spendingCents > 0);
assert.ok(Array.isArray(sm.upcoming) && Array.isArray(sm.topCategories));
assert.equal(typeof sm.reviewCount, "number");
assert.equal((await call(reports, "GET", "reports?kind=nope")).status, 400);

/* ---------- recurring ---------- */
let rc = await ok(recurring, "GET", "recurring");
const sug = rc.suggestions.find((x) => /netflix/i.test(x.merchant));
assert.ok(sug, "Netflix is suggested as recurring");
rc = await ok(recurring, "POST", "recurring", { action: "confirm", detectKey: sug.key });
assert.ok(rc.items.some((x) => /netflix/i.test(x.merchant)));
assert.ok(!rc.suggestions.some((x) => x.key === sug.key), "confirmed suggestions leave the list");
rc = (await call(recurring, "POST", "recurring", { name: "Rent", amountCents: -110000, cadence: "monthly", nextDate: "2026-12-01", categoryId: id("Rent") })).data;
const rent = rc.items.find((x) => x.name === "Rent");
assert.ok(rent);
rc = await ok(recurring, "PATCH", "recurring", { id: rent.id, patch: { amountCents: -115000 } });
assert.equal(rc.items.find((x) => x.id === rent.id).amountCents, -115000);
assert.equal((await call(recurring, "POST", "recurring", { name: "X", amountCents: -1, cadence: "daily", nextDate: "2026-12-01" })).status, 400);
rc = await ok(recurring, "DELETE", "recurring?id=" + rent.id);
assert.ok(!rc.items.some((x) => x.id === rent.id));

/* ---------- goals ---------- */
let gl = (await call(goals, "POST", "goals", { name: "Vacation fund", targetCents: 900000, targetDate: "2027-05-15", accountId: chk.id })).data;
assert.equal(gl.goals[0].progress.savedCents, 500000, "a linked account's balance is the saved amount");
gl = (await call(goals, "POST", "goals", { name: "Trip", targetCents: 100000, savedCents: 25000 })).data;
const trip = gl.goals.find((x) => x.name === "Trip");
assert.equal(trip.progress.pct, 0.25);
gl = await ok(goals, "PATCH", "goals", { id: trip.id, patch: { savedCents: 100000 } });
assert.equal(gl.goals.find((x) => x.id === trip.id).progress.done, true);
assert.equal((await call(goals, "POST", "goals", { name: "Bad", targetCents: 0 })).status, 400);
gl = await ok(goals, "DELETE", "goals?id=" + trip.id);
assert.equal(gl.goals.length, 1);

/* ---------- sync push + net worth ---------- */
/* A classic card with the same name as a synced credit account merges
   into it (statement dates join the synced balance; one account). */
await cardsPost(makeCtx(env, { name: "Rewards card", statementStart: "2026-10-05", statementEnd: "2026-11-04", dueDate: "2026-11-01" }, "POST", "http://local/api/cards", authHeaders(token)));
assert.equal((await ok(accounts, "GET", "accounts")).accounts.filter((a) => a.name.toLowerCase() === "rewards card").length, 1, "before the sync: the classic card alone");
const sp = await call(sync, "POST", "sync", {
  asOf: "2026-11-20",
  accounts: [
    { id: "chk", name: "Checking", type: "depository", balanceCents: 520000 },
    { id: "card9", name: "Rewards card", institution: "Test Bank", type: "credit", balanceCents: 21212 },
    { id: "ira", name: "Roth IRA", type: "investment", balanceCents: 1000000 },
    { notAnAccount: true }
  ]
}, syncTok);
assert.equal(sp.status, 200);
assert.equal(sp.data.accounts, 3);
const merged = (await ok(accounts, "GET", "accounts")).accounts.filter((a) => a.name.toLowerCase() === "rewards card");
assert.equal(merged.length, 1, "after the sync: one Rewards card account, not two");
assert.equal(merged[0].balanceCents, 21212);
assert.equal(merged[0].dueDate, "2026-11-01", "the classic card's due date moved onto the synced account");
const nw = await ok(networth, "GET", "networth");
assert.equal(nw.current.netWorthCents, 520000 + 1000000 - 21212 - 750000);
assert.ok(nw.series.length >= 2);
assert.equal(nw.byType.investment, 1000000);

/* ---------- export ---------- */
const ej = await call(exporter, "GET", "export?format=json");
assert.equal(ej.status, 200);
assert.ok(ej.data.transactions.length > 0 && ej.data.accounts.length > 0 && ej.data.budgets.length > 0);
assert.match(ej.headers.get("Content-Disposition"), /attachment/);
await ok(transactions, "POST", "transactions", { date: "2026-11-07", merchant: "=HYPERLINK(\"x\")", amountCents: -100 });
const ec = await call(exporter, "GET", "export?format=csv");
assert.match(ec.headers.get("Content-Type"), /text\/csv/);
assert.ok(ec.data.split("\r\n")[0].startsWith("Date,Merchant,Amount"));
assert.ok(ec.data.includes("\"'=HYPERLINK(\"\"x\"\")\""), "a formula-looking merchant is neutralised in CSV");

/* ---------- migration gate ---------- */
const mg = await ok(migration, "POST", "migration");
assert.equal(typeof mg.match, "boolean");
assert.ok(mg.mirroredAt);
assert.equal(mg.months.length, 13);
assert.equal(mg.match, true, "rows added on the new screens don't break the gate: " + JSON.stringify(mg.months.filter((m) => !m.match)));
assert.ok(mg.months.find((m) => m.month === "2026-11").newOnlySpendingCents > 0, "new-app-only rows are reported separately");

console.log("v2-api.test.mjs: all assertions passed");
