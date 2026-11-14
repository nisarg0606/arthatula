/*
 * Payment timing: the pure helpers behind the Cash flow screen's
 * Payments section (js/core/v2/payments.js). Made-up amounts, but the
 * shape is the real one: an Amex whose statement closes Dec 5 and is
 * due Jan 4, Affirm installments riding on it, pre-filed "One-off"
 * bill settlements in the log, and paychecks landing mid-month.
 * Run: node tests/payments.test.mjs
 */
import assert from "node:assert/strict";
import { addMonthsToDate, cycleFor, paymentDateFor, isCardBillTx, fundedByPriorPaycheck, paymentFlow, carryPlannedIncome, applyPlannedIncome, runningBalances, lowestBalance } from "../js/core/v2/payments.js";

/* ---- month shifting ---- */
assert.equal(addMonthsToDate("2026-12-05", 1), "2027-01-05");
assert.equal(addMonthsToDate("2026-11-06", -1), "2026-10-06");
assert.equal(addMonthsToDate("2026-01-31", 1), "2026-02-28", "day clamps to the shorter month");
assert.equal(addMonthsToDate("2026-03-31", -1), "2026-02-28");

/* ---- statement cycles ---- */
const AMEX = { id: "acc_amex", type: "credit", name: "Blue Cash Everyday", mask: "4007", statementStart: "2026-11-06", statementEnd: "2026-12-05", dueDate: "2027-01-04" };
assert.deepEqual(cycleFor(AMEX, "2026-11-13"), { start: "2026-11-06", end: "2026-12-05", due: "2027-01-04" }, "a charge inside the current cycle");
assert.deepEqual(cycleFor(AMEX, "2026-12-05"), { start: "2026-11-06", end: "2026-12-05", due: "2027-01-04" }, "a charge ON the closing day belongs to that statement");
assert.deepEqual(cycleFor(AMEX, "2026-12-06"), { start: "2026-12-06", end: "2027-01-05", due: "2027-02-04" }, "the day after closing rolls to the next statement");
assert.deepEqual(cycleFor(AMEX, "2026-11-04"), { start: "2026-10-06", end: "2026-11-05", due: "2026-12-04" }, "an earlier charge rolls the cycle back a month");
assert.deepEqual(cycleFor(AMEX, "2027-03-20"), { start: "2027-03-06", end: "2027-04-05", due: "2027-05-04" }, "future cycles project forward by whole months");
assert.equal(cycleFor({ id: "x", type: "credit", name: "No dates" }, "2026-11-13"), null, "no statement dates, no cycle");
assert.equal(cycleFor(null, "2026-11-13"), null);
assert.equal(cycleFor({ id: "x", type: "credit", statementStart: "2026-11-06", statementEnd: "2026-12-05", dueDate: null }, "2026-11-13").due, "2026-12-26", "no due date: statement end + 21 days");

/* ---- payment dates ---- */
assert.equal(paymentDateFor({ date: "2026-11-13" }, AMEX), "2027-01-04", "a card charge is paid at its statement's due date");
assert.equal(paymentDateFor({ date: "2026-11-13" }, { id: "chk", type: "depository" }), "2026-11-13", "a checking charge stays on its own date");
assert.equal(paymentDateFor({ date: "2026-11-13" }, null), "2026-11-13", "no account, own date");

/* ---- the paycheck note ---- */
assert.equal(fundedByPriorPaycheck("2027-01-04"), true, "due Jan 4: right after the Dec 31 paycheck");
assert.equal(fundedByPriorPaycheck("2026-12-21"), false);
assert.equal(fundedByPriorPaycheck(null), false);

/* ---- the flow over Nov-Feb ---- */
const CATS = {
  pay: { kind: "income", name: "Paycheck" },
  rent: { kind: "expense", name: "Rent" },
  groc: { kind: "expense", name: "Groceries" },
  eat: { kind: "expense", name: "Eating Out" },
  shop: { kind: "expense", name: "Shopping/Personal" },
  loan: { kind: "expense", name: "Loan/Debt Payment" },
  fam: { kind: "expense", name: "Family" },
  oneoff: { kind: "expense", name: "One-off" },
  cardpay: { kind: "transfer", name: "Credit card payment" }
};
const TXS = [
  { date: "2026-10-19", merchant: "Affirm", amountCents: -44500, categoryId: "loan", accountId: "acc_amex" },
  { date: "2026-11-04", merchant: "Affirm", amountCents: -44500, categoryId: "loan", accountId: "acc_amex" },
  { date: "2026-11-13", merchant: "Affirm (iPhone)", amountCents: -25475, categoryId: "fam", accountId: "acc_amex" },
  { date: "2026-11-18", merchant: "Affirm", amountCents: -44500, categoryId: "loan", accountId: "acc_amex" },
  { date: "2026-12-02", merchant: "Affirm", amountCents: -44500, categoryId: "loan", accountId: "acc_amex" },
  { date: "2026-12-20", merchant: "Store", amountCents: -10000, categoryId: "shop", accountId: "acc_amex" },
  { date: "2026-12-01", merchant: "Refund", amountCents: 5000, categoryId: "shop", accountId: "acc_amex" },
  { date: "2026-11-10", merchant: "Dinner", amountCents: -8000, myShareCents: -3000, categoryId: "eat", accountId: "acc_amex" },
  { date: "2026-11-20", merchant: "Pending charge", amountCents: -9999, categoryId: "shop", accountId: "acc_amex", pending: true },
  { date: "2026-11-01", merchant: "Rent", amountCents: -71800, categoryId: "rent", accountId: null },
  { date: "2026-11-15", merchant: "Payroll", amountCents: 297600, categoryId: "pay", accountId: null },
  { date: "2026-12-01", merchant: "Groceries", amountCents: -20000, categoryId: "groc", accountId: null },
  { date: "2026-11-05", merchant: "Amex Blue Cash bill — due Nov 5", amountCents: -21726, categoryId: "oneoff", accountId: null },
  { date: "2026-12-04", merchant: "Amex Blue Cash bill — due Dec 4", amountCents: -89000, categoryId: "oneoff", accountId: null },
  { date: "2026-12-04", merchant: "Card payment", amountCents: -89000, categoryId: "cardpay", accountId: "acc_chk" },
  { date: "2026-12-04", merchant: "Card payment received", amountCents: 89000, categoryId: "cardpay", accountId: "acc_amex" }
];
const ACCOUNTS = [AMEX, { id: "acc_chk", type: "depository", name: "Checking" }];

