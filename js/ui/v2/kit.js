/* Shared kit for the new (v2) screens: API calls, a tiny DOM builder
   that only ever sets text (never HTML), money/date formatting, the
   category and account caches, and a reusable edit dialog. */
import { apiFetch } from "../storage.js";
import { amountsHidden, HIDDEN } from "../../core/format.js";

export const v2 = { categories: [], groups: [], accounts: [], loadedAt: 0 };

/* fetch a /api/v2 route; resolves the JSON body, rejects with the
   server's error message. */
export function api(method, path, body) {
  const opts = { method: method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  return apiFetch("/api/v2/" + path, opts).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
      return data;
    });
  });
}

/* h("div", { class: "x", text: "hi", on: { click: fn }, attrs: { "aria-label": "…" } }, child, …) */
export function h(tag, props) {
  const el = document.createElement(tag);
  const p = props || {};
  if (p.class) el.className = p.class;
  if (p.text !== undefined && p.text !== null) el.textContent = String(p.text);
  if (p.attrs) Object.keys(p.attrs).forEach(function (k) { if (p.attrs[k] !== null && p.attrs[k] !== undefined && p.attrs[k] !== false) el.setAttribute(k, p.attrs[k] === true ? "" : p.attrs[k]); });
  if (p.on) Object.keys(p.on).forEach(function (k) { el.addEventListener(k, p.on[k]); });
  if (p.value !== undefined) el.value = p.value;
  if (p.style) Object.keys(p.style).forEach(function (k) { el.style.setProperty(k, p.style[k]); });
  for (let i = 2; i < arguments.length; i++) {
    const c = arguments[i];
    if (c === null || c === undefined || c === false) continue;
    (Array.isArray(c) ? c : [c]).forEach(function (x) { if (x !== null && x !== undefined && x !== false) el.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
  }
  return el;
}
export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
/* cents -> "$1,234.56"; whole: no cents; signed: "+$5.00" for money in. */
export function money(cents, opts) {
  const o = opts || {};
  if (cents === null || cents === undefined) return "—";
  if (amountsHidden()) return HIDDEN;
  const s = (o.whole ? usd0 : usd).format(Math.abs(cents) / 100);
  if (cents < 0) return "-" + s;
  return (o.signed && cents > 0 ? "+" : "") + s;
}
/* "$12.34" or "12.34" -> 1234 cents, or null. */
export function parseMoney(text) {
  const n = parseFloat(String(text || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dayLabel(iso) { return iso ? MONTHS[Number(iso.slice(5, 7)) - 1] + " " + Number(iso.slice(8, 10)) + ", " + iso.slice(0, 4) : ""; }
export function shortDay(iso) { return iso ? MONTHS[Number(iso.slice(5, 7)) - 1] + " " + Number(iso.slice(8, 10)) : ""; }
export function monthLabel(key, long) { return (long ? MONTHS_LONG : MONTHS)[Number(key.slice(5, 7)) - 1] + " " + key.slice(0, 4); }
export function todayIso() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function thisMonth() { return todayIso().slice(0, 7); }

/* Categories + accounts used by every screen; refreshed at most every
   20 s unless forced. */
export function loadBasics(force) {
  if (!force && Date.now() - v2.loadedAt < 20000 && v2.categories.length) return Promise.resolve(v2);
  return Promise.all([api("GET", "categories"), api("GET", "accounts")]).then(function (r) {
    v2.groups = r[0].groups; v2.categories = r[0].categories; v2.accounts = r[1].accounts; v2.netWorth = r[1].netWorth;
    v2.loadedAt = Date.now();
    return v2;
  });
}
export function categoryById(id) { return v2.categories.find(function (c) { return c.id === id; }) || null; }
export function accountById(id) { return v2.accounts.find(function (a) { return a.id === id; }) || null; }
export function categoryName(id) { const c = categoryById(id); return c ? (c.icon ? c.icon + " " : "") + c.name : "Uncategorized"; }

/* <select> of categories grouped like the budget, current one picked. */
export function categorySelect(selected, opts) {
  const o = opts || {};
  const sel = h("select", { class: o.class || "", attrs: { "aria-label": o.label || "Category" } });
  if (o.allowNone) sel.appendChild(h("option", { value: "", text: o.noneLabel || "Uncategorized" }));
  v2.groups.forEach(function (g) {
    if (o.kinds && o.kinds.indexOf(g.kind) === -1) return;
    const og = h("optgroup", { attrs: { label: g.name } });
    v2.categories.filter(function (c) { return c.groupId === g.id && (!c.archived || c.id === selected); }).forEach(function (c) {
      const opt = h("option", { value: c.id, text: (c.icon ? c.icon + " " : "") + c.name });
      if (c.id === selected) opt.selected = true;
      og.appendChild(opt);
    });
    if (og.children.length) sel.appendChild(og);
  });
  if (!selected && o.allowNone) sel.value = "";
  return sel;
}
export function accountSelect(selected, opts) {
  const o = opts || {};
  const sel = h("select", { attrs: { "aria-label": o.label || "Account" } });
  sel.appendChild(h("option", { value: "", text: o.noneLabel || "No account" }));
  v2.accounts.filter(function (a) { return !a.hidden || a.id === selected; }).forEach(function (a) {
    const opt = h("option", { value: a.id, text: a.name + (a.mask ? " ··" + a.mask : "") });
    if (a.id === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

/* A labelled field: field("Amount", input). */
export function field(label, control, hint) {
  const id = control.id || ("f" + Math.random().toString(36).slice(2, 9));
  control.id = id;
  return h("div", { class: "field" }, h("label", { text: label, attrs: { for: id } }), control, hint ? h("p", { class: "hint v2-field-hint", text: hint }) : null);
}

/* One dialog for every edit form. open(title, bodyEl, actions) where
   actions = [{ label, primary?, danger?, onClick(close) }]. */
let dialogEl = null;
export function openDialog(title, body, actions) {
  if (!dialogEl) {
    dialogEl = h("dialog", { class: "tx-dialog v2-dialog", attrs: { "aria-labelledby": "v2DialogTitle" } });
    document.body.appendChild(dialogEl);
    dialogEl.addEventListener("click", function (ev) { if (ev.target === dialogEl) dialogEl.close(); });
  }
  clear(dialogEl);
  const status = h("p", { class: "v2-dialog-status", attrs: { role: "status", "aria-live": "polite" } });
  const close = function () { dialogEl.close(); };
  const fail = function (e) { status.textContent = (e && e.message) || String(e); status.classList.add("err"); };
  dialogEl.appendChild(h("div", { class: "txd-head" },
    h("h3", { text: title, attrs: { id: "v2DialogTitle" } }),
    h("button", { class: "txd-close", text: "×", attrs: { type: "button", "aria-label": "Close" }, on: { click: close } })));
  dialogEl.appendChild(h("div", { class: "v2-dialog-body" }, body, status));
  dialogEl.appendChild(h("div", { class: "actions v2-dialog-actions" }, (actions || []).map(function (a) {
    return h("button", {
      class: a.primary ? "btn-primary" : (a.danger ? "danger" : ""), text: a.label, attrs: { type: "button" },
      on: { click: function () {
        status.textContent = ""; status.classList.remove("err");
        try {
          const r = a.onClick(close, fail);
          if (r && r.then) r.then(function () {}, fail);
        } catch (e) { fail(e); }
      } }
    });
  })));
  if (typeof dialogEl.showModal === "function") dialogEl.showModal(); else dialogEl.setAttribute("open", "");
  const first = dialogEl.querySelector("input,select,textarea");
  /* Don't steal focus from a field the person (or a test) already moved to. */
  if (first) setTimeout(function () {
    const at = document.activeElement;
    if (at && at !== first && dialogEl.contains(at) && /^(INPUT|SELECT|TEXTAREA)$/.test(at.tagName)) return;
    try { first.focus({ preventScroll: true }); } catch (e) { /* noop */ }
  }, 30);
  return { close: close, fail: fail, el: dialogEl };
}

/* A card section with a title row and optional action buttons. */
export function section(title, actions, body, cls) {
  return h("section", { class: "card v2-card " + (cls || "") },
    h("div", { class: "v2-card-head" }, h("h2", { class: "card-title", text: title }),
      actions && actions.length ? h("div", { class: "actions" }, actions) : null),
    body);
}
export function button(label, onClick, cls, attrs) {
  return h("button", { class: cls || "", text: label, attrs: Object.assign({ type: "button" }, attrs || {}), on: { click: onClick } });
}
export function emptyState(text) { return h("p", { class: "hint v2-empty", text: text }); }
export function errorState(el, e) { clear(el).appendChild(h("p", { class: "auth-error", text: "Couldn't load: " + ((e && e.message) || e) })); }
export function loading(el) { clear(el).appendChild(h("p", { class: "hint v2-loading", text: "Loading…" })); }

/* Chart.js colors that follow the theme. */
export function isDark() { return document.documentElement.classList.contains("dark"); }
export function chartColors() {
  return { text: isDark() ? "#a1a1aa" : "#52525b", grid: isDark() ? "rgba(255,255,255,.06)" : "rgba(10,10,10,.06)",
    accent: "#14b8a6", income: "#10b981", spend: "#f43f5e", plan: "#8b5cf6" };
}
const charts = {};
/* Eye button on: the value axes and tooltips show no amounts (the shape stays). */
function maskChart(config) {
  const o = config.options = config.options || {};
  Object.keys(o.scales || {}).forEach(function (k) {
    if (k !== "x") o.scales[k].ticks = Object.assign({}, o.scales[k].ticks, { callback: function () { return HIDDEN; } });
  });
  o.plugins = Object.assign({}, o.plugins);
  o.plugins.tooltip = Object.assign({}, o.plugins.tooltip, { callbacks: { label: function (c) { return (c.dataset.label ? c.dataset.label + ": " : "") + HIDDEN; } } });
}
/* (Re)draw a Chart.js chart into a <canvas>; falls back to text. */
export function drawChart(key, canvas, config, fallbackText) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
  if (!window.Chart || !canvas) {
    if (canvas && canvas.parentNode) canvas.parentNode.replaceChild(h("p", { class: "chart-fallback", text: fallbackText || "" }), canvas);
    return null;
  }
  if (amountsHidden()) maskChart(config);
  charts[key] = new window.Chart(canvas, config);
  return charts[key];
}
