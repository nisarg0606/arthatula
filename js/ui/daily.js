/* Daily expenses tab: the feed, quick add, and expense create/update/delete. */
import { DAILY_CATEGORIES, categorizeByRulesJs } from "../core/categories.js";
import { CAL_MONTHS_SHORT, formatDateLabel } from "../core/dates.js";
import { fmt } from "../core/format.js";
import { sanitizeState, toNumber } from "../core/plan.js";
import { expenseShare, sanitizeMyShare } from "../core/spending.js";
import { bankTxCandidates, fillCardSelect, linkBankTx } from "./banklink.js";
import { fmtDate, renderCards } from "./cards.js";
import { DOUGHNUT_COLORS } from "./charts.js";
import { app, els } from "./context.js";
import { renderSummary } from "./dashboard.js";
import { makeDatePicker, refreshDatePickers } from "./datepicker.js";
import { buildForm, monthLabel } from "./editor.js";
import { merchantRuleControl } from "./merchant.js";
import { PAGE_SIZE, clampPage, pager } from "./pager.js";
import { renderPending, updateSpentPending } from "./pending.js";
import { renderReview } from "./review.js";
import { keepScroll } from "./scroll.js";
import { apiFetch, persist, setMode } from "./storage.js";

/* ================= Daily expenses ================= */

export function todayLocal() {
  var d = new Date();
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

export function categorizeRemote(description, amount) {
  return apiFetch("/api/categorize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: description, amount: amount })
  }).then(function (res) {
    if (!res.ok) throw new Error("categorize " + res.status);
    return res.json();
  }).then(function (data) {
    if (DAILY_CATEGORIES.indexOf(data.category) === -1) throw new Error("bad category");
    return data; /* { category, confidence?, source } */
  }).catch(function () {
    return { category: categorizeByRulesJs(description), source: "rules" };
  });
}

/* Rebuilds the Daily list without moving the reader (see scroll.js). */
export function renderDaily() { keepScroll(renderDailyNow); }

function renderDailyNow() {
  if (!els.expenseList) return;
  /* The list is rebuilt below: drop the pickers of the old rows, then
     refresh the static pickers' labels (the quick-add date may have
     just been defaulted, the baseline date set by render(), ...). */
  app.datePickers = app.datePickers.filter(function (p) { return !p.isRow; });
  if (els.expDate && !els.expDate.value) els.expDate.value = todayLocal();
  refreshDatePickers();
  if (els.expCategory && els.expCategory.options.length <= 1) {
    DAILY_CATEGORIES.forEach(function (c) {
      var o = document.createElement("option"); o.value = c; o.textContent = c;
      els.expCategory.appendChild(o);
    });
  }
  if (els.expCard) fillCardSelect(els.expCard, els.expCard.value || "");
  var list = (app.state.dailyExpenses || []).slice().sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0);
  });
  /* Rows rebuild after every edit: keep the ones that were expanded open. */
  var openIds = [].map.call(els.expenseList.querySelectorAll("details.tx[open]"), function (d) { return d.dataset.id; });
  els.expenseList.innerHTML = "";
  renderReview();
  if (!list.length) {
    var p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No daily expenses yet. Add your first one above — it will roll up into that month's actuals.";
    els.expenseList.appendChild(p);
    return;
  }
  renderDailySummary(list);
  /* Day and month totals come from the whole list; only one page of
     rows is built (see pager.js). Day/month totals are your actual
     cost, so shared expenses count at share value — the same numbers
     the monthly rollup produces. */
  var monthTotal = {}, dayTotal = {};
  list.forEach(function (e) {
    var v = expenseShare(e), mk = String(e.date).slice(0, 7);
    monthTotal[mk] = (monthTotal[mk] || 0) + v;
    dayTotal[e.date] = (dayTotal[e.date] || 0) + v;
  });
  app.dailyPage = clampPage(app.dailyPage, list.length);
  var start = (app.dailyPage - 1) * PAGE_SIZE;
  var lastMonth = null, group = null, lastDay = null;
  list.slice(start, start + PAGE_SIZE).forEach(function (e) {
    var mk = String(e.date).slice(0, 7);
    if (mk !== lastMonth) {
      lastMonth = mk;
      var head = document.createElement("div");
      head.className = "month-head";
      var mName = document.createElement("h3");
      mName.className = "month-total";
      mName.textContent = monthLabel(mk) || longMonth(mk);
      var mSum = document.createElement("span");
      mSum.className = "month-sum";
      mSum.textContent = fmt(monthTotal[mk]);
      head.appendChild(mName); head.appendChild(mSum);
      els.expenseList.appendChild(head);
      lastDay = null;
    }
    if (e.date !== lastDay) {
      lastDay = e.date;
      var dayHead = document.createElement("div");
      dayHead.className = "day-head";
      var dName = document.createElement("h4");
      dName.className = "day-total";
      dName.textContent = formatDateLabel(e.date).replace(/, \d{4}$/, "");
      var dSum = document.createElement("span");
      dSum.textContent = fmt(dayTotal[e.date]);
      dayHead.appendChild(dName); dayHead.appendChild(dSum);
      els.expenseList.appendChild(dayHead);
      group = document.createElement("div");
      group.className = "tx-group";
      els.expenseList.appendChild(group);
    }
    group.appendChild(expenseRow(e, openIds.indexOf(String(e.id)) !== -1));
  });
  var pages = pager(app.dailyPage, list.length, function (n) { app.dailyPage = n; renderDailyNow(); }, els.expenseList);
  if (pages) els.expenseList.appendChild(pages);
}

