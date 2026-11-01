/* Month editor: the planned/actual form, month totals, copy/reset/import/export, month selection. */
import { formatDateLabel } from "../core/dates.js";
import { fmt } from "../core/format.js";
import { EXPENSE_FIELD_KEYS, MONTHS, NUMBER_FIELDS, TEXT_FIELDS, blankState, monthExpenses, monthIncome, sanitizeState, toNumber } from "../core/plan.js";
import { dailyRollupByMonth } from "../core/spending.js";
import { computeComparison } from "../core/summary.js";
import { app, els } from "./context.js";
import { render, renderSummary } from "./dashboard.js";
import { persist } from "./storage.js";

export function getMonth(key) {
  var found = null;
  app.state.months.forEach(function (m) { if (m.monthKey === key) found = m; });
  return found;
}

export function getActual(key) {
  var found = null;
  app.state.actuals.forEach(function (a) { if (a.monthKey === key) found = a; });
  return found;
}

export function monthLabel(key) {
  var found = "";
  MONTHS.forEach(function (m) { if (m.key === key) found = m.label; });
  return found;
}

export function buildForm() {
  els.monthSelect.innerHTML = "";
  MONTHS.forEach(function (m) {
    var opt = document.createElement("option");
    opt.value = m.key; opt.textContent = m.label;
    els.monthSelect.appendChild(opt);
  });
  els.monthSelect.value = app.selectedKey;

  if (els.viewPlannedBtn && els.viewActualBtn) {
    els.viewPlannedBtn.className = app.editMode === "planned" ? "toggle active" : "toggle";
    els.viewActualBtn.className = app.editMode === "actual" ? "toggle active" : "toggle";
  }

  var isActual = app.editMode === "actual";
  var month = isActual ? getActual(app.selectedKey) : getMonth(app.selectedKey);
  els.monthForm.innerHTML = "";

  if (isActual) {
    var enteredWrap = document.createElement("div");
    enteredWrap.className = "field wide";
    var enteredLabel = document.createElement("label");
    enteredLabel.htmlFor = "f-entered";
    var enteredBox = document.createElement("input");
    enteredBox.type = "checkbox"; enteredBox.id = "f-entered";
    /* A month with daily-log entries always counts as entered. */
    var hasDaily = (dailyRollupByMonth(app.state)[app.selectedKey] || {}).count > 0;
    enteredBox.checked = !!month.entered || hasDaily;
    enteredBox.disabled = hasDaily;
    enteredBox.style.marginRight = "8px";
    enteredLabel.appendChild(enteredBox);
    enteredLabel.appendChild(document.createTextNode(
      "Actuals entered for this month (months without actuals stay blank in the comparison, they are not treated as zero)"));
    enteredBox.addEventListener("change", function () {
      getActual(app.selectedKey).entered = enteredBox.checked;
      persist(); renderSummary();
    });
    enteredWrap.appendChild(enteredLabel);
    els.monthForm.appendChild(enteredWrap);
  }

  var fields = isActual ? NUMBER_FIELDS : NUMBER_FIELDS.concat(TEXT_FIELDS);
  var currentGroup = null;
  fields.forEach(function (f) {
    if (f.group && f.group !== currentGroup) {
      currentGroup = f.group;
      var h = document.createElement("h3");
      h.textContent = (isActual ? "Actual — " : "") + currentGroup;
      h.className = "wide group-heading";
      els.monthForm.appendChild(h);
    }
    var wrap = document.createElement("div");
    wrap.className = "field" + (f.key === "oneOffNote" || f.key === "note" ? " wide" : "");
    var label = document.createElement("label");
    label.htmlFor = "f-" + f.key;
    label.textContent = isActual ? f.label.replace(" ($)", " — actual ($)") : f.label;
    wrap.appendChild(label);
    var input;
    if (f.key === "note" || f.key === "oneOffNote") {
      input = document.createElement("textarea");
      input.rows = f.key === "note" ? 2 : 1;
      input.maxLength = 500;
      input.value = month[f.key] || "";
    } else {
      input = document.createElement("input");
      input.type = "number"; input.inputMode = "decimal"; input.step = "0.01"; input.placeholder = "0";
      input.value = month[f.key] ? month[f.key] : "";
    }
    input.id = "f-" + f.key;
    if (isActual && EXPENSE_FIELD_KEYS.indexOf(f.key) !== -1 &&
        (dailyRollupByMonth(app.state)[app.selectedKey] || {}).count > 0) {
      input.readOnly = true;
      input.title = "From the daily expense log rollup — edit the daily entries to change this.";
      label.textContent += " (from daily log)";
      /* Show the rolled-up value, not the stored manual one. */
      var rollTotals = dailyRollupByMonth(app.state)[app.selectedKey].totals;
      input.value = rollTotals[f.key] ? rollTotals[f.key] : "";
    }
    input.addEventListener("input", function () {
      var m = isActual ? getActual(app.selectedKey) : getMonth(app.selectedKey);
      if (input.type === "number") {
        m[f.key] = toNumber(input.value);
        if (isActual && m[f.key] !== 0) m.entered = true;
      } else {
        m[f.key] = input.value;
      }
      persist(); renderSummary();
    });
    wrap.appendChild(input);
    els.monthForm.appendChild(wrap);
  });
  renderMonthTotals();
}

