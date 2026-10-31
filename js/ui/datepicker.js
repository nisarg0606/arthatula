/* The calendar date pickers. */
import { CAL_DOW_SHORT, CAL_MONTHS_FULL, buildCalendarCells, calMonthShift, formatDateLabel } from "../core/dates.js";
import { isValidDateStrJs } from "../core/plan.js";
import { app, els } from "./context.js";
import { todayLocal } from "./daily.js";

export function closeDatePickers(except) {
  app.datePickers.forEach(function (p) { if (p !== except) p.close(); });
}

export function refreshDatePickers() {
  app.datePickers.forEach(function (p) { p.refresh(); });
}

export function makeDatePicker(cfg) {
  /* cfg: {btn, display, pop, input, placeholder?, optional?, row?, onChange?} */
  var view = null;
  var picker = { isRow: !!cfg.row };
  function refresh() {
    cfg.display.textContent = formatDateLabel(cfg.input.value || "", cfg.placeholder);
  }
  function close() {
    cfg.pop.classList.add("hidden");
    cfg.btn.setAttribute("aria-expanded", "false");
  }
  function setValue(v) {
    cfg.input.value = v || "";
    refresh();
    var ev;
    try { ev = new Event("change", { bubbles: true }); }
    catch (e) { ev = document.createEvent("Event"); ev.initEvent("change", true, false); }
    cfg.input.dispatchEvent(ev);
    if (cfg.onChange) cfg.onChange(cfg.input.value);
  }
  function renderCal() {
    var v = cfg.input.value || "";
    var base = new Date((isValidDateStrJs(v) ? v : todayLocal()) + "T12:00:00");
    if (!view) view = { year: base.getFullYear(), month: base.getMonth() };
    var cells = buildCalendarCells(view.year, view.month, v, todayLocal());
    var html = "<div class=\"cal-head\"><button type=\"button\" class=\"cal-nav\" data-nav=\"-1\" aria-label=\"Previous month\">&#8249;</button><span class=\"cal-title\">" +
      CAL_MONTHS_FULL[view.month] + " " + view.year +
      "</span><button type=\"button\" class=\"cal-nav\" data-nav=\"1\" aria-label=\"Next month\">&#8250;</button></div><div class=\"cal-grid\">";
    CAL_DOW_SHORT.forEach(function (x) { html += "<span class=\"cal-dow\">" + x + "</span>"; });
    cells.forEach(function (c) {
      var cls = "cal-day" + (c.dim ? " dim" : "") + (c.selected ? " sel" : "") + (c.today ? " today" : "");
      html += "<button type=\"button\" class=\"" + cls + "\" data-iso=\"" + c.iso + "\">" + c.day + "</button>";
    });
    html += "</div><div class=\"cal-foot\"><button type=\"button\" data-today=\"1\">Today</button>" +
      (cfg.optional ? "<button type=\"button\" data-clear=\"1\">Clear</button>" : "") +
      "<button type=\"button\" data-close=\"1\">Close</button></div>";
    cfg.pop.innerHTML = html;
    cfg.pop.querySelectorAll("[data-nav]").forEach(function (b) {
      b.addEventListener("click", function () {
        view = calMonthShift(view.year, view.month, Number(b.getAttribute("data-nav")));
        renderCal();
      });
    });
    cfg.pop.querySelectorAll("[data-iso]").forEach(function (b) {
      b.addEventListener("click", function () {
        var picked = b.getAttribute("data-iso");
        view = null; close(); setValue(picked);
      });
    });
    var todayBtn = cfg.pop.querySelector("[data-today]");
    if (todayBtn) todayBtn.addEventListener("click", function () { view = null; close(); setValue(todayLocal()); });
    var clearBtn = cfg.pop.querySelector("[data-clear]");
    if (clearBtn) clearBtn.addEventListener("click", function () { view = null; close(); setValue(""); });
    var closeBtn = cfg.pop.querySelector("[data-close]");
    if (closeBtn) closeBtn.addEventListener("click", close);
  }
  function open() {
    closeDatePickers(picker);
    view = null;
    renderCal();
    cfg.pop.classList.remove("hidden");
    cfg.btn.setAttribute("aria-expanded", "true");
    if (window.innerWidth > 560) {
      /* Flip to right-aligned when the popover would spill off-screen. */
      cfg.pop.classList.remove("cal-flip");
      var r = cfg.pop.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) cfg.pop.classList.add("cal-flip");
    }
  }
  picker.close = close;
  picker.refresh = refresh;
  cfg.btn.addEventListener("click", function () {
    if (cfg.pop.classList.contains("hidden")) open(); else close();
  });
  refresh();
  app.datePickers.push(picker);
  return picker;
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  /* ============ Premium calendar date pickers ============
   * Ported from the carpool tracker: compact pill button + calendar
   * popover, bound to a hidden input that keeps holding the exact
   * YYYY-MM-DD string each form already reads/writes, so all submit and
   * save logic is unchanged. Picking a day dispatches a real "change"
   * event on the hidden input (the baseline-date listener relies on it)
   * and then calls the picker's onChange, if any. */

  app.datePickers = [];
  /* Close on clicks outside any picker. Uses the event path, not
     target.closest(): the ‹ › buttons re-render the popover, so by the
     time this runs the clicked button is detached and closest() finds no
     .datepicker — which used to close the calendar on every month change. */

  document.addEventListener("click", function (e) {
    var path = e.composedPath ? e.composedPath() : [];
    var inside = path.some(function (n) { return n.classList && n.classList.contains("datepicker"); });
    if (!inside) closeDatePickers(null);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDatePickers(null);
  });
  if (els.expDateBtn) makeDatePicker({ btn: els.expDateBtn, display: els.expDateDisplay, pop: els.expDateCal, input: els.expDate });
  if (els.cardStartBtn) makeDatePicker({ btn: els.cardStartBtn, display: els.cardStartDisplay, pop: els.cardStartCal, input: els.cardStart });
  if (els.cardEndBtn) makeDatePicker({ btn: els.cardEndBtn, display: els.cardEndDisplay, pop: els.cardEndCal, input: els.cardEnd });
  if (els.cardDueBtn) makeDatePicker({ btn: els.cardDueBtn, display: els.cardDueDisplay, pop: els.cardDueCal, input: els.cardDue, placeholder: "No due date", optional: true });
}
