/*
 * v2 model (Phase 0) tests: the scoped query helper refuses SQL that is
 * not pinned to an owner and never returns another owner's
 * rows; the mirror copies classic data into v2 idempotently; and the
 * migration gate — every plan month's v2 income and spending equal the
 * classic actuals to the cent — holds for a realistic mix of daily
 * expenses, shared expenses, pre-baseline spending, card tags, bank
 * transfers, reviewed income/repayments/ignores and typed-in actuals.
 * Run: node tests/v2-model.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, setupTestAuth, authedCtx } from "./_fake-d1.mjs";
import { onRequestPost as expPost, onRequestPut as expPut, onRequestDelete as expDel } from "../functions/api/expenses.js";
import { onRequestPost as cardsPost } from "../functions/api/cards.js";
import { upsertBankData, setBankReview, patchActual, patchState } from "../functions/api/budget.js";
import { ensureV2, scope, ensureOwner, OWNER_ID } from "../functions/api/_v2db.js";
import { mirrorV1, compareTotals } from "../functions/api/_v2mirror.js";
import { loadTransactions, loadAccounts, loadBudgets, loadCategories } from "../functions/api/_v2store.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctx = authedCtx(env, token);
const EXP = "http://local/api/expenses";
await ensureV2(env.DB);

/* ---------- 1. scoped helper ---------- */
{
  const me = scope(env.DB, OWNER_ID);
  await assert.rejects(() => me.all("SELECT * FROM transactions"), /not pinned/, "unpinned SELECT refused");
  await assert.rejects(() => me.run("DELETE FROM transactions WHERE id = ?2", "x"), /not pinned/, "unpinned DELETE refused");
  assert.throws(() => scope(env.DB, ""), /owner/);
  await ensureOwner(env.DB, "friend");
  const friend = scope(env.DB, "friend");
  await friend.run("INSERT INTO transactions (id, owner_id, date, merchant, amount_cents) VALUES (?2, ?1, '2026-11-02', 'Friend secret', -999)", "tx_friend");
  await friend.run("INSERT INTO accounts (id, owner_id, name, type, balance_cents) VALUES (?2, ?1, 'Friend checking', 'depository', 123456)", "acc_friend");
  const mine = await loadTransactions(me);
  assert.ok(!mine.some((t) => t.id === "tx_friend"), "owner never sees the friend's transaction");
  assert.ok(!(await loadAccounts(me)).some((a) => a.id === "acc_friend"), "owner never sees the friend's account");
  assert.equal((await loadTransactions(friend)).length, 1, "friend sees only their own");
  /* An update scoped to the owner cannot touch the friend's row even by id. */
  await me.run("UPDATE transactions SET merchant = 'hacked' WHERE owner_id = ?1 AND id = ?2", "tx_friend");
  assert.equal((await friend.first("SELECT merchant FROM transactions WHERE owner_id = ?1 AND id = ?2", "tx_friend")).merchant, "Friend secret");
  /* Each owner gets its own default categories. */
  const meCats = (await loadCategories(me)).categories, frCats = (await loadCategories(friend)).categories;
  assert.equal(meCats.length, 19, "19 default categories");
  assert.equal(frCats.length, 19);
  assert.ok(!meCats.some((c) => frCats.some((f) => f.id === c.id)), "category ids are per owner");
}

/* ---------- 2. classic data, then the mirror ---------- */
await patchState(env.DB, { baselineDate: "2026-10-26", startingBalance: 5000 });
await cardsPost(ctx({ name: "Test Card", statementStart: "2026-10-05", statementEnd: "2026-11-04", dueDate: "2026-11-01" }, "POST", "http://local/api/cards"));
const add = async (body) => {
  const r = await expPost(ctx(body, "POST", EXP));
  assert.ok(r.status === 201 || r.status === 200, "expense POST " + r.status);
  return (await r.json()).expense;
};
await add({ date: "2026-10-20", description: "Before baseline lunch", amount: 18.5, category: "Eating Out" });
await add({ date: "2026-10-27", description: "Corner Market", amount: 18.75, category: "Groceries", card: "Test Card" });
await add({ date: "2026-11-02", description: "Dinner with friends", amount: 120, myShare: 40, category: "Eating Out" });
const rent = await add({ date: "2026-11-01", description: "Rent", amount: 1100, category: "Rent" });
await add({ date: "2026-11-15", description: "Gas station", amount: 45.1, category: "Fuel/Transport" });
await add({ date: "2027-01-05", description: "Mystery", amount: 9.99, category: "Misc/Other" });
/* Bank: a posted paycheck (income), a repayment, a card payment, an
   ignored transfer, an unreviewed inflow, a pending charge, and the bank
   side of an expense (linked, so never doubled). */