export function longMonth(mk) {
  var d = new Date(mk + "-15T12:00:00");
  return isNaN(d.getTime()) ? mk : CAL_MONTHS_SHORT[d.getMonth()] + " " + d.getFullYear();
}

export function categoryColor(cat) {
  var i = DAILY_CATEGORIES.indexOf(cat);
  return DOUGHNUT_COLORS[(i < 0 ? DAILY_CATEGORIES.length - 1 : i) % DOUGHNUT_COLORS.length];
}

export function renderDailySummary(list) {
  var box = document.getElementById("dailySummary");
  if (!box) return;
  box.innerHTML = "";
  if (!list.length) return;
  var now = new Date();
  var nowKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  var keys = list.map(function (e) { return String(e.date).slice(0, 7); });
  var mk = keys.indexOf(nowKey) !== -1 ? nowKey : keys[0];
  var items = list.filter(function (e) { return String(e.date).slice(0, 7) === mk; });
  var total = 0, byCat = {};
  items.forEach(function (e) { var v = expenseShare(e); total += v; byCat[e.category] = (byCat[e.category] || 0) + v; });
  var daysIn = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0).getDate();
  var days = mk === nowKey ? now.getDate() : daysIn;
  var top = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })[0];
  [["Spent · " + (monthLabel(mk) || longMonth(mk)), fmt(total)],
   ["Transactions", String(items.length)],
   ["Average / day", fmt(total / days)],
   ["Top category", top || "—", top ? fmt(byCat[top]) : ""]].forEach(function (kv) {
    var tile = document.createElement("div");
    tile.className = "sum-tile";
    var l = document.createElement("span"); l.className = "sum-label"; l.textContent = kv[0];
    var v = document.createElement("span"); v.className = "sum-value"; v.textContent = kv[1];
    tile.appendChild(l); tile.appendChild(v);
    if (kv[2]) { var sub = document.createElement("span"); sub.className = "sum-sub"; sub.textContent = kv[2]; tile.appendChild(sub); }
    box.appendChild(tile);
  });
}

/* One transaction: a tappable summary row (category badge, description,
   category · card, amount) that expands into the editing controls. */

