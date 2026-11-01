/*
 * Workers entry point: the same app as the Cloudflare Pages deployment,
 * runnable as one Worker so the "Deploy to Cloudflare" button can set it
 * up in a single step (that button supports Workers only).
 *
 * /api/* goes to the very same handlers Pages runs from functions/ (each
 * file's onRequestGet / onRequestPost / ... / onRequest), with the Pages
 * context shape they expect; everything else is a static file from the
 * assets binding. Every response gets the security headers of
 * functions/_middleware.js.
 *
 * tests/worker.test.mjs checks ROUTES covers every file in functions/api.
 */
import { withSecurityHeaders } from "./functions/_middleware.js";
import { ensureV2, scope, OWNER_ID } from "./functions/api/_v2db.js";
import { ensureMarket } from "./functions/api/_market.js";
import { getSimplefinUrl } from "./functions/api/settings.js";
import { syncSimplefin } from "./functions/api/v2/simplefin.js";
import * as actuals from "./functions/api/actuals.js";
import * as ask from "./functions/api/ask.js";
import * as auth from "./functions/api/auth.js";
import * as bank from "./functions/api/bank.js";
import * as budget from "./functions/api/budget.js";
import * as cards from "./functions/api/cards.js";
import * as categorize from "./functions/api/categorize.js";
import * as expenses from "./functions/api/expenses.js";
import * as mcp from "./functions/api/mcp.js";
import * as pending from "./functions/api/pending.js";
import * as settings from "./functions/api/settings.js";
import * as syncRequests from "./functions/api/sync-requests.js";
import * as syncComplete from "./functions/api/sync-requests/[id]/complete.js";
import * as syncClaim from "./functions/api/sync-requests/claim.js";
import * as syncLatest from "./functions/api/sync-requests/latest.js";
import * as v2accounts from "./functions/api/v2/accounts.js";
import * as v2autoreview from "./functions/api/v2/autoreview.js";
import * as v2budgets from "./functions/api/v2/budgets.js";
import * as v2categories from "./functions/api/v2/categories.js";
import * as v2checklist from "./functions/api/v2/checklist.js";
import * as v2demo from "./functions/api/v2/demo.js";
import * as v2export from "./functions/api/v2/export.js";
import * as v2import from "./functions/api/v2/import.js";
import * as v2goals from "./functions/api/v2/goals.js";
import * as v2investments from "./functions/api/v2/investments.js";
import * as v2market from "./functions/api/v2/market.js";
import * as v2layout from "./functions/api/v2/layout.js";
import * as v2migration from "./functions/api/v2/migration.js";
import * as v2networth from "./functions/api/v2/networth.js";
import * as v2recurring from "./functions/api/v2/recurring.js";
import * as v2reports from "./functions/api/v2/reports.js";
import * as v2rules from "./functions/api/v2/rules.js";
import * as v2simplefin from "./functions/api/v2/simplefin.js";
import * as v2splitwise from "./functions/api/v2/splitwise.js";
import * as v2sync from "./functions/api/v2/sync.js";
import * as v2transactions from "./functions/api/v2/transactions.js";

/* [path, module, file] — a path segment written ":name" is a parameter
   (Pages' [name].js); `file` is the functions/ file it stands for. */
