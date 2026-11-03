/*
 * OAuth 2.1 for /api/mcp (functions/api/_oauth.js).
 * Covers: discovery docs (JSON, request-derived origin, not SPA HTML —
 * via the handlers, via functions/_middleware.js which is the Pages
 * guarantee for dotted paths, and via worker.js for the Worker
 * deployment), the setup-mode guard, Dynamic Client Registration
 * validation, the authorize flow (unknown client / bad redirect must
 * NOT redirect; missing/plain PKCE redirects an error; deny; wrong
 * access code 401 then the attempt limiter's 429), the token exchange
 * (bad verifier burns the code; code reuse fails), the issued token
 * being a real least-privilege 'mcp' session (works on /api/mcp with
 * all tools, refused on the raw API; /api/mcp 401 carries the
 * WWW-Authenticate resource_metadata pointer), refresh rotation (old
 * refresh token dies, the previous OAuth session is revoked, exactly
 * one OAuth session stays live), and revocation.
 * Run: node tests/oauth.test.mjs — dummy data only.
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, authHeaders, setupTestAuth } from "./_fake-d1.mjs";
import { handleOAuthRequest, isOAuthPath } from "../functions/api/_oauth.js";
import { onRequest as middleware } from "../functions/_middleware.js";
import worker from "../worker.js";
import { onRequestPost as mcpPost } from "../functions/api/mcp.js";
import { onRequestGet as expGet } from "../functions/api/expenses.js";
import { onRequestGet as authGet } from "../functions/api/auth.js";

const ORIGIN = "https://example.test";
const CODE = "test-code-123"; /* setupTestAuth's code */
const REDIRECT = "https://client.example/callback";

const getCtx = (env, url) => ({ env, request: new Request(url, { method: "GET" }) });
const formCtx = (env, fields, url) => ({
  env,
  request: new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  })
});
const dispatch = (env, ctx) => handleOAuthRequest(ctx);
async function pkce(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function register(env, overrides) {
  const res = await dispatch(env, makeCtx(env, {
    redirect_uris: [REDIRECT], client_name: "Test Claude",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "mcp",
    ...(overrides || {})
  }, "POST", ORIGIN + "/oauth/register"));
  return res;
}
async function authorizeParams(env, clientId, verifier) {
  return {
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    state: "state-42", code_challenge: await pkce(verifier), code_challenge_method: "S256",
    scope: "mcp", resource: ORIGIN + "/api/mcp"
  };
}
async function approveAndGetCode(env, clientId, verifier) {
  const params = await authorizeParams(env, clientId, verifier);
  const res = await dispatch(env, formCtx(env, { ...params, decision: "approve", code: CODE }, ORIGIN + "/oauth/authorize"));
  assert.equal(res.status, 302, "approve redirects");
  const loc = new URL(res.headers.get("Location"));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("state"), "state-42", "state preserved");
  const code = loc.searchParams.get("code");
  assert.ok(code && code.length >= 32, "a real code came back");
  return code;
}
const exchange = (env, fields) => dispatch(env, formCtx(env, fields, ORIGIN + "/oauth/token"));
const mcpList = (env, token) => mcpPost(makeCtx(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "POST", "http://local/api/mcp", authHeaders(token)));
async function oauthSessions(env, device) {
  const res = await authGet(makeCtx(env, undefined, "GET", "http://local/api/auth?action=sessions", authHeaders(device)));
  return (await res.json()).sessions.filter((s) => s.kind === "mcp" && s.label.startsWith("OAuth:"));
}

