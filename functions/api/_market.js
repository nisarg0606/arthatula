/*
 * The nightly market recap: the day's closes for three index funds
 * (SPY, QQQ, DIA stand in for the S&P 500, Nasdaq 100 and Dow, since
 * Finnhub's free plan quotes funds but not the indexes themselves), the
 * day's top market headlines, and a short summary written by the AI
 * provider (or a plain one built from the numbers when there's no AI
 * key). One recap per trading day, kept in v2_settings as
 * "market:YYYY-MM-DD".
 *
 * ensureMarket() is cheap to call on every request: it only fetches
 * once a new trading day has closed. A Worker deployment also calls it
 * from its nightly cron (worker.js); Pages has no cron, so there the
 * first visit after the close writes it.
 *
 * Key: FINNHUB_API_KEY (env) or the one saved in Settings (free at
 * https://finnhub.io/register).
 */
import { ensureTables } from "./budget.js";
import { getAiConfig, aiRequest, responseText } from "./_ai.js";

export const FINNHUB_API = "https://finnhub.io/api/v1";
export const SYMBOLS = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "Nasdaq 100" },
  { symbol: "DIA", name: "Dow" }
];
const RETRY_MS = 15 * 60 * 1000;

export async function getFinnhubKey(env) {
  if (env.FINNHUB_API_KEY) return env.FINNHUB_API_KEY;
  await ensureTables(env.DB);
  const row = await env.DB.prepare("SELECT value FROM budget_settings WHERE key = ?").bind("finnhub_api_key").first();
  return (row && row.value) || null;
}

/* { date: "YYYY-MM-DD", minutes, weekday (0 = Sunday) } in New York. */
export function newYork(ms) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date(ms)).forEach((p) => { parts[p.type] = p.value; });
  return {
    date: parts.year + "-" + parts.month + "-" + parts.day,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)
  };
}

/* The latest weekday whose session has closed (4:10 pm New York, a
   little after the 4:00 close). Holidays aren't known here: the quote's
   own timestamp says which day actually traded (see ensureMarket). */
export function expectedSession(ms) {
  let t = ms;
  let ny = newYork(t);
  if (ny.weekday >= 1 && ny.weekday <= 5 && ny.minutes >= 16 * 60 + 10) return ny.date;
  for (let i = 0; i < 7; i++) {
    t -= 864e5;
    ny = newYork(t);
    if (ny.weekday >= 1 && ny.weekday <= 5) return ny.date;
  }
  return ny.date;
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error("Finnhub answered " + res.status + (res.status === 401 || res.status === 403 ? " (check the key)" : ""));
  return res.json();
}

/* Quotes and headlines for the latest session. */
export async function fetchMarket(key, fetchImpl) {
  const q = (path) => FINNHUB_API + path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(key);
  const quotes = await Promise.all(SYMBOLS.map(async (x) => {
    const r = await getJson(fetchImpl, q("/quote?symbol=" + x.symbol));
    if (!r || typeof r.c !== "number" || !r.c) throw new Error("No quote for " + x.symbol + ".");
    return { symbol: x.symbol, name: x.name, close: r.c, change: r.d, changePct: r.dp, t: r.t };
  }));
  let news = [];
  try {
    news = (await getJson(fetchImpl, q("/news?category=general")) || []).slice(0, 8)
      .map((n) => ({ headline: String(n.headline || "").slice(0, 200), source: String(n.source || "").slice(0, 60), url: /^https:\/\//.test(n.url) ? n.url : "" }))
      .filter((n) => n.headline);
  } catch (e) { /* the recap still works from the numbers */ }
  return { date: newYork(quotes[0].t * 1000).date, quotes, news };
}

const pct = (v) => (v > 0 ? "+" : "") + (Math.round(v * 100) / 100).toFixed(2) + "%";

/* The recap without AI: one sentence per fund. */
export function plainSummary(m) {
  const moves = m.quotes.map((q) => q.name + " " + (q.changePct >= 0 ? "rose " : "fell ") + pct(Math.abs(q.changePct)).replace("+", "") + " to " + q.close.toFixed(2));
  return "US stocks on " + m.date + ": " + moves.join(", ") + ".";
}

export function buildPrompt(m) {
  return [
    "Write a short end-of-day US stock market recap for a personal finance app, 3 or 4 plain sentences, no headings, no bullet points.",
    "Use ONLY the numbers and headlines below; don't invent figures or causes. Mention the S&P 500, Nasdaq and Dow moves, then what the headlines suggest drove the day.",
    "No investment advice and no predictions.",
    "",
    "Date: " + m.date,
    "Closes (index funds): " + m.quotes.map((q) => q.symbol + " (" + q.name + ") " + q.close.toFixed(2) + ", " + pct(q.changePct)).join("; "),
    "Headlines:",
    ...(m.news.length ? m.news.map((n) => "- " + n.headline + (n.source ? " (" + n.source + ")" : "")) : ["- (none)"])
  ].join("\n");
}

async function writeSummary(env, m, fetchImpl) {
  const cfg = await getAiConfig(env);
  if (!cfg.key) return { text: plainSummary(m), by: "numbers" };
  try {
    const [url, init] = aiRequest(cfg, buildPrompt(m), { temperature: 0.3 });
    const res = await fetchImpl(url, init);
    const text = res.ok ? responseText(await res.json()) : "";
    if (text) return { text: text.slice(0, 1500), by: cfg.provider };
  } catch (e) { /* fall back to the numbers */ }
  return { text: plainSummary(m), by: "numbers" };
}

/* Make sure the latest closed session has a recap. Returns
   { status: "nokey" | "ready" | "error", error? }. */
export async function ensureMarket(s, env, fetchImpl, nowMs) {
  const f = fetchImpl || fetch;
  const now = nowMs || Date.now();
  const key = await getFinnhubKey(env);
  if (!key) return { status: "nokey" };
  const expected = expectedSession(now);
  if ((await s.getSetting("market:checked")) === expected) return { status: "ready" };
  const failedAt = Number(await s.getSetting("market:failed_at")) || 0;
  if (now - failedAt < RETRY_MS) return { status: "error", error: await s.getSetting("market:error") };
  try {
    const m = await fetchMarket(key, f);
    /* Mid-session quotes (first use during the day) aren't a recap yet:
       wait for the next close. */
    if (m.date <= expected && !(await s.getSetting("market:" + m.date))) {
      const sum = await writeSummary(env, m, f);
      await s.setSetting("market:" + m.date, JSON.stringify({ date: m.date, quotes: m.quotes.map(({ t, ...q }) => q), news: m.news, summary: sum.text, by: sum.by, at: new Date(now).toISOString() }));
    }
    await s.setSetting("market:checked", expected);
    return { status: "ready" };
  } catch (e) {
    await s.setSetting("market:failed_at", String(now));
    await s.setSetting("market:error", String((e && e.message) || e).slice(0, 200));
    return { status: "error", error: String((e && e.message) || e) };
  }
}

/* Saved recaps, newest first. */
export async function marketHistory(s, limit) {
  const rows = await s.all("SELECT key, value FROM v2_settings WHERE owner_id = ?1 AND key GLOB 'market:[0-9]*' ORDER BY key DESC LIMIT ?2", limit || 30);
  return rows.map((r) => { try { return JSON.parse(r.value); } catch (e) { return null; } }).filter(Boolean);
}
