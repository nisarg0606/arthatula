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
  if (name === "dashboard") renderSummary(); /* charts need a visible canvas */
  if (name === "cards") renderCards();
  if (name === "bank") { renderBank(); loadBank(); } /* fresh snapshot on every visit */
  if (name === "daily") { renderPending(); loadPending(); } /* fresh snapshot on every visit */
  if (name === "settings") renderSecurity(true);
  onShowV2(name); /* the new screens render on every visit */
}

/* Depth effects. Stat tiles tilt toward the pointer (up to 8°) with a
   glare that follows it; chart panels rise into view once. Both are
   skipped under prefers-reduced-motion (the CSS also neutralises them). */

export const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const summaryGridEl = document.getElementById("summaryGrid");

export const revealEls = document.querySelectorAll(".reveal");

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  document.querySelectorAll(".tab-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      showTab(b.getAttribute("data-tab"));
      window.scrollTo(0, 0); /* a new tab starts at its top, like an app */
    });
  });
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
  if (els.addExpenseTopBtn) {
    els.addExpenseTopBtn.addEventListener("click", function () {
      showTab("daily");
      if (els.expDescription) els.expDescription.focus();
    });
  }
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
