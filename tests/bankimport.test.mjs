/*
 * Bank import without Plaid: the CSV parser on made-up statements in
 * common US and Indian layouts, the /api/v2/import route (duplicates,
 * rules, keyword guesses, running balance), and the SimpleFIN client and
 * route against a fake fetch (the access URL never reaches the browser).
 * Run: node tests/bankimport.test.mjs — made-up data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { parseCsv, detect, toTransactions, parseAmount, parseDate } from "../js/core/csvimport.js";
import * as importer from "../functions/api/v2/import.js";
import * as simplefin from "../functions/api/v2/simplefin.js";
import * as transactions from "../functions/api/v2/transactions.js";
import * as categories from "../functions/api/v2/categories.js";
import * as rules from "../functions/api/v2/rules.js";
import * as accounts from "../functions/api/v2/accounts.js";
import { similarName } from "../functions/api/_v2import.js";

const read = (csv) => { const t = parseCsv(csv); const m = detect(t); return { m, ...toTransactions(t, m) }; };

/* ---------- amounts and dates ---------- */
assert.equal(parseAmount("1,23,456.78"), 12345678);
assert.equal(parseAmount("$12.00"), 1200);
assert.equal(parseAmount("(12.50)"), -1250);
assert.equal(parseAmount("-7"), -700);
assert.equal(parseAmount("500.00 Dr"), -50000);
assert.equal(parseAmount("500.00Cr"), 50000);
assert.equal(parseAmount("Rs. 40"), 4000);
assert.equal(parseAmount("₹ 1,000"), 100000);
assert.equal(parseAmount("12.00-"), -1200);
assert.equal(parseAmount(""), null);
assert.equal(parseAmount("-"), null);
assert.equal(parseAmount("abc"), null);
assert.equal(parseDate("2026-11-03"), "2026-11-03");
assert.equal(parseDate("03/11/2026", "dmy"), "2026-11-03");
assert.equal(parseDate("03/11/2026", "mdy"), "2026-03-11");
assert.equal(parseDate("03/11/26", "dmy"), "2026-11-03");
assert.equal(parseDate("01-Nov-2026"), "2026-11-01");
assert.equal(parseDate("1 Nov 2026"), "2026-11-01");
assert.equal(parseDate("Nov 5, 2026"), "2026-11-05");
assert.equal(parseDate("31/02/2026", "dmy"), null);
assert.equal(parseDate("Opening balance"), null);

/* ---------- CSV cells ---------- */
assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n\r\n1,2,3'), [["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
assert.deepEqual(parseCsv("﻿a;b\n1;2"), [["a", "b"], ["1", "2"]]);

/* ---------- Chase checking: signed Amount, a Type column that isn't Dr/Cr ---------- */
let r = read([
  "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
  'DEBIT,10/28/2026,"STARBUCKS STORE 123, SEATTLE",-5.75,DEBIT_CARD,1200.25,,',
  "CREDIT,10/30/2026,ACME PAYROLL PPD,2000.00,ACH_CREDIT,3200.25,,",
  "DEBIT,10/31/2026,NETFLIX.COM,-15.49,ACH_DEBIT,3184.76,,"
].join("\n"));
assert.equal(r.m.columns.type, -1);
assert.equal(r.m.flip, false);
assert.deepEqual(r.rows[0], { date: "2026-10-28", description: "STARBUCKS STORE 123, SEATTLE", amountCents: -575, balanceCents: 120025 });
assert.equal(r.rows[1].amountCents, 200000);

/* ---------- Amex: charges are positive, so the sign flips ---------- */
r = read("Date,Description,Amount\n10/05/2026,WHOLE FOODS MARKET,45.10\n10/06/2026,NETFLIX.COM,15.49\n10/07/2026,AUTOPAY PAYMENT - THANK YOU,-500.00\n10/08/2026,SHELL OIL 123,30.00");
assert.equal(r.m.flip, true);
assert.deepEqual(r.rows.map((x) => x.amountCents), [-4510, -1549, 50000, -3000]);

/* ---------- Capital One: Debit / Credit columns ---------- */
r = read("Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n2026-11-01,2026-11-02,1234,TRADER JOE S,Groceries,23.40,\n2026-11-03,2026-11-03,1234,CAPITAL ONE AUTOPAY,Payment,,100.00");
assert.deepEqual(r.rows.map((x) => [x.date, x.amountCents]), [["2026-11-01", -2340], ["2026-11-03", 10000]]);

/* ---------- HDFC: preamble, DD/MM/YY, Withdrawal / Deposit, lakh commas, footer ---------- */
const HDFC = [
  "HDFC BANK Ltd.,,,,,,",
  "Account No :,50100000000000,,,,,",
  "Statement From :,01/11/2026,To:,30/11/2026,,,",
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  '03/11/26,UPI-SWIGGY-SWIGGY@ICICI-ICIC0000001-412345678901-FOOD,0000412345678901,03/11/26,"1,250.00",,"1,23,750.00"',
  '05/11/26,NEFT CR-ACME SOFTWARE PVT LTD-SALARY NOV,N309260000000001,05/11/26,,"85,000.00","2,08,750.00"',
  '15/11/26,POS 4XXXXX1234 BIG BAZAAR GROCERY,0000000000000000,15/11/26,"2,340.50",,"2,06,409.50"',
  "*** End of statement ***,,,,,,"
].join("\n");
r = read(HDFC);
assert.equal(r.m.header, 3);
assert.equal(r.m.dateOrder, "dmy");
assert.deepEqual(r.rows.map((x) => [x.date, x.amountCents, x.balanceCents]),
  [["2026-11-03", -125000, 12375000], ["2026-11-05", 8500000, 20875000], ["2026-11-15", -234050, 20640950]]);
