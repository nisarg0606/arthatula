/* Manual "Sync now" display rules. */

/* A finished sync's result stops showing next to the button a day after
   it finished; a sync that is still queued or running always shows.
   finishedAt is the server's "YYYY-MM-DD HH:MM:SS" (UTC). */
export var SYNC_RESULT_SHOWN_MS = 24 * 60 * 60 * 1000;
export function syncResultExpired(req, nowMs) {
  if (!req || req.status === "pending" || req.status === "running" || !req.finishedAt) return false;
  var finished = Date.parse(String(req.finishedAt).replace(" ", "T") + "Z");
  return !isNaN(finished) && nowMs - finished > SYNC_RESULT_SHOWN_MS;
}