export function renderMonthTotals() {
  var planned = getMonth(app.selectedKey);
  var pNet = monthIncome(planned) - monthExpenses(planned);
  var pairs;
  if (app.editMode === "actual") {
    /* Same numbers as the dashboard: a month with daily-log entries uses
       the log for its expenses even if its stored actuals were never
       synced (e.g. a month added to the plan after its expenses). */
    var a = getActual(app.selectedKey);
    var row = computeComparison(app.state).rows.filter(function (r) { return r.monthKey === app.selectedKey; })[0];
    var aInc = row && row.entered ? row.actualIncome : monthIncome(a);
    var aExp = row && row.entered ? row.actualExpenses : monthExpenses(a);
    var aNet = aInc - aExp;
    pairs = [["Actual income", aInc], ["Actual expenses", aExp],
      ["Actual net", aNet], ["Predicted net", pNet],
      ["Variance", row && row.entered ? aNet - pNet : null]];
  } else {
    pairs = [["Income", monthIncome(planned)], ["Expenses", monthExpenses(planned)], ["Net", pNet]];
  }
  els.monthTotals.innerHTML = "";
  pairs.forEach(function (pair) {
    var s = document.createElement("span");
    s.textContent = pair[0] + ": " + (pair[1] === null ? "—" : fmt(pair[1]));
    if ((pair[0] === "Net" || pair[0] === "Actual net" || pair[0] === "Variance") && pair[1] !== null) {
      s.className = pair[1] < 0 ? "neg" : "pos";
    }
    els.monthTotals.appendChild(s);
  });
}

export function copyFields(from, to, skipOneOffs) {
  NUMBER_FIELDS.concat(TEXT_FIELDS).forEach(function (f) {
    if (skipOneOffs && (f.key === "oneOffs" || f.key === "oneOffNote")) return;
    to[f.key] = from[f.key];
  });
}

/* One place to change the month in focus: the Month editor's select,
   the dashboard switcher, a bar in the monthly chart and a row in the
   compare table all route here, so every view stays in sync. */

export function selectMonth(key) {
  if (!MONTHS.some(function (m) { return m.key === key; })) return;
  app.selectedKey = key; buildForm(); renderSummary();
}

