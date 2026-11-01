/* Tabs, theme, tilt and reveal effects. */
import { renderSecurity } from "./auth.js";
import { loadBank, renderBank } from "./bank.js";
import { renderCards } from "./cards.js";
import { els } from "./context.js";
import { renderSummary } from "./dashboard.js";
import { loadPending, renderPending } from "./pending.js";
import { onShow as onShowV2 } from "./v2/index.js";

/* ================= Tabs + theme ================= */

export function showTab(name) {
  document.querySelectorAll("[data-section]").forEach(function (sec) {
    sec.hidden = sec.getAttribute("data-section") !== name;
  });
  document.querySelectorAll(".tab-btn").forEach(function (b) {
    var on = b.getAttribute("data-tab") === name;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  document.body.setAttribute("data-tab", name); /* CSS hides the + button on Daily */
  document.querySelectorAll(".more-tile").forEach(function (t) {
    var on = t.getAttribute("data-go") === name;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  var more = document.getElementById("moreTab"), add = document.getElementById("addTab");
  var btn = document.querySelector('.nav-float .tab-btn[data-tab="' + name + '"]');
  /* More lights up when the open screen has nothing of its own in the bar (phones show Daily as the center Add button). */
  var inBar = (btn && btn.offsetParent) || (name === "daily" && add && add.offsetParent);
  if (more) more.classList.toggle("active", !inBar);
  if (add) add.classList.toggle("active", name === "daily");
  if (name === "dashboard") renderSummary(); /* charts need a visible canvas */
  if (name === "cards") renderCards();
  if (name === "bank") { renderBank(); loadBank(); } /* fresh snapshot on every visit */
  if (name === "daily") { renderPending(); loadPending(); } /* fresh snapshot on every visit */
  if (name === "settings") renderSecurity(true);
  onShowV2(name); /* the new screens render on every visit */
}

/* ================= Tab bar + More =================
   Phones show Home, Activity, the center Add button and Budget; wide
   screens the Money tabs. More opens a sheet with the rest, built from
   the nav's own buttons so the two never drift apart. The sheet follows
   the finger when dragged down and closes on a long enough drag or a
   quick flick. */

function buildMoreSheet(sheet, body) {
  var groups = [["Money", ".nav-float .tab-btn:not(.classic)"], ["Classic", ".nav-float .tab-btn.classic"]];
  groups.forEach(function (g) {
    var head = document.createElement("h3");
    head.className = "sheet-group"; head.textContent = g[0];
    var grid = document.createElement("div");
    grid.className = "more-grid";
    if (g[0] === "Money") { head.classList.add("sheet-money"); grid.classList.add("sheet-money"); }
    document.querySelectorAll(g[1]).forEach(function (b) {
      var name = b.getAttribute("data-tab");
      var tile = document.createElement("button");
      tile.type = "button"; tile.className = "more-tile"; tile.setAttribute("data-go", name);
      var ico = document.createElement("span");
      ico.className = "more-ico";
      ico.appendChild(b.querySelector("svg").cloneNode(true));
      var label = document.createElement("span");
      label.textContent = b.querySelector(".lbl-long").textContent;
      tile.appendChild(ico); tile.appendChild(label);
      tile.addEventListener("click", function () {
        closeSheet(sheet);
        goTab(name);
      });
      grid.appendChild(tile);
    });
    body.appendChild(head); body.appendChild(grid);
  });
}

function closeSheet(sheet) {
  if (!sheet.open || sheet.classList.contains("closing")) return;
  if (reduceMotion) { sheet.close(); return; }
  sheet.classList.add("closing");
  sheet.style.transform = "";
  setTimeout(function () { sheet.classList.remove("closing"); sheet.close(); }, 280);
}

/* Drag down to dismiss: 1:1 while dragging (resisting upward pulls),
   then close past a third of the sheet or on a downward flick; else
   settle back from where it was let go. */
function dragToDismiss(sheet, handle) {
  var startY = 0, dy = 0, lastY = 0, lastT = 0, v = 0, dragging = false;
  handle.addEventListener("pointerdown", function (e) {
    if (e.target.closest("button")) return;
    dragging = true; startY = lastY = e.clientY; lastT = e.timeStamp; dy = 0; v = 0;
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add("dragging");
  });
  handle.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var raw = e.clientY - startY;
    dy = raw >= 0 ? raw : -Math.sqrt(-raw) * 2; /* rubber-band upward */
    var dt = e.timeStamp - lastT;
    if (dt > 0) v = (e.clientY - lastY) / dt * 1000; /* px/s */
    lastY = e.clientY; lastT = e.timeStamp;
    sheet.style.transform = "translateY(" + dy + "px)";
  });
  function end(e) {
    if (!dragging) return;
    dragging = false;
    if (e.timeStamp - lastT > 100) v = 0; /* held still before letting go: no flick */
    sheet.classList.remove("dragging");
    if (dy > sheet.offsetHeight / 3 || v > 600) closeSheet(sheet);
    else sheet.style.transform = "";
  }
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/* Open a tab from the bar or the More sheet: it starts at its top, like
   an app, and rises in (CSS: [data-section].entering). A plain animation
   on the new screen, not View Transitions: WebKit's snapshots of the old
   page disturbed the scroll position afterwards. */
export function goTab(name) {
  showTab(name);
  window.scrollTo(0, 0);
  var sec = document.querySelector('[data-section="' + name + '"]');
  if (!sec || reduceMotion) return;
  sec.classList.remove("entering");
  void sec.offsetWidth; /* restart the animation on a repeat visit */
  sec.classList.add("entering");
}

/* Depth effects. Stat tiles tilt toward the pointer (up to 8°) with a
   glare that follows it; chart panels rise into view once. Both are
   skipped under prefers-reduced-motion (the CSS also neutralises them). */

export const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const summaryGridEl = document.getElementById("summaryGrid");

export const revealEls = document.querySelectorAll(".reveal");

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  /* iOS Safari shows :active press states only once the page listens
     for touches. */
  document.addEventListener("touchstart", function () {}, { passive: true });
  document.querySelectorAll(".tab-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      goTab(b.getAttribute("data-tab"));
    });
  });
  var sheet = document.getElementById("moreSheet"), moreTab = document.getElementById("moreTab");
  if (sheet && moreTab && sheet.showModal) {
    buildMoreSheet(sheet, document.getElementById("moreBody"));
    moreTab.addEventListener("click", function () { sheet.showModal(); });
    document.getElementById("moreDone").addEventListener("click", function () { closeSheet(sheet); });
    /* A tap on the dimmed backdrop lands on the dialog itself. */
    sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSheet(sheet); });
    sheet.addEventListener("cancel", function (e) { e.preventDefault(); closeSheet(sheet); });
    dragToDismiss(sheet, sheet.querySelector(".sheet-head"));
  }
  if (summaryGridEl && !reduceMotion) {
    summaryGridEl.addEventListener("pointermove", function (ev) {
      var tile = ev.target.closest && ev.target.closest(".stat");
      if (!tile || ev.pointerType === "touch") return;
      var r = tile.getBoundingClientRect();
      var px = (ev.clientX - r.left) / r.width, py = (ev.clientY - r.top) / r.height;
      tile.classList.add("tilting");
      tile.style.setProperty("--ry", ((px - 0.5) * 16).toFixed(2) + "deg");
      tile.style.setProperty("--rx", ((0.5 - py) * 16).toFixed(2) + "deg");
      tile.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
      tile.style.setProperty("--my", (py * 100).toFixed(1) + "%");
    });
    summaryGridEl.addEventListener("pointerout", function (ev) {
      var tile = ev.target.closest && ev.target.closest(".stat");
      if (!tile || tile.contains(ev.relatedTarget)) return;
      tile.classList.remove("tilting");
      tile.style.setProperty("--rx", "0deg");
      tile.style.setProperty("--ry", "0deg");
    });
  }
  if (reduceMotion || typeof IntersectionObserver === "undefined") {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  } else {
    var revealer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); revealer.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { revealer.observe(el); });
  }
  /* Add expense: the header button (desktop) and the center tab (phones).
     Focus inside the tap so iOS opens the keyboard. */
  [els.addExpenseTopBtn, document.getElementById("addTab")].forEach(function (b) {
    if (!b) return;
    b.addEventListener("click", function () {
      goTab("daily");
      if (els.expDescription) els.expDescription.focus();
    });
  });
  if (els.themeToggle) {
    els.themeToggle.addEventListener("click", function () {
      var dark = document.documentElement.classList.toggle("dark");
      try { localStorage.setItem("arthatula-theme", dark ? "dark" : "light"); } catch (e) {}
      renderSummary();
    });
  }
  if (els.doughnutMode) {
    els.doughnutMode.addEventListener("change", function () { renderSummary(); });
  }
}
