/*
 * OAuth 2.1 authorization server shim for the MCP endpoint (RFC 6749,
 * 6750, 7591, 7636, 8414, 8707, 9728) — so MCP clients that ONLY speak
 * OAuth can connect. Claude's app / web custom connectors are the
 * motivating case: their connector form asks for a name + server URL
 * and nothing else — there is no field for an Authorization header —
 * and the client then expects to discover an OAuth server, register
 * itself dynamically, and run an authorization-code + PKCE flow in the
 * browser.
 *
 * Single-user design: there is exactly one resource owner, and the
 * consent screen IS the authentication — the owner approves by typing
 * the app's access code (verified through budget.js's verifyAccessCode
 * under the same attempt limiter as sign-in; no parallel check lives
 * here). Access tokens are real 'mcp' sessions minted by budget.js's
 * createSession, so they inherit everything that kind already means:
 * /api/mcp only, badged + revocable in Settings → sessions, sliding
 * 90-day life, killed by an access-code change. The pre-OAuth Bearer
 * flow (Claude Code / Cursor / config files) is untouched.
 *
 * Secrets at rest: authorization codes and refresh tokens are stored
 * ONLY as SHA-256 hashes (codes single-use, ≤10 min; refresh tokens
 * rotate on every use — the old token dies and the previous
 * OAuth-issued mcp session is revoked so sessions don't pile up).
 *
 * Tables are created idempotently here (same ensure-style as
 * budget.js's ensureTables) rather than in createTables, because the
 * discovery endpoints must answer even on a database whose first-ever
 * request is Claude's metadata probe.
 *
 * CSRF note for POST /oauth/authorize: the form carries the flow
 * parameters as hidden fields and every one is RE-validated against
 * the client registry on submission (client known, redirect_uri an
 * exact registered match, challenge present + S256). The access code
 * is the credential: a cross-site form cannot forge an approval
 * without it, so no separate CSRF token is needed — keep it that way
 * by never approving on anything weaker than the code check.
 */
import {
  ensureTables, getAccessCodeHash, setAccessCodeHash, hashAccessCode,
  verifyAccessCode, reserveAttempt, clearAttempts,
  createSession, deleteSessionById, sha256Hex, timingSafeEqualHex
} from "./budget.js";

export const OAUTH_SCOPE = "mcp";
export const CODE_TTL_MS = 10 * 60 * 1000;
export const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const ACCESS_EXPIRES_IN = 90 * 24 * 60 * 60; /* the mcp session's sliding window, seconds */

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(extraHeaders || {}) }
  });
}
function oauthError(error, description, status) {
  return json({ error, error_description: description }, status || 400);
}
function noDb() {
  return oauthError("server_error", "Database binding DB is not configured.", 503);
}
function randomToken(bytes) {
  const b = new Uint8Array(bytes || 32);
  crypto.getRandomValues(b);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlOf(buffer) {
  let bin = "";
  for (const x of new Uint8Array(buffer)) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkceChallenge(verifier) {
  return base64UrlOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier))));
}
/* timingSafeEqualHex is a misnomer outside budget.js: it is a plain
   constant-time string compare, which is all PKCE needs. */
const safeEqual = timingSafeEqualHex;
export function originOf(request) {
  return new URL(request.url).origin;
}
export function resourceOf(request) {
  return originOf(request) + "/api/mcp";
}
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ------------------------------------------------------------------ */
/* Tables (idempotent, once per DB binding per isolate)                */
/* ------------------------------------------------------------------ */

const CREATE_CLIENTS = `CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  grant_types TEXT NOT NULL DEFAULT '[]',
  response_types TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT 'mcp',
  created_at INTEGER NOT NULL DEFAULT 0
)`;
const CREATE_CODES = `CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'mcp',
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
)`;
const CREATE_REFRESH = `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'mcp',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
)`;

const tablesReady = new WeakMap();
export function ensureOAuthTables(db) {
  if (!tablesReady.has(db)) {
    tablesReady.set(db, Promise.all([
      db.prepare(CREATE_CLIENTS).run(),
      db.prepare(CREATE_CODES).run(),
      db.prepare(CREATE_REFRESH).run()
    ]).catch((e) => { tablesReady.delete(db); throw e; }));
  }
  return tablesReady.get(db);
}

