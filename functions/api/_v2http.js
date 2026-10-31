/*
 * Request plumbing shared by every /api/v2/* route: database check,
 * sign-in (requireAuth), v2 tables, the v1 mirror, and the owner
 * scope. Handlers receive { db, s, session, request, url, env } and
 * return a plain object (sent as JSON) or a Response.
 */
import { requireAuth } from "./budget.js";
import { ensureV2, scope, ownerFor, json, errorResponse, HttpError, OWNER_ID } from "./_v2db.js";
import { mirrorV1 } from "./_v2mirror.js";

export { json, HttpError };

export async function handleV2(context, handler, opts) {
  const o = opts || {};
  if (!context.env.DB) return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
  try {
    const db = context.env.DB;
    const auth = await requireAuth(db, context.request, { allowSync: !!o.allowSync });
    if (auth.response) return auth.response;
    if (o.syncOnly && auth.session.kind !== "sync") return json({ error: "Only the paired sync automation can call this." }, 403);
    await ensureV2(db);
    const ownerId = ownerFor(auth.session);
    /* The classic app still writes the owner's expenses, bank rows and
       plan: bring v2 up to date first (a no-op when nothing changed). */
    if (ownerId === OWNER_ID && !o.skipMirror) await mirrorV1(db);
    const out = await handler({
      db, s: scope(db, ownerId), session: auth.session, request: context.request,
      url: new URL(context.request.url), env: context.env, context
    });
    return out instanceof Response ? out : json(out);
  } catch (err) {
    return errorResponse(err);
  }
}

/* Field validators shared by the routes. */
export function cleanStr(v, max) { return typeof v === "string" ? v.trim().slice(0, max || 200) : ""; }
export function cleanCents(v, name, opts) {
  const o = opts || {};
  if ((v === null || v === undefined || v === "") && o.nullable) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 1e12) throw new HttpError(400, (name || "amount") + " must be a whole number of cents.");
  if (o.min !== undefined && v < o.min) throw new HttpError(400, (name || "amount") + " must be at least " + o.min + ".");
  return v;
}
export function cleanDate(v, name, nullable) {
  if ((v === null || v === undefined || v === "") && nullable) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) ||
      new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, (name || "date") + " must be a valid YYYY-MM-DD date.");
  }
  return v;
}
export function cleanMonth(v, name) {
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw new HttpError(400, (name || "month") + " must be YYYY-MM.");
  return v;
}
export function oneOf(v, list, name) {
  if (list.indexOf(v) === -1) throw new HttpError(400, (name || "value") + " must be one of " + list.join(", ") + ".");
  return v;
}
export async function bodyOf(request) {
  const text = await request.text();
  if (text.length > 512 * 1024) throw new HttpError(413, "Request too large.");
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw new HttpError(400, "Body must be JSON."); }
}
export function todayIso() { return new Date().toISOString().slice(0, 10); }