export const ROUTES = [
  ["/api/actuals", actuals, "api/actuals.js"],
  ["/api/ask", ask, "api/ask.js"],
  ["/api/auth", auth, "api/auth.js"],
  ["/api/bank", bank, "api/bank.js"],
  ["/api/budget", budget, "api/budget.js"],
  ["/api/cards", cards, "api/cards.js"],
  ["/api/categorize", categorize, "api/categorize.js"],
  ["/api/expenses", expenses, "api/expenses.js"],
  ["/api/mcp", mcp, "api/mcp.js"],
  ["/api/pending", pending, "api/pending.js"],
  ["/api/settings", settings, "api/settings.js"],
  ["/api/sync-requests", syncRequests, "api/sync-requests.js"],
  ["/api/sync-requests/:id/complete", syncComplete, "api/sync-requests/[id]/complete.js"],
  ["/api/sync-requests/claim", syncClaim, "api/sync-requests/claim.js"],
  ["/api/sync-requests/latest", syncLatest, "api/sync-requests/latest.js"],
  ["/api/v2/accounts", v2accounts, "api/v2/accounts.js"],
  ["/api/v2/autoreview", v2autoreview, "api/v2/autoreview.js"],
  ["/api/v2/budgets", v2budgets, "api/v2/budgets.js"],
  ["/api/v2/categories", v2categories, "api/v2/categories.js"],
  ["/api/v2/checklist", v2checklist, "api/v2/checklist.js"],
  ["/api/v2/demo", v2demo, "api/v2/demo.js"],
  ["/api/v2/export", v2export, "api/v2/export.js"],
  ["/api/v2/goals", v2goals, "api/v2/goals.js"],
  ["/api/v2/import", v2import, "api/v2/import.js"],
  ["/api/v2/investments", v2investments, "api/v2/investments.js"],
  ["/api/v2/market", v2market, "api/v2/market.js"],
  ["/api/v2/layout", v2layout, "api/v2/layout.js"],
  ["/api/v2/migration", v2migration, "api/v2/migration.js"],
  ["/api/v2/networth", v2networth, "api/v2/networth.js"],
  ["/api/v2/recurring", v2recurring, "api/v2/recurring.js"],
  ["/api/v2/reports", v2reports, "api/v2/reports.js"],
  ["/api/v2/rules", v2rules, "api/v2/rules.js"],
  ["/api/v2/simplefin", v2simplefin, "api/v2/simplefin.js"],
  ["/api/v2/splitwise", v2splitwise, "api/v2/splitwise.js"],
  ["/api/v2/sync", v2sync, "api/v2/sync.js"],
  ["/api/v2/transactions", v2transactions, "api/v2/transactions.js"]
];

/* The route for a path and its parameters, or null. Exact segments win
   over a parameter, like Pages (…/claim before …/:id/complete). */
export function match(pathname) {
  const parts = pathname.replace(/\/+$/, "").split("/");
  let best = null;
  for (const [path, mod] of ROUTES) {
    const want = path.split("/");
    if (want.length !== parts.length) continue;
    const params = {};
    let wild = 0, ok = true;
    for (let i = 0; i < want.length && ok; i++) {
      if (want[i].startsWith(":")) { params[want[i].slice(1)] = decodeURIComponent(parts[i]); wild++; }
      else ok = want[i] === parts[i];
    }
    if (ok && (!best || wild < best.wild)) best = { mod, params, wild };
  }
  return best;
}

function handlerFor(mod, method) {
  const name = "onRequest" + method.charAt(0) + method.slice(1).toLowerCase();
  return mod[name] || mod.onRequest || null;
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const route = match(url.pathname);
  if (!route) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const handler = handlerFor(route.mod, request.method);
  if (!handler) return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  return handler({
    request, env, params: route.params, data: {},
    waitUntil: (p) => ctx.waitUntil(p),
    next: () => env.ASSETS.fetch(request)
  });
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const response = path === "/api" || path.startsWith("/api/") ? await handleApi(request, env, ctx) : await env.ASSETS.fetch(request);
    return withSecurityHeaders(response, request.url);
  },
  /* The nightly market recap and SimpleFIN pull (wrangler.toml
     [triggers]); Pages has no cron, so there the first visit after the
     close writes the recap and opening the app pulls SimpleFIN. */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const s = scope(env.DB, OWNER_ID);
    ctx.waitUntil(ensureV2(env.DB).then(() => Promise.all([
      ensureMarket(s, env),
      getSimplefinUrl(env.DB).then((url) => url && syncSimplefin(s, env.DB)).catch(() => { /* status shows the error */ })
    ])));
  }
};