assert.equal(r.skipped, 1);

/* ---------- ICICI / Kotak style: one Amount column + Dr / Cr ---------- */
r = read([
  "S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Amount,Dr / Cr,Balance,Dr / Cr",
  "1,01-Nov-2026,01-Nov-2026,-,ATM WDL MUMBAI,2000.00,DR,50000.00,CR",
  "2,02-Nov-2026,02-Nov-2026,-,INT CREDIT,120.50,CR,50120.50,CR"
].join("\n"));
assert.equal(r.m.columns.date, 2, "Transaction Date wins over Value Date");
assert.deepEqual(r.rows.map((x) => [x.description, x.amountCents]), [["ATM WDL MUMBAI", -200000], ["INT CREDIT", 12050]]);

/* ---------- SBI: tab-separated, "1 Nov 2026" dates ---------- */
r = read("Txn Date\tValue Date\tDescription\tRef No./Cheque No.\tDebit\tCredit\tBalance\n1 Nov 2026\t1 Nov 2026\tBY TRANSFER-NEFT ACME\t-\t\t5,000.00\t15,000.00\n2 Nov 2026\t2 Nov 2026\tTO TRANSFER-UPI ZOMATO\t-\t450.00\t\t14,550.00");
assert.deepEqual(r.rows.map((x) => x.amountCents), [500000, -45000]);

/* ---------- ambiguous dates and no header ---------- */
assert.equal(detect(parseCsv("Date,Description,Amount\n03/04/2026,X,-1\n05/06/2026,Y,-2")).dateOrder, null);
assert.equal(detect(parseCsv("hello,world\n1,2")).ok, false);

assert.equal(similarName("UPI-SWIGGY-SWIGGY@ICICI-412345", "Swiggy"), true);
assert.equal(similarName("AMAZON MKTPLACE", "Uber trip"), false);

/* ---------- /api/v2/import ---------- */
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
async function call(mod, method, route, body) {
  const fn = mod["onRequest" + method[0] + method.slice(1).toLowerCase()];
  const res = await fn(makeCtx(env, body, method, "http://local/api/v2/" + route, authHeaders(token)));
  return { status: res.status, data: await res.json() };
}
const ok = async (...a) => { const x = await call(...a); assert.ok(x.status < 300, a[2] + " -> " + x.status + " " + JSON.stringify(x.data)); return x.data; };

assert.equal((await call(importer, "POST", "import", { rows: [] })).status, 400);
assert.equal((await call(importer, "POST", "import", { newAccount: { name: "X" }, rows: [{ date: "2026-13-01", description: "a", amountCents: -1 }] })).status, 400);
assert.equal((await call(importer, "POST", "import", { rows: [{ date: "2026-11-01", description: "a", amountCents: -1 }] })).status, 400, "needs an account");

const cats = (await ok(categories, "GET", "categories")).categories;
const catId = (n) => cats.find((c) => c.name === n).id;
await ok(rules, "POST", "rules", { matchText: "swiggy", setCategoryId: catId("Eating Out") });
/* Typed in by hand already: the CSV's copy of it is a duplicate. */
await ok(transactions, "POST", "transactions", { date: "2026-11-15", merchant: "Big Bazaar", amountCents: -234050 });

const rows = toTransactions(parseCsv(HDFC), detect(parseCsv(HDFC))).rows;
let out = await ok(importer, "POST", "import", { newAccount: { name: "HDFC Savings" }, rows });
assert.equal(out.added, 2);
assert.equal(out.duplicates, 1);
assert.equal(out.categorized, 1, "the swiggy rule filed it");
assert.equal(out.toReview, 1, "the salary waits for review");
assert.equal(out.balanceUpdated, true);
const acct = (await ok(accounts, "GET", "accounts")).accounts.find((a) => a.id === out.accountId);
assert.equal(acct.name, "HDFC Savings");
assert.equal(acct.balanceCents, 20640950, "newest running balance");
let list = (await ok(transactions, "GET", "transactions?accountId=" + out.accountId)).transactions;
const swiggy = list.find((t) => /SWIGGY/.test(t.merchant));
assert.equal(swiggy.categoryId, catId("Eating Out"));
assert.equal(swiggy.needsReview, false);
assert.equal(swiggy.source, "csv");

/* The same statement again: nothing new. */
out = await ok(importer, "POST", "import", { accountId: out.accountId, rows });
assert.deepEqual([out.added, out.duplicates], [0, 3]);

