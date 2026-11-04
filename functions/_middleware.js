/*
 * Security headers for every response — the static page and assets as
 * well as /api/*. (A functions/_middleware.js runs for all requests on
 * the Pages project. If you deploy a hand-bundled Advanced Mode
 * _worker.js, build it with `npx wrangler pages functions build
 * --outdir=<dir>` so this middleware is included, or wrap its fetch
 * handler with withSecurityHeaders() below.)
 *
 * - Content-Security-Policy: scripts only from this origin; fetch/XHR only to this origin, so even a
 *   misbehaving script can't send the budget or the session token
 *   anywhere else. 'unsafe-inline' styles stay for the style
 *   attributes Chart.js and the app set.
 * - frame-ancestors 'none' / X-Frame-Options: the app can't be framed,
 *   so no other site can trick a tap onto "Approve" (pairing) or
 *   "Revoke".
 * - /api/* responses are never cached (they carry tokens and finances).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'none'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains"
};

export function withSecurityHeaders(response, url) {
  /* A WebSocket upgrade (the live price stream) can't be rebuilt as a
     new Response — the runtime ties the socket to the original — so
     it goes back untouched. */
  if (response.webSocket || response.status === 101) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (new URL(url).pathname.startsWith("/api/")) out.headers.set("Cache-Control", "no-store");
  return out;
}

/* OAuth 2.1 for the MCP server (api/_oauth.js): its paths live OUTSIDE
 * /api/ — /.well-known/* (discovery) and /oauth/* (register, authorize,
 * token, revoke). Pages function routing for DOTTED directories like
 * .well-known is not guaranteed (an unmatched path otherwise falls
 * through to the static SPA, which is exactly how this feature would
 * silently fail), so the middleware — which Pages runs for EVERY
 * request — intercepts those paths itself and dispatches to the same
 * handlers the functions/oauth + functions/.well-known route files
 * export. The route files stay as the conventional mapping; this is
 * the guarantee. */
import { handleOAuthRequest, isOAuthPath } from "./api/_oauth.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (isOAuthPath(url.pathname)) {
    const response = await handleOAuthRequest(context);
    if (response) {
      const out = withSecurityHeaders(response, context.request.url);
      /* The consent form's whole job is a 302 out to the client's
         registered redirect_uri (another origin), which the app-wide
         form-action 'self' would otherwise block — relax it for the
         OAuth endpoints only (they serve no scripts regardless). */
      out.headers.set("Content-Security-Policy",
        CONTENT_SECURITY_POLICY.replace("form-action 'self'", "form-action 'self' https:"));
      return out;
    }
  }
  const response = await context.next();
  return withSecurityHeaders(response, context.request.url);
}
