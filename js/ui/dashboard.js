/* Dashboard summary tiles and the top-level render(). */
import { formatDateLabel } from "../core/dates.js";
import { fmt } from "../core/format.js";
import { categoryPacing } from "../core/pacing.js";
import { MONTHS } from "../core/plan.js";
import { planFreeAfterBills, spentInMonth } from "../core/spending.js";
import { computeDashboard } from "../core/summary.js";
import { renderSecurity } from "./auth.js";
import { renderCards } from "./cards.js";
import { renderCharts } from "./charts.js";
import { app, els } from "./context.js";
import { renderDaily, todayLocal } from "./daily.js";
import { renderMerchantRules } from "./merchant.js";
import { buildForm, getMonth, monthLabel, renderMonthTotals, selectMonth } from "./editor.js";
import { updateSpentPending } from "./pending.js";
import { showTransactions } from "./popup.js";
import { renderGeminiStatus } from "./settings.js";

export function setStatLabel(valueEl, text) {
  if (!valueEl || !valueEl.parentElement) return;
  var label = valueEl.parentElement.querySelector(".stat-label");
  if (label) label.textContent = text;
}

export function setStatHidden(valueEl, hidden) {
  if (valueEl && valueEl.parentElement) valueEl.parentElement.hidden = hidden;
}

export function renderSummary() {
  var dash = computeDashboard(app.state, app.compareWithPlan);
  var cmp = dash.cmp;
  var t = dash.totals;
  var noActuals = !app.compareWithPlan && dash.enteredCount === 0;
  if (els.compareToggle) els.compareToggle.checked = app.compareWithPlan;
  if (app.compareWithPlan) {
    setStatLabel(els.statEnding, "Ending balance · " + MONTHS[MONTHS.length - 1].label);
    setStatLabel(els.statNet, "Net saved (" + MONTHS.length + " months)");
    setStatLabel(els.statIncome, "Total income");
    setStatLabel(els.statExpenses, "Total expenses");
    setStatLabel(els.statAverage, "Average net / month");
    setStatLabel(els.statRate, "Savings rate");
    els.statIncome.textContent = fmt(t.income);
    els.statExpenses.textContent = fmt(t.expenses);
    els.statNet.textContent = fmt(t.net);
    els.statEnding.textContent = fmt(t.ending);
    els.statAverage.textContent = fmt(t.average);
    els.statRate.textContent = t.rate.toFixed(1) + "%";
  } else {
    setStatLabel(els.statEnding, "Actual balance · latest entered month");
    setStatLabel(els.statNet, "Actual net saved (entered months)");
    setStatLabel(els.statIncome, "Actual income (entered months)");
    setStatLabel(els.statExpenses, "Actual expenses (entered months)");
    setStatLabel(els.statAverage, "Average actual net / entered month");
    setStatLabel(els.statRate, "Actual savings rate");
    els.statIncome.textContent = noActuals ? "—" : fmt(t.income);
    els.statExpenses.textContent = noActuals ? "—" : fmt(t.expenses);
    els.statNet.textContent = noActuals ? "—" : fmt(t.net);
    els.statEnding.textContent = (noActuals || t.ending === null) ? "—" : fmt(t.ending);
    els.statAverage.textContent = noActuals ? "—" : fmt(t.average);
    els.statRate.textContent = noActuals ? "—" : t.rate.toFixed(1) + "%";
  }
  els.statNet.className = "stat-value " + (t.net < 0 ? "neg" : "pos");
  /* The actual-net and variance cards are Compare-mode concepts. */
  setStatHidden(els.statActualNet, !app.compareWithPlan);
  setStatHidden(els.statVariance, !app.compareWithPlan);
  if (els.statActualNet) {
    els.statActualNet.textContent = cmp.enteredCount ? fmt(cmp.actualNetEntered) : "—";
  }
  if (els.statVariance) {
    els.statVariance.textContent = cmp.enteredCount ? fmt(cmp.varianceEntered) : "—";
    els.statVariance.className = "stat-value " + (cmp.varianceEntered < 0 ? "neg" : "pos");
  }
  /* Selected-month figures, one per view (never added together):
     what the PLAN leaves free after that month's bills & loans, and
     what was SPENT in it by charge date from the daily log. */
  if (els.statFreeMonth) {
    var freeMonth = planFreeAfterBills(getMonth(app.selectedKey));
    els.statFreeMonth.textContent = fmt(freeMonth);
    els.statFreeMonth.className = "ms-stat-value " + (freeMonth < 0 ? "neg" : "pos");
  }
  if (els.statSpentMonth) {
    els.statSpentMonth.textContent = fmt(spentInMonth(app.state, app.selectedKey));
  }
  updateSpentPending();
  renderPacing();
  if (els.actualEmptyNote) {
    els.actualEmptyNote.hidden = !noActuals;
    if (noActuals) {
      els.actualEmptyNote.textContent =
        "No actuals entered yet — log daily expenses or fill a month's actuals to see your real income, expenses and savings here. Turn on “Compare with plan” to see the projection.";
    }
  }
  if (els.chartLineTitle) {
    els.chartLineTitle.textContent = app.compareWithPlan
      ? "Cumulative balance — predicted vs actual" : "Cumulative balance — actual";
  }
  if (els.chartBarsTitle) {
    els.chartBarsTitle.textContent = app.compareWithPlan
      ? "Monthly income vs expenses (planned) & actual expenses" : "Monthly income vs expenses — actual";
  }
  if (els.compareTableWrap) els.compareTableWrap.hidden = !app.compareWithPlan;
  var dm = document.getElementById("dashMonth");
  if (dm) {
    dm.value = app.selectedKey;
    var idx = MONTHS.map(function (m) { return m.key; }).indexOf(app.selectedKey);
    document.getElementById("dashMonthPrev").disabled = idx <= 0;
    document.getElementById("dashMonthNext").disabled = idx >= MONTHS.length - 1;
  }
  renderCharts(cmp);
  els.monthsTableBody.innerHTML = "";
  cmp.rows.forEach(function (r) {
    var tr = document.createElement("tr");
    if (r.monthKey === app.selectedKey) tr.className = "selected";
    var cells = [
      monthLabel(r.monthKey), fmt(r.income), fmt(r.expenses),
      fmt(r.predictedNet),
      r.entered ? fmt(r.actualNet) : "—",
      r.entered ? fmt(r.variance) : "—",
      fmt(r.predictedCumulative),
      (r.actualCumulative !== null && r.actualCumulative !== undefined) ? fmt(r.actualCumulative) : "—"
    ];
    cells.forEach(function (txt, i) {
      var td = document.createElement("td");
      td.textContent = txt;
      if (i === 3 || i === 4) td.className = (i === 3 ? r.predictedNet : r.actualNet) < 0 ? "neg" : "pos";
      if (i === 5 && r.entered) td.className = r.variance < 0 ? "neg" : "pos";
      tr.appendChild(td);
    });
    tr.addEventListener("click", function () { selectMonth(r.monthKey); });
    els.monthsTableBody.appendChild(tr);
  });
  renderMonthTotals();
}