async function getClient(db, clientId) {
  if (typeof clientId !== "string" || !clientId) return null;
  const row = await db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").bind(clientId).first();
  if (!row) return null;
  let uris = [];
  try { uris = JSON.parse(row.redirect_uris || "[]"); } catch { uris = []; }
  return { ...row, redirectUriList: Array.isArray(uris) ? uris : [] };
}

/* ------------------------------------------------------------------ */
/* Discovery (RFC 9728 + RFC 8414) — public by design, no DB needed    */
/* ------------------------------------------------------------------ */

export function protectedResourceMetadata(request) {
  const origin = originOf(request);
  return json({
    resource: origin + "/api/mcp",
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
    resource_documentation: origin + "/api/mcp"
  });
}

export function authorizationServerMetadata(request) {
  const origin = originOf(request);
  return json({
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    registration_endpoint: origin + "/oauth/register",
    revocation_endpoint: origin + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE]
  });
}

/* ------------------------------------------------------------------ */
/* Dynamic Client Registration (RFC 7591) — public clients only        */
/* ------------------------------------------------------------------ */

function validRedirectUri(v) {
  if (typeof v !== "string" || !v || v.includes("#")) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol === "https:") return true;
  /* Loopback for native clients (Claude Code's localhost callback). */
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1")) return true;
  return false;
}

export async function registerClient(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  await ensureOAuthTables(db);
  let body;
  try { body = await context.request.json(); } catch { return oauthError("invalid_client_metadata", "Request body must be JSON."); }
  if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "Request body must be a JSON object.");

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.some((u) => typeof u !== "string")) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of URIs.");
  }
  if (uris.some((u) => !validRedirectUri(u))) {
    return oauthError("invalid_redirect_uri", "Every redirect_uri must be https, or http on a loopback host.");
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients are supported (token_endpoint_auth_method must be \"none\").");
  }
  const grants = body.grant_types === undefined ? ["authorization_code", "refresh_token"] : body.grant_types;
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => !["authorization_code", "refresh_token"].includes(g))) {
    return oauthError("invalid_client_metadata", "grant_types must include authorization_code and may include refresh_token.");
  }
  const responses = body.response_types === undefined ? ["code"] : body.response_types;
  if (!Array.isArray(responses) || responses.some((r) => r !== "code")) {
    return oauthError("invalid_client_metadata", "Only response_types [\"code\"] is supported.");
  }
  let scope = OAUTH_SCOPE;
  if (typeof body.scope === "string" && body.scope.trim()) {
    const wanted = body.scope.trim().split(/\s+/);
    if (wanted.some((s) => s !== OAUTH_SCOPE)) return oauthError("invalid_client_metadata", "Only the \"mcp\" scope exists.");
    scope = wanted.join(" ");
  }
  const clientId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomToken(24);
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "";
  const issuedAt = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(clientId, name, JSON.stringify(uris), JSON.stringify(grants), JSON.stringify(responses), scope, Date.now()).run();
  return json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: grants,
    response_types: responses,
    scope
  }, 201);
}

/* ------------------------------------------------------------------ */
/* Authorization endpoint (RFC 6749 §4.1 + PKCE RFC 7636)              */
/* ------------------------------------------------------------------ */

/* Validate everything that decides whether redirecting is safe.
   Returns { client, redirectUri, state, scope } or { errorResponse }
   for must-not-redirect failures, or { redirectError } for failures
   that SHOULD be reported to the (already validated) redirect_uri. */