export const dashMonth = document.getElementById("dashMonth");

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  els.startingBalance.addEventListener("input", function () {
    app.state.startingBalance = toNumber(els.startingBalance.value);
    persist(); renderSummary();
  });
  if (els.baselineDate) {
    els.baselineDate.addEventListener("change", function () {
      if (/^\d{4}-\d{2}-\d{2}$/.test(els.baselineDate.value)) {
        app.state.baselineDate = els.baselineDate.value;
        if (els.headerBaseline) els.headerBaseline.textContent = formatDateLabel(app.state.baselineDate).replace(/^\w+, /, "");
        persist();
      }
    });
  }
  if (els.compareToggle) {
    els.compareToggle.checked = app.compareWithPlan;
    els.compareToggle.addEventListener("change", function () {
      app.compareWithPlan = els.compareToggle.checked;
      try { localStorage.setItem("arthatula-compare", app.compareWithPlan ? "1" : "0"); } catch (e) {}
      renderSummary(); /* instant re-render; no stored budget data changes */
    });
  }
  if (els.viewPlannedBtn && els.viewActualBtn) {
    els.viewPlannedBtn.addEventListener("click", function () {
      app.editMode = "planned"; buildForm(); renderSummary();
    });
    els.viewActualBtn.addEventListener("click", function () {
      app.editMode = "actual"; buildForm(); renderSummary();
    });
  }
  els.monthSelect.addEventListener("change", function () { selectMonth(els.monthSelect.value); });
  if (dashMonth) {
    MONTHS.forEach(function (m) {
      var o = document.createElement("option"); o.value = m.key; o.textContent = m.label; dashMonth.appendChild(o);
    });
    dashMonth.addEventListener("change", function () { selectMonth(dashMonth.value); });
    [["dashMonthPrev", -1], ["dashMonthNext", 1]].forEach(function (pair) {
      var b = document.getElementById(pair[0]);
      if (b) b.addEventListener("click", function () {
        var i = MONTHS.map(function (m) { return m.key; }).indexOf(app.selectedKey) + pair[1];
        if (i >= 0 && i < MONTHS.length) selectMonth(MONTHS[i].key);
      });
    });
  }
  els.copyAllBtn.addEventListener("click", function () {
    if (app.editMode === "actual") { alert("Copy works on the Planned view — switch to Planned first."); return; }
    var src = getMonth(app.selectedKey);
    app.state.months.forEach(function (m) { if (m.monthKey !== app.selectedKey) copyFields(src, m, true); });
    persist(); renderSummary();
    alert("Copied " + monthLabel(app.selectedKey) + " to all months (one-offs were not copied).");
  });
  els.copyPrevBtn.addEventListener("click", function () {
    if (app.editMode === "actual") { alert("Copy works on the Planned view — switch to Planned first."); return; }
    var idx = MONTHS.findIndex(function (m) { return m.key === app.selectedKey; });
    if (idx <= 0) { alert("There is no previous month to copy from."); return; }
    copyFields(getMonth(MONTHS[idx - 1].key), getMonth(app.selectedKey), true);
    persist(); buildForm(); renderSummary();
  });
  els.resetBtn.addEventListener("click", function () {
    if (!confirm("Reset everything to blank? This clears the starting balance, all 12 planned months, all actuals, and all credit cards.")) return;
    app.state = blankState();
    persist(); render();
  });
  els.exportBtn.addEventListener("click", function () {
    var payload = { version: 3, exportedAt: new Date().toISOString(),
      baselineDate: app.state.baselineDate, baselineNote: app.state.baselineNote,
      startingBalance: app.state.startingBalance, months: app.state.months, actuals: app.state.actuals,
      dailyExpenses: app.state.dailyExpenses, cards: app.state.cards };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "budget-data.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  els.importFile.addEventListener("change", function () {
    var file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { alert("That file is not valid JSON."); return; }
      if (!parsed || !Array.isArray(parsed.months)) { alert("That file does not look like a budget export (no months array)."); return; }
      app.state = sanitizeState(parsed);
      persist(); render();
      alert(app.mode === "database" ? "Imported and saved to the database." : "Imported and saved locally in this browser.");
    }).catch(function () { alert("Could not read that file."); });
    els.importFile.value = "";
  });
}
