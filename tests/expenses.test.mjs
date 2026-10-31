/*
 * Daily-expense CRUD + monthly rollup tests against the D1 shim.
 * Run: node tests/expenses.test.mjs — dummy amounts only.
 */
import assert from "node:assert/strict";
import {
  onRequestGet, onRequestPost, onRequestPut, onRequestDelete
} from "../functions/api/expenses.js";
import { FakeD1, makeCtx, setupTestAuth, authedCtx } from "./_fake-d1.mjs";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const ctxA = authedCtx(env, token);
const url = "http://local/api/expenses";
const post = (b) => onRequestPost(ctxA( b, "POST", url));
const put = (b) => onRequestPut(ctxA( b, "PUT", url));

// 1. Create without a category -> auto-categorized by rules.
let res = await post({ date: "2026-11-03", description: "Walmart weekly shop", amount: 80 });
assert.equal(res.status, 201);
let body = await res.json();
assert.equal(body.expense.category, "Groceries");
assert.equal(body.expense.categorizationSource, "rules");
const firstId = body.expense.id;
// Rollup: November actual groceries now reflect the log, month is entered.
let nov = body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.groceries, 80);
assert.equal(nov.entered, true);

// 2. Second expense in another category rolls up alongside, no double count.
res = await post({ date: "2026-11-04", description: "Shell fuel", amount: 40 });
body = await res.json();
nov = body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.groceries, 80);
assert.equal(nov.gasTransport, 40);

// 3. Manual category on create is honoured and labelled manual.
res = await post({ date: "2026-11-05", description: "Mystery shop", amount: 10, category: "One-off" });
body = await res.json();
assert.equal(body.expense.categorizationSource, "manual");
nov = body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.oneOffs, 10);

// 4. List, with and without the month filter.
res = await onRequestGet(ctxA( undefined, "GET", url + "?month=2026-11"));
assert.equal((await res.json()).expenses.length, 3);
res = await onRequestGet(ctxA( undefined, "GET", url + "?month=2026-12"));
assert.equal((await res.json()).expenses.length, 0);

// 5. Update amount + category override (source becomes manual), rollup follows.
res = await put({ id: firstId, patch: { amount: 100, category: "Eating Out" } });
body = await res.json();
assert.equal(body.expense.categorizationSource, "manual");
nov = body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.groceries, 0, "moved out of Groceries by the override");
assert.equal(nov.eatingOut, 100);

// 6. Delete removes the expense and its rollup contribution.
res = await onRequestDelete(ctxA( undefined, "DELETE", url + "?id=" + firstId));
body = await res.json();
nov = body.state.actuals.find((a) => a.monthKey === "2026-11");
assert.equal(nov.eatingOut, 0);
assert.equal(nov.gasTransport, 40, "other months'/categories' rollups untouched");
res = await onRequestGet(ctxA( undefined, "GET", url));
assert.equal((await res.json()).expenses.length, 2);

// 7. Validation: bad date is rejected.
res = await post({ date: "03/11/2026", description: "x", amount: 1 });
assert.equal(res.status, 400);

// 8. A month whose daily log empties stops counting as entered (it used to
//    stay "entered" with $0 everywhere, skewing averages and savings rate).
res = await post({ date: "2027-01-10", description: "Walmart weekly shop", amount: 25 });
const janId = (await res.json()).expense.id;
res = await onRequestDelete(ctxA(undefined, "DELETE", url + "?id=" + janId));
let jan = (await res.json()).state.actuals.find((a) => a.monthKey === "2027-01");
assert.equal(jan.entered, false, "deleting the last expense un-enters the month");
assert.equal(jan.groceries, 0);

// 9. Moving a month's only expense to another month clears the old month too.
res = await post({ date: "2027-02-10", description: "Shell fuel", amount: 30 });
const febId = (await res.json()).expense.id;
res = await put({ id: febId, patch: { date: "2027-03-10" } });
body = await res.json();
const feb = body.state.actuals.find((a) => a.monthKey === "2027-02");
const mar = body.state.actuals.find((a) => a.monthKey === "2027-03");
assert.equal(feb.entered, false, "old month un-entered after its only expense moved");
assert.equal(feb.gasTransport, 0, "old month's rolled-up total cleared");
assert.equal(mar.gasTransport, 30);
assert.equal(mar.entered, true);

// 10. Baseline rule: an expense dated BEFORE the baseline date
// (2026-10-26) is kept in the log but never rolls into actuals — the
// starting balance already reflects it. One dated ON the baseline
// date counts.
res = await post({ date: "2026-10-15", description: "Pre-baseline shop", amount: 50, category: "Groceries" });
assert.equal(res.status, 201);
body = await res.json();
let oct = body.state.actuals.find((a) => a.monthKey === "2026-10");
assert.equal(oct.entered, false, "pre-baseline expense must not enter October actuals");
assert.equal(oct.groceries, 0, "pre-baseline expense must not roll up");
assert.equal(body.state.dailyExpenses.some((e) => e.description === "Pre-baseline shop"), true, "pre-baseline expense stays in the log");
res = await post({ date: "2026-10-26", description: "Baseline-day shop", amount: 20, category: "Groceries" });
body = await res.json();
oct = body.state.actuals.find((a) => a.monthKey === "2026-10");
assert.equal(oct.entered, true);
assert.equal(oct.groceries, 20, "only the on-baseline expense rolls up");


// 10. Moving the baseline re-rolls the affected months immediately: an
// expense the old baseline excluded starts counting, and vice versa.
{
  const { patchState } = await import("../functions/api/budget.js");
  const db = new FakeD1();
  const envB = { DB: db };
  const tok = await setupTestAuth(envB);
  const ctxB = authedCtx(envB, tok);
  await patchState(db, { baselineDate: "2026-10-27" });
  await onRequestPost(ctxB({ date: "2026-10-26", description: "Coffee", amount: 5, category: "Dining" }, "POST", url));
  let st = await patchState(db, { baselineDate: "2026-10-26" });
  let oct = st.actuals.find((a) => a.monthKey === "2026-10");
  assert.equal(oct.entered, true, "earlier baseline brings the Oct 26 expense in");
  assert.ok(Object.values(oct).includes(5));
  st = await patchState(db, { baselineDate: "2026-10-27" });
  oct = st.actuals.find((a) => a.monthKey === "2026-10");
  assert.equal(oct.entered, false, "later baseline drops it again");
}

// 11. Notes: saved on create, edited, trimmed and capped; other edits keep them.
{
  let r = await post({ date: "2026-11-06", description: "Loan installment", amount: 50, category: "Loan/Debt Payment", note: "  for the visa fee  " });
  let b = await r.json();
  assert.equal(b.expense.note, "for the visa fee");
  r = await put({ id: b.expense.id, patch: { note: "x".repeat(600) } });
  assert.equal((await r.json()).expense.note.length, 500);
  r = await put({ id: b.expense.id, patch: { amount: 55 } });
  assert.equal((await r.json()).expense.note.length, 500, "an amount edit keeps the note");
  r = await put({ id: b.expense.id, patch: { note: "" } });
  assert.equal((await r.json()).expense.note, "", "a note can be cleared");
}

console.log("expenses.test.mjs: all assertions passed");