export function expenseRow(e, open) {
    var row = document.createElement("details");
    row.className = "expense-item tx";
    row.dataset.id = String(e.id);
    var sum = document.createElement("summary");
    sum.className = "tx-main";
    var badge = document.createElement("span");
    badge.className = "tx-badge";
    badge.style.setProperty("--c", categoryColor(e.category));
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = String(e.category || "?").charAt(0);
    var text = document.createElement("span");
    text.className = "tx-text";
    var desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = e.description || "(no description)";
    var sub = document.createElement("span");
    sub.className = "tx-sub";
    sub.textContent = (e.category || "Misc/Other") + (e.card ? " · " + e.card : "") + (e.bankTxId ? " · linked to bank" : "") +
      (e.pendingTxId && !e.pendingSettled ? " · counted from pending" : "");
    text.appendChild(desc); text.appendChild(sub);
    if (e.note) {
      var noteLine = document.createElement("span");
      noteLine.className = "tx-note";
      noteLine.textContent = e.note;
      text.appendChild(noteLine);
    }
    var amt = document.createElement("span");
    amt.className = "amt";
    var amtMain = document.createElement("span");
    amtMain.className = "amt-main";
    amtMain.textContent = fmt(e.amount || 0);
    amt.appendChild(amtMain);
    if (typeof e.myShare === "number" && e.myShare !== (e.amount || 0)) {
      var shareLine = document.createElement("span");
      shareLine.className = "share-sub";
      shareLine.textContent = "my share " + fmt(e.myShare);
      amt.appendChild(shareLine);
    }
    sum.appendChild(badge); sum.appendChild(text); sum.appendChild(amt);
    row.appendChild(sum);
    var edit = document.createElement("div");
    edit.className = "tx-edit";
    row.appendChild(edit);
    /* The editing controls are built on first open: building every
       row's picker and selects up front was most of the Daily tab's
       render time on a long list. */
    var built = false;
    function build() {
      if (built) return;
      built = true;
      /* Premium calendar pill for the row's date — picking a new day
         saves it straight away (same update path as the other row
         controls); the Edit prompts no longer ask for a date. */
      var dateWrap = document.createElement("div");
      dateWrap.className = "datepicker";
      var dateBtn = document.createElement("button");
      dateBtn.type = "button"; dateBtn.className = "date-btn row";
      dateBtn.setAttribute("aria-haspopup", "dialog"); dateBtn.setAttribute("aria-expanded", "false");
      dateBtn.setAttribute("aria-label", "Change the date of this expense");
      var dateDisp = document.createElement("span");
      var dateCaret = document.createElement("span");
      dateCaret.className = "date-caret"; dateCaret.setAttribute("aria-hidden", "true");
      dateCaret.innerHTML = "&#9662;";
      dateBtn.appendChild(dateDisp); dateBtn.appendChild(dateCaret);
      var dateInput = document.createElement("input");
      dateInput.type = "hidden"; dateInput.value = e.date || "";
      var datePop = document.createElement("div");
      datePop.className = "cal-pop hidden"; datePop.setAttribute("role", "dialog");
      datePop.setAttribute("aria-label", "Choose a date");
      dateWrap.appendChild(dateBtn); dateWrap.appendChild(dateInput); dateWrap.appendChild(datePop);
      edit.appendChild(dateWrap);
      makeDatePicker({ btn: dateBtn, display: dateDisp, pop: datePop, input: dateInput, row: true,
        onChange: function (v) { if (v && v !== e.date) updateExpense(e.id, { date: v }); } });
      var sel = document.createElement("select");
      sel.setAttribute("aria-label", "Category");
      DAILY_CATEGORIES.forEach(function (c) {
        var o = document.createElement("option"); o.value = c; o.textContent = c;
        if (c === e.category) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { updateExpense(e.id, { category: sel.value }); });
      edit.appendChild(sel);
      if (app.mode === "database") edit.appendChild(merchantRuleControl(e, sel));
      var cardSel = document.createElement("select");
      cardSel.setAttribute("aria-label", "Card this expense was charged to");
      fillCardSelect(cardSel, e.card || "");
      cardSel.addEventListener("change", function () {
        updateExpense(e.id, { card: cardSel.value || null });
      });
      edit.appendChild(cardSel);
      if (app.bankData && (app.bankData.transactions || []).length) {
        var txSel = document.createElement("select");
        txSel.className = "tx-link";
        txSel.setAttribute("aria-label", "Bank payment this expense was paid with");
        var noneOpt = document.createElement("option");
        noneOpt.value = ""; noneOpt.textContent = "Bank payment: not linked";
        txSel.appendChild(noneOpt);
        var acctName = {};
        (app.bankData.accounts || []).forEach(function (a) { acctName[a.id] = (a.institution || a.name || "") + (a.mask ? " ••" + a.mask : ""); });
        bankTxCandidates(e).forEach(function (c) {
          var o = document.createElement("option");
          o.value = c.tx.id;
          o.textContent = (c.diff < 0.005 ? "★ " : "") + fmtDate(c.tx.date).replace(/, \d{4}$/, "") + " · " +
            String(c.tx.name || "").slice(0, 40) + " · " + fmt(c.tx.amount || 0) +
            (acctName[c.tx.accountId] ? " · " + acctName[c.tx.accountId] : "") +
            (c.other ? " (already imported separately)" : "");
          txSel.appendChild(o);
        });
        txSel.value = e.bankTxId || "";
        txSel.addEventListener("change", function () { linkBankTx(e, txSel.value, txSel); });
        edit.appendChild(txSel);
      }
      var shareInput = document.createElement("input");
      shareInput.type = "number";
      shareInput.className = "share-input";
      shareInput.min = "0"; shareInput.step = "0.01"; shareInput.inputMode = "decimal";
      shareInput.placeholder = "My share";
      shareInput.setAttribute("aria-label", "My share of this expense (blank = the full amount is mine)");
      shareInput.title = "My share ($) — blank means the full amount is yours. Actuals count only your share.";
      if (typeof e.myShare === "number") shareInput.value = e.myShare;
      shareInput.addEventListener("change", function () {
        var raw = shareInput.value.trim();
        if (raw === "") { updateExpense(e.id, { myShare: null }); return; }
        var v = toNumber(raw);
        if (v < 0 || v > (e.amount || 0)) {
          alert("Your share must be between $0 and the expense amount (" + fmt(e.amount || 0) + ").");
          shareInput.value = typeof e.myShare === "number" ? e.myShare : "";
          return;
        }
        updateExpense(e.id, { myShare: v });
      });
      edit.appendChild(shareInput);
      var noteInput = document.createElement("input");
      noteInput.type = "text";
      noteInput.className = "note-input";
      noteInput.maxLength = 500;
      noteInput.placeholder = "Add a note (e.g. what this was for)";
      noteInput.setAttribute("aria-label", "Note for this expense");
      noteInput.value = e.note || "";
      noteInput.addEventListener("change", function () {
        var v = noteInput.value.trim();
        if (v !== (e.note || "")) updateExpense(e.id, { note: v });
      });
      noteInput.addEventListener("keydown", function (ev) { if (ev.key === "Enter") noteInput.blur(); });
      edit.appendChild(noteInput);
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = "via " + (e.categorizationSource || "rules");
      edit.appendChild(meta);
      var editBtn = document.createElement("button");
      editBtn.type = "button"; editBtn.textContent = "Edit";
      editBtn.addEventListener("click", function () {
        var nd = prompt("Description:", e.description);
        if (nd === null) return;
        var na = prompt("Amount ($):", e.amount);
        if (na === null) return;
        var nshare = prompt("My share ($) — leave blank if the full amount is yours:",
          typeof e.myShare === "number" ? e.myShare : "");
        if (nshare === null) return;
        var amtVal = toNumber(na);
        var patch = { description: nd, amount: amtVal };
        if (String(nshare).trim() === "") {
          patch.myShare = null;
        } else {
          var sv = toNumber(nshare);
          if (sv < 0 || sv > amtVal) { alert("Your share must be between $0 and the amount."); return; }
          patch.myShare = sv;
        }
        updateExpense(e.id, patch);
      });
      edit.appendChild(editBtn);
      var delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.textContent = "Delete"; delBtn.className = "danger";
      delBtn.addEventListener("click", function () {
        if (confirm("Delete this expense?")) deleteExpense(e.id);
      });
      edit.appendChild(delBtn);
    }
    sum.addEventListener("click", build);
    row.addEventListener("toggle", function () { if (row.open) build(); });
    if (open) { row.open = true; build(); }
    return row;
}

export function afterExpensesChanged(newState) {
  if (newState) app.state = sanitizeState(newState);
  persist(); buildForm(); renderSummary(); renderDaily(); renderCards(); renderPending(); updateSpentPending();
}

export function createExpense(entry) {
  if (app.mode === "database") {
    apiFetch("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry) })
      .then(function (res) { if (!res.ok) throw new Error("expenses " + res.status); return res.json(); })
      .then(function (data) { afterExpensesChanged(data.state); })
      .catch(function () { setMode("local"); createExpenseLocal(entry); });
  } else {
    createExpenseLocal(entry);
  }
}

export function createExpenseLocal(entry) {
  var src = entry.categorizationSource || "rules";
  var amt = toNumber(entry.amount);
  app.state.dailyExpenses.push({
    id: Date.now(), date: entry.date, description: entry.description,
    amount: amt, category: entry.category || categorizeByRulesJs(entry.description),
    categorizationSource: entry.category ? "manual" : src,
    card: entry.card ? String(entry.card).slice(0, 100) : null,
    myShare: sanitizeMyShare(entry.myShare, amt)
  });
  afterExpensesChanged(null);
}

export function updateExpense(id, patch) {
  if (app.mode === "database" && typeof id === "number") {
    apiFetch("/api/expenses", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, patch: patch }) })
      .then(function (res) { if (!res.ok) throw new Error("expenses " + res.status); return res.json(); })
      .then(function (data) { afterExpensesChanged(data.state); })
      .catch(function () { setMode("local"); updateExpenseLocal(id, patch); });
  } else {
    updateExpenseLocal(id, patch);
  }
}

