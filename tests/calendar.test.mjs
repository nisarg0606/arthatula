/*
 * Premium calendar picker tests: pill-button label formatting, month
 * grid math, month navigation, get/set round-trip through the pure
 * helpers (the DOM widget writes the picked cell's iso into the hidden
 * input and renders formatDateLabel as the button text), plus the
 * standing cross-check that every element id the app looks up exists in
 * index.html. Run: node tests/calendar.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as app from "../js/core/index.js";

/* ---- formatDateLabel: carpool pill format "Wed, Oct 21, 2026" ---- */
assert.equal(app.formatDateLabel("2026-10-21"), "Wed, Oct 21, 2026");
assert.equal(app.formatDateLabel("2026-11-05"), "Thu, Nov 5, 2026");
assert.equal(app.formatDateLabel("2027-01-28"), "Thu, Jan 28, 2027");
assert.equal(app.formatDateLabel("2026-10-26"), "Mon, Oct 26, 2026");
/* Empty / invalid values fall back to the placeholder (the optional
 * card due date uses "No due date"). */
assert.equal(app.formatDateLabel(""), "Select a date");
assert.equal(app.formatDateLabel(null), "Select a date");
assert.equal(app.formatDateLabel(undefined), "Select a date");
assert.equal(app.formatDateLabel("", "No due date"), "No due date");
assert.equal(app.formatDateLabel(null, "No due date"), "No due date");
assert.equal(app.formatDateLabel("2026-13-40", "No due date"), "No due date");
assert.equal(app.formatDateLabel("not-a-date"), "Select a date");

/* ---- buildCalendarCells: October 2026 (starts on a Thursday) ---- */
const cells = app.buildCalendarCells(2026, 9, "2026-10-21", "2026-10-26");
assert.equal(cells.length, 42, "always 6 rows x 7 days");
assert.deepEqual(cells[0], { iso: "2026-09-27", day: 27, dim: true, selected: false, today: false },
  "leading cell is the Sunday of the first week, from September, dimmed");
assert.deepEqual(cells[4], { iso: "2026-10-01", day: 1, dim: false, selected: false, today: false });
assert.deepEqual(cells[24], { iso: "2026-10-21", day: 21, dim: false, selected: true, today: false },
  "the selected day is flagged");
assert.deepEqual(cells[29], { iso: "2026-10-26", day: 26, dim: false, selected: false, today: true },
  "today is flagged (outlined in the UI)");
assert.deepEqual(cells[41], { iso: "2026-11-07", day: 7, dim: true, selected: false, today: false },
  "trailing cells spill into November, dimmed");
assert.equal(cells.filter((c) => !c.dim).length, 31, "October has 31 in-month days");
assert.equal(cells.filter((c) => c.selected).length, 1);
assert.equal(cells.filter((c) => c.today).length, 1);
/* No selection / no today -> nothing flagged. */
const bare = app.buildCalendarCells(2027, 1, "", "");
assert.equal(bare.some((c) => c.selected || c.today), false);
assert.equal(bare.filter((c) => !c.dim).length, 28, "February 2027 has 28 days");

/* ---- calMonthShift: navigation across year boundaries ---- */
assert.deepEqual(app.calMonthShift(2026, 11, 1), { year: 2027, month: 0 });
assert.deepEqual(app.calMonthShift(2026, 0, -1), { year: 2025, month: 11 });
assert.deepEqual(app.calMonthShift(2026, 5, -7), { year: 2025, month: 10 });
assert.deepEqual(app.calMonthShift(2026, 9, 0), { year: 2026, month: 9 });

/* ---- get/set round-trip: iso -> label -> the same cell in its month
 * grid carries that iso again (what the widget stores on a click). ---- */
for (const iso of ["2026-10-21", "2026-11-05", "2027-02-28", "2026-12-31", "2027-01-01"]) {
  const [y, m, d] = iso.split("-").map(Number);
  const label = app.formatDateLabel(iso);
  assert.ok(label.includes(String(d)) && label.includes(String(y)), "label carries day + year: " + label);
  const grid = app.buildCalendarCells(y, m - 1, iso, "");
  const hit = grid.find((c) => !c.dim && c.day === d);
  assert.equal(hit.iso, iso, "cell round-trips to the same iso");
  assert.equal(hit.selected, true);
}

/* ---- id cross-check: every id in the els registry (js/ui/context.js) exists in
 * index.html, the new date-picker ids included, and no native
 * type="date" input survives anywhere in the page. ---- */
const appSrc = readFileSync(new URL("../js/ui/context.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const block = appSrc.match(/\["startingBalance"[\s\S]*?\]\s*\.forEach\(function \(id\)/);
assert.ok(block, "els registry block found in js/ui/context.js");
const ids = [...block[0].matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]).filter((s) => s !== "startingBalance" || true);
assert.ok(ids.length > 40, "registry parsed, got " + ids.length);
for (const id of ids) {
  assert.ok(html.includes('id="' + id + '"'), "index.html is missing id: " + id);
}
for (const id of ["expDate", "expDateBtn", "expDateDisplay", "expDateCal",
  "cardStart", "cardStartBtn", "cardStartDisplay", "cardStartCal",
  "cardEnd", "cardEndBtn", "cardEndDisplay", "cardEndCal",
  "cardDue", "cardDueBtn", "cardDueDisplay", "cardDueCal",
  "baselineDate", "baselineDateDisplay"]) {
  assert.ok(html.includes('id="' + id + '"'), "missing date-picker id: " + id);
}
assert.ok(!html.includes('type="date"'), "no native date inputs remain");

/* ---- Regression guard: the outside-click closer must use the event
 * path (composedPath), not target.closest(). The month nav buttons
 * re-render the popover from their own click handler, detaching the
 * clicked button before the document handler runs; closest() on the
 * detached button finds no .datepicker and instantly re-closes the
 * calendar, which made month navigation impossible. ---- */
const pickerSrc = readFileSync(new URL("../js/ui/datepicker.js", import.meta.url), "utf8");
assert.ok(pickerSrc.includes("composedPath"), "outside-click closer uses composedPath");
assert.ok(!pickerSrc.includes('closest(".datepicker")'), "outside-click closer must not use closest on the possibly-detached target");

console.log("calendar.test.mjs: all assertions passed");