assert.equal(isCardBillTx(TXS[12], CATS), true, "the pre-filed One-off entry is a bill settlement");
assert.equal(isCardBillTx(TXS[0], CATS), false);

const flow = paymentFlow(TXS, CATS, ACCOUNTS, "2026-11", "2027-02");
const byMonth = {};
flow.months.forEach(function (m) { byMonth[m.month] = m; });
assert.deepEqual(flow.months.map(function (m) { return m.month; }), ["2026-11", "2026-12", "2027-01", "2027-02"], "Nov through Feb");
assert.equal(byMonth["2026-11"].incomeCents, 297600, "November keeps its paycheck");
assert.equal(byMonth["2026-11"].outCents, 71800, "November out is rent only: the Nov 5 bill placeholder is not counted and no Amex charge is due in November");
assert.equal(byMonth["2026-12"].outCents, 109000, "December out = the Oct 19 + Nov 4 Affirm charges ($890, due Dec 4) + groceries; the pre-filed $890 bill entry does NOT double it");
assert.equal(byMonth["2027-01"].outCents, 112475, "January out = iPhone installment + Nov 18 + Dec 2 Affirm + his share of dinner - the refund, all on the statement due Jan 4");
assert.equal(byMonth["2027-02"].outCents, 10000, "the Dec 20 charge misses the Dec 5 close, so it is due in February");
assert.equal(flow.total.outCents, 303275);
assert.equal(flow.total.incomeCents, 297600);
assert.equal(flow.total.netCents, -5675);
assert.equal(byMonth["2027-01"].byCategory.fam, 25475, "the iPhone installment shows as Family spending in January, its payment month");
assert.equal(byMonth["2027-01"].byCategory.shop, -5000, "the refund lowers January's Shopping");

assert.deepEqual(flow.bills, [
  { accountId: "acc_amex", name: "Blue Cash Everyday", mask: "4007", dueDate: "2026-12-04", month: "2026-12", cents: 89000, count: 2 },
  { accountId: "acc_amex", name: "Blue Cash Everyday", mask: "4007", dueDate: "2027-01-04", month: "2027-01", cents: 112475, count: 5 },
  { accountId: "acc_amex", name: "Blue Cash Everyday", mask: "4007", dueDate: "2027-02-04", month: "2027-02", cents: 10000, count: 1 }
], "charges grouped into the statement they will be paid with");

/* A card with no statement dates: charges stay in their charge month
   and make no bill. */
const noCycle = paymentFlow(
  [{ date: "2026-11-13", merchant: "X", amountCents: -5000, categoryId: "shop", accountId: "acc_x" }],
  CATS, [{ id: "acc_x", type: "credit", name: "Mystery card" }], "2026-11", "2026-11");
assert.equal(noCycle.months[0].outCents, 5000);
assert.deepEqual(noCycle.bills, []);

/* ---- planned income + running balance ---- */
assert.deepEqual(carryPlannedIncome({ "2026-12": 595200 }, "2026-11", "2027-02"),
  { "2026-11": 0, "2026-12": 595200, "2027-01": 595200, "2027-02": 595200 },
  "a month with no plan repeats the last planned month");
const planned = carryPlannedIncome({ "2026-11": 595200, "2026-12": 595200 }, "2026-11", "2027-02");
const withPlan = applyPlannedIncome(flow.months, planned, "2026-11");
assert.equal(withPlan[0].incomeCents, 595200, "November's income is the full plan, not just the half that landed");
assert.equal(withPlan[2].incomeCents, 595200, "January is planned income; nothing has landed yet");
const past = applyPlannedIncome([{ month: "2026-10", incomeCents: 10000, outCents: 0, netCents: 10000, byCategory: {} }], { "2026-10": 595200 }, "2026-11");
assert.equal(past[0].incomeCents, 10000, "a past month keeps its actuals even if a plan exists");

const bal = runningBalances(withPlan, 100000, "2026-11");
assert.deepEqual(bal.map(function (m) { return m.balanceCents; }), [623400, 1109600, 1592325, 2177525], "the cushion grows month to month on plan income");
assert.ok(bal.every(function (m) { return !m.shortfall; }));
assert.deepEqual(lowestBalance(bal), { month: "2026-11", balanceCents: 623400 });
const tight = runningBalances([{ month: "2026-10", incomeCents: 0, outCents: 0, netCents: 0 }, { month: "2026-11", incomeCents: 0, outCents: 50000, netCents: -50000 }], 10000, "2026-11");
assert.equal(tight[0].balanceCents, null, "months before the anchor have no running balance");
assert.equal(tight[1].balanceCents, -40000);
assert.equal(tight[1].shortfall, true, "a month ending under zero is flagged");

console.log("payments.test.mjs: all assertions passed");
