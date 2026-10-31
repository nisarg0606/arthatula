/* Paid-with options and linking expenses to bank transactions. */
import { fmt } from "../core/format.js";
import { fmtDate } from "./cards.js";
import { app } from "./context.js";
import { updateExpense } from "./daily.js";
import { apiFetch } from "./storage.js";

/* ================= Credit cards (statement cycles) ================= */

export function fillCardSelect(selectEl, selected) {
  if (!selectEl) return;
  var current = selected !== undefined ? selected : (selectEl.value || "");
  selectEl.innerHTML = "";
  var none = document.createElement("option");
  none.value = ""; none.textContent = "— none / cash —";
  selectEl.appendChild(none);
  (app.state.cards || []).forEach(function (c) {
    var o = document.createElement("option");
    o.value = c.name; o.textContent = c.name;
    selectEl.appendChild(o);
  });
  /* Bank accounts too: Zelle and other bank payments name the account
     the money left from, e.g. "Zelle · Chase ••1234". */
  var banks = (app.bankData && app.bankData.accounts) || [];
  if (banks.length) {
    var group = document.createElement("optgroup");
    group.label = "Bank account (Zelle, transfer)";
    banks.forEach(function (a) {
      var o = document.createElement("option");
      o.value = o.textContent = bankPaymentLabel(a);
      group.appendChild(o);
    });
    selectEl.appendChild(group);
  }
  selectEl.value = current || "";
  if (current && selectEl.value !== current) {
    /* Keep a saved value that isn't listed (bank data not loaded yet,
       or a renamed card) instead of silently showing "none". */
    var keep = document.createElement("option");
    keep.value = keep.textContent = current;
    selectEl.appendChild(keep);
    selectEl.value = current;
  }
}

export function bankPaymentLabel(a) {
  return "Zelle · " + (a.institution || a.name || "Bank") + (a.mask ? " ••" + a.mask : "");
}

/* Bank outflows an expense could have been paid by: money out within
   7 days of it, nearest amount first. Rows linked to a different
   expense are still offered (flagged) so a duplicate import can be
   merged into the hand-entered expense. */

export function bankTxCandidates(e) {
  var txs = (app.bankData && app.bankData.transactions) || [];
  var linkedTo = {};
  (app.state.dailyExpenses || []).forEach(function (x) { if (x.bankTxId) linkedTo[x.bankTxId] = x; });
  var day = 864e5, at = Date.parse(e.date + "T00:00:00Z");
  return txs.filter(function (t) {
    if (t.id === e.bankTxId) return true;
    return (t.amount || 0) > 0 && Math.abs(Date.parse(t.date + "T00:00:00Z") - at) <= 7 * day;
  }).map(function (t) {
    var other = linkedTo[t.id] && linkedTo[t.id].id !== e.id ? linkedTo[t.id] : null;
    return { tx: t, other: other, diff: Math.abs((t.amount || 0) - (e.amount || 0)) };
  }).sort(function (a, b) {
    return (a.tx.id === e.bankTxId ? -1 : 0) - (b.tx.id === e.bankTxId ? -1 : 0) || a.diff - b.diff;
  }).slice(0, 8);
}

export function linkBankTx(e, txId, sel) {
  var patch = { bankTxId: txId || null };
  var account = txId && (app.bankData.accounts || []).filter(function (a) {
    var t = (app.bankData.transactions || []).filter(function (x) { return x.id === txId; })[0];
    return t && a.id === t.accountId;
  })[0];
  if (account && !e.card) patch.card = bankPaymentLabel(account);
  var other = txId && (app.state.dailyExpenses || []).filter(function (x) { return x.bankTxId === txId && x.id !== e.id; })[0];
  if (other) {
    if (!confirm("This bank payment was already imported as \"" + other.description + "\" (" + fmt(other.amount || 0) +
      ", " + fmtDate(other.date) + "). Remove that copy and link the payment to this expense instead?")) {
      sel.value = e.bankTxId || "";
      return;
    }
    apiFetch("/api/expenses?id=" + encodeURIComponent(other.id), { method: "DELETE" })
      .then(function (res) { if (!res.ok) throw new Error("expenses " + res.status); updateExpense(e.id, patch); })
      .catch(function () { alert("Couldn't remove the imported copy, so nothing was linked. Try again."); sel.value = e.bankTxId || ""; });
    return;
  }
  updateExpense(e.id, patch);
}
