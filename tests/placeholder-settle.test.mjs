/*
 * Pending placeholders vs. the posted charge. An assistant adds a
 * hand-made row tagged "pending-placeholder" while a card charge is
 * still pending; the reports and the Dashboard leave those rows out.
 * When the bank feed (SimpleFIN, or a statement CSV) brings the posted
 * charge, importRows must store it and settle the placeholder, not
 * treat the placeholder as a stored copy and drop the posted row (which
 * lost the charge from the Dashboard altogether). Also covers the
 * SimpleFIN sync reaching its window back to a placeholder still
 * waiting, so charges an earlier sync passed over come in.
 * Run: node tests/placeholder-settle.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import { ensureV2, scope, OWNER_ID } from "../functions/api/_v2db.js";
import { importRows, isPlaceholder } from "../functions/api/_v2import.js";
import * as simplefin from "../functions/api/v2/simplefin.js";

assert.ok(isPlaceholder({ external_id: null, tags: '["pending-placeholder"]' }));
assert.ok(!isPlaceholder({ external_id: null, tags: "[]" }));
assert.ok(!isPlaceholder({ external_id: "sfin:a:b", tags: '["pending-placeholder"]' }));

async function setup() {
  const db = new FakeD1();
  await ensureV2(db);
  const s = scope(db, OWNER_ID);
  const groceries = (await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND name = 'Groceries'")).id;
  for (const id of ["accCard", "accOther"]) {
    await s.run("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, source) VALUES (?2, ?1, ?3, ?4, 'Bank', 'credit', 'plaid')",
      id, "plaid:" + id, id + " (4222)");
  }
  const placeholder = async (id, account, date, merchant, cents, categoryId, tags) => {
    await s.run("INSERT INTO transactions (id, owner_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked, tags, notes) " +
      "VALUES (?2, ?1, 'manual', ?3, ?4, ?5, ?5, ?6, ?7, 1, ?8, 'Pending at the bank.')",
      id, account, date, merchant, cents, categoryId, JSON.stringify(tags || ["pending-placeholder"]));
  };
  return { db, s, groceries, placeholder };
}

/* ---------- importRows: the posted charge comes in, the placeholder settles ---------- */
{
  const { db, s, groceries, placeholder } = await setup();
  await placeholder("ph1", "accCard", "2026-11-19", "Costco", -76674, groceries);
  const out = await importRows(s, db, "accCard",
    [{ date: "2026-11-21", description: "COSTCO WHSE #0465 TEMPE AZ", amountCents: -76674, externalId: "sfin:c:t1" }], "simplefin");
  assert.equal(out.added, 1, "the posted charge is stored");
  assert.equal(out.duplicates, 0, "the placeholder is not a stored copy");
  assert.equal(out.placeholdersSettled, 1);
  const posted = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND external_id = 'sfin:c:t1'");
  assert.equal(posted.category_id, groceries, "the posted row takes the placeholder's category");
  assert.equal(posted.needs_review, 0);
  assert.equal(posted.hidden, 0);
  const ph = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND id = 'ph1'");
  assert.equal(ph.hidden, 1, "the placeholder is settled (hidden), not deleted");
  assert.match(ph.notes, /^Pending at the bank\. Settled: the posted charge came in on 2026-11-21\.$/);

  /* The next sync brings the same row again: an id duplicate, nothing else moves. */
  const again = await importRows(s, db, "accCard",
    [{ date: "2026-11-21", description: "COSTCO WHSE #0465 TEMPE AZ", amountCents: -76674, externalId: "sfin:c:t1" }], "simplefin");
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(again.placeholdersSettled, 0);
  const n = await s.first("SELECT COUNT(*) AS n FROM transactions WHERE owner_id = ?1 AND hidden = 0 AND amount_cents = -76674");
  assert.equal(n.n, 1, "the charge counts once");
  console.log("placeholder settles ok");
}

/* ---------- what does not settle ---------- */
{
  const { db, s, groceries, placeholder } = await setup();
  /* Another card's placeholder, a different amount, too far away in time. */
  await placeholder("phOther", "accOther", "2026-11-19", "Target", -233, groceries);
  await placeholder("phAmount", "accCard", "2026-11-19", "Target", -250, groceries);
  await placeholder("phFar", "accCard", "2026-11-01", "Target", -233, groceries);
  const out = await importRows(s, db, "accCard",
    [{ date: "2026-11-20", description: "TARGET 00012345", amountCents: -233, externalId: "sfin:c:t2" }], "simplefin");
  assert.equal(out.added, 1);
  assert.equal(out.placeholdersSettled, 0);
  const hidden = await s.first("SELECT COUNT(*) AS n FROM transactions WHERE owner_id = ?1 AND hidden = 1");
  assert.equal(hidden.n, 0, "no placeholder was touched");

  /* Two identical charges, one placeholder: the first settles it, the second still comes in. */
  await placeholder("phTwin", "accCard", "2026-11-22", "Walmart", -1486, null);
  const two = await importRows(s, db, "accCard", [
    { date: "2026-11-23", description: "WALMART.COM", amountCents: -1486, externalId: "sfin:c:w1" },
    { date: "2026-11-23", description: "WALMART.COM", amountCents: -1486, externalId: "sfin:c:w2" }
  ], "simplefin");
  assert.equal(two.added, 2);
  assert.equal(two.placeholdersSettled, 1);
  console.log("placeholder non-matches ok");
}

