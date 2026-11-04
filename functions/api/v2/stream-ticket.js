/*
 * v2 stream ticket (serves /api/v2/stream-ticket).
 *   POST -> { ticket, expiresAt }
 * Trades the caller's session (which the WebSocket handshake can't
 * carry) for a one-minute ticket for /api/v2/stream. See ../_stream.js.
 * Session kinds: the default requireAuth already refuses sync and MCP
 * sessions here — only signed-in devices get tickets.
 */
import { handleV2 } from "../_v2http.js";
import { getAccessCodeHash } from "../budget.js";
import { makeStreamTicket } from "../_stream.js";

export const onRequestPost = (context) => handleV2(context, async ({ db }) => {
  const made = await makeStreamTicket(await getAccessCodeHash(db), Date.now());
  return { ticket: made.ticket, expiresAt: made.expiresAt };
}, { skipMirror: true });
