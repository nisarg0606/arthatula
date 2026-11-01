/*
 * Access-code sign-in + session management for the Arthatula app.
 *
 * The owner picks an access code INSIDE the app (setup screen) — it is
 * never sent through chat or stored anywhere but as a salted PBKDF2
 * hash in budget_settings ('access_code_hash'), and it is never
 * returned by any endpoint. Signing in creates a session: the raw token
 * (32 random bytes, base64url) is returned ONCE to the caller and only
 * its SHA-256 is kept in the `sessions` table.
 *
 *   GET  /api/auth?action=status    (no auth)  { setupRequired, authed }
 *   GET  /api/auth?action=sessions  (device)   { sessions: [...] }
 *   GET  /api/auth?action=pairing   (device)   { pending: null | { label, requestedAt, fingerprint },
 *                                                window: null | { expiresAt } }
 *   POST /api/auth { action: "setup", setupSecret, code, label? } -> { token, expiresAt, session }
 *   POST /api/auth { action: "login", code, label? }            -> { token, expiresAt, session }
 *   POST /api/auth { action: "reset-code", setupSecret, newCode, label? } -> { token, expiresAt, session }
 *        Forgotten code: the SETUP_SECRET from first setup sets a new
 *        code and signs out every session (devices, sync, MCP).
 *   POST /api/auth { action: "logout" }                         (any session)
 *   POST /api/auth { action: "revoke", id }                     (device)
 *   POST /api/auth { action: "change-code", currentCode, newCode } (device)
 *   POST /api/auth { action: "pair-open" }                      (device) -> { code, expiresAt }
 *   POST /api/auth { action: "pair-request", pairCode, tokenHash, label? } (no session; one-time code)
 *                                                               -> { ok, fingerprint }
 *   POST /api/auth { action: "pair-approve", fingerprint }      (device)
 *   POST /api/auth { action: "pair-deny" }                      (device)
 *   POST /api/auth { action: "mcp-create", label? }             (device) -> { token, expiresAt, session }
 *        Mints a least-privilege 'mcp' session token for an AI
 *        assistant; it can call /api/mcp only and is revocable from
 *        the sessions list like any other session.
 *
 * Setup is locked behind the SETUP_SECRET environment secret (set it on
 * the Pages project before first use; keep it, since it also resets a
 * forgotten code), and the first code is claimed atomically — a racing second
 * setup gets 409 and every pre-setup session is wiped.
 *
 * Every secret check reserves an attempt first: 5 per IP and 20 overall
 * per 10 minutes (HTTP 429 beyond that). New codes need 12+ characters.
 *
 * Pairing (v7): see budget.js — the owner opens a 10-minute window in
 * Settings and hands the one-time pairing code to the sync script; the
 * script registers only its token's SHA-256 hash; the owner approves
 * after comparing fingerprints. 'sync' sessions can only use the
 * expense and card routes that opt in (requireAuth allowSync).
 */
import {
  ensureTables, getAccessCodeHash, setAccessCodeHash, claimAccessCode, hashAccessCode,
  verifyAccessCode, timingSafeEqualHex, createSession, getSessionForToken, extractSessionToken,
  sha256Hex, requireAuth, listSessions, deleteSessionById, deleteOtherSessions, deleteAllSessions,
  reserveAttempt, clearAttempts, MIN_CODE_LENGTH,
  isValidTokenHash, pairingFingerprint, openPairing, getPairingWindow, consumePairCode,
  getPendingPairing, setPendingPairing, clearPendingPairing, createSessionForTokenHash
} from "./budget.js";

function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(extraHeaders || {}) }
  });
}
function noDb() {
  return json({ error: "Database binding DB is not configured. Connect the D1 database to this Pages project (or run via wrangler) to store the budget." }, 503);
}
function cleanLabel(v) { return typeof v === "string" ? v.slice(0, 100) : ""; }
function validNewCode(v) { return typeof v === "string" && v.length >= MIN_CODE_LENGTH; }
const SHORT_CODE_ERROR = "Access code must be at least " + MIN_CODE_LENGTH + " characters.";

