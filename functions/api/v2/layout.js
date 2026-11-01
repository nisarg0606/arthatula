/*
 * Dashboard layout (serves /api/v2/layout): which Dashboard cards show
 * and in what order, kept per owner so it follows you across devices.
 *   GET -> { order: [key…], hidden: [key…] }  (the default when unset)
 *   PUT { order, hidden } -> the saved layout. Keys must be from
 *        SECTIONS; ones missing from order are appended in default order.
 */
import { handleV2, bodyOf, HttpError } from "../_v2http.js";

export const SECTIONS = ["overview", "market", "month", "ask", "trends"];
const KEY = "dashboard_layout";

function keys(v, name) {
  if (!Array.isArray(v)) throw new HttpError(400, name + " must be a list.");
  v.forEach(function (k) { if (SECTIONS.indexOf(k) === -1) throw new HttpError(400, "Unknown section: " + String(k).slice(0, 40) + "."); });
  return v.filter(function (k, i) { return v.indexOf(k) === i; });
}

export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const order = keys(r.order || [], "order");
  return { order: order.concat(SECTIONS.filter(function (k) { return order.indexOf(k) === -1; })), hidden: keys(r.hidden || [], "hidden") };
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => {
  const raw = await s.getSetting(KEY);
  /* A stored key a later version dropped is skipped, not an error. */
  const saved = raw ? JSON.parse(raw) : {};
  const known = function (l) { return (Array.isArray(l) ? l : []).filter(function (k) { return SECTIONS.indexOf(k) !== -1; }); };
  return normalize({ order: known(saved.order), hidden: known(saved.hidden) });
}, { skipMirror: true });

export const onRequestPut = (context) => handleV2(context, async ({ s, request }) => {
  const layout = normalize(await bodyOf(request));
  await s.setSetting(KEY, JSON.stringify(layout));
  return layout;
}, { skipMirror: true });