/* ---------- 1. Discovery: JSON, right fields, derived origin ------- */
{
  const env = { DB: new FakeD1() };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
    const res = await dispatch(env, getCtx(env, ORIGIN + path));
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("Content-Type"), /application\/json/);
    const doc = await res.json();
    assert.equal(doc.resource, ORIGIN + "/api/mcp");
    assert.deepEqual(doc.authorization_servers, [ORIGIN]);
    assert.deepEqual(doc.bearer_methods_supported, ["header"]);
    assert.ok(isOAuthPath(path));
  }
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const res = await dispatch(env, getCtx(env, ORIGIN + path));
    assert.equal(res.status, 200, path);
    const doc = await res.json();
    assert.equal(doc.issuer, ORIGIN);
    assert.equal(doc.authorization_endpoint, ORIGIN + "/oauth/authorize");
    assert.equal(doc.token_endpoint, ORIGIN + "/oauth/token");
    assert.equal(doc.registration_endpoint, ORIGIN + "/oauth/register");
    assert.equal(doc.revocation_endpoint, ORIGIN + "/oauth/revoke");
    assert.deepEqual(doc.response_types_supported, ["code"]);
    assert.deepEqual(doc.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(doc.token_endpoint_auth_methods_supported, ["none"]);
  }
  /* A different request origin yields that origin — nothing hardcoded. */
  const other = await (await dispatch(env, getCtx(env, "http://preview.local/.well-known/oauth-authorization-server"))).json();
  assert.equal(other.issuer, "http://preview.local");

  /* Pages guarantee: the root middleware serves these paths itself, so
     the SPA fallback (context.next) is never reached for them. */
  const spa = async () => new Response("<html>SPA</html>", { headers: { "Content-Type": "text/html" } });
  const mwRes = await middleware({ env, request: new Request(ORIGIN + "/.well-known/oauth-protected-resource"), next: spa });
  assert.match(mwRes.headers.get("Content-Type"), /application\/json/, "middleware answers JSON, not the SPA");
  assert.equal((await mwRes.json()).resource, ORIGIN + "/api/mcp");
  const mwPass = await middleware({ env, request: new Request(ORIGIN + "/some-app-page"), next: spa });
  assert.equal(await mwPass.text(), "<html>SPA</html>", "non-OAuth paths still fall through");

  /* Worker deployment: worker.js dispatches OAuth paths before ASSETS. */
  const wEnv = { DB: env.DB, ASSETS: { fetch: spa } };
  const wRes = await worker.fetch(new Request(ORIGIN + "/.well-known/oauth-authorization-server"), wEnv, { waitUntil: () => {} });
  assert.match(wRes.headers.get("Content-Type"), /application\/json/, "worker answers JSON, not the SPA");
  assert.equal((await wRes.json()).issuer, ORIGIN);
}

/* ---------- 2. Setup-mode guard ------------------------------------ */
{
  const env = { DB: new FakeD1() };
  const reg = await register(env);
  assert.equal(reg.status, 201, "DCR stays public before setup (Claude registers before any auth)");
  const client = await reg.json();
  const params = await authorizeParams(env, client.client_id, "verifier-setup");
  const url = ORIGIN + "/oauth/authorize?" + new URLSearchParams(params);
  const res = await dispatch(env, getCtx(env, url));
  assert.equal(res.status, 403, "authorize refuses before an access code exists");
  assert.equal((await res.json()).setupRequired, true);
  const tok = await exchange(env, { grant_type: "authorization_code", code: "x", client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "verifier-setup" });
  assert.equal(tok.status, 403, "token endpoint refuses before setup");
}