/* Keyword guess stays on To review; two identical lines are both kept. */
out = await ok(importer, "POST", "import", { accountId: out.accountId, rows: [
  { date: "2026-11-20", description: "NETFLIX.COM", amountCents: -64900 },
  { date: "2026-11-21", description: "CHAI POINT", amountCents: -4000 },
  { date: "2026-11-21", description: "CHAI POINT", amountCents: -4000 }
] });
assert.equal(out.added, 3);
list = (await ok(transactions, "GET", "transactions?accountId=" + out.accountId)).transactions;
const nf = list.find((t) => t.merchant === "NETFLIX.COM");
assert.equal(nf.categoryId, catId("Subscriptions"));
assert.equal(nf.needsReview, true);
/* CSV rows can be deleted like your own. */
await ok(transactions, "DELETE", "transactions?id=" + nf.id);

/* ---------- SimpleFIN client ---------- */
const CLAIM = "https://bridge.example/simplefin/claim/abc123";
const ACCESS = "https://user1:s3cret@bridge.example/simplefin";
const setupToken = btoa(CLAIM);
assert.equal(await simplefin.claim(setupToken, async (url, init) => {
  assert.equal(url, CLAIM); assert.equal(init.method, "POST");
  return new Response(ACCESS);
}), ACCESS);
await assert.rejects(simplefin.claim(setupToken, async () => new Response("", { status: 403 })), /already used/);
await assert.rejects(simplefin.claim("not a token!", async () => new Response(ACCESS)), /doesn't look like/);
assert.equal(simplefin.guessType("Sapphire Preferred", -12000), "credit");
assert.equal(simplefin.guessType("Everyday Checking", 50000), "depository");

const day = (iso) => Date.parse(iso + "T12:00:00Z") / 1000;
let accountsCalls = 0;
const SET = {
  errlist: [{ code: "con.auth", msg: "Your credit union needs you to sign in again." }],
  connections: [{ conn_id: "c1", name: "First Example Bank" }],
  accounts: [
    { id: "chk1", name: "Everyday Checking", conn_id: "c1", currency: "USD", balance: "1520.10", "available-balance": "1500.00", "balance-date": day("2026-11-25"),
      transactions: [
        { id: "t1", posted: day("2026-11-22"), amount: "-12.34", description: "TRADER JOES #123" },
        { id: "t2", posted: day("2026-11-23"), amount: "2500.00", description: "ACME PAYROLL" },
        { id: "t3", posted: 0, amount: "-9.99", description: "PENDING THING", pending: true }
      ] },
    { id: "cc1", name: "Rewards Visa", conn_id: "c1", currency: "USD", balance: "-310.55", "balance-date": day("2026-11-25"),
      transactions: [{ id: "t1", posted: day("2026-11-24"), amount: "-45.00", description: "SHELL OIL" }] }
  ]
};
globalThis.fetch = async (url, init) => {
  if (url === CLAIM) return new Response(ACCESS);
  assert.ok(url.startsWith("https://bridge.example/simplefin/accounts?start-date="), url);
  assert.ok(!url.includes("s3cret"), "credentials move to the header");
  assert.equal(init.headers.Authorization, "Basic " + btoa("user1:s3cret"));
  accountsCalls++;
  return new Response(JSON.stringify(SET));
};
assert.equal((await ok(simplefin, "GET", "simplefin")).connected, false);
assert.deepEqual(await ok(simplefin, "POST", "simplefin", { action: "sync", auto: true }), { skipped: true });
out = await ok(simplefin, "POST", "simplefin", { setupToken });
assert.equal(out.connected, true);
assert.equal(out.accounts, 2);
assert.equal(out.added, 3, "pending rows wait until they post");
assert.deepEqual(out.errors, ["Your credit union needs you to sign in again."]);
const st = await call(simplefin, "GET", "simplefin");
assert.equal(st.data.connected, true);
assert.ok(!JSON.stringify(st.data).includes("s3cret"), "the access URL never goes to the browser");
const all = (await ok(accounts, "GET", "accounts")).accounts;
const chk = all.find((a) => a.name === "Everyday Checking");
const cc = all.find((a) => a.name === "Rewards Visa");
assert.deepEqual([chk.type, chk.balanceCents, chk.institution, chk.source], ["depository", 152010, "First Example Bank", "simplefin"]);
assert.deepEqual([cc.type, cc.balanceCents], ["credit", 31055], "owed is positive");
list = (await ok(transactions, "GET", "transactions?accountId=" + chk.id)).transactions;
assert.equal(list.find((t) => t.merchant === "TRADER JOES #123").amountCents, -1234);

/* Opened again soon: auto skips. Sync now: the same ids don't come twice. */
assert.deepEqual(await ok(simplefin, "POST", "simplefin", { action: "sync", auto: true }), { skipped: true });
out = await ok(simplefin, "POST", "simplefin", { action: "sync" });
assert.deepEqual([out.added, out.duplicates], [0, 3]);
assert.equal(accountsCalls, 2);

assert.equal((await ok(simplefin, "DELETE", "simplefin")).connected, false);
assert.equal((await call(simplefin, "POST", "simplefin", { action: "sync" })).status, 400);

console.log("bankimport.test.mjs: all assertions passed");
