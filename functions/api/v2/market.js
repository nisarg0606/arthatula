/*
 * v2 market recap (serves /api/v2/market). See ../_market.js.
 *   GET -> { status: "nokey" | "ready" | "error", error?, latest, history }
 *        Writes the latest closed session's recap first when it's
 *        missing. latest is the newest recap (or null); history the
 *        ones before it (up to 14).
 */
import { handleV2 } from "../_v2http.js";
import { ensureMarket, marketHistory } from "../_market.js";

export const onRequestGet = (context) => handleV2(context, async ({ s, env }) => {
  const st = await ensureMarket(s, env);
  const all = await marketHistory(s, 15);
  return Object.assign(st, { latest: all[0] || null, history: all.slice(1) });
}, { skipMirror: true });
