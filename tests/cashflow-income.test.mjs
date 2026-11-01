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
 * Run: node tests/cashflow-income.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { patchState, upsertBankData } from "../functions/api/budget.js";
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
    /* October: the same paycheck, already inside the booked actuals. */
    { id: "pay-oct", accountId: "chk", date: "2026-10-31", name: "ACME PAYROLL 000101", amount: -2976.54, pfc: "INCOME" },
    /* An ordinary outflow stays neutral either way. */
    { id: "out-oct", accountId: "chk", date: "2026-10-12", name: "AUTOPAY CARD", amount: 300 }
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
assert.equal(cf.total.spendingCents, 0, "unlinked bank outflows stay transfers, not spending");

console.log("cashflow-income.test.mjs: all assertions passed");
