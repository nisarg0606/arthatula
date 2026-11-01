/*
 * README screenshots: starts a throwaway local copy of the app (its own
 * temporary database, port 8793), fills it with made-up sample data, and
 * saves screenshots as WebP in docs/screenshots/ (needs cwebp:
 * brew install webp). Needs the e2e dependencies (cd e2e && npm ci).
 *   node tools/readme-screenshots.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthatula-shots-"));
const require = createRequire(path.join(repo, "e2e", "package.json"));
const { chromium, devices } = require("@playwright/test");
const SP = outDir;
const STATE = path.join(os.tmpdir(), "arthatula-shots-state");
const PORT = 8793, BASE = "http://127.0.0.1:" + PORT;
const WRANGLER = path.join(repo, "e2e/node_modules/wrangler/bin/wrangler.js");
const CODE = "demo-screens-code-123";

function startServer() {
  const p = spawn("node", [WRANGLER, "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", STATE, "--var", "SETUP_SECRET:demo-setup"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"], detached: true });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 60000);
    const check = async () => { try { await fetch(BASE + "/"); clearTimeout(t); resolve(p); } catch { setTimeout(check, 500); } };
    check();
  });
}
const stop = (p) => new Promise((r) => { p.once("exit", () => setTimeout(r, 1500)); try { process.kill(-p.pid, "SIGINT"); } catch {} setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 5000); });

let H = null;
async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: Object.assign({ "Content-Type": "application/json" }, H), body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(method + " " + url + " " + res.status + " " + JSON.stringify(j));
  return j;
}
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date(new Date().toISOString().slice(0, 10) + "T12:00:00Z");
const daysAgo = (n) => iso(new Date(today - n * 864e5));

fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
let server = await startServer();
const auth = await api("POST", "/api/auth", { action: "setup", setupSecret: "demo-setup", code: CODE, label: "screens" });
H = { Authorization: "Bearer " + auth.token };

/* ---- made-up data ---- */
const { categories } = await api("GET", "/api/v2/categories");
const cat = (n) => { const c = categories.find((x) => x.name === n); if (!c) throw new Error("no category " + n); return c.id; };
const emoji = { Groceries: "🛒", "Eating Out": "🍜", Rent: "🏠", Subscriptions: "📺", Utilities: "💡", "Fuel/Transport": "🚗", "Shopping/Personal": "🛍️", Paycheck: "💼", Gym: "🏋️", "Phone & Internet": "📱" };
for (const [n, e] of Object.entries(emoji)) await api("PATCH", "/api/v2/categories", { type: "category", id: cat(n), patch: { icon: e } });

const acct = {};
for (const a of [["Everyday Checking", "depository", 684250, "Example Bank"], ["High-Yield Savings", "depository", 1820000, "Example Bank"], ["Rewards Card", "credit", 142380, "Example Card Co."],
  ["Brokerage", "investment", 0, "Example Broker"], ["Retirement (401k)", "investment", 0, "Example Plan"]]) {
  acct[a[0]] = (await api("POST", "/api/v2/accounts", { name: a[0], type: a[1], balanceCents: a[2], institution: a[3] })).account.id;
}
const tx = [];
const add = (d, m, c, cents, a) => tx.push({ date: d, merchant: m, categoryId: cat(c), amountCents: cents, accountId: acct[a || "Rewards Card"] });
for (let back = 0; back < 182; back++) {
  const d = daysAgo(back), day = Number(d.slice(8));
  if (day === 1 || day === 15) add(d, "Acme Corp Payroll", "Paycheck", 412500, "Everyday Checking");
  if (day === 1) { add(d, "Maple Court Apartments", "Rent", -185000, "Everyday Checking"); add(d, "Streamly", "Subscriptions", -1599); add(d, "Tunewave", "Subscriptions", -1099); }
  if (day === 5) add(d, "City Power & Water", "Utilities", -9420, "Everyday Checking");
  if (day === 8) add(d, "Skyline Mobile", "Phone & Internet", -6500);
  if (day === 3) add(d, "Ironworks Gym", "Gym", -4500);
  if (back % 6 === 0) add(d, "Green Basket Market", "Groceries", -(6800 + (back * 37) % 4200));
  if (back % 9 === 2) add(d, "Fresh Corner Grocery", "Groceries", -(2400 + (back * 53) % 1800));
  if (back % 4 === 1) add(d, ["Noodle House", "Taco Spot", "Corner Café", "Pizza Lab"][back % 4 === 1 ? (back / 4 | 0) % 4 : 0], "Eating Out", -(1450 + (back * 71) % 2600));
  if (back % 10 === 4) add(d, "QuickFuel", "Fuel/Transport", -(4200 + (back * 13) % 1500));
  if (back % 17 === 7) add(d, "Northwind Outfitters", "Shopping/Personal", -(5900 + (back * 29) % 7000));
}
add(daysAgo(3), "Pixel Electronics (new laptop)", "Shopping/Personal", -129900);
for (const t of tx) await api("POST", "/api/v2/transactions", t);
await api("PATCH", "/api/v2/transactions", { reviewAll: true }).catch(() => {});