await upsertBankData(env.DB, {
  accounts: [{ id: "chk1", institution: "Test Bank", name: "Checking", subtype: "checking", mask: "0001", currentBalance: 3210.98, availableBalance: 3200 }],
  transactions: [
    { id: "b_pay", accountId: "chk1", date: "2026-11-01", name: "PAYROLL ACME", amount: -2050 },
    { id: "b_repay", accountId: "chk1", date: "2026-11-03", name: "ZELLE FROM ROOMIE", amount: -40 },
    { id: "b_card", accountId: "chk1", date: "2026-11-09", name: "CARD PAYMENT", amount: 640 },
    { id: "b_move", accountId: "chk1", date: "2026-11-12", name: "TRANSFER TO SAVINGS", amount: 200 },
    { id: "b_unknown", accountId: "chk1", date: "2026-11-20", name: "VENMO CASHOUT", amount: -15 },
    { id: "b_pend", accountId: "chk1", date: "2026-11-21", name: "PENDING THING", amount: 12, pending: true },
    { id: "b_rent", accountId: "chk1", date: "2026-11-01", name: "Rent", amount: 1100 }
  ]
});
await setBankReview(env.DB, "b_pay", "income");
await setBankReview(env.DB, "b_repay", "repayment");
await setBankReview(env.DB, "b_move", "ignore");
/* Typed-in actuals: December income + a month with no daily log. */
await patchActual(env.DB, "2026-12", { takeHomePay: 4100, otherIncome: 100, rent: 1100, groceries: 321.1, oneOffs: 1234.56 });
await patchActual(env.DB, "2026-11", { takeHomePay: 2050 });
/* Plan: November budget. */
await patchState(env.DB, { monthKey: "2026-11", patch: { takeHomePay: 4100, rent: 1100, groceries: 450, credilaEmi: 100, otherLoan: 50 } });

let r = await mirrorV1(env.DB);
assert.equal(r.skipped, false);
assert.equal((await mirrorV1(env.DB)).skipped, true, "unchanged v1 data: second run is a no-op");

/* ---------- 3. the migration gate ---------- */
let gate = await compareTotals(env.DB);
for (const m of gate.months) {
  assert.ok(m.match, "totals match for " + m.month + ": " + JSON.stringify(m));
}
assert.ok(gate.match);
const nov = gate.months.find((m) => m.month === "2026-11");
assert.equal(nov.v2SpendingCents, 110000 + 4000 + 4510, "Nov spending = rent + my share of dinner + gas");
assert.equal(nov.v2IncomeCents, 205000 + 205000, "Nov income = typed take-home + reviewed paycheck");

const me = scope(env.DB, OWNER_ID);
const txs = await loadTransactions(me);
const byExt = Object.fromEntries(txs.filter((t) => t.externalId).map((t) => [t.externalId, t]));
assert.ok(byExt["bank:b_card"] && byExt["bank:b_card"].needsReview, "unreviewed card payment is a transfer to review");
assert.ok(byExt["bank:b_move"].hidden, "ignored transfer is hidden");
assert.ok(!byExt["bank:b_rent"], "a bank row backing an expense is not duplicated");
assert.ok(!byExt["bank:b_pend"], "pending bank rows are not mirrored");
assert.equal(byExt["exp:" + rent.id].accountId !== null, true, "expense linked to its bank account");
const before = txs.find((t) => t.merchant === "Before baseline lunch");
assert.ok(before.excludeReports, "pre-baseline spending is listed but excluded from totals");
const tj = txs.find((t) => t.merchant === "Corner Market");
const accounts = await loadAccounts(me);
assert.equal(accounts.find((a) => a.id === tj.accountId).name, "Test Card", "card tag becomes the card account");
const chk = accounts.find((a) => a.externalId === "plaid:chk1");
assert.equal(chk.balanceCents, 321098);
assert.equal(accounts.find((a) => a.externalId === "plaid:chk1").type, "depository");
const snaps = await me.all("SELECT * FROM balance_snapshots WHERE owner_id = ?1");
assert.equal(snaps.length, 1, "one balance snapshot for the checking account");
const dec = (await loadTransactions(me)).filter((t) => t.date.startsWith("2026-12"));
assert.ok(dec.some((t) => t.merchant === "One-off" && t.amountCents === -123456), "typed-in Dec one-off mirrored as a transaction");
const budgets = await loadBudgets(me, "2026-11", "2026-11");
const cats = (await loadCategories(me)).categories;
const cid = (n) => cats.find((c) => c.name === n).id;
assert.equal(budgets.find((b) => b.categoryId === cid("Loan/Debt Payment")).amountCents, 15000, "EMI + other loan budget combine");
assert.equal(budgets.find((b) => b.categoryId === cid("Paycheck")).amountCents, 410000);

/* ---------- 4. changes in the classic app flow through ---------- */
await expPut(ctx({ id: rent.id, patch: { amount: 1150 } }, "PUT", EXP));
await expDel(ctx(undefined, "DELETE", EXP + "?id=" + txs.find((t) => t.merchant === "Mystery").v1ExpenseId));
gate = await compareTotals(env.DB);
assert.ok(gate.match, "still matching after an edit and a delete: " + JSON.stringify(gate.months.filter((m) => !m.match)));
const after = await loadTransactions(me);
assert.equal(after.find((t) => t.externalId === "exp:" + rent.id).amountCents, -115000, "edited amount mirrored");
assert.ok(!after.some((t) => t.merchant === "Mystery"), "deleted expense removed from v2");
/* The friend's data is untouched by all of this. */
assert.equal((await loadTransactions(scope(env.DB, "friend"))).length, 1);

/* A v2-owned change on a bank row survives a re-mirror. */
await me.run("UPDATE transactions SET category_id = ?2, category_locked = 1, needs_review = 0 WHERE owner_id = ?1 AND external_id = 'bank:b_card'", cid("Credit card payment"));
await mirrorV1(env.DB, { force: true });
const card = (await loadTransactions(me)).find((t) => t.externalId === "bank:b_card");
assert.equal(card.categoryId, cid("Credit card payment"));
assert.equal(card.needsReview, false);

console.log("v2-model.test.mjs: all assertions passed");