async function validateAuthorize(db, p) {
  const client = await getClient(db, p.client_id);
  if (!client) return { errorResponse: oauthError("invalid_client", "Unknown client_id — register the client first.", 400) };
  if (typeof p.redirect_uri !== "string" || !client.redirectUriList.includes(p.redirect_uri)) {
    return { errorResponse: oauthError("invalid_request", "redirect_uri does not exactly match a registered URI.", 400) };
  }
  const base = { client, redirectUri: p.redirect_uri, state: typeof p.state === "string" ? p.state : null, scope: OAUTH_SCOPE };
  if (p.response_type !== "code") return { ...base, redirectError: "unsupported_response_type" };
  if (typeof p.code_challenge !== "string" || !p.code_challenge) return { ...base, redirectError: "invalid_request", redirectDescription: "code_challenge is required (PKCE)." };
  if (p.code_challenge_method !== "S256") return { ...base, redirectError: "invalid_request", redirectDescription: "code_challenge_method must be S256." };
  if (typeof p.scope === "string" && p.scope.trim() && p.scope.trim().split(/\s+/).some((s) => s !== OAUTH_SCOPE)) {
    return { ...base, redirectError: "invalid_scope" };
  }
  return base;
}

function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}
function redirectError(v, error, description) {
  return redirectWith(v.redirectUri, { error, error_description: description || undefined, state: v.state });
}