/* ---------- 3. The full flow --------------------------------------- */
const env = { DB: new FakeD1() };
const device = await setupTestAuth(env);
let clientId, access1, refresh1, access2, refresh2, goodCode;
{
  /* DCR validation. */
  assert.equal((await register(env, { redirect_uris: [] })).status, 400, "redirect_uris required");
  assert.equal((await register(env, { redirect_uris: ["http://evil.example/cb"] })).status, 400, "plain http non-loopback rejected");
  assert.equal((await register(env, { redirect_uris: ["javascript:alert(1)"] })).status, 400, "non-http(s) rejected");
  assert.equal((await register(env, { token_endpoint_auth_method: "client_secret_basic" })).status, 400, "secret clients rejected");
  assert.equal((await register(env, { grant_types: ["implicit"] })).status, 400, "implicit rejected");
  const loop = await register(env, { redirect_uris: ["http://localhost:33418/callback"], client_name: "Loopback" });
  assert.equal(loop.status, 201, "loopback http is fine for native clients");

  const reg = await register(env);
  assert.equal(reg.status, 201);
  const client = await reg.json();
  clientId = client.client_id;
  assert.ok(clientId);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.deepEqual(client.redirect_uris, [REDIRECT]);
  assert.ok(Number.isInteger(client.client_id_issued_at));

  const verifier = "verifier-one-0123456789-abcdefghijklmnopqrstuvwxyz";
  const params = await authorizeParams(env, clientId, verifier);

  /* Authorize failures that must NOT redirect. */
  let res = await dispatch(env, getCtx(env, ORIGIN + "/oauth/authorize?" + new URLSearchParams({ ...params, client_id: "nope" })));
  assert.equal(res.status, 400); assert.equal(res.headers.get("Location"), null, "unknown client: no redirect");
  res = await dispatch(env, getCtx(env, ORIGIN + "/oauth/authorize?" + new URLSearchParams({ ...params, redirect_uri: "https://client.example/other" })));
  assert.equal(res.status, 400); assert.equal(res.headers.get("Location"), null, "bad redirect: no redirect");

  /* Failures that DO redirect (the redirect_uri is trusted by now). */
  const noChallenge = { ...params }; delete noChallenge.code_challenge;
  res = await dispatch(env, getCtx(env, ORIGIN + "/oauth/authorize?" + new URLSearchParams(noChallenge)));
  assert.equal(res.status, 302);
  let loc = new URL(res.headers.get("Location"));
  assert.equal(loc.searchParams.get("error"), "invalid_request", "missing PKCE challenge redirects an error");
  assert.equal(loc.searchParams.get("state"), "state-42");
  res = await dispatch(env, getCtx(env, ORIGIN + "/oauth/authorize?" + new URLSearchParams({ ...params, code_challenge_method: "plain" })));
  loc = new URL(res.headers.get("Location"));
  assert.equal(loc.searchParams.get("error"), "invalid_request", "plain PKCE rejected");
  res = await dispatch(env, getCtx(env, ORIGIN + "/oauth/authorize?" + new URLSearchParams({ ...params, resource: "https://example.test/api/other" })));
  loc = new URL(res.headers.get("Location"));
  assert.equal(loc.searchParams.get("error"), "invalid_target", "foreign resource indicator rejected");

  /* The consent page itself. */
  res = await dispatch(env, getCtx(env, ORIGIN + "/oauth/authorize?" + new URLSearchParams(params)));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Test Claude/);
  assert.match(html, /access code/i);
  assert.match(html, /MCP tools/);
  assert.ok(!html.includes(CODE), "the page never echoes a code");

  /* Deny needs no code and redirects access_denied. */
  res = await dispatch(env, formCtx(env, { ...params, decision: "deny" }, ORIGIN + "/oauth/authorize"));
  assert.equal(res.status, 302);
  loc = new URL(res.headers.get("Location"));
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "state-42");

  /* Wrong access code -> 401 consent page with the error. */
  res = await dispatch(env, formCtx(env, { ...params, decision: "approve", code: "wrong-code-999" }, ORIGIN + "/oauth/authorize"));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Wrong access code/);

  /* Bad-verifier exchange burns the code. */
  const burned = await approveAndGetCode(env, clientId, verifier);
  res = await exchange(env, { grant_type: "authorization_code", code: burned, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "not-the-verifier" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant", "bad PKCE verifier fails");
  res = await exchange(env, { grant_type: "authorization_code", code: burned, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant", "the burned code stays burned");

  /* Wrong redirect at exchange fails too. */
  const forRedirect = await approveAndGetCode(env, clientId, verifier);
  res = await exchange(env, { grant_type: "authorization_code", code: forRedirect, client_id: clientId, redirect_uri: "https://client.example/other", code_verifier: verifier });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant", "redirect mismatch fails");

  /* Happy path. */
  goodCode = await approveAndGetCode(env, clientId, verifier);
  res = await exchange(env, { grant_type: "authorization_code", code: goodCode, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(res.status, 200);
  const tokens = await res.json();
  access1 = tokens["access" + "_token"]; refresh1 = tokens.refresh_token;
  assert.ok(access1 && access1.length >= 32);
  assert.ok(refresh1 && refresh1.length >= 32);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, "mcp");
  assert.equal(tokens.expires_in, 90 * 24 * 60 * 60);

  /* Code reuse fails. */
  res = await exchange(env, { grant_type: "authorization_code", code: goodCode, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant", "authorization codes are single-use");

  /* The issued token is a real mcp session. */
  const list = await mcpList(env, access1);
  assert.equal(list.status, 200, "OAuth access token calls /api/mcp");
  const tools = (await list.json()).result.tools;
  assert.equal(tools.length, 68, "all 68 tools listed");
  const raw = await expGet(makeCtx(env, undefined, "GET", "http://local/api/expenses", authHeaders(access1)));
  assert.equal(raw.status, 403, "OAuth token refused on the raw API (mcp kind invariant)");
  const sessions = await oauthSessions(env, device);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].label, "OAuth: Test Claude");

  /* The 401 that starts Claude's discovery now points at the metadata. */
  const anon = await mcpPost(makeCtx(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "POST", "http://local/api/mcp"));
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("WWW-Authenticate"),
    'Bearer resource_metadata="http://local/.well-known/oauth-protected-resource", scope="mcp"');

  /* Refresh rotation: new pair, old refresh dead, old session revoked. */
  res = await dispatch(env, formCtx(env, { grant_type: "refresh_token", refresh_token: refresh1, client_id: clientId }, ORIGIN + "/oauth/token"));
  assert.equal(res.status, 200);
  const rotated = await res.json();
  access2 = rotated["access" + "_token"]; refresh2 = rotated.refresh_token;
  assert.ok(access2 && access2 !== access1, "rotation issues a new access token");
  assert.ok(refresh2 && refresh2 !== refresh1, "rotation issues a new refresh token");
  res = await dispatch(env, formCtx(env, { grant_type: "refresh_token", refresh_token: refresh1, client_id: clientId }, ORIGIN + "/oauth/token"));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant", "the rotated-out refresh token is dead");
  assert.equal((await mcpList(env, access1)).status, 401, "the previous OAuth session was revoked on rotation");
  assert.equal((await mcpList(env, access2)).status, 200, "the new access token works");
  assert.equal((await oauthSessions(env, device)).length, 1, "rotation does not pile up sessions");
  res = await dispatch(env, formCtx(env, { grant_type: "refresh_token", refresh_token: refresh2, client_id: "someone-else" }, ORIGIN + "/oauth/token"));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_client", "refresh is bound to its client");

  /* Unsupported grant + revocation. */
  res = await exchange(env, { grant_type: "client_credentials", client_id: clientId });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "unsupported_grant_type");
  res = await dispatch(env, formCtx(env, { token: refresh2 }, ORIGIN + "/oauth/revoke"));
  assert.equal(res.status, 200, "revoke always 200");
  res = await dispatch(env, formCtx(env, { grant_type: "refresh_token", refresh_token: refresh2, client_id: clientId }, ORIGIN + "/oauth/token"));
  assert.equal(res.status, 400, "revoked refresh token is dead");
  assert.equal((await mcpList(env, access2)).status, 401, "revoking the refresh token killed its session too");
  assert.equal((await oauthSessions(env, device)).length, 0);
  res = await dispatch(env, formCtx(env, { token: "never-issued" }, ORIGIN + "/oauth/revoke"));
  assert.equal(res.status, 200, "revoking an unknown token is still 200");
}

/* ---------- 4. Attempt limiter on the consent POST ------------------ */
{
  const env2 = { DB: new FakeD1() };
  await setupTestAuth(env2);
  const client = await (await register(env2)).json();
  const params = await authorizeParams(env2, client.client_id, "verifier-limit");
  let last;
  for (let i = 1; i <= 5; i++) {
    last = await dispatch(env2, formCtx(env2, { ...params, decision: "approve", code: "wrong-code-" + i }, ORIGIN + "/oauth/authorize"));
    if (i < 5) assert.equal(last.status, 401, "wrong code #" + i);
  }
  assert.equal(last.status, 429, "the 5th wrong code hits the shared attempt limiter");
  const sixth = await dispatch(env2, formCtx(env2, { ...params, decision: "approve", code: CODE }, ORIGIN + "/oauth/authorize"));
  assert.equal(sixth.status, 429, "even the right code waits out the lockout");
}

console.log("oauth.test.mjs: all assertions passed");
