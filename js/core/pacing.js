/* Category pacing for one month: how much of each day-to-day budget is
   spent compared with how far through the month we are. Bills (rent,
   utilities, loans, ...) are left out: they land on one day, so they
   would always look "ahead of pace". */
import { CATEGORY_TO_FIELD } from "./categories.js";
import { NUMBER_FIELDS } from "./plan.js";
import { expenseShare, isSpending } from "./spending.js";

export var PACE_FIELDS = ["groceries", "eatingOut", "gasTransport", "shopping", "otherExpenses"];

/* Spending counts as ahead of pace once it is this much over where an
   even pace would put it, so a single grocery run on day 2 isn't flagged. */
var PACE_SLACK = 1.1;

/* -> null for a month that hasn't started, otherwise
   { daysLeft, rows: [{ key, label, planned, spent, left, perDay, usedPct, timePct, status, items }] }
   items are the expenses counted in spent.
   status: "over" (past the plan), "ahead" (spending faster than the
   month is passing), "ok". */
export function categoryPacing(state, monthKey, todayIso) {
  var today = String(todayIso || "").slice(0, 10);
  if (!monthKey || monthKey > today.slice(0, 7)) return null;
  var y = parseInt(monthKey.slice(0, 4), 10), m = parseInt(monthKey.slice(5, 7), 10);
  var days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  var day = monthKey === today.slice(0, 7) ? parseInt(today.slice(8, 10), 10) : days;
  var timeFrac = day / days;
  var month = ((state && state.months) || []).filter(function (x) { return x.monthKey === monthKey; })[0] || {};
  var spent = {}, items = {};
  ((state && state.dailyExpenses) || []).forEach(function (e) {
    if (!isSpending(e) || e.date.slice(0, 7) !== monthKey) return;
    var f = CATEGORY_TO_FIELD[e.category] || "otherExpenses";
    spent[f] = (spent[f] || 0) + expenseShare(e);
    (items[f] = items[f] || []).push(e);
  });
  var daysLeft = days - day + 1; /* today still counts */
  var rows = PACE_FIELDS.map(function (key) {
    var planned = month[key] || 0, s = Math.round((spent[key] || 0) * 100) / 100;
    var left = Math.round((planned - s) * 100) / 100;
    var label = NUMBER_FIELDS.filter(function (f) { return f.key === key; })[0].label.replace(/ \(\$\)$/, "");
    return {
      key: key, label: label, planned: planned, spent: s, left: left,
      perDay: left > 0 ? Math.floor(left / daysLeft * 100) / 100 : 0,
      usedPct: planned > 0 ? Math.round(s / planned * 100) : null,
      timePct: Math.round(timeFrac * 100),
      status: s > planned ? "over" : s > planned * timeFrac * PACE_SLACK ? "ahead" : "ok",
      items: items[key] || []
    };
  }).filter(function (r) { return r.planned > 0 || r.spent > 0; });
  return { daysLeft: daysLeft, rows: rows };
}
