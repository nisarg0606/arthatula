/*
 * Cash-flow income test: the v2 mirror's treatment of bank inflows.
 *
 * The classic planner starts at the baseline, so history months have
 * no entered actuals — their only income record is the bank feed.
 * Unlinked bank inflows in such months must count as income in the
 * reports, or cash flow pits months of spending against zero income.
 * Two guards keep that honest:
 *   - a month whose take-home pay IS booked in the actuals keeps its
 *     bank inflows neutral (the paycheck must not count twice);
 *   - moves between the owner's own accounts (name patterns, or an
 *     inflow paired with an equal outflow from another account
 *     within 3 days) stay transfers, never income.
 * Outflows have one mirror-image rule: CYBRID-CROBO debits — money
 * sent to India, which the sync deliberately never logs as an
 * expense — count as spending under their own "Sent to India"
 * category in every month, booked or not. Every other unlinked
 * outflow stays a transfer (that spending already reaches the
 * reports through the daily log's card charges).
 * Run: node tests/cashflow-income.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { patchState, upsertBankData } from "../functions/api/budget.js";
import { ensureOwner, OWNER_ID } from "../functions/api/_v2db.js";
import * as reports from "../functions/api/v2/reports.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);

await patchState(env.DB, { setup: { planStart: "2026-05", baselineDate: "2026-10-26" } });
/* October's income is booked the classic way; May's never was. */
await patchState(env.DB, { actualMonthKey: "2026-10", patch: { takeHomePay: 2976.54, entered: true } });

await upsertBankData(env.DB, {
  accounts: [
    { id: "chk", institution: "Test Bank", name: "Checking", subtype: "checking", currentBalance: 1000 },
    { id: "sav", institution: "Test Bank", name: "Savings", subtype: "savings", currentBalance: 2000 }
  ],
  transactions: [
    /* May: a paycheck in both its real-world halves — a PAYROLL
       credit, and the "Online Transfer / Payment: Credit" half that
       lands in the Amex checking (Plaid tags it TRANSFER_IN) — plus
       a friend's Zelle settlement. All three are income. */
    { id: "pay-may", accountId: "chk", date: "2026-05-15", name: "ACME PAYROLL 000101", amount: -1100, pfc: "INCOME" },
    { id: "pay2-may", accountId: "chk", date: "2026-05-15", name: "Online Transfer / Payment: Credit", amount: -1876.54, pfc: "TRANSFER_IN" },
    { id: "zelle-may", accountId: "chk", date: "2026-05-22", name: "Zelle payment from ANJALI PATEL", amount: -250 },
    /* May: money he moved himself — an exactly-paired inflow/outflow
       across his two accounts, a name-pattern transfer, and a Zelle
       from his own other bank. None of it is income. */
    { id: "out-may", accountId: "chk", date: "2026-05-09", name: "Withdrawal", amount: 1000 },
    { id: "in-may", accountId: "sav", date: "2026-05-10", name: "Deposit", amount: -1000 },
    { id: "xfer-may", accountId: "chk", date: "2026-05-20", name: "ONLINE TRANSFER FROM CHECKING X8798", amount: -500 },
    { id: "self-may", accountId: "chk", date: "2026-05-26", name: "Zelle payment from NISARG SHAH", amount: -700 },
    /* An unrecognized inflow stays a neutral transfer. */
    { id: "mystery-may", accountId: "chk", date: "2026-05-27", name: "ACME DEPOSIT 883920", amount: -432 },
    /* Money sent to India via Cybrid counts as spending in any month. */
    { id: "cyb-may", accountId: "chk", date: "2026-05-21", name: "CYBRID-CROBO.MON 01272C3F", amount: 5000 },
    /* October: the same paycheck, already inside the booked actuals. */
    { id: "pay-oct", accountId: "chk", date: "2026-10-31", name: "ACME PAYROLL 000101", amount: -2976.54, pfc: "INCOME" },
    /* An ordinary outflow stays neutral either way. */
    { id: "out-oct", accountId: "chk", date: "2026-10-12", name: "AUTOPAY CARD", amount: 300 },
    { id: "cyb-oct", accountId: "chk", date: "2026-10-20", name: "CYBRID-CROBO.MON 88410A", amount: 1200 }
  ]
});

const res = await reports.onRequestGet(makeCtx(env, undefined, "GET",
  "http://local/api/v2/reports?kind=cashflow&from=2026-05&to=2026-10", authHeaders(token)));
assert.equal(res.status, 200);
const cf = JSON.parse(await res.text());
const byMonth = {};
cf.months.forEach((m) => { byMonth[m.month] = m; });

assert.equal(byMonth["2026-05"].incomeCents, 110000 + 187654 + 25000,
  "May income = both paycheck halves + Zelle settlement (own-account moves and unknowns excluded)");
assert.equal(byMonth["2026-10"].incomeCents, 297654,
  "October income = the booked actuals only; the bank paycheck is not counted twice");
assert.equal(cf.total.incomeCents, 110000 + 187654 + 25000 + 297654);
assert.equal(byMonth["2026-05"].spendingCents, 500000, "May spending = the Cybrid send to India");
assert.equal(byMonth["2026-10"].spendingCents, 120000, "Cybrid counts even in a booked month; the card autopay stays a transfer");
assert.equal(cf.total.spendingCents, 500000 + 120000,
  "only the Cybrid outflows count as spending; other unlinked outflows stay transfers");

/* The Cybrid rows must carry the dedicated category, not the
   Misc/Other fallback the mirror uses for unknown names. */
const cybCats = await env.DB.prepare(
  "SELECT c.name AS n FROM transactions t JOIN categories c ON c.id = t.category_id " +
  "WHERE t.source = 'v1bank' AND (t.merchant LIKE '%CYBRID%' OR t.description LIKE '%CYBRID%') ORDER BY t.date"
).all();
assert.deepEqual(cybCats.results.map((r) => r.n), ["Sent to India", "Sent to India"]);

/* An owner created BEFORE "Sent to India" existed must still get it:
   the seed batch re-runs idempotently on every ensure. */
await env.DB.prepare("DELETE FROM categories WHERE name = 'Sent to India'").run();
await ensureOwner(env.DB, OWNER_ID);
const restored = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Sent to India'").first();
assert.equal(restored.n, 1, "re-running the seeds restores a category added after the owner was created");
const dupes = await env.DB.prepare(
  "SELECT COUNT(*) AS n FROM (SELECT name FROM categories GROUP BY name HAVING COUNT(*) > 1)").first();
assert.equal(dupes.n, 0, "the re-run duplicated no category");

console.log("cashflow-income.test.mjs: all assertions passed");
