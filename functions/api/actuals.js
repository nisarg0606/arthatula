/*
 * Arthatula — actuals endpoint.
 *
 * Routes (this file serves /api/actuals):
 *   PUT  /api/actuals  { monthKey, patch: { ...actualFields, entered? } }
 *   POST /api/actuals  alias of PUT
 *
 * Actuals are the real numbers for a month (entered from the baseline
 * date onwards), stored in the monthly_actuals table next to the planned
 * figures in monthly_budgets. All logic lives in ./budget.js.
 */
import { patchActual, requireAuth } from "./budget.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function onRequestPut(context) {
  if (!context.env.DB) {
    return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
  }
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const body = await context.request.json();
    if (!body || typeof body.monthKey !== "string" || !body.patch) {
      return json({ error: "PUT expects { monthKey, patch }" }, 400);
    }
    return json(await patchActual(context.env.DB, body.monthKey, body.patch));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
export const onRequestPost = onRequestPut;
