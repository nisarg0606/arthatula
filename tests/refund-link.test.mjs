/*
 * Refund linking: a refund row points at the charge it pays back
 * (transactions.refund_of) and takes its category, so the pair
 * nullifies. Covers the pure matchers, the column migration for
 * databases created before the column existed, the manual link via
 * PATCH /api/v2/transactions (validation: no self-links, no chains,
 * opposite signs, never more than the charge), and the import
 * auto-link in _v2import.js (unambiguous matches only, across feed
 * twins of the same card; payments never auto-link).
 * Run: node tests/refund-link.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { ensureV2, scope, OWNER_ID } from "../functions/api/_v2db.js";
import { refundCoreName, refundNamesMatch, looksLikeRefund, pickRefundOriginal } from "../functions/api/_v2refund.js";
import { importRows } from "../functions/api/_v2import.js";
import * as accounts from "../functions/api/v2/accounts.js";
import * as transactions from "../functions/api/v2/transactions.js";
import * as categories from "../functions/api/v2/categories.js";

/* ---------- pure matchers ---------- */
assert.equal(refundCoreName("Refund: Frontier Airlines"), "FRONTIER AIRLINES");
assert.equal(refundCoreName("EXPEDIA **************"), "EXPEDIA");
assert.equal(refundCoreName("AplPay TRADER JOE S TEMPE AZ"), "APLPAY TRADER JOE S TEMPE AZ");
assert.ok(refundNamesMatch("Refund: Target", "TARGET"));
assert.ok(refundNamesMatch("EXPEDIA **************", "Expedia"));
assert.ok(refundNamesMatch("GROUPON CHICAGO", "Groupon"));
assert.ok(!refundNamesMatch("SHELL OIL", "WALMART"));
assert.ok(!refundNamesMatch("", "TARGET"));

assert.ok(looksLikeRefund({ amountCents: 4324, merchant: "Refund: Target" }));
assert.ok(!looksLikeRefund({ amountCents: -4324, merchant: "Refund: Target" }));
assert.ok(!looksLikeRefund({ amountCents: 50000, merchant: "AUTOPAY PAYMENT - THANK YOU" }));
assert.ok(!looksLikeRefund({ amountCents: 707, merchant: "Cash dividend of $7.07 from BND" }));
assert.ok(!looksLikeRefund({ amountCents: 2644, merchant: "Credit card cashback rewards" }));

{
  const fam = new Set(["accA", "accB"]);
  const charge = { id: "c1", account_id: "accA", date: "2026-09-20", merchant: "Expedia", amount_cents: -15374, category_id: "catX", refund_of: null };
  const totals = {};
  const row = { date: "2026-09-21", merchant: "EXPEDIA **************", amountCents: 4400 };
  assert.equal(pickRefundOriginal([charge], totals, row, fam), charge);
  assert.equal(totals.c1, 4400);
  /* A second refund that would overrun the charge no longer fits. */
  assert.equal(pickRefundOriginal([charge], totals, { ...row, amountCents: 12000 }, fam), null);
  /* Two fitting charges = ambiguous = no pick. */
  const charge2 = { ...charge, id: "c2", date: "2026-09-19" };
  assert.equal(pickRefundOriginal([charge, charge2], {}, row, fam), null);
  /* Another card's charge is not family. */
  assert.equal(pickRefundOriginal([{ ...charge, id: "c3", account_id: "accZ" }], {}, row, fam), null);
  /* Too old: outside the 180-day lookback. */
  assert.equal(pickRefundOriginal([{ ...charge, id: "c4", date: "2026-01-01" }], {}, row, fam), null);
}