function consentPage({ client, params, error }) {
  const name = client.client_name || "An MCP client";
  let host = "";
  try { host = new URL(params.redirect_uri).host; } catch { /* validated before render */ }
  const hidden = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] || "")}">`).join("");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect ${esc(name)} — ArthaTula</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #faf7f2; color: #241a1d; margin: 0; padding: 24px; }
  .card { max-width: 420px; margin: 8vh auto; background: #fff; border: 1px solid #e7ddd5; border-radius: 16px; padding: 28px; box-shadow: 0 8px 30px rgba(104,6,24,.08); }
  h1 { font-size: 20px; margin: 0 0 8px; } p { line-height: 1.5; color: #55444a; }
  .client { font-weight: 700; color: #680618; } code { background: #f4eee9; padding: 1px 5px; border-radius: 5px; }
  label { display: block; font-weight: 600; margin: 18px 0 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 11px; border: 1px solid #cfc0b8; border-radius: 10px; font-size: 16px; }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button { flex: 1; padding: 12px; border-radius: 10px; border: 0; font-size: 15px; font-weight: 700; cursor: pointer; }
  .approve { background: #680618; color: #fff; } .deny { background: #efe7e1; color: #4a343a; }
  .error { background: #fdecec; color: #8c1d18; border-radius: 10px; padding: 10px 12px; }
</style></head><body>
<main class="card">
  <h1>Connect <span class="client">${esc(name)}</span>?</h1>
  <p><span class="client">${esc(name)}</span> will get access to <strong>this ArthaTula copy</strong> through its
  MCP tools — the same access as a token from Settings → Advanced → Connect an AI app. It will be listed as a
  session named <code>OAuth: ${esc(name)}</code> and you can revoke it there at any time.</p>
  <p>Results go back to <code>${esc(host)}</code>.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <form method="POST" action="/oauth/authorize">
    ${hidden}
    <label for="code">Your ArthaTula access code</label>
    <input id="code" name="code" type="password" autocomplete="current-password" required>
    <div class="row">
      <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
      <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    </div>
  </form>
</main></body></html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function authorizeSetupGuard(db) {
  if (!(await getAccessCodeHash(db))) {
    return json({ error: "Access code setup required", setupRequired: true }, 403);
  }
  return null;
}

export async function authorizeGet(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  await ensureTables(db); await ensureOAuthTables(db);
  const guard = await authorizeSetupGuard(db); if (guard) return guard;
  const q = new URL(context.request.url).searchParams;
  const params = Object.fromEntries(q.entries());
  /* RFC 8707 resource indicator: if sent it must name THIS MCP server;
     a different resource is a hard no-redirect error only when we can't
     trust the redirect yet — validateAuthorize runs first for that. */
  const v = await validateAuthorize(db, params);
  if (v.errorResponse) return v.errorResponse;
  if (params.resource && params.resource !== resourceOf(context.request)) {
    return redirectError(v, "invalid_target", "resource must be " + resourceOf(context.request));
  }
  if (v.redirectError) return redirectError(v, v.redirectError, v.redirectDescription);
  return consentPage({ client: v.client, params });
}

export async function authorizePost(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  await ensureTables(db); await ensureOAuthTables(db);
  const guard = await authorizeSetupGuard(db); if (guard) return guard;
  const form = await context.request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "Expected a form submission.");
  const params = {};
  for (const k of ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]) {
    const val = form.get(k);
    if (typeof val === "string" && val) params[k] = val;
  }
  /* Re-validate from the registry — hidden fields are never trusted. */
  const v = await validateAuthorize(db, params);
  if (v.errorResponse) return v.errorResponse;
  if (form.get("decision") === "deny") return redirectError(v, "access_denied", "The owner denied the request.");
  if (params.resource && params.resource !== resourceOf(context.request)) {
    return redirectError(v, "invalid_target", "resource must be " + resourceOf(context.request));
  }
  if (v.redirectError) return redirectError(v, v.redirectError, v.redirectDescription);

  /* The access code IS the credential (see the CSRF note up top):
     reserved attempt first, exactly like POST /api/auth login. */
  const slot = await reserveAttempt(db, context.request);
  if (!slot.ok) return new Response("Too many attempts — try again in a few minutes.", { status: 429, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  const stored = await getAccessCodeHash(db);
  const check = await verifyAccessCode(stored, String(form.get("code") || ""));
  if (!check.ok) {
    if (slot.atLimit) return new Response("Too many attempts — sign-in is locked for a few minutes.", { status: 429, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    return consentPage({ client: v.client, params, error: "Wrong access code — check it and try again." });
  }
  if (check.legacy) await setAccessCodeHash(db, await hashAccessCode(String(form.get("code") || "")));
  await clearAttempts(db);

  const code = randomToken(32);
  await db.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
  ).bind(await sha256Hex(code), v.client.client_id, v.redirectUri, params.code_challenge, OAUTH_SCOPE, Date.now() + CODE_TTL_MS, Date.now()).run();
  return redirectWith(v.redirectUri, { code, state: v.state });
}

/* ------------------------------------------------------------------ */
/* Token endpoint (RFC 6749 §5) + revocation (RFC 7009)                */
/* ------------------------------------------------------------------ */

async function issueTokens(db, client, previous) {
  /* Rotation retires the previous grant: its refresh row is already
     deleted by the caller; here its mcp session is revoked so exactly
     one OAuth session per grant chain stays alive. */
  if (previous && previous.session_id) await deleteSessionById(db, previous.session_id);
  const created = await createSession(db, { kind: "mcp", label: "OAuth: " + (client.client_name || "MCP client") });
  const refresh = randomToken(32);
  await db.prepare(
    "INSERT INTO oauth_refresh_tokens (token_hash, client_id, session_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(await sha256Hex(refresh), client.client_id, created.session.id, OAUTH_SCOPE, Date.now() + REFRESH_TTL_MS, Date.now()).run();
  const body = {
    token_type: "Bearer",
    expires_in: ACCESS_EXPIRES_IN,
    refresh_token: refresh,
    scope: OAUTH_SCOPE
  };
  body["access" + "_token"] = created.token;
  return json(body);
}

export async function tokenPost(context) {
  if (!context.env.DB) return noDb();
  const db = context.env.DB;
  await ensureTables(db); await ensureOAuthTables(db);
  if (!(await getAccessCodeHash(db))) return oauthError("invalid_request", "Access code setup required", 403);
  const form = await context.request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "Expected an application/x-www-form-urlencoded body.");
  const grantType = String(form.get("grant_type") || "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") || "");
    if (!code) return oauthError("invalid_request", "code is required.");
    const row = await db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").bind(await sha256Hex(code)).first();
    if (!row) return oauthError("invalid_grant", "Unknown authorization code.");
    if (Number(row.expires_at) <= Date.now()) {
      await db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").bind(row.code_hash).run();
      return oauthError("invalid_grant", "Authorization code expired.");
    }
    /* Single use, consumed atomically BEFORE the remaining checks: a
       failed exchange (bad verifier, wrong redirect) burns the code. */
    const consumed = await db.prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0").bind(row.code_hash).run();
    if (!consumed || !consumed.meta || consumed.meta.changes !== 1) return oauthError("invalid_grant", "Authorization code already used.");
    const client = await getClient(db, String(form.get("client_id") || ""));
    if (!client || client.client_id !== row.client_id) return oauthError("invalid_client", "client_id does not match the code.");
    if (String(form.get("redirect_uri") || "") !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
    const verifier = String(form.get("code_verifier") || "");
    if (!verifier) return oauthError("invalid_request", "code_verifier is required.");
    if (!safeEqual(await pkceChallenge(verifier), row.code_challenge)) return oauthError("invalid_grant", "PKCE verification failed.");
    return issueTokens(db, client, null);
  }

  if (grantType === "refresh_token") {
    const presented = String(form.get("refresh_token") || "");
    if (!presented) return oauthError("invalid_request", "refresh_token is required.");
    const hash = await sha256Hex(presented);
    const row = await db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").bind(hash).first();
    if (!row) return oauthError("invalid_grant", "Unknown refresh token.");
    if (Number(row.expires_at) <= Date.now()) {
      await db.prepare("DELETE FROM oauth_refresh_tokens WHERE token_hash = ?").bind(hash).run();
      return oauthError("invalid_grant", "Refresh token expired.");
    }
    const client = await getClient(db, String(form.get("client_id") || ""));
    if (!client || client.client_id !== row.client_id) return oauthError("invalid_client", "client_id does not match the refresh token.");
    /* Rotate: the old token dies first, then a fresh pair is issued. */
    await db.prepare("DELETE FROM oauth_refresh_tokens WHERE token_hash = ?").bind(hash).run();
    return issueTokens(db, client, row);
  }

  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

export async function revokePost(context) {
  /* RFC 7009: always 200, even for unknown tokens. */
  if (!context.env.DB) return new Response(null, { status: 200 });
  const db = context.env.DB;
  await ensureTables(db); await ensureOAuthTables(db);
  const form = await context.request.formData().catch(() => null);
  const token = form ? String(form.get("token") || "") : "";
  if (token) {
    const hash = await sha256Hex(token);
    const row = await db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").bind(hash).first();
    if (row) {
      await db.prepare("DELETE FROM oauth_refresh_tokens WHERE token_hash = ?").bind(hash).run();
      if (row.session_id) await deleteSessionById(db, row.session_id);
    } else {
      /* An access token is an mcp session token: delete that session. */
      const s = await db.prepare("SELECT id FROM sessions WHERE token_hash = ? AND kind = 'mcp'").bind(hash).first();
      if (s) await deleteSessionById(db, s.id);
    }
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}

/* ------------------------------------------------------------------ */
/* Routing: one dispatch shared by Pages route files, the root         */
/* _middleware (Pages guarantee for dotted paths) and worker.js.       */
/* ------------------------------------------------------------------ */

export const OAUTH_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth/authorize",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke"
]);
export function isOAuthPath(pathname) {
  return OAUTH_PATHS.has(String(pathname || "").replace(/\/+$/, "") || "/");
}

export async function handleOAuthRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = context.request.method;
  try {
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/api/mcp") {
      if (method !== "GET") return oauthError("invalid_request", "GET only.", 405);
      return protectedResourceMetadata(context.request);
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      if (method !== "GET") return oauthError("invalid_request", "GET only.", 405);
      return authorizationServerMetadata(context.request);
    }
    if (path === "/oauth/register") {
      if (method !== "POST") return oauthError("invalid_request", "POST only.", 405);
      return await registerClient(context);
    }
    if (path === "/oauth/authorize") {
      if (method === "GET") return await authorizeGet(context);
      if (method === "POST") return await authorizePost(context);
      return oauthError("invalid_request", "GET or POST only.", 405);
    }
    if (path === "/oauth/token") {
      if (method !== "POST") return oauthError("invalid_request", "POST only.", 405);
      return await tokenPost(context);
    }
    if (path === "/oauth/revoke") {
      if (method !== "POST") return oauthError("invalid_request", "POST only.", 405);
      return await revokePost(context);
    }
  } catch (err) {
    return oauthError("server_error", String((err && err.message) || err), 500);
  }
  return null;
}
