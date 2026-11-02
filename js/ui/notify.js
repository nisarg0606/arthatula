/* The bell: notifications the server writes (sync imports, pending
   charges, pairing requests, failed syncs), and the Telegram connection
   in Settings → Advanced.
   Polls /api/notifications every 30 seconds while the tab is visible,
   and right away when you come back to it. A new row also refreshes
   what it's about, so new transactions and pairing requests appear
   without a reload. */
import { app } from "./context.js";
import { apiFetch, load } from "./storage.js";
import { loadPending } from "./pending.js";
import { loadPairing, fmtSessionTime } from "./auth.js";
import { showTab } from "./shell.js";
import { onShow as onShowV2 } from "./v2/index.js";

var POLL_MS = 30000;
var items = [], lastId = 0, polled = false, inFlight = false;

function $(id) { return document.getElementById(id); }

function poll() {
  if (app.mode !== "database" || document.hidden || inFlight) return;
  inFlight = true;
  apiFetch("/api/notifications" + (lastId ? "?after=" + lastId : "")).then(function (res) {
    if (!res.ok) throw new Error("notifications " + res.status);
    return res.json();
  }).then(function (data) {
    var fresh = data.notifications || [];
    if (polled) react(fresh);
    polled = true;
    if (fresh.length) {
      lastId = fresh[0].id;
      items = fresh.concat(items).slice(0, 50);
    }
    renderBadge(data.unread);
    renderTelegram(data.telegram || {});
    if (!$("notifPanel").hidden) renderList();
  }).catch(function () { /* the next tick retries */ })
    .then(function () { inFlight = false; });
}

/* Refresh whatever the new rows are about. */
function react(fresh) {
  var kinds = {};
  fresh.forEach(function (n) { kinds[n.kind] = true; });
  if (kinds.transaction) {
    load();
    var tab = document.body.getAttribute("data-tab");
    if (tab && tab !== "settings") onShowV2(tab);
  } else if (kinds.pending) loadPending();
  if (kinds.pairing) loadPairing();
}

function renderBadge(unread) {
  var badge = $("notifBadge");
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? "99+" : String(unread || "");
  $("notifBtn").setAttribute("aria-label", unread ? "Notifications, " + unread + " unread" : "Notifications");
}

function goTo(kind) {
  if (kind === "pairing") {
    showTab("settings");
    var adv = $("settingsAdvanced");
    if (adv) adv.open = true;
    loadPairing();
    var card = $("pairOpenBtn");
    if (card) card.scrollIntoView({ block: "center" });
  } else showTab("transactions");
}

function renderList() {
  var list = $("notifList");
  list.innerHTML = "";
  if (!items.length) {
    var empty = document.createElement("li");
    empty.className = "notif-empty";
    empty.textContent = "Nothing yet. New charges and sync news show up here.";
    list.appendChild(empty);
    return;
  }
  items.forEach(function (n) {
    var li = document.createElement("li");
    if (!n.read) li.className = "unread";
    var title = document.createElement("div");
    title.textContent = n.title;
    li.appendChild(title);
    if (n.body) {
      var body = document.createElement("div");
      body.className = "notif-body";
      body.textContent = n.body;
      li.appendChild(body);
    }
    var when = document.createElement("time");
    when.textContent = fmtSessionTime(n.createdAt);
    li.appendChild(when);
    if (n.kind === "pairing" || n.kind === "transaction" || n.kind === "pending") {
      li.setAttribute("data-go", n.kind);
      li.tabIndex = 0;
      li.addEventListener("click", function () { closePanel(); goTo(n.kind); });
      li.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { closePanel(); goTo(n.kind); } });
    }
    list.appendChild(li);
  });
}

function openPanel() {
  $("notifPanel").hidden = false;
  $("notifBtn").setAttribute("aria-expanded", "true");
  renderList();
  /* Opening marks everything read; rows stay highlighted until next time. */
  if (!$("notifBadge").hidden) {
    renderBadge(0);
    apiFetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read" }) })
      .then(function () { items.forEach(function (n) { n.read = true; }); })
      .catch(function () { /* stays unread on the server; harmless */ });
  }
}

function closePanel() {
  $("notifPanel").hidden = true;
  $("notifBtn").setAttribute("aria-expanded", "false");
}

/* ---------- Settings → Telegram ---------- */

function renderTelegram(tg) {
  var status = $("tgStatus");
  if (!status) return;
  status.textContent = tg.connected ? "Connected to @" + tg.bot + "." : tg.bot ? "Bot @" + tg.bot + " saved — open it in Telegram, press Start, then press Connect again." : "Not connected.";
  $("tgTestBtn").disabled = !tg.connected;
  $("tgOffBtn").disabled = !tg.bot;
  $("notifTgNote").textContent = tg.connected ? "also sent to Telegram" : "";
}

function tgPost(body) {
  return apiFetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Telegram setup failed (" + res.status + ").");
        return data;
      });
    });
}

function initTelegram() {
  if (!$("tgConnectBtn")) return;
  $("tgConnectBtn").addEventListener("click", function () {
    var input = $("tgTokenInput");
    $("tgStatus").textContent = "Connecting…";
    tgPost({ action: "telegram", botToken: input.value.trim() || undefined }).then(function (data) {
      input.value = "";
      renderTelegram(data);
      if (data.needsStart) alert("Almost there: open @" + data.bot + " in Telegram, press Start, then press Connect again.");
    }).catch(function (e) { $("tgStatus").textContent = e.message; });
  });
  $("tgTestBtn").addEventListener("click", function () {
    tgPost({ action: "telegram-test" }).then(poll).catch(function (e) { alert(e.message); });
  });
  $("tgOffBtn").addEventListener("click", function () {
    if (!confirm("Stop sending notifications to Telegram?")) return;
    tgPost({ action: "telegram-off" }).then(function () { renderTelegram({}); }).catch(function (e) { alert(e.message); });
  });
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  var btn = $("notifBtn");
  if (!btn) return;
  btn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if ($("notifPanel").hidden) openPanel(); else closePanel();
  });
  $("notifPanel").addEventListener("click", function (ev) { ev.stopPropagation(); });
  document.addEventListener("click", function () { if (!$("notifPanel").hidden) closePanel(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !$("notifPanel").hidden) { closePanel(); btn.focus(); }
  });
  document.addEventListener("visibilitychange", poll);
  initTelegram();
  setInterval(poll, POLL_MS);
  /* First check as soon as sign-in has put the app in database mode. */
  var tries = 0;
  (function first() {
    if (app.mode === "database") poll();
    else if (++tries < 60) setTimeout(first, 1000);
  })();
}
