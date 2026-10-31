/* Daily review list for new bank money to or from people. */
import { fmt } from "../core/format.js";
import { ignoreRuleFor, owedOverdue, owedToMe, reviewQueue } from "../core/review.js";
import { renderBank } from "./bank.js";
import { bankPaymentLabel } from "./banklink.js";
import { fmtDate } from "./cards.js";
import { app, els } from "./context.js";
import { afterExpensesChanged, deleteExpense, renderDaily, todayLocal, updateExpense } from "./daily.js";
import { showTab } from "./shell.js";
import { apiFetch, load } from "./storage.js";

export function renderReview() {
  var queue = reviewQueue(app.state, app.bankData);
  var n = queue.length;
  if (els.reviewBadge) { els.reviewBadge.hidden = !n; els.reviewBadge.textContent = String(n); }
  if (els.reviewBanner) {
    els.reviewBanner.hidden = !n;
    els.reviewBanner.textContent = n + (n === 1 ? " bank payment" : " bank payments") + " to review →";
  }
  if (els.statOwed) {
    var owed = owedToMe(app.state, app.bankData);
    els.statOwed.textContent = fmt(owed);
    var old = document.getElementById("statOwedOld");
    var stale = owedOverdue(app.state, app.bankData, todayLocal());
    if (old) { old.hidden = !(stale > 0); old.textContent = fmt(stale) + " waiting over 4 weeks"; }
  }
  if (!els.reviewBox || !els.reviewList) return;
  els.reviewBox.hidden = !n && !app.lastReview;
  els.reviewList.innerHTML = "";
  if (app.lastReview) {
    var undo = document.createElement("button");
    undo.type = "button"; undo.className = "ri-undo";
    undo.textContent = "Undo last review";
    undo.addEventListener("click", function () {
      var u = app.lastReview; app.lastReview = null;
      if (u.rule) saveIgnoreRules(currentIgnoreRules().filter(function (r) { return !sameRule(r, u.rule); }), true);
      else if (u.expenseId) deleteExpense(u.expenseId);
      else if (u.expenseLinkId) updateExpense(u.expenseLinkId, { bankTxId: null });
      else saveReview(u.txId, null, true);
      renderReview();
    });
    els.reviewList.appendChild(undo);
  }
  var acct = {};
  ((app.bankData && app.bankData.accounts) || []).forEach(function (a) { acct[a.id] = a; });
  queue.forEach(function (t) {
    var moneyIn = t.amount < 0;
    var item = document.createElement("div");
    item.className = "review-item";
    var main = document.createElement("div");
    main.className = "ri-main";
    var text = document.createElement("span");
    text.className = "ri-text";
    var name = document.createElement("span");
    name.className = "desc"; name.textContent = t.name || "(no description)";
    var sub = document.createElement("span");
    sub.className = "tx-sub";
    var a = acct[t.accountId];
    sub.textContent = fmtDate(t.date) + (a ? " · " + bankPaymentLabel(a).replace(/^Zelle · /, "") : "") + (t.pending ? " · pending" : "");
    text.appendChild(name); text.appendChild(sub);
    var amt = document.createElement("span");
    amt.className = "amt " + (moneyIn ? "pos" : "neg");
    amt.textContent = (moneyIn ? "+" : "−") + fmt(Math.abs(t.amount));
    main.appendChild(text); main.appendChild(amt);
    item.appendChild(main);
    var actions = document.createElement("div");
    actions.className = "ri-actions";
    function btn(label, onClick, primary) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      if (primary) b.className = "primary";
      b.addEventListener("click", onClick);
      actions.appendChild(b);
    }
    if (moneyIn) {
      btn("Repayment", function () { saveReview(t.id, "repayment"); }, true);
      btn("Income", function () { saveReview(t.id, "income"); });
      btn("Ignore", function () { saveReview(t.id, "ignore"); });
      btn("Always ignore", function () { alwaysIgnore(t); });
    } else {
      btn("Add as expense", function () { addFromBank(t); }, true);
      var near = (app.state.dailyExpenses || []).filter(function (e) {
        return !e.bankTxId && Math.abs(Date.parse(e.date + "T00:00:00Z") - Date.parse(t.date + "T00:00:00Z")) <= 7 * 864e5;
      }).sort(function (x, y) { return Math.abs(x.amount - t.amount) - Math.abs(y.amount - t.amount); }).slice(0, 8);
      if (near.length) {
        var sel = document.createElement("select");
        sel.setAttribute("aria-label", "Link this payment to an expense you already entered");
        var o0 = document.createElement("option"); o0.value = ""; o0.textContent = "Link to an expense…";
        sel.appendChild(o0);
        near.forEach(function (e) {
          var o = document.createElement("option");
          o.value = String(e.id);
          o.textContent = (Math.abs(e.amount - t.amount) < 0.005 ? "★ " : "") + e.description.slice(0, 32) + " · " + fmt(e.amount);
          sel.appendChild(o);
        });
        sel.addEventListener("change", function () {
          var id = Number(sel.value);
          if (!id) return;
          app.lastReview = { txId: t.id, expenseLinkId: id };
          updateExpense(id, { bankTxId: t.id });
        });
        actions.appendChild(sel);
      }
      btn("Not an expense", function () { saveReview(t.id, "ignore"); });
      btn("Always ignore", function () { alwaysIgnore(t); });
    }
    item.appendChild(actions);
    els.reviewList.appendChild(item);
  });
}

