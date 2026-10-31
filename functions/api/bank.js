/*
 * Arthatula — bank snapshot endpoint (Bank tab).
 *
 * Routes (this file serves /api/bank):
 *   GET  /api/bank -> { accounts: [...], transactions: [...], syncedAt }
 *        Device sessions only. Transactions are newest-first, capped
 *        at 400. Balances/amounts are dollars.
 *   POST /api/bank -> { ok: true, accounts: n, transactions: m }
 *        SYNC sessions only (the paired Plaid automation): body
 *        { accounts: [...], transactions: [...], syncedAt } is upserted
 *        by Plaid id. Device sessions are refused with 403 — the
 *        snapshot is written by the automation alone, so what the tab
 *        shows is always what Plaid reported.
 *
 *   PATCH /api/bank { txId, kind } -> the snapshot again
 *        Device sessions only: records the Daily review decision for
 *        one bank transaction — kind "repayment", "income", "ignore",
 *        or null to clear it (see setBankReview in ./budget.js).
 *   PATCH /api/bank { ignoreRules: [...] } -> the snapshot again
 *        Device sessions only: replaces the "always ignore payments
 *        like this" rules (see setIgnoreRules in ./budget.js).
 *
 * Amounts cross the API in dollars; storage is integer cents in
 * bank_accounts / bank_transactions (see ./budget.js). Bank amounts
 * keep the Plaid depository sign convention (positive = money OUT of
 * the account, negative = money IN — salary deposits arrive negative);
 * the UI flips the sign for display. All storage logic lives in
 * ./budget.js.
 */
import { ensureTables, getBankSnapshot, upsertBankData, setBankReview, setIgnoreRules, requireAuth } from "./budget.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function noDb() {
  return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
}

export async function onRequestGet(context) {
  if (!context.env.DB) return noDb();
  try {
    /* No allowSync: sync sessions are refused (403) by requireAuth —
       the automation writes the snapshot, it never reads it back. */
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    await ensureTables(context.env.DB);
    return json(await getBankSnapshot(context.env.DB));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) return noDb();
  try {
    /* allowSync lets the guard resolve a sync session; the kind check
       right after keeps the route sync-ONLY (same pattern as the
       device-only checks in /api/auth). */
    const auth = await requireAuth(context.env.DB, context.request, { allowSync: true });
    if (auth.response) return auth.response;
    if (!auth.session || auth.session.kind !== "sync") {
      return json({ error: "Only the paired sync automation can write bank data." }, 403);
    }
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return json({ error: "POST expects a JSON body: { accounts, transactions, syncedAt }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "POST expects { accounts, transactions, syncedAt }" }, 400);
    }
    const counts = await upsertBankData(context.env.DB, body);
    return json({ ok: true, accounts: counts.accounts, transactions: counts.transactions });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}

export async function onRequestPatch(context) {
  if (!context.env.DB) return noDb();
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    const body = await context.request.json();
    if (body && Array.isArray(body.ignoreRules)) return json(await setIgnoreRules(context.env.DB, body.ignoreRules));
    if (!body || typeof body.txId !== "string" || !body.txId) return json({ error: "PATCH expects { txId, kind }" }, 400);
    return json(await setBankReview(context.env.DB, body.txId, body.kind === undefined ? null : body.kind));
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
}