/* ---------- the column reaches databases created before it ---------- */
{
  const db = new FakeD1();
  /* The transactions table exactly as it shipped before refund_of. */
  await db.prepare(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, external_id TEXT,
    source TEXT NOT NULL DEFAULT 'manual', account_id TEXT,
    date TEXT NOT NULL, merchant TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL,
    my_share_cents INTEGER, category_id TEXT,
    category_locked INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
    pending INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    exclude_reports INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0, v1_expense_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  await ensureV2(db);
  const cols = await db.prepare("PRAGMA table_info(transactions)").all();
  assert.ok(cols.results.map((c) => c.name).includes("refund_of"), "refund_of added by migration");
}

/* ---------- manual linking through the transactions route ---------- */
const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
const B = "http://local/api/v2/";
async function call(mod, method, route, body) {
  const fn = mod["onRequest" + method[0] + method.slice(1).toLowerCase()];
  const res = await fn(makeCtx(env, body, method, B + route, authHeaders(token)));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}
const acct = (await call(accounts, "POST", "accounts", { name: "Test Card (4242)", type: "credit" })).data.account;
const catList = (await call(categories, "GET", "categories")).data.categories;
const shop = catList.find((c) => c.name === "Shopping/Personal");

const charge = (await call(transactions, "POST", "transactions",
  { date: "2026-10-28", merchant: "Target", amountCents: -4324, accountId: acct.id, categoryId: shop.id })).data.transaction;
const refund = (await call(transactions, "POST", "transactions",
  { date: "2026-10-30", merchant: "Refund: Target", amountCents: 4324, accountId: acct.id })).data.transaction;
assert.equal(refund.needsReview, true);
assert.equal(refund.refundOf, null);

const linked = await call(transactions, "PATCH", "transactions", { id: refund.id, patch: { refundOf: charge.id } });
assert.equal(linked.status, 200, JSON.stringify(linked.data));
assert.equal(linked.data.transaction.refundOf, charge.id);
assert.equal(linked.data.transaction.categoryId, shop.id, "the refund takes the charge's category");
assert.equal(linked.data.transaction.needsReview, false);

/* Over-refunding the same charge is refused. */
const refund2 = (await call(transactions, "POST", "transactions",
  { date: "2026-10-31", merchant: "Refund: Target", amountCents: 100, accountId: acct.id })).data.transaction;
const over = await call(transactions, "PATCH", "transactions", { id: refund2.id, patch: { refundOf: charge.id } });
assert.equal(over.status, 400, "refunds past the charge are refused");

/* No chains: a refund can't be the target of another link. */
const chain = await call(transactions, "PATCH", "transactions", { id: charge.id, patch: { refundOf: refund.id } });
assert.equal(chain.status, 400, "linking to a refund is refused");

/* No self-links, no same-sign links, no missing targets. */
assert.equal((await call(transactions, "PATCH", "transactions", { id: refund.id, patch: { refundOf: refund.id } })).status, 400);
assert.equal((await call(transactions, "PATCH", "transactions", { id: refund2.id, patch: { refundOf: refund.id } })).status, 400);
assert.equal((await call(transactions, "PATCH", "transactions", { id: refund2.id, patch: { refundOf: "tx_missing" } })).status, 400);

/* Unlinking keeps the category the pair settled on. */
const unlinked = await call(transactions, "PATCH", "transactions", { id: refund.id, patch: { refundOf: null } });
assert.equal(unlinked.status, 200);
assert.equal(unlinked.data.transaction.refundOf, null);
assert.equal(unlinked.data.transaction.categoryId, shop.id);

/* ---------- import auto-link, across feed twins of one card ---------- */
{
  const db = new FakeD1();
  await ensureV2(db);
  const s = scope(db, OWNER_ID);
  const shopRow = await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND name = ?2", "Shopping/Personal");
  await s.run("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, source) VALUES (?2, ?1, ?3, ?4, ?5, 'credit', 'plaid')",
    "accA", "plaid:x1", "Discover it (3670)", "Discover");
  await s.run("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, source) VALUES (?2, ?1, ?3, ?4, ?5, 'credit', 'simplefin')",
    "accB", "sfin:y1", "Discover it (3670)", "Capital One");
  await s.run("INSERT INTO transactions (id, owner_id, external_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked, needs_review) " +
    "VALUES (?2, ?1, 'plaid:t1', 'v1bank', ?3, '2026-09-20', 'Expedia', 'Expedia', -15374, ?4, 1, 0)",
    "chg1", "accA", shopRow.id);

  const out1 = await importRows(s, db, "accB",
    [{ date: "2026-09-20", description: "EXPEDIA **************", amountCents: 4400, externalId: "sfin:r1" }], "simplefin");
  assert.equal(out1.refundsLinked, 1, "the unambiguous refund auto-links");
  const row1 = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND external_id = ?2", "sfin:r1");
  assert.equal(row1.refund_of, "chg1");
  assert.equal(row1.category_id, shopRow.id, "and takes the charge's category");
  assert.equal(row1.needs_review, 0);

  /* A second identical charge makes the next refund ambiguous. */
  await s.run("INSERT INTO transactions (id, owner_id, external_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked, needs_review) " +
    "VALUES (?2, ?1, 'plaid:t2', 'v1bank', ?3, '2026-09-19', 'Expedia', 'Expedia', -15374, ?4, 1, 0)",
    "chg2", "accA", shopRow.id);
  const out2 = await importRows(s, db, "accB",
    [{ date: "2026-09-21", description: "EXPEDIA **************", amountCents: 4400, externalId: "sfin:r2" }], "simplefin");
  assert.equal(out2.refundsLinked, 0, "ambiguous refunds wait for a manual link");
  const row2 = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND external_id = ?2", "sfin:r2");
  assert.equal(row2.refund_of, null);

  /* A card payment is never mistaken for a refund. */
  const out3 = await importRows(s, db, "accB",
    [{ date: "2026-09-22", description: "AUTOPAY PAYMENT - THANK YOU", amountCents: 10000, externalId: "sfin:p1" }], "simplefin");
  assert.equal(out3.refundsLinked, 0);
  const row3 = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND external_id = ?2", "sfin:p1");
  assert.equal(row3.refund_of, null);
}

console.log("refund-link.test.mjs: all assertions passed");
