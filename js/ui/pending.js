/* Pending card charges. */
import { formatDateLabel } from "../core/dates.js";
import { fmt } from "../core/format.js";
import { DAILY_CATEGORIES } from "../core/categories.js";
import { countedPending, likelyToChange, unpostedCounted } from "../core/pending.js";
import { pendingInMonth } from "../core/spending.js";
import { app, els } from "./context.js";
import { afterExpensesChanged, deleteExpense, todayLocal, updateExpense } from "./daily.js";
import { apiFetch } from "./storage.js";

/* ================= Pending charges =================
   Read-only snapshot pushed by the Plaid sync automation to
   /api/pending (the charges Plaid currently reports as pending).
   A pending charge is NOT an expense until the owner taps "Count it
   now" (or it posts and the normal import adds it). The dashboard's
   Spent card shows the month's not-yet-counted pending total as a
   separate "+$X pending" preview line. */

export function loadPending() {
  return apiFetch("/api/pending").then(function (res) {
    if (!res.ok) throw new Error("pending " + res.status);
    return res.json();
  }).then(function (data) {
    app.pendingData = data;
    renderPending();
    updateSpentPending();
  }).catch(function () {
    renderPending(); /* section stays hidden until a snapshot exists */
  });
}

export function updateSpentPending() {
  if (!els.statSpentPending) return;
  var counted = countedPending(app.state.dailyExpenses);
  var pend = pendingInMonth(app.pendingData && app.pendingData.transactions, app.selectedKey, counted);
  els.statSpentPending.textContent = pend > 0 ? "+" + fmt(pend) + " pending" : "";
}

/* Pending rows, each with "Count it now" (or "Counted" once it is an
   expense), plus counted charges that never posted, to remove or keep. */
export function renderPending() {
  if (!els.pendingSection) return;
  var txs = (app.pendingData && app.pendingData.transactions) || [];
  var counted = countedPending(app.state.dailyExpenses);
  var unposted = unpostedCounted(app.state.dailyExpenses, app.pendingData && app.pendingData.transactions, todayLocal());
  els.pendingSection.hidden = !txs.length && !unposted.length;
  if (els.pendingSection.hidden) return;
  var waiting = txs.filter(function (t) { return !counted[t.id]; });
  var total = 0;
  waiting.forEach(function (t) { total += t.amount || 0; });
  if (els.pendingMeta) {
    els.pendingMeta.textContent = waiting.length + (waiting.length === 1 ? " charge · " : " charges · ") + fmt(total) + " — not counted yet";
  }
  if (!els.pendingList) return;
  els.pendingList.innerHTML = "";
  txs.forEach(function (t) {
    var row = document.createElement("div");
    row.className = "pending-row";
    var main = document.createElement("div");
    main.className = "pending-main";
    var name = document.createElement("span");
    name.className = "pending-name";
    name.textContent = t.name || "Pending charge";
    var sub = document.createElement("span");
    sub.className = "pending-sub";
    sub.textContent = [formatDateLabel(t.date), t.accountLabel, t.category].filter(Boolean).join(" · ");
    main.appendChild(name);
    main.appendChild(sub);
    row.appendChild(main);
    if (counted[t.id]) {
      var done = document.createElement("span");
      done.className = "pending-badge counted";
      done.textContent = "Counted";
      row.appendChild(done);
    } else {
      var count = document.createElement("button");
      count.type = "button";
      count.className = "pending-count";
      count.textContent = "Count it now";
      count.addEventListener("click", function () { countNow(t, count); });
      row.appendChild(count);
    }
    var amt = document.createElement("span");
    amt.className = "pending-amount";
    amt.textContent = fmt(t.amount || 0);
    row.appendChild(amt);
    els.pendingList.appendChild(row);
  });
  if (unposted.length) {
    var h = document.createElement("p");
    h.className = "pending-note pending-flag-head";
    h.textContent = "Counted early but never posted. Remove it if the charge was dropped, or keep it if it's right.";
    els.pendingList.appendChild(h);
    unposted.forEach(function (e) {
      var row = document.createElement("div");
      row.className = "pending-row pending-flag";
      var main = document.createElement("div");
      main.className = "pending-main";
      var name = document.createElement("span");
      name.className = "pending-name"; name.textContent = e.description;
      var sub = document.createElement("span");
      sub.className = "pending-sub";
      sub.textContent = [formatDateLabel(e.date), e.card, e.category].filter(Boolean).join(" · ");
      main.appendChild(name); main.appendChild(sub);
      var remove = document.createElement("button");
      remove.type = "button"; remove.className = "pending-count"; remove.textContent = "Remove";
      remove.addEventListener("click", function () { deleteExpense(e.id); });
      var keep = document.createElement("button");
      keep.type = "button"; keep.className = "pending-count"; keep.textContent = "Keep";
      keep.addEventListener("click", function () { updateExpense(e.id, { pendingSettled: true }); });
      var amt = document.createElement("span");
      amt.className = "pending-amount"; amt.textContent = fmt(e.amount || 0);
      row.appendChild(main); row.appendChild(remove); row.appendChild(keep); row.appendChild(amt);
      els.pendingList.appendChild(row);
    });
  }
}

/* "Count it now": make the pending charge a real expense today. When it
   posts, the sync's import updates this same expense (see
   functions/api/expenses.js), so it is never counted twice. */
function countNow(t, btn) {
  if (likelyToChange(t) && !confirm("The final amount for " + (t.name || "this charge") +
    " often changes (tips, holds). Count " + fmt(t.amount || 0) + " now anyway? It updates to the real amount when it posts.")) return;
  var cards = (app.state.cards || []).map(function (c) { return c.name; });
  btn.disabled = true;
  apiFetch("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: t.date, description: t.name || "Pending charge", amount: t.amount || 0,
      category: DAILY_CATEGORIES.indexOf(t.category) !== -1 ? t.category : undefined,
      card: cards.indexOf(t.accountLabel) !== -1 ? t.accountLabel : undefined, pendingTxId: t.id }) })
    .then(function (res) { if (!res.ok) throw new Error("expenses " + res.status); return res.json(); })
    .then(function (data) { afterExpensesChanged(data.state); })
    .catch(function () { btn.disabled = false; alert("Couldn't count that charge. Check your connection and try again."); });
}