const month = iso(today).slice(0, 7);
for (const [n, c] of [["Paycheck", 825000], ["Rent", 185000], ["Groceries", 55000], ["Eating Out", 32000], ["Subscriptions", 2700], ["Utilities", 11000], ["Fuel/Transport", 15000], ["Shopping/Personal", 20000], ["Phone & Internet", 6500], ["Gym", 4500]]) {
  await api("PUT", "/api/v2/budgets", { month, categoryId: cat(n), amountCents: c, rollover: n === "Groceries" });
}
const nextOf = (day) => { const d = new Date(today); d.setUTCDate(day); if (d <= today) d.setUTCMonth(d.getUTCMonth() + 1); return iso(d); };
for (const r of [["Maple Court Apartments", -185000, "Rent", 1], ["Streamly", -1599, "Subscriptions", 1], ["City Power & Water", -9420, "Utilities", 5], ["Skyline Mobile", -6500, "Phone & Internet", 8], ["Acme Corp Payroll", 412500, "Paycheck", 15]]) {
  await api("POST", "/api/v2/recurring", { name: r[0], amountCents: r[1], cadence: "monthly", nextDate: nextOf(r[3]), categoryId: cat(r[2]) });
}
await api("POST", "/api/v2/goals", { name: "Emergency fund", targetCents: 2500000, accountId: acct["High-Yield Savings"] });
await api("POST", "/api/v2/goals", { name: "Trip to Japan", targetCents: 600000, savedCents: 245000, targetDate: daysAgo(-240) });
await stop(server);

