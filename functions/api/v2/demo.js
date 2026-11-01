/*
 * Sample data for a first look (serves /api/v2/demo).
 *   GET    -> { demo, empty, dismissed }
 *          demo: sample data is loaded; empty: you have no data of your
 *          own (no accounts, transactions, budgets, bills or goals);
 *          dismissed: you chose "Start fresh".
 *   POST   { action: "dismiss" } -> status   (hide the first-run card)
 *   POST   -> status   loads the sample data; refused (409) once you
 *          have data of your own.
 *   DELETE -> status   removes exactly the sample rows: ids start with
 *          "demo_" (budgets: source "demo"; market recaps: "sample":
 *          true), so anything you added yourself stays.
 * Sample rows live only in the v2 tables: the classic screens never see
 * them, and the mirror only rewrites its own sources (v1exp, v1bank, …).
 */
import { handleV2, HttpError, bodyOf, todayIso } from "../_v2http.js";
import { loadCategories } from "../_v2store.js";
import { addDays, addMonths, monthOf } from "../../../js/core/v2/money.js";

const DEMO = "demo_*";

async function status(s) {
  const r = await s.first(
    "SELECT (SELECT COUNT(*) FROM accounts WHERE owner_id = ?1 AND id NOT GLOB ?2) + " +
    "(SELECT COUNT(*) FROM transactions WHERE owner_id = ?1 AND id NOT GLOB ?2) + " +
    "(SELECT COUNT(*) FROM budgets WHERE owner_id = ?1 AND source <> 'demo') + " +
    "(SELECT COUNT(*) FROM recurring WHERE owner_id = ?1 AND id NOT GLOB ?2) + " +
    "(SELECT COUNT(*) FROM goals WHERE owner_id = ?1 AND id NOT GLOB ?2) AS n", DEMO);
  return { demo: (await s.getSetting("demo:on")) === "1", empty: !(r && r.n), dismissed: (await s.getSetting("demo:dismissed")) === "1" };
}