function tooManyAttempts(retryAfterMs) {
  const mins = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return json({
    error: "Too many attempts — sign-in is locked. Try again in about " + mins + " minute" + (mins === 1 ? "" : "s") + ".",
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
  }, 429, { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
}

/* Verify the access code under the attempt limit. Returns { ok: true }
   or { response }. The attempt is reserved BEFORE the code is checked;
   a wrong code is a 401, or a 429 once it uses up the last allowed
   attempt. A correct code clears the attempt log, and a v6.x SHA-256
   hash is upgraded to PBKDF2 on the spot. */
async function verifyCode(db, request, code) {
  const stored = await getAccessCodeHash(db);
  if (!stored) return { response: json({ error: "Access code setup required", setupRequired: true }, 403) };
  const slot = await reserveAttempt(db, request);
  if (!slot.ok) return { response: tooManyAttempts(slot.retryAfterMs) };
  const check = await verifyAccessCode(stored, code);
  if (!check.ok) {
    if (slot.atLimit) return { response: tooManyAttempts(slot.retryAfterMs) };
    return { response: json({ error: "Wrong access code" }, 401) };
  }
  if (check.legacy) await setAccessCodeHash(db, await hashAccessCode(code));
  await clearAttempts(db);
  return { ok: true };
}

export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  try {
    const action = new URL(context.request.url).searchParams.get("action") || "status";
    if (action === "sessions") {
      const auth = await requireAuth(db, context.request);
      if (auth.response) return auth.response;
      return json({ sessions: await listSessions(db, auth.session.token_hash) });
    }
    if (action === "pairing") {
      const auth = await requireAuth(db, context.request);
      if (auth.response) return auth.response;
      const pending = await getPendingPairing(db);
      const win = await getPairingWindow(db);
      /* Only the label, request time and an 8-char fingerprint are
         exposed — enough to compare against the script's output. */
      return json({
        pending: pending ? { label: pending.label, requestedAt: pending.requestedAt, fingerprint: pairingFingerprint(pending.tokenHash) } : null,
        window: win ? { expiresAt: new Date(win.until).toISOString().slice(0, 19).replace("T", " ") } : null
      });
    }
    if (action === "status") {
      const codeHash = await getAccessCodeHash(db);
      let authed = false;
      if (codeHash) authed = !!(await getSessionForToken(db, extractSessionToken(context.request)));
      return json({ setupRequired: !codeHash, authed });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  try {
    await ensureTables(db);
    const body = await context.request.json().catch(() => ({}));
    const action = body && body.action;

    if (action === "setup") {
      if (await getAccessCodeHash(db)) return json({ error: "An access code is already set — sign in instead." }, 409);
      const expected = context.env.SETUP_SECRET;
      if (typeof expected !== "string" || !expected) {
        return json({ error: "Setup is locked. Add a SETUP_SECRET secret to your Cloudflare app (Settings → Variables and Secrets), redeploy, then enter it here." }, 403);
      }
      if (!validNewCode(body.code)) return json({ error: SHORT_CODE_ERROR }, 400);
      const slot = await reserveAttempt(db, context.request);
      if (!slot.ok) return tooManyAttempts(slot.retryAfterMs);
      /* Compare digests so the comparison is constant-time and length-blind. */
      const okSecret = timingSafeEqualHex(await sha256Hex(String(body.setupSecret || "")), await sha256Hex(expected));
      if (!okSecret) return json({ error: "Wrong setup secret." }, 401);
      if (!(await claimAccessCode(db, await hashAccessCode(body.code)))) {
        return json({ error: "An access code is already set — sign in instead." }, 409);
      }
      /* Nothing created before the code existed may survive it. */
      await deleteAllSessions(db);
      await clearPendingPairing(db);
      await clearAttempts(db);
      const created = await createSession(db, { kind: "device", label: cleanLabel(body.label) });
      return json({ token: created.token, expiresAt: created.session.expiresAt, session: created.session });
    }

    if (action === "login") {
      const check = await verifyCode(db, context.request, body.code);
      if (check.response) return check.response;
      const created = await createSession(db, { kind: "device", label: cleanLabel(body.label) });
      return json({ token: created.token, expiresAt: created.session.expiresAt, session: created.session });
    }

    if (action === "reset-code") {
      if (!(await getAccessCodeHash(db))) return json({ error: "Access code setup required", setupRequired: true }, 409);
      const expected = context.env.SETUP_SECRET;
      if (typeof expected !== "string" || !expected) {
        return json({ error: "Resetting needs your SETUP_SECRET. Add it back in Cloudflare (your app → Settings → Variables and Secrets), redeploy, then try again." }, 403);
      }
      if (!validNewCode(body.newCode)) return json({ error: SHORT_CODE_ERROR }, 400);
      /* Same attempt budget as sign-in: reserved before the check. */
      const slot = await reserveAttempt(db, context.request);
      if (!slot.ok) return tooManyAttempts(slot.retryAfterMs);
      const okSecret = timingSafeEqualHex(await sha256Hex(String(body.setupSecret || "")), await sha256Hex(expected));
      if (!okSecret) return slot.atLimit ? tooManyAttempts(slot.retryAfterMs) : json({ error: "Wrong setup secret." }, 401);
      await setAccessCodeHash(db, await hashAccessCode(body.newCode));
      /* Whoever knew the old code is out, sync and MCP tokens included. */
      await deleteAllSessions(db);
      await clearPendingPairing(db);
      await clearAttempts(db);
      const created = await createSession(db, { kind: "device", label: cleanLabel(body.label) });
      return json({ token: created.token, expiresAt: created.session.expiresAt, session: created.session });
    }

    if (action === "pair-request") {
      /* No session: the caller (the Plaid sync script) proves the owner
         opened this pairing by presenting the one-time pairing code, and
         sends ONLY the SHA-256 hash of a token it keeps locally. Nothing
         authenticates with that hash until the owner approves it. */
      if (!(await getAccessCodeHash(db))) return json({ error: "Access code setup required", setupRequired: true }, 409);
      if (!isValidTokenHash(body.tokenHash)) {
        return json({ error: "tokenHash must be a 64-character lowercase SHA-256 hex digest." }, 400);
      }
      if (!(await getPairingWindow(db))) {
        return json({ error: "No pairing window is open — start pairing in Settings → Security first." }, 403);
      }
      const slot = await reserveAttempt(db, context.request);
      if (!slot.ok) return tooManyAttempts(slot.retryAfterMs);
      if (!(await consumePairCode(db, body.pairCode))) return json({ error: "Wrong or expired pairing code." }, 401);
      const pending = await setPendingPairing(db, { tokenHash: body.tokenHash, label: cleanLabel(body.label) });
      return json({ ok: true, fingerprint: pairingFingerprint(pending.tokenHash) });
    }

    /* Everything below needs a live session. */
    const auth = await requireAuth(db, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    const session = auth.session;
    const currentHash = session.token_hash;

    if (action === "logout") {
      await deleteSessionById(db, session.id);
      return json({ ok: true });
    }
    /* Account management is for signed-in devices only — a sync token
       can sign itself out and nothing more. */
    if (session.kind !== "device") return json({ error: "Sync tokens can't manage sessions or pairing." }, 403);

    if (action === "pair-open") {
      const opened = await openPairing(db);
      return json({ ok: true, code: opened.code, expiresAt: opened.expiresAt });
    }
    if (action === "pair-approve") {
      const pending = await getPendingPairing(db);
      if (!pending) return json({ error: "No pairing request is waiting." }, 400);
      if (typeof body.fingerprint !== "string" || !body.fingerprint) {
        return json({ error: "Approve needs the fingerprint you compared." }, 400);
      }
      if (!timingSafeEqualHex(body.fingerprint.toLowerCase(), pairingFingerprint(pending.tokenHash))) {
        return json({ error: "The pending request changed — reload Settings and compare the fingerprint again." }, 409);
      }
      /* The registered hash becomes a revocable 'sync' session (180-day
         life); the raw token stays on the sync script's machine. */
      await createSessionForTokenHash(db, { kind: "sync", label: pending.label, tokenHash: pending.tokenHash });
      await clearPendingPairing(db);
      return json({ ok: true, label: pending.label, sessions: await listSessions(db, currentHash) });
    }
    if (action === "pair-deny") {
      await clearPendingPairing(db);
      return json({ ok: true });
    }
    if (action === "mcp-create") {
      /* The raw token is returned ONCE, here; only its SHA-256 is
         stored. An mcp session can call /api/mcp and nothing else (see
         requireAuth), shows in the sessions list, and dies with a code
         change like every other session. */
      const created = await createSession(db, { kind: "mcp", label: cleanLabel(body.label) || "AI assistant (MCP)" });
      return json({
        token: created.token, expiresAt: created.session.expiresAt, session: created.session,
        sessions: await listSessions(db, currentHash)
      });
    }
    if (action === "sessions") {
      return json({ sessions: await listSessions(db, currentHash) });
    }
    if (action === "revoke") {
      if (!body.id || typeof body.id !== "string") return json({ error: "Missing session id" }, 400);
      await deleteSessionById(db, body.id);
      return json({ ok: true, sessions: await listSessions(db, currentHash) });
    }
    if (action === "change-code") {
      if (!validNewCode(body.newCode)) return json({ error: "New access code must be at least " + MIN_CODE_LENGTH + " characters." }, 400);
      const check = await verifyCode(db, context.request, body.currentCode);
      if (check.response) return check.response;
      await setAccessCodeHash(db, await hashAccessCode(body.newCode));
      /* Every other device/token is signed out; this one stays in. */
      await deleteOtherSessions(db, session.id);
      return json({ ok: true, sessions: await listSessions(db, currentHash) });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
