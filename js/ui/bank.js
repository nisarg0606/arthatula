/* Bank tab: account snapshot, transactions, ignore rules. */
import { fmt } from "../core/format.js";
import { fillCardSelect } from "./banklink.js";
import { fmtDate } from "./cards.js";
import { app, els } from "./context.js";
import { renderDaily } from "./daily.js";
import { PAGE_SIZE, clampPage, pager } from "./pager.js";
import { currentIgnoreRules, sameRule, saveIgnoreRules } from "./review.js";
import { apiFetch } from "./storage.js";

/* ================= Bank tab =================
   Read-only snapshot pushed by the Plaid sync automation to
   /api/bank (accounts + transactions + syncedAt). Fetched alongside
   the main load and again on every visit to the tab; a failed fetch
   just leaves the empty state — it must never break other tabs.
   Amounts keep the Plaid depository sign convention (positive =
   money OUT, negative = money IN), so money IN is displayed as a
   green +$ and money OUT as a −$. */

export function bankAccountLabel(a) {
  if (!a) return "Account";
  var label = ((a.institution || "") + " " + (a.name || "")).trim() || a.id || "Account";
  return a.mask ? label + " ••" + a.mask : label;
}

export function loadBank() {
  return apiFetch("/api/bank").then(function (res) {
    if (!res.ok) throw new Error("bank " + res.status);
    return res.json();
  }).then(function (data) {
    app.bankData = data;
    renderBank();
    if (els.expCard) fillCardSelect(els.expCard, els.expCard.value || "");
    renderDaily(); /* bank accounts, link pickers and the review list depend on the snapshot */
  }).catch(function () {
    renderBank(); /* shows the empty state until a snapshot exists */
  });
}

export function renderBank() {
  if (!els.bankAccounts) return;
  var accounts = (app.bankData && app.bankData.accounts) || [];
  var txs = (app.bankData && app.bankData.transactions) || [];
  if (els.bankSyncedAt) {
    els.bankSyncedAt.textContent = app.bankData && app.bankData.syncedAt
      ? "Last synced: " + new Date(app.bankData.syncedAt).toLocaleString("en-US",
          { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : "";
  }
  /* Account filter: rebuild the options, keep the current choice. */
  if (els.bankAccountFilter) {
    var sel = els.bankAccountFilter;
    sel.innerHTML = "";
    var allOpt = document.createElement("option");
    allOpt.value = ""; allOpt.textContent = "All accounts";
    sel.appendChild(allOpt);
    accounts.forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a.id; opt.textContent = bankAccountLabel(a);
      sel.appendChild(opt);
    });
    sel.value = app.bankFilter;
    if (sel.value !== app.bankFilter) { app.bankFilter = ""; sel.value = ""; }
  }
  if (els.bankIgnoreRules) {
    var rules = currentIgnoreRules();
    var acctLabel = {};
    accounts.forEach(function (a) { acctLabel[a.id] = bankAccountLabel(a); });
    els.bankIgnoreRules.innerHTML = "";
    els.bankIgnoreRules.hidden = !rules.length;
    if (rules.length) {
      var h = document.createElement("h3");
      h.className = "chart-title"; h.textContent = "Always ignored in the review list";
      els.bankIgnoreRules.appendChild(h);
      rules.forEach(function (r) {
        var row = document.createElement("div");
        row.className = "rule-row";
        var label = document.createElement("span");
        label.textContent = (r.direction === "in" ? "Money in · " : "Money out · ") + r.name + " · " + (acctLabel[r.accountId] || "account");
        var stop = document.createElement("button");
        stop.type = "button"; stop.textContent = "Stop ignoring";
        stop.addEventListener("click", function () {
          saveIgnoreRules(currentIgnoreRules().filter(function (x) { return !sameRule(x, r); }));
        });
        row.appendChild(label); row.appendChild(stop);
        els.bankIgnoreRules.appendChild(row);
      });
    }
  }
  els.bankAccounts.innerHTML = "";
  if (!accounts.length && !txs.length) {
    var empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No bank data yet — it appears after the next Plaid sync.";
    els.bankAccounts.appendChild(empty);
  }
  accounts.forEach(function (a) {
    var panel = document.createElement("div");
    panel.className = "card-panel";
    var head = document.createElement("div");
    head.className = "card-panel-head";
    var title = document.createElement("h3");
    title.className = "chart-title";
    title.textContent = bankAccountLabel(a);
    head.appendChild(title);
    var bal = document.createElement("span");
    bal.style.fontWeight = "800";
    bal.textContent = a.currentBalance === null || a.currentBalance === undefined ? "—" : fmt(a.currentBalance);
    head.appendChild(bal);
    panel.appendChild(head);
    var meta = document.createElement("p");
    meta.className = "hint";
    var bits = [];
    if (a.subtype) bits.push(a.subtype.charAt(0).toUpperCase() + a.subtype.slice(1));
    bits.push("Current balance");
    if (a.availableBalance !== null && a.availableBalance !== undefined && a.availableBalance !== a.currentBalance) {
      bits.push("Available: " + fmt(a.availableBalance));
    }
    meta.textContent = bits.join(" · ");
    panel.appendChild(meta);
    els.bankAccounts.appendChild(panel);
  });
  if (!els.bankTxList) return;
  els.bankTxList.innerHTML = "";
  var byId = {};
  accounts.forEach(function (a) { byId[a.id] = a; });
  var shown = txs.filter(function (t) { return !app.bankFilter || t.accountId === app.bankFilter; });
  if (!shown.length) {
    if (txs.length) {
      var none = document.createElement("p");
      none.className = "hint";
      none.textContent = "No transactions for this account yet.";
      els.bankTxList.appendChild(none);
    }
    return;
  }
  var wrap = document.createElement("div");
  wrap.className = "table-scroll";
  var table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Date</th><th>Description</th><th class=\"col-cat\">Account</th><th>Amount</th></tr></thead>";
  var tbody = document.createElement("tbody");
  app.bankPage = clampPage(app.bankPage, shown.length);
  var start = (app.bankPage - 1) * PAGE_SIZE;
  shown.slice(start, start + PAGE_SIZE).forEach(function (t) {
    var tr = document.createElement("tr");
    var moneyIn = (t.amount || 0) < 0;
    var cells = [
      fmtDate(t.date),
      (t.name || "(no description)") + (t.pending ? " (pending)" : ""),
      bankAccountLabel(byId[t.accountId]),
      (moneyIn ? "+" : "-") + fmt(Math.abs(t.amount || 0))
    ];
    cells.forEach(function (txt, i) {
      var td = document.createElement("td");
      td.textContent = txt;
      if (i === 1 || i === 2) td.style.textAlign = "left";
      if (i === 1) td.className = "col-desc";
      if (i === 2) td.className = "col-cat"; /* hidden on phones */
      if (i === 3) td.className = moneyIn ? "pos" : "neg";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  els.bankTxList.appendChild(wrap);
  var pages = pager(app.bankPage, shown.length, function (n) { app.bankPage = n; renderBank(); }, els.bankTxList);
  if (pages) els.bankTxList.appendChild(pages);
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.bankAccountFilter) {
    els.bankAccountFilter.addEventListener("change", function () {
      app.bankFilter = els.bankAccountFilter.value || "";
      app.bankPage = 1;
      renderBank();
    });
  }
}