export function currentIgnoreRules() { return (app.bankData && app.bankData.ignoreRules) || []; }

export function sameRule(a, b) { return a.accountId === b.accountId && a.direction === b.direction && a.name === b.name; }

export function alwaysIgnore(t) {
  var rule = ignoreRuleFor(t);
  if (!confirm("Always ignore " + (rule.direction === "in" ? "money in" : "payments") + " named like \"" + (t.name || "") +
    "\" on this account? You can undo this on the Bank tab.")) return;
  saveIgnoreRules(currentIgnoreRules().filter(function (r) { return !sameRule(r, rule); }).concat([rule]));
  app.lastReview = { rule: rule };
}

export function saveIgnoreRules(rules, isUndo) {
  apiFetch("/api/bank", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ignoreRules: rules }) })
    .then(function (res) { if (!res.ok) throw new Error("bank " + res.status); return res.json(); })
    .then(function (data) { app.bankData = data; renderBank(); renderDaily(); })
    .catch(function () { if (!isUndo) app.lastReview = null; alert("Couldn't save that. Check your connection and try again."); });
}

export function saveReview(txId, kind, isUndo) {
  apiFetch("/api/bank", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txId: txId, kind: kind }) })
    .then(function (res) { if (!res.ok) throw new Error("bank " + res.status); return res.json(); })
    .then(function (data) {
      app.bankData = data;
      if (!isUndo) app.lastReview = { txId: txId };
      /* "income" changes the month's actuals on the server: reload them. */
      return load();
    })
    .catch(function () { alert("Couldn't save that review. Check your connection and try again."); });
}

export function addFromBank(t) {
  var a = ((app.bankData && app.bankData.accounts) || []).filter(function (x) { return x.id === t.accountId; })[0];
  apiFetch("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: t.date, description: t.name || "Bank payment", amount: Math.abs(t.amount),
      card: a ? bankPaymentLabel(a) : undefined, bankTxId: t.id }) })
    .then(function (res) { if (!res.ok) throw new Error("expenses " + res.status); return res.json(); })
    .then(function (data) {
      app.lastReview = { txId: t.id, expenseId: data.expense && data.expense.id };
      afterExpensesChanged(data.state);
    })
    .catch(function () { alert("Couldn't add that expense. Check your connection and try again."); });
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  /* Header strip for the month in focus: the current month when it has
     expenses, else the newest month that does. */
  /* ---- Daily review list ----
     New money to or from people (see reviewQueue). Each item gets one
     decision; own-account transfers, card bills and paychecks never
     show up. Also refreshes the tab badge, the dashboard banner and the
     Owed to me tile, which all read the same data. */

  app.lastReview = null; /* { txId } of the last decision, for Undo */
  if (els.reviewBanner) els.reviewBanner.addEventListener("click", function () { showTab("daily"); });
}
