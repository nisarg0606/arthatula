/*
 * Live price streaming: the server half of the Investments screen's
 * live view (the client half is js/core/v2/live.js).
 *
 * The browser's WebSocket can't carry the app's Bearer session token,
 * so it first trades the token for a short-lived ticket
 * (POST /api/v2/stream-ticket) and presents the ticket as a query
 * parameter to the stream proxy (GET /api/v2/stream). A ticket is
 * `exp.signature` where the signature is the SHA-256 of the access
 * code hash + ":stream:" + exp: the code hash is a server-side secret
 * that never leaves the database, so tickets can't be forged, need no
 * storage, and die on their own in a minute.
 *
 * The proxy holds the Finnhub key server-side (like every other key
 * in this app) and relays the socket, so the browser only ever talks
 * to its own origin — which the Content-Security-Policy already
 * allows (connect-src 'self').
 */
import { sha256Hex, timingSafeEqualHex } from "./budget.js";
import { FINNHUB_API } from "./_market.js";

export const STREAM_TICKET_TTL_MS = 60 * 1000;

export async function makeStreamTicket(codeHash, nowMs) {
  const exp = nowMs + STREAM_TICKET_TTL_MS;
  const sig = await sha256Hex(String(codeHash) + ":stream:" + exp);
  return { ticket: exp + "." + sig, expiresAt: exp };
}

export async function verifyStreamTicket(codeHash, ticket, nowMs) {
  if (!codeHash || typeof ticket !== "string") return false;
  const dot = ticket.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(ticket.slice(0, dot));
  const sig = ticket.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowMs || exp > nowMs + 10 * STREAM_TICKET_TTL_MS) return false;
  const want = await sha256Hex(String(codeHash) + ":stream:" + exp);
  return timingSafeEqualHex(sig, want);
}

/* The ?symbols= list for /api/v2/quotes: uppercase, validated,
   de-duplicated, capped at Finnhub's free-plan 50 streamed symbols. */
export function parseSymbolsParam(raw) {
  const seen = new Set(), out = [];
  for (const part of String(raw || "").split(",")) {
    const s = part.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

/* Finnhub /quote for each symbol, in parallel. A symbol that errors
   or answers nonsense is simply left out — the caller falls back to
   the bank's price for it. Returns { SYM: { c, d, dp, pc, t } }. */
export async function fetchQuotes(key, fetchImpl, symbols) {
  const out = {};
  await Promise.all((symbols || []).map(async (symbol) => {
    try {
      const res = await fetchImpl(FINNHUB_API + "/quote?symbol=" + encodeURIComponent(symbol) + "&token=" + encodeURIComponent(key));
      if (!res.ok) return;
      const r = await res.json();
      if (r && typeof r.c === "number" && r.c > 0) out[symbol] = { c: r.c, d: r.d, dp: r.dp, pc: r.pc, t: r.t };
    } catch (e) { /* one bad symbol mustn't sink the rest */ }
  }));
  return out;
}