export function render() {
  els.startingBalance.value = app.state.startingBalance ? app.state.startingBalance : "";
  if (els.baselineDate) els.baselineDate.value = app.state.baselineDate || "2026-10-26";
  if (els.baselineDateDisplay) els.baselineDateDisplay.textContent = formatDateLabel(app.state.baselineDate || "2026-10-26");
  if (els.headerBaseline) els.headerBaseline.textContent = formatDateLabel(app.state.baselineDate).replace(/^\w+, /, "");
  buildForm();
  renderSummary();
  renderDaily();
  renderCards();
  renderGeminiStatus();
  renderMerchantRules();
  renderSecurity();
}

/* Pace for the selected month (js/core/pacing.js). */
function renderPacing() {
  var box = document.getElementById("pacePanel");
  if (!box) return;
  var pace = categoryPacing(app.state, app.selectedKey, todayLocal());
  box.hidden = !pace || !pace.rows.length;
  if (box.hidden) return;
  var current = app.selectedKey === todayLocal().slice(0, 7);
  document.getElementById("paceTitle").textContent = "Pace · " + monthLabel(app.selectedKey) +
    (current ? " · " + pace.daysLeft + (pace.daysLeft === 1 ? " day left" : " days left") : "");
  var list = document.getElementById("paceList");
  list.innerHTML = "";
  pace.rows.forEach(function (r) {
    var li = document.createElement("li");
    li.className = "pace-row " + r.status;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pace-btn";
    btn.setAttribute("aria-label", r.label + ": show the " + r.items.length + " expenses counted");
    btn.addEventListener("click", function () { showTransactions(r.label + " · " + monthLabel(app.selectedKey), r.items); });
    var head = document.createElement("span");
    head.className = "pace-head";
    var name = document.createElement("span");
    name.textContent = r.label;
    var nums = document.createElement("span");
    nums.className = "pace-nums";
    nums.textContent = fmt(r.spent) + " of " + fmt(r.planned);
    head.appendChild(name); head.appendChild(nums);
    var bar = document.createElement("span");
    bar.className = "pace-bar";
    var fill = document.createElement("span");
    fill.className = "pace-fill";
    fill.style.width = Math.min(100, r.usedPct === null ? 100 : r.usedPct) + "%";
    bar.appendChild(fill);
    if (current) {
      var mark = document.createElement("span");
      mark.className = "pace-mark";
      mark.style.left = r.timePct + "%";
      mark.title = "Where an even pace would be today";
      bar.appendChild(mark);
    }
    var sub = document.createElement("span");
    sub.className = "pace-sub";
    sub.textContent = r.status === "over" ? (r.planned > 0 ? fmt(-r.left) + " over the plan" : "Not in the plan this month")
      : !current ? fmt(r.left) + " left over"
      : fmt(r.left) + " left · about " + fmt(r.perDay) + " a day" + (r.status === "ahead" ? " · spending faster than planned" : "");
    btn.appendChild(head); btn.appendChild(bar); btn.appendChild(sub);
    li.appendChild(btn);
    list.appendChild(li);
  });
}
