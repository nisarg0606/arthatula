/* Calendar helpers: ISO dates, labels, month shifts and the month grid. */
import { isValidDateStrJs } from "./plan.js";

/* ---- Premium calendar date picker (ported from the carpool tracker) ----
 * Pure helpers: the pill button label ("Wed, Oct 21, 2026"), the month
 * grid math and month navigation. The DOM widget lives in initApp and
 * binds to a hidden input holding the same YYYY-MM-DD string the forms
 * have always used, so no save/load logic changes. */

export const CAL_WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const CAL_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const CAL_MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const CAL_DOW_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function calIso(y, m, d) {
  return y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

export function formatDateLabel(v, placeholder) {
  if (!v || !isValidDateStrJs(v)) return placeholder || "Select a date";
  var d = new Date(v + "T12:00:00");
  return CAL_WEEKDAYS_SHORT[d.getDay()] + ", " + CAL_MONTHS_SHORT[d.getMonth()] + " " +
    d.getDate() + ", " + d.getFullYear();
}

export function calMonthShift(year, month, delta) {
  var total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/* The 42 cells (6 rows x 7) of one calendar month view, carpool-style:
 * leading/trailing days from the neighbouring months are flagged dim. */

export function buildCalendarCells(year, month, selectedIso, todayIso) {
  var startDay = new Date(year, month, 1).getDay();
  var days = new Date(year, month + 1, 0).getDate();
  var prevDays = new Date(year, month, 0).getDate();
  var cells = [];
  for (var i = 0; i < 42; i++) {
    var dn = i - startDay + 1;
    var dt, dim = false;
    if (dn < 1) { dt = new Date(year, month - 1, prevDays + dn); dim = true; }
    else if (dn > days) { dt = new Date(year, month + 1, dn - days); dim = true; }
    else dt = new Date(year, month, dn);
    var iso = calIso(dt.getFullYear(), dt.getMonth(), dt.getDate());
    cells.push({ iso: iso, day: dt.getDate(), dim: dim,
      selected: !!selectedIso && iso === selectedIso,
      today: !!todayIso && iso === todayIso });
  }
  return cells;
}