export function updateExpenseLocal(id, patch) {
  app.state.dailyExpenses.forEach(function (e) {
    if (e.id === id) {
      Object.keys(patch).forEach(function (k) { e[k] = patch[k]; });
      if (patch.category) e.categorizationSource = "manual";
    }
  });
  afterExpensesChanged(null);
}

export function deleteExpense(id) {
  if (app.mode === "database" && typeof id === "number") {
    apiFetch("/api/expenses?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (res) { if (!res.ok) throw new Error("expenses " + res.status); return res.json(); })
      .then(function (data) { afterExpensesChanged(data.state); })
      .catch(function () { setMode("local"); deleteExpenseLocal(id); });
  } else {
    deleteExpenseLocal(id);
  }
}

export function deleteExpenseLocal(id) {
  app.state.dailyExpenses = app.state.dailyExpenses.filter(function (e) { return e.id !== id; });
  /* Local mirror of the server rule: if a month loses its last daily
     expense, its synced actual expense fields return to zero. */
  afterExpensesChanged(null);
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.expenseForm) {
    var catDebounce = null;
    els.expDescription.addEventListener("input", function () {
      if (els.expCategory.value) return; /* user already picked one */
      clearTimeout(catDebounce);
      catDebounce = setTimeout(function () {
        var desc = els.expDescription.value.trim();
        if (!desc) { els.expCatHint.textContent = ""; return; }
        categorizeRemote(desc, toNumber(els.expAmount.value)).then(function (r) {
          els.expCatHint.textContent = "Auto category: " + r.category + " (via " + r.source +
            (r.confidence !== undefined ? ", confidence " + Math.round(r.confidence * 100) + "%" : "") +
            ") — change the Category box to override.";
          els.expCatHint.dataset.autoCategory = r.category;
          els.expCatHint.dataset.autoSource = r.source;
        });
      }, 600);
    });
    els.expenseForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var entry = {
        date: els.expDate.value || todayLocal(),
        description: els.expDescription.value.trim(),
        amount: toNumber(els.expAmount.value),
        category: els.expCategory.value || undefined,
        categorizationSource: els.expCatHint.dataset.autoSource || undefined,
        card: els.expCard && els.expCard.value ? els.expCard.value : undefined
      };
      if (!entry.description) { alert("Add a description first."); return; }
      if (els.expShare && els.expShare.value.trim() !== "") {
        var shareVal = toNumber(els.expShare.value);
        if (shareVal < 0 || shareVal > entry.amount) {
          alert("Your share must be between $0 and the amount (" + fmt(entry.amount) + ").");
          return;
        }
        entry.myShare = shareVal;
      }
      if (!entry.category && els.expCatHint.dataset.autoCategory) {
        entry.category = els.expCatHint.dataset.autoCategory;
        entry.categorizationSource = els.expCatHint.dataset.autoSource || "rules";
        /* It came from the auto-categorizer, not a manual pick: send no
           category so the server categorizes (and labels) it itself in
           database mode; local mode uses the hint values above. */
        if (app.mode === "database") delete entry.category;
      }
      app.dailyPage = 1; /* show the new expense */
      createExpense(entry);
      els.expDescription.value = ""; els.expAmount.value = "";
      els.expCategory.value = ""; if (els.expCard) els.expCard.value = "";
      if (els.expShare) els.expShare.value = "";
      els.expCatHint.textContent = "";
      delete els.expCatHint.dataset.autoCategory;
    });
  }
}
