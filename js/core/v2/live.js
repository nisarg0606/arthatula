/* Live prices for the Investments screen: the pure half of the
   streaming view (the socket plumbing lives in js/ui/v2/investments.js).
 *
 * Prices come from Finnhub through the app's own streaming proxy
 * (/api/v2/stream): a REST quote per symbol seeds the day's change
 * (current + previous close), then trade messages tick the price.
 * Quantities and cost basis still come from the bank sync — only the
 * price moves here. All money stays integer cents, like the rest of
 * the v2 model. */

/* US-listed tickers: letters/digits with an optional . or - suffix
   (BRK.B, BF-B). Anything else (CUR:USD cash pseudo-tickers, crypto,
   Plaid-internal ids) has no Finnhub stock stream and is skipped. */
const TICKER_RE = /^[A-Z0-9]{1,6}([.\-][A-Z0-9]{1,4})?$/;

export function isStreamableTicker(t) {
  return typeof t === "string" && TICKER_RE.test(t);
}

/* The distinct symbols worth subscribing to, in holdings order:
   non-cash positions with a streamable ticker, capped at Finnhub's
   free-plan 50 concurrent symbols. */
export function streamSymbols(holdings) {
  const seen = new Set(), out = [];
  for (const hd of holdings || []) {
    if (!hd || hd.kind === "cash" || !isStreamableTicker(hd.ticker)) continue;
    if (seen.has(hd.ticker)) continue;
    seen.add(hd.ticker);
    out.push(hd.ticker);
    if (out.length >= 50) break;
  }
  return out;
}

/* New York session for a moment: "open" (9:30–16:00 ET), "pre"
   (4:00–9:30), "post" (16:00–20:00), "closed" (nights + weekends).
   Holidays aren't known — a holiday just looks like a quiet day. */
export function nySession(ms) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).forEach((p) => { parts[p.type] = p.value; });
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  if (wd <= 0 || wd >= 6) return "closed";
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (mins < 4 * 60) return "closed";
  if (mins < 9 * 60 + 30) return "pre";
  if (mins < 16 * 60) return "open";
  if (mins < 20 * 60) return "post";
  return "closed";
}

const round2 = (v) => Math.round(v * 100) / 100;

/* Seed one symbol from a Finnhub /quote payload (dollars; c current,
   pc previous close, dp day change %, t epoch seconds). */
export function seedQuote(state, symbol, q) {
  if (!q || typeof q.c !== "number" || !(q.c > 0)) return state;
  const prevCloseCents = typeof q.pc === "number" && q.pc > 0 ? Math.round(q.pc * 100) : null;
  state[symbol] = {
    priceCents: Math.round(q.c * 100),
    prevCloseCents,
    dayPct: typeof q.dp === "number" ? round2(q.dp) : (prevCloseCents ? round2((q.c * 100 - prevCloseCents) / prevCloseCents * 100) : null),
    t: typeof q.t === "number" ? q.t * 1000 : null,
    live: false
  };
  return state;
}

/* One streamed trade (price in dollars, t epoch ms). Keeps the seeded
   previous close so the day change stays anchored to it. */
export function applyTrade(state, symbol, price, t) {
  if (typeof price !== "number" || !(price > 0)) return state;
  const st = state[symbol] || (state[symbol] = { priceCents: null, prevCloseCents: null, dayPct: null, t: null, live: false });
  st.priceCents = Math.round(price * 100);
  st.t = typeof t === "number" ? t : null;
  st.live = true;
  if (st.prevCloseCents) st.dayPct = round2((st.priceCents - st.prevCloseCents) / st.prevCloseCents * 100);
  return state;
}

/* A Finnhub stream frame -> its trades. Ping frames, subscribe acks
   and junk all read as []. */
export function parseStreamMessage(text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return []; }
  if (!m || m.type !== "trade" || !Array.isArray(m.data)) return [];
  const out = [];
  for (const d of m.data) {
    if (d && typeof d.s === "string" && typeof d.p === "number" && d.p > 0) out.push({ symbol: d.s, price: d.p, t: typeof d.t === "number" ? d.t : null });
  }
  return out;
}

/* A holding's value at the live price, or null when there is no live
   price for it (cash, unstreamable, not seeded yet). */
export function liveValueCents(hd, state) {
  if (!hd || hd.kind === "cash" || typeof hd.quantity !== "number") return null;
  const st = state && state[hd.ticker];
  if (!st || st.priceCents === null || st.priceCents === undefined) return null;
  return Math.round(hd.quantity * st.priceCents);
}

/* The portfolio's day move over the holdings that have both a live
   price and a previous close: { cents, pct } or null. */
export function dayTotals(holdings, state) {
  let cents = 0, base = 0, any = false;
  for (const hd of holdings || []) {
    if (!hd || hd.kind === "cash" || typeof hd.quantity !== "number") continue;
    const st = state && state[hd.ticker];
    if (!st || st.priceCents === null || st.priceCents === undefined || !st.prevCloseCents) continue;
    cents += hd.quantity * (st.priceCents - st.prevCloseCents);
    base += hd.quantity * st.prevCloseCents;
    any = true;
  }
  if (!any || !base) return null;
  return { cents: Math.round(cents), pct: round2(cents / base * 100) };
}
