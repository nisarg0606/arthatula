/*
 * v2 live price stream (serves /api/v2/stream?ticket=...).
 * A WebSocket proxy: the browser connects here with its one-minute
 * ticket, this function opens the Finnhub socket with the saved key
 * and relays messages both ways (the client sends the subscribe
 * frames; Finnhub's trades and pings flow back untouched). The key
 * never reaches the browser. See ../_stream.js for the ticket scheme.
 *
 * Deliberately NOT routed through handleV2: the handshake carries a
 * ticket instead of a session header, and its success response is a
 * 101 upgrade, not JSON.
 */
import { json } from "../_v2db.js";
import { getAccessCodeHash } from "../budget.js";
import { getFinnhubKey } from "../_market.js";
import { verifyStreamTicket } from "../_stream.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "This endpoint streams live prices over a WebSocket." }, 426);
  }
  if (!env.DB) return json({ error: "No database bound." }, 503);
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  const codeHash = await getAccessCodeHash(env.DB);
  if (!(await verifyStreamTicket(codeHash, ticket, Date.now()))) {
    return json({ error: "Sign-in required" }, 401);
  }
  const key = await getFinnhubKey(env);
  if (!key) return json({ error: "Add a Finnhub key in Settings → Market data to stream live prices." }, 503);

  let upstream = null;
  try {
    const res = await fetch("https://ws.finnhub.io?token=" + encodeURIComponent(key), { headers: { Upgrade: "websocket" } });
    upstream = res.webSocket || null;
  } catch (e) { upstream = null; }
  if (!upstream) return json({ error: "Couldn't reach the price feed." }, 502);

  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  upstream.accept();
  const closeBoth = (code, reason) => {
    try { server.close(code, reason); } catch (e) { /* already closed */ }
    try { upstream.close(code, reason); } catch (e) { /* already closed */ }
  };
  server.addEventListener("message", (e) => { try { upstream.send(e.data); } catch (err) { /* peer gone */ } });
  upstream.addEventListener("message", (e) => { try { server.send(e.data); } catch (err) { /* peer gone */ } });
  server.addEventListener("close", (e) => closeBoth(e.code, e.reason));
  upstream.addEventListener("close", (e) => closeBoth(e.code, e.reason));
  server.addEventListener("error", () => closeBoth());
  upstream.addEventListener("error", () => closeBoth());
  return new Response(null, { status: 101, webSocket: client });
}
