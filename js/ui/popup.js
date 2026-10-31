/* Popup listing the transactions behind a chart item. */
import { fmt } from "../core/format.js";
import { expenseShare } from "../core/spending.js";
import { fmtDate } from "./cards.js";

/* Popup listing the transactions behind a chart item (native <dialog>:
   Esc and the × close it; so does a tap on the dimmed backdrop). */

export function showTransactions(title, list) {
  var dlg = document.getElementById("txDialog");
  if (!dlg) return;
  list = list.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  document.getElementById("txDialogTitle").textContent = title;
  var total = list.reduce(function (s, e) { return s + expenseShare(e); }, 0);
  document.getElementById("txDialogSum").textContent =
    list.length + (list.length === 1 ? " transaction · " : " transactions · ") + fmt(Math.round(total * 100) / 100);
  var box = document.getElementById("txDialogList");
  box.innerHTML = "";
  list.forEach(function (e) {
    var row = document.createElement("div");
    row.className = "txd-row";
    var text = document.createElement("span");
    text.className = "tx-text";
    var desc = document.createElement("span");
    desc.className = "desc"; desc.textContent = e.description || "(no description)";
    var sub = document.createElement("span");
    sub.className = "tx-sub";
    sub.textContent = fmtDate(e.date) + " · " + (e.category || "Misc/Other") + (e.card ? " · " + e.card : "");
    text.appendChild(desc); text.appendChild(sub);
    if (e.note) {
      var noteLine = document.createElement("span");
      noteLine.className = "tx-note";
      noteLine.textContent = e.note;
      text.appendChild(noteLine);
    }
    var amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = fmt(expenseShare(e));
    if (typeof e.myShare === "number" && e.myShare !== (e.amount || 0)) {
      var of = document.createElement("span");
      of.className = "share-sub"; of.textContent = "my share of " + fmt(e.amount || 0);
      amt.appendChild(of);
    }
    row.appendChild(text); row.appendChild(amt);
    box.appendChild(row);
  });
  if (!dlg.open) dlg.showModal();
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  (function () {
    var dlg = document.getElementById("txDialog");
    if (!dlg) return;
    document.getElementById("txDialogClose").addEventListener("click", function () { dlg.close(); });
    dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  })();
}