/* ---------- a typed-in row (no placeholder tag) still absorbs the feed's copy ---------- */
{
  const { db, s, groceries, placeholder } = await setup();
  await placeholder("typed", "accCard", "2026-11-19", "Costco", -19322, groceries, ["groceries"]);
  const out = await importRows(s, db, "accCard",
    [{ date: "2026-11-20", description: "COSTCO WHSE", amountCents: -19322, externalId: "sfin:c:t3" }], "simplefin");
  assert.equal(out.added, 0);
  assert.equal(out.duplicates, 1, "a row you typed in is still a stored copy");
  console.log("typed rows unchanged ok");
}

/* ---------- SimpleFIN sync: the window reaches back to a waiting placeholder ---------- */
{
  const CLAIM = "https://bridge.example/simplefin/claim/abc123";
  const ACCESS = "https://user1:s3cret@bridge.example/simplefin";
  const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const now = Date.now() / 1000;
  const phDate = iso(now - 20 * 86400);
  const postedDate = iso(now - 18 * 86400);
  const starts = [];
  const set = {
    connections: [{ conn_id: "c1", name: "Bank" }],
    accounts: [{ id: "card1", name: "Gold Card", conn_id: "c1", currency: "USD", balance: "-766.74", "balance-date": Math.floor(now),
      transactions: [{ id: "t9", posted: Math.floor(Date.parse(postedDate + "T12:00:00Z") / 1000), amount: "-766.74", description: "COSTCO WHSE #0465" }] }]
  };
  globalThis.fetch = async (url) => {
    if (url === CLAIM) return new Response(ACCESS);
    starts.push(Number(new URL(url).searchParams.get("start-date")));
    return new Response(JSON.stringify(set));
  };
  const env = { DB: new FakeD1() };
  const token = await setupTestAuth(env);
  await ensureV2(env.DB);
  const s = scope(env.DB, OWNER_ID);
  await s.run("INSERT INTO accounts (id, owner_id, external_id, name, institution, type, source) VALUES ('accSurv', ?1, 'plaid:g', 'Gold Card', 'Bank', 'credit', 'plaid')");
  await s.run("INSERT INTO account_aliases (owner_id, external_id, account_id) VALUES (?1, 'sfin:card1', 'accSurv')");
  const call = async (body) => {
    const res = await simplefin.onRequestPost(makeCtx(env, body, "POST", "http://local/api/v2/simplefin", authHeaders(token)));
    return { status: res.status, data: JSON.parse(await res.text()) };
  };
  /* Connect, then pretend the posted charge was passed over before (a placeholder is waiting). */
  await call({ setupToken: btoa(CLAIM) });
  await s.run("DELETE FROM transactions WHERE owner_id = ?1");
  await s.run("INSERT INTO transactions (id, owner_id, source, account_id, date, merchant, description, amount_cents, tags) " +
    "VALUES ('phW', ?1, 'manual', 'accSurv', ?2, 'Costco', 'Costco', -76674, '[\"pending-placeholder\"]')", phDate);
  await s.setSetting("simplefin_last_sync", new Date((now - 86400) * 1000).toISOString());
  const out = await call({ action: "sync" });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const start = starts[starts.length - 1];
  assert.ok(start <= Date.parse(phDate + "T00:00:00Z") / 1000 - 3 * 86400 + 1, "the window reaches back past the placeholder");
  assert.ok(start >= now - 90 * 86400 - 5, "never past SimpleFIN's 90 days");
  assert.equal(out.data.added, 1);
  assert.equal(out.data.placeholdersSettled, 1);
  assert.ok(Number.isFinite(out.data.refundsLinked), "every count adds up (no NaN)");
  const ph = await s.first("SELECT hidden FROM transactions WHERE owner_id = ?1 AND id = 'phW'");
  assert.equal(ph.hidden, 1);

  /* With nothing waiting, the window is the usual week of overlap. */
  await s.setSetting("simplefin_last_sync", new Date((now - 86400) * 1000).toISOString());
  await call({ action: "sync" });
  const usual = starts[starts.length - 1];
  assert.ok(Math.abs(usual - (now - 8 * 86400)) < 60, "a week before the last sync");
  console.log("simplefin window ok");
}

console.log("placeholder-settle.test.mjs: all passed");