/* Same numbers on every seed: a tiny seeded random. */
function rng(seed) {
  let x = seed;
  return function () { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}
const between = (rand, lo, hi) => Math.round(lo + rand() * (hi - lo));

export function sampleRows(today, cat) {
  const rand = rng(7);
  const acc = { checking: "demo_acc_checking", savings: "demo_acc_savings", card: "demo_acc_card", invest: "demo_acc_invest" };
  const tx = [];
  let n = 0;
  const add = (date, merchant, cents, category, account) => {
    if (date > today) return;
    tx.push(["INSERT INTO transactions (id, owner_id, source, account_id, date, merchant, description, amount_cents, category_id, category_locked) VALUES (?2, ?1, 'demo', ?3, ?4, ?5, ?5, ?6, ?7, 1)",
      "demo_tx_" + (++n), account, date, merchant, cents, cat(category)]);
  };
  const start = addMonths(monthOf(today), -2) + "-01";
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const day = Number(d.slice(8, 10));
    if (day === 1) add(d, "Sample Apartments", -185000, "Rent", acc.checking);
    if (day === 1 || day === 15) add(d, "Acme Corp Payroll (sample)", 260000, "Paycheck", acc.checking);
    if (day === 3) add(d, "StreamFlix (sample)", -1599, "Subscriptions", acc.card);
    if (day === 9) add(d, "Tunely Music (sample)", -1099, "Subscriptions", acc.card);
    if (day === 12) add(d, "Bright Power Co (sample)", -between(rand, 7000, 11000), "Utilities", acc.checking);
    if (day === 20) add(d, "Card payment", -between(rand, 60000, 90000), "Credit card payment", acc.checking);
    if (day === 22) add(d, "To savings", -40000, "Transfer", acc.checking);
    if (day % 4 === 2) add(d, ["Greenleaf Market", "Corner Grocer", "FreshCart"][day % 3] + " (sample)", -between(rand, 3500, 12000), "Groceries", acc.card);
    if (day % 5 === 3) add(d, ["Noodle Nook", "Taco Planet", "Cafe Placeholder"][day % 3] + " (sample)", -between(rand, 1200, 5500), "Eating Out", acc.card);
    if (day % 9 === 5) add(d, "Zoom Fuel (sample)", -between(rand, 3000, 5500), "Fuel/Transport", acc.card);
    if (day === 17) add(d, "Gadget Barn (sample)", -between(rand, 2500, 15000), "Shopping/Personal", acc.card);
  }
  /* Balances: about six months of daily snapshots, drifting to today's. */
  const balances = { checking: 482350, savings: 1250000, card: 68420, invest: 3418600 };
  const snaps = [];
  Object.keys(acc).forEach((k) => {
    let b = balances[k];
    for (let i = 0; i <= 182; i++) {
      snaps.push(["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4)", acc[k], addDays(today, -i), b]);
      if (k === "invest") b = Math.round(b / (1 + 0.0009 + (rand() - 0.5) * 0.02));
      else if (k === "savings") b -= i % 30 === 0 ? 40000 : 0;
      else b = Math.max(5000, b + between(rand, -2500, 2500));
    }
  });
  const accounts = [
    [acc.checking, "Everyday Checking", "Sample Bank", "depository", "checking", "0001", balances.checking, null],
    [acc.savings, "Rainy Day Savings", "Sample Bank", "depository", "savings", "0002", balances.savings, null],
    [acc.card, "Cashback Card", "Sample Card Co", "credit", "credit card", "0003", balances.card, addDays(today, 9)],
    [acc.invest, "Index Fund Brokerage", "Sample Invest", "investment", "brokerage", "0004", balances.invest, null]
  ].map((a) => ["INSERT INTO accounts (id, owner_id, name, institution, type, subtype, mask, balance_cents, balance_at, due_date, source) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'demo')",
    a[0], a[1], a[2], a[3], a[4], a[5], a[6], today, a[7]]);
  const month = monthOf(today);
  const budgets = [["Rent", 185000], ["Groceries", 60000], ["Eating Out", 30000], ["Subscriptions", 3000], ["Utilities", 10000], ["Fuel/Transport", 15000], ["Shopping/Personal", 15000], ["Paycheck", 520000]]
    .map(([c, cents]) => ["INSERT INTO budgets (owner_id, month, category_id, amount_cents, source) VALUES (?1, ?2, ?3, ?4, 'demo')", month, cat(c), cents]);
  const nextOn = (day) => { const d = month + "-" + String(day).padStart(2, "0"); return d >= today ? d : addMonths(month, 1) + "-" + String(day).padStart(2, "0"); };
  const recurring = [
    ["demo_rec_rent", "Rent", "Sample Apartments", "Rent", acc.checking, -185000, nextOn(1)],
    ["demo_rec_stream", "StreamFlix", "StreamFlix (sample)", "Subscriptions", acc.card, -1599, nextOn(3)],
    ["demo_rec_music", "Tunely Music", "Tunely Music (sample)", "Subscriptions", acc.card, -1099, nextOn(9)]
  ].map((r) => ["INSERT INTO recurring (id, owner_id, name, merchant, category_id, account_id, amount_cents, cadence, next_date, source) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'monthly', ?8, 'demo')",
    r[0], r[1], r[2], cat(r[3]), r[4], r[5], r[6]]);
  const goals = [["INSERT INTO goals (id, owner_id, name, target_cents, target_date, account_id) VALUES (?2, ?1, ?3, ?4, ?5, ?6)",
    "demo_goal_trip", "Trip to the mountains (sample)", 2000000, addMonths(month, 8) + "-01", acc.savings]];
  /* A week of market recaps, so the Market today card has something. */
  const market = [];
  let spy = 590;
  for (let d = addDays(today, -1), i = 0; i < 7; d = addDays(d, -1)) {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    if (wd === 0 || wd === 6) continue;
    i++;
    const quotes = [["SPY", "S&P 500", spy], ["QQQ", "Nasdaq 100", spy * 0.86], ["DIA", "Dow", spy * 0.72]].map(([symbol, name, close]) => {
      const changePct = Math.round((rand() - 0.45) * 200) / 100;
      return { symbol, name, close: Math.round(close * 100) / 100, change: Math.round(close * changePct) / 100, changePct };
    });
    spy = spy / (1 + quotes[0].changePct / 100);
    const summary = "Sample recap for " + d + ": " + quotes.map((q) => q.name + (q.changePct >= 0 ? " rose " : " fell ") + Math.abs(q.changePct).toFixed(2) + "%").join(", ") + ". Made-up numbers to show how the card looks.";
    market.push(["INSERT OR IGNORE INTO v2_settings (owner_id, key, value) VALUES (?1, ?2, ?3)", "market:" + d,
      JSON.stringify({ date: d, quotes, news: [{ headline: "Sample headline: markets do market things", source: "Sample News", url: "" }], summary, by: "numbers", sample: true, at: d + "T21:10:00.000Z" })]);
  }
  return [].concat(accounts, snaps, tx, budgets, recurring, goals, market);
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => status(s));

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  if (b.action === "dismiss") { await s.setSetting("demo:dismissed", "1"); return status(s); }
  const st = await status(s);
  if (st.demo) return st;
  if (!st.empty) throw new HttpError(409, "You already have data of your own, so sample data isn't loaded.");
  const { categories } = await loadCategories(s);
  const byName = {};
  categories.forEach((c) => { byName[c.name] = c.id; });
  await s.batch(sampleRows(todayIso(), (name) => byName[name] || null));
  await s.setSetting("demo:on", "1");
  return status(s);
});

export const onRequestDelete = (context) => handleV2(context, async ({ s }) => {
  await s.batch([
    /* Your own rows that point at a sample account keep their history, unlinked. */
    ["UPDATE transactions SET account_id = NULL WHERE owner_id = ?1 AND account_id GLOB ?2 AND id NOT GLOB ?2", DEMO],
    ["UPDATE goals SET account_id = NULL WHERE owner_id = ?1 AND account_id GLOB ?2 AND id NOT GLOB ?2", DEMO],
    ["UPDATE recurring SET account_id = NULL WHERE owner_id = ?1 AND account_id GLOB ?2 AND id NOT GLOB ?2", DEMO],
    ["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id GLOB ?2", DEMO],
    ["DELETE FROM auto_reviews WHERE owner_id = ?1 AND transaction_id GLOB ?2", DEMO],
    ["DELETE FROM transactions WHERE owner_id = ?1 AND id GLOB ?2", DEMO],
    ["DELETE FROM balance_snapshots WHERE owner_id = ?1 AND account_id GLOB ?2", DEMO],
    ["DELETE FROM accounts WHERE owner_id = ?1 AND id GLOB ?2", DEMO],
    ["DELETE FROM recurring WHERE owner_id = ?1 AND id GLOB ?2", DEMO],
    ["DELETE FROM goals WHERE owner_id = ?1 AND id GLOB ?2", DEMO],
    ["DELETE FROM budgets WHERE owner_id = ?1 AND source = 'demo'"],
    ["DELETE FROM v2_settings WHERE owner_id = ?1 AND key GLOB 'market:[0-9]*' AND value LIKE '%\"sample\":true%'"],
    ["DELETE FROM v2_settings WHERE owner_id = ?1 AND key = 'demo:on'"]
  ]);
  return status(s);
});