/* Balance history and market recaps straight into the local database. */
const sql = [];
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let b = 2380000, r = 4920000, spy = 541.2, chk = 590000, sav = 1650000;
for (let back = 185; back >= 0; back--) {
  const d = new Date(today - back * 864e5), dow = d.getUTCDay(), ds = iso(d), i = 185 - back;
  if ((dow === 0 || dow === 6) && back !== 0) continue;
  const m = 0.0045 * Math.sin(i / 6) + 0.0035 * Math.sin(i / 17) + 0.0009 + (back <= 35 ? 0.004 : 0) + (back === 0 ? 0.003 : 0);
  b = Math.round(b * (1 + m * 1.3)); r = Math.round(r * (1 + m)); const spyPrev = spy; spy = spy * (1 + 0.0042 * Math.sin(i / 7) + 0.003 * Math.sin(i / 19) + 0.0006);
  chk = Math.round(chk + 900 * Math.sin(i / 3) + (back <= 35 ? 1500 : 0)); sav = sav + 2600;
  for (const [n, v] of [["Brokerage", b], ["Retirement (401k)", r], ["Everyday Checking", chk], ["High-Yield Savings", sav], ["Rewards Card", 120000 + Math.round(30000 * Math.abs(Math.sin(i / 5)))]]) {
    sql.push(`INSERT OR REPLACE INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES ('me', ${q(acct[n])}, '${ds}', ${v});`);
  }
  if (back <= 120 && back >= 1) {
    const pct = (spy / spyPrev - 1) * 100, qq = pct * 1.3 - 0.05, dj = pct * 0.8 + 0.02;
    const word = (p) => (p >= 0 ? "rose " : "fell ") + Math.abs(p).toFixed(2) + "%";
    const rec = { date: ds, by: "gemini", at: ds + "T21:30:00Z",
      quotes: [{ symbol: "SPY", name: "S&P 500", close: +spy.toFixed(2), change: +(spy - spyPrev).toFixed(2), changePct: +pct.toFixed(2) }, { symbol: "QQQ", name: "Nasdaq 100", close: +(spy * 0.86).toFixed(2), changePct: +qq.toFixed(2) }, { symbol: "DIA", name: "Dow", close: +(spy * 0.78).toFixed(2), changePct: +dj.toFixed(2) }],
      news: [{ headline: "Chipmakers lead a broad rally as demand outlook brightens (sample headline)", source: "Sample Wire", url: "https://example.com/" }, { headline: "Treasury yields ease after softer inflation reading (sample headline)", source: "Sample Wire", url: "https://example.com/" }],
      summary: `The S&P 500 ${word(pct)} and the Nasdaq ${word(qq)}, while the Dow ${word(dj)}. Chipmakers set the tone after an upbeat demand outlook, and easing Treasury yields helped growth stocks. Sample recap for the README screenshots.` };
    sql.push(`INSERT OR REPLACE INTO v2_settings (owner_id, key, value) VALUES ('me', 'market:${ds}', ${q(JSON.stringify(rec))});`);
  }
}
sql.push(`UPDATE accounts SET balance_cents = ${b} WHERE id = ${q(acct["Brokerage"])}; UPDATE accounts SET balance_cents = ${r} WHERE id = ${q(acct["Retirement (401k)"])};`);
sql.push(`INSERT OR REPLACE INTO budget_settings (key, value) VALUES ('finnhub_api_key', 'sample'), ('gemini_api_key', 'demo-key-0001');`);
sql.push(`INSERT OR REPLACE INTO v2_settings (owner_id, key, value) VALUES ('me', 'market:checked', '9999-12-31');`);
fs.writeFileSync(path.join(SP, "seed.sql"), sql.join("\n"));
execFileSync("node", [WRANGLER, "d1", "execute", "arthatula", "--local", "--persist-to", STATE, "--file", path.join(SP, "seed.sql")], { cwd: repo, stdio: "ignore" });
server = await startServer();
const tok = (await api("POST", "/api/auth", { action: "login", code: CODE, label: "shots" })).token;

/* ---- screenshots ---- */
const browser = await chromium.launch();
process.on("exit", () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} });
async function shoot(name, opts, tab, scrollSel, extra) {
  const ctx = await browser.newContext(Object.assign({ colorScheme: "light", reducedMotion: "reduce" }, opts));
  await ctx.addInitScript(([t, theme, hide]) => {
    localStorage.setItem("arthatula-session", t);
    localStorage.setItem("arthatula-theme", theme);
    localStorage.setItem("arthatula-hide-amounts", hide ? "1" : "0");
  }, [tok, (extra && extra.theme) || "light", !!(extra && extra.hide)]);
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));
  try { await page.waitForSelector("#v2Overview .v2-tile", { timeout: 20000 }); }
  catch (e) { console.log("Home didn't load for", name, errs.slice(0, 8)); throw e; }
  if (tab !== "dashboard") {
    const btn = page.locator('.tab-btn[data-tab="' + tab + '"]');
    if (await btn.isVisible()) await btn.click();
    else { await page.click("#moreTab"); await page.click('.more-tile[data-go="' + tab + '"]'); }
  }
  await page.waitForTimeout(2500);
  if (scrollSel) await page.locator(scrollSel).first().evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 150));
  else await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  await ctx.close();
}
const desktop = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 };
const phone = Object.assign({}, devices["iPhone 13"], { deviceScaleFactor: 2 });
delete phone.defaultBrowserType;
await shoot("home", desktop, "dashboard");
await shoot("investments", desktop, "investments", "#v2Investments .v2-tiles");
await shoot("budget", desktop, "budget");
await shoot("transactions", desktop, "transactions");
await shoot("cashflow", desktop, "cashflow");
await shoot("home-dark", desktop, "dashboard", null, { theme: "dark" });
await shoot("phone-home", phone, "dashboard");
await shoot("phone-hidden", phone, "dashboard", null, { hide: true });
await browser.close();
await stop(server);
const dest = path.join(repo, "docs", "screenshots");
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith(".png"))) {
  execFileSync("cwebp", ["-quiet", "-q", "88", "-m", "6", path.join(outDir, f), "-o", path.join(dest, f.replace(/\.png$/, ".webp"))]);
}
console.log("Saved to docs/screenshots:", fs.readdirSync(dest).join(" "));
