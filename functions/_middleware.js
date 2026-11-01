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
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (new URL(url).pathname.startsWith("/api/")) out.headers.set("Cache-Control", "no-store");
  return out;
}

export async function onRequest(context) {
  const response = await context.next();
  return withSecurityHeaders(response, context.request.url);
}
