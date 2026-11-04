/*
 * v2 live quotes (serves /api/v2/quotes?symbols=AAPL,MSFT,...).
 *   GET -> { status: "nokey", quotes: {} }
 *        | { status: "ready", quotes: { SYM: { c, d, dp, pc, t } }, at }
 * Real-time Finnhub quotes seeding the Investments screen's live view:
 * the current price plus the previous close the day change hangs off.
 * Quotes are cached for 20 seconds per isolate, so reopening the
 * screen doesn't burn the free plan's 60 calls a minute.
 */
import { handleV2, HttpError } from "../_v2http.js";
import { getFinnhubKey } from "../_market.js";
import { parseSymbolsParam, fetchQuotes } from "../_stream.js";

const CACHE_MS = 20 * 1000;
const cache = new Map(); /* symbol -> { at, q } */

export const onRequestGet = (context) => handleV2(context, async ({ env, url }) => {
  const symbols = parseSymbolsParam(url.searchParams.get("symbols") || "");
  if (!symbols.length) throw new HttpError(400, "Give at least one valid symbol.");
  const key = await getFinnhubKey(env);
  if (!key) return { status: "nokey", quotes: {} };
  const now = Date.now();
  const quotes = {}, missing = [];
  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && now - hit.at < CACHE_MS) quotes[s] = hit.q;
    else missing.push(s);
  }
  if (missing.length) {
    const fresh = await fetchQuotes(key, fetch, missing);
    for (const s of Object.keys(fresh)) {
      quotes[s] = fresh[s];
      cache.set(s, { at: now, q: fresh[s] });
    }
  }
  return { status: "ready", quotes, at: new Date(now).toISOString() };
}, { skipMirror: true });
