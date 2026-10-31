/* Chart.js setup and the dashboard charts. */
import { fmt } from "../core/format.js";
import { MONTHS } from "../core/plan.js";
import { expenseShare, isSpending } from "../core/spending.js";
import { fmtDate } from "./cards.js";
import { app, els } from "./context.js";
import { categoryColor } from "./daily.js";
import { getMonth, monthLabel, selectMonth } from "./editor.js";
import { showTransactions } from "./popup.js";

export function isDark() { return document.documentElement.classList.contains("dark"); }

export function chartTextColor() { return isDark() ? "#a1a1aa" : "#52525b"; }

export function chartGridColor() { return isDark() ? "rgba(255,255,255,.06)" : "rgba(10,10,10,.06)"; }

/* Series colours: one hue per meaning, used by every chart. */

export const C = { income: "#10b981", expense: "#f43f5e", plan: "#8b5cf6", balance: "#14b8a6", neutral: "#a1a1aa" };

export function rgba(hex, a) {
  var n = parseInt(hex.slice(1), 16);
  return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}

/* Vertical fill that fades toward the baseline. Scriptable, so it is
   rebuilt when the chart area resizes. */

export function fade(hex, top, bottom) {
  return function (ctx) {
    var area = ctx.chart.chartArea;
    if (!area) return rgba(hex, top);
    var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, rgba(hex, top));
    g.addColorStop(1, rgba(hex, bottom));
    return g;
  };
}

export const compactMoney = typeof Intl !== "undefined"
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 })
  : null;

export function money(v) { return compactMoney ? compactMoney.format(v) : fmt(v); }

/* Depth: every line, bar and arc casts a soft coloured shadow, so the
   marks float above the panel. */

export const depthShadow = {
  id: "depthShadow",
  beforeDatasetDraw: function (chart, args) {
    var ds = chart.data.datasets[args.index];
    var c = ds.shadowColor || (typeof ds.borderColor === "string" ? ds.borderColor : null);
    if (!c) return;
    var ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = c.charAt(0) === "#" ? rgba(c, isDark() ? 0.55 : 0.35) : c;
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 8;
  },
  afterDatasetDraw: function (chart, args) {
    var ds = chart.data.datasets[args.index];
    if (ds.shadowColor || typeof ds.borderColor === "string") chart.ctx.restore();
  }
};

/* Doughnut centre label: the total, with a caption under it. */

export const centerText = {
  id: "centerText",
  afterDraw: function (chart, args, opts) {
    if (!opts || !opts.value) return;
    var meta = chart.getDatasetMeta(0);
    if (!meta.data.length) return;
    var x = meta.data[0].x, y = meta.data[0].y, ctx = chart.ctx;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = isDark() ? "#fafafa" : "#0a0a0a";
    ctx.font = "700 24px Geist, system-ui, sans-serif";
    ctx.fillText(opts.value, x, y - 8);
    ctx.fillStyle = chartTextColor();
    ctx.font = "600 12px Geist, system-ui, sans-serif";
    ctx.fillText(opts.caption || "", x, y + 16);
    ctx.restore();
  }
};

export function isNarrow() { return window.innerWidth < 640; }

export function baseOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 900, easing: "easeOutQuart" },
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 8, right: 4 } },
    plugins: {
      legend: { position: "top", align: isNarrow() ? "start" : "end",
        labels: { color: chartTextColor(), usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: isNarrow() ? 12 : 16,
          font: { family: "Geist, system-ui, sans-serif", size: 12, weight: "600" } } },
      tooltip: {
        backgroundColor: isDark() ? "rgba(31,31,31,.96)" : "rgba(10,10,10,.92)",
        borderColor: isDark() ? "#313131" : "rgba(10,10,10,.92)", borderWidth: 1,
        titleColor: "#fafafa", bodyColor: "#e4e4e7",
        titleFont: { family: "Geist, system-ui, sans-serif", size: 12, weight: "600" },
        bodyFont: { family: "Geist, system-ui, sans-serif", size: 14, weight: "600" },
        padding: 12, cornerRadius: 12, boxPadding: 4, usePointStyle: true, caretSize: 6,
        callbacks: { label: function (c) {
          return " " + c.dataset.label + "  " + (c.parsed.y === null || c.parsed.y === undefined ? "—" : fmt(c.parsed.y));
        } }
      }
    },
    scales: {
      x: { border: { display: false }, grid: { display: false },
        ticks: { color: chartTextColor(), maxRotation: 0, autoSkipPadding: 16, font: { family: "Geist, system-ui, sans-serif", size: 12 } } },
      y: { border: { display: false }, grid: { color: chartGridColor(), drawTicks: false },
        ticks: { color: chartTextColor(), padding: 8, maxTicksLimit: isNarrow() ? 5 : 6, callback: money,
          font: { family: "Geist, system-ui, sans-serif", size: 12 } } }
    }
  };
}

export function showFallback(canvasEl, fallbackEl, text) {
  if (canvasEl) canvasEl.style.display = "none";
  if (fallbackEl) { fallbackEl.hidden = false; fallbackEl.textContent = text; }
}

export function hideFallback(canvasEl, fallbackEl) {
  if (canvasEl) canvasEl.style.display = "";
  if (fallbackEl) fallbackEl.hidden = true;
}

export const DOUGHNUT_COLORS = ["#14b8a6", "#8b5cf6", "#f59e0b", "#f43f5e", "#3b82f6", "#10b981", "#ec4899", "#06b6d4", "#a855f7", "#f97316", "#84cc16", "#71717a", "#0ea5e9"];

export function renderCharts(cmp) {
  var labels = ["Start"].concat(MONTHS.map(function (m) { return m.label; }));
  var shortLabels = MONTHS.map(function (m) { return m.label; });
  if (typeof window === "undefined" || !window.Chart) {
    /* Library failed to load: plain-text fallbacks instead of charts. */
    if (app.compareWithPlan) {
      showFallback(els.chart, els.chartFallback,
        "Chart library unavailable. Predicted cumulative balance:\n" +
        cmp.rows.map(function (r) { return monthLabel(r.monthKey) + ": " + fmt(r.predictedCumulative); }).join("\n"));
      showFallback(els.barsChart, els.barsFallback,
        cmp.rows.map(function (r) {
          return monthLabel(r.monthKey) + " — income " + fmt(r.income) + ", expenses " + fmt(r.expenses);
        }).join("\n"));
    } else {
      showFallback(els.chart, els.chartFallback,
        "Chart library unavailable. Actual cumulative balance:\n" +
        cmp.rows.map(function (r) {
          return monthLabel(r.monthKey) + ": " +
            (r.actualCumulative !== null && r.actualCumulative !== undefined ? fmt(r.actualCumulative) : "not entered");
        }).join("\n"));
      showFallback(els.barsChart, els.barsFallback,
        cmp.rows.map(function (r) {
          return r.entered
            ? monthLabel(r.monthKey) + " — actual income " + fmt(r.actualIncome) + ", actual expenses " + fmt(r.actualExpenses)
            : monthLabel(r.monthKey) + " — no actuals entered";
        }).join("\n"));
    }
    showFallback(els.doughnutChart, els.doughnutFallback, "Chart library unavailable.");
    showFallback(els.dailyChart, els.dailyFallback, "Chart library unavailable.");
    return;
  }
  hideFallback(els.chart, els.chartFallback);
  hideFallback(els.barsChart, els.barsFallback);
  hideFallback(els.doughnutChart, els.doughnutFallback);
  hideFallback(els.dailyChart, els.dailyFallback);
  var start = app.state.startingBalance || 0;

  /* 1) Cumulative balance: smooth area for the actual balance, a dashed
     plan line on top in Compare mode. */
  if (app.chartLine) app.chartLine.destroy();
  var actualSeries = [start].concat(cmp.rows.map(function (r) { return r.actualCumulative; }));
  var lineDatasets = [{ label: "Actual balance", data: actualSeries,
    borderColor: C.balance, backgroundColor: fade(C.balance, isDark() ? 0.35 : 0.28, 0),
    fill: "origin", borderWidth: 3, tension: 0.4, cubicInterpolationMode: "monotone", spanGaps: false,
    pointRadius: 0, pointHoverRadius: 6, pointHoverBorderWidth: 3, pointHoverBorderColor: "#fff", pointHoverBackgroundColor: C.balance }];
  if (app.compareWithPlan) {
    lineDatasets.push({ label: "Predicted balance",
      data: [start].concat(cmp.rows.map(function (r) { return r.predictedCumulative; })),
      borderColor: C.plan, backgroundColor: C.plan, borderDash: [6, 6], borderWidth: 2, tension: 0.4,
      cubicInterpolationMode: "monotone", fill: false, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2 });
  }
  var lastActual = null;
  actualSeries.forEach(function (v) { if (v !== null && v !== undefined) lastActual = v; });
  if (els.lineKpi) els.lineKpi.textContent = lastActual === null ? "" : "Now " + fmt(lastActual);
  app.chartLine = new window.Chart(els.chart, {
    type: "line",
    data: { labels: labels, datasets: lineDatasets },
    options: baseOptions(),
    plugins: [depthShadow]
  });

  /* 2) Rounded gradient bars with the monthly net as a line on top. */
  if (app.chartBars) app.chartBars.destroy();
  var barStyle = { borderRadius: 8, borderSkipped: false, maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.9 };
  function bars(label, color, data) {
    return Object.assign({ label: label, data: data, backgroundColor: fade(color, 1, 0.45),
      hoverBackgroundColor: color, shadowColor: rgba(color, isDark() ? 0.45 : 0.3), order: 2 }, barStyle);
  }
  var netData, barDatasets;
  if (app.compareWithPlan) {
    barDatasets = [
      bars("Planned income", C.income, cmp.rows.map(function (r) { return r.income; })),
      bars("Planned expenses", C.neutral, cmp.rows.map(function (r) { return r.expenses; })),
      bars("Actual expenses", C.expense, cmp.rows.map(function (r) { return r.entered ? r.actualExpenses : null; }))
    ];
    netData = cmp.rows.map(function (r) { return r.predictedNet; });
  } else {
    barDatasets = [
      bars("Actual income", C.income, cmp.rows.map(function (r) { return r.entered ? r.actualIncome : null; })),
      bars("Actual expenses", C.expense, cmp.rows.map(function (r) { return r.entered ? r.actualExpenses : null; }))
    ];
    netData = cmp.rows.map(function (r) { return r.entered ? r.actualNet : null; });
  }
  barDatasets.push({ type: "line", label: app.compareWithPlan ? "Predicted net" : "Net", data: netData, order: 1,
    borderColor: isDark() ? "#fafafa" : "#0a0a0a", backgroundColor: isDark() ? "#fafafa" : "#0a0a0a",
    shadowColor: "rgba(0,0,0,.25)", borderWidth: 2, tension: 0.4, cubicInterpolationMode: "monotone",
    pointRadius: 3, pointHoverRadius: 6, pointBorderColor: isDark() ? "#181818" : "#fff", pointBorderWidth: 2, spanGaps: false });
  var barOpts = baseOptions();
  var selIdx = MONTHS.map(function (m) { return m.key; }).indexOf(app.selectedKey);
  /* Tap a month's bars to show it in the category and daily charts; the
     month in focus gets a bold label. */
  barOpts.onClick = function (evt, elements) { if (elements.length) selectMonth(MONTHS[elements[0].index].key); };
  barOpts.onHover = function (evt, elements) { evt.native.target.style.cursor = elements.length ? "pointer" : ""; };
  barOpts.scales.x.ticks.font = function (c) { return { family: "Geist, system-ui, sans-serif", size: 12, weight: c.index === selIdx ? "700" : "400" }; };
  barOpts.scales.x.ticks.color = function (c) { return c.index === selIdx ? (isDark() ? "#fafafa" : "#0a0a0a") : chartTextColor(); };
  app.chartBars = new window.Chart(els.barsChart, {
    type: "bar",
    data: { labels: shortLabels, datasets: barDatasets },
    options: barOpts,
    plugins: [depthShadow]
  });

  /* 3) Category doughnut: thin rounded ring, separated arcs that pop
     out on hover, total in the centre. */
  if (els.doughnutMonthLabel) els.doughnutMonthLabel.textContent = monthLabel(app.selectedKey);
  var modeSel = els.doughnutMode ? els.doughnutMode.value : "actual";
  var catTotals = {};
  if (modeSel === "actual") {
    (app.state.dailyExpenses || []).forEach(function (e) {
      if (isSpending(e) && String(e.date).slice(0, 7) === app.selectedKey) {
        /* Actuals are share-based, like the rollup: a shared expense
           counts only his portion here too. */
        catTotals[e.category] = Math.round(((catTotals[e.category] || 0) + expenseShare(e)) * 100) / 100;
      }
    });
  } else {
    var pm = getMonth(app.selectedKey);
    var planMap = { "Groceries": pm.groceries, "Eating Out": pm.eatingOut, "Rent": pm.rent,
      "Utilities": pm.utilities, "Phone & Internet": pm.phoneInternet, "Fuel/Transport": pm.gasTransport,
      "Insurance": pm.insurance, "Subscriptions": pm.subscriptions, "Shopping/Personal": pm.shopping,
      "Loan/Debt Payment": (pm.credilaEmi || 0) + (pm.creditCardPayment || 0) + (pm.otherLoan || 0),
      "One-off": pm.oneOffs, "Misc/Other": pm.otherExpenses };
    Object.keys(planMap).forEach(function (k) { if (planMap[k]) catTotals[k] = planMap[k]; });
  }
  var catLabels = Object.keys(catTotals).filter(function (k) { return catTotals[k] > 0; })
    .sort(function (a, b) { return catTotals[b] - catTotals[a]; });
  if (app.chartDough) app.chartDough.destroy();
  if (!catLabels.length) {
    showFallback(els.doughnutChart, els.doughnutFallback,
      "No " + modeSel + " expenses for " + monthLabel(app.selectedKey) + " yet. Add some on the " +
      (modeSel === "actual" ? "Daily expenses" : "Month editor") + " tab and they appear here.");
    app.chartDough = null;
  } else {
    var catSum = catLabels.reduce(function (s, k) { return s + catTotals[k]; }, 0);
    var doughOpts = baseOptions();
    delete doughOpts.scales;
    doughOpts.interaction = { mode: "nearest", intersect: true };
    doughOpts.cutout = "74%";
    doughOpts.layout = { padding: 12 };
    doughOpts.plugins.legend.position = isNarrow() ? "bottom" : "right";
    doughOpts.plugins.legend.align = "center";
    doughOpts.plugins.centerText = { value: money(catSum), caption: modeSel === "actual" ? "SPENT" : "PLANNED" };
    doughOpts.plugins.tooltip.callbacks = { label: function (c) {
      return " " + c.label + "  " + fmt(c.parsed) + " · " + Math.round((c.parsed / catSum) * 100) + "%";
    } };
    if (modeSel === "actual") {
      /* Tap a slice or a legend item to see the transactions behind it. */
      var showCat = function (cat) {
        showTransactions(cat + " · " + monthLabel(app.selectedKey), (app.state.dailyExpenses || []).filter(function (e) {
          return isSpending(e) && e.category === cat && String(e.date).slice(0, 7) === app.selectedKey;
        }));
      };
      doughOpts.onClick = function (evt, elements) { if (elements.length) showCat(catLabels[elements[0].index]); };
      doughOpts.onHover = function (evt, elements) { evt.native.target.style.cursor = elements.length ? "pointer" : ""; };
      doughOpts.plugins.legend.onClick = function (evt, item) { showCat(item.text); };
      doughOpts.plugins.legend.onHover = function (evt) { evt.native.target.style.cursor = "pointer"; };
      doughOpts.plugins.legend.onLeave = function (evt) { evt.native.target.style.cursor = ""; };
    }
    app.chartDough = new window.Chart(els.doughnutChart, {
      type: "doughnut",
      data: { labels: catLabels, datasets: [{
        data: catLabels.map(function (k) { return catTotals[k]; }),
        backgroundColor: catLabels.map(categoryColor), /* same colour as the Daily badges */
        borderWidth: 0, borderRadius: 8, spacing: 4, hoverOffset: 16,
        shadowColor: isDark() ? "rgba(0,0,0,.6)" : "rgba(10,10,10,.18)"
      }]},
      options: doughOpts,
      plugins: [depthShadow, centerText]
    });
  }

  /* 4) Daily spending in the selected month: a bar per day, with the
     running total as an area on a second axis. */
  if (els.dailyMonthLabel) els.dailyMonthLabel.textContent = monthLabel(app.selectedKey);
  if (app.chartDaily) app.chartDaily.destroy();
  var parts = app.selectedKey.split("-");
  var daysIn = new Date(Number(parts[0]), Number(parts[1]), 0).getDate();
  var perDay = [];
  for (var d = 0; d < daysIn; d++) perDay.push(0);
  var anyDaily = false;
  (app.state.dailyExpenses || []).forEach(function (e) {
    if (!isSpending(e) || String(e.date).slice(0, 7) !== app.selectedKey) return;
    var day = Number(String(e.date).slice(8, 10));
    if (day >= 1 && day <= daysIn) { perDay[day - 1] = Math.round((perDay[day - 1] + expenseShare(e)) * 100) / 100; anyDaily = true; }
  });
  if (!anyDaily) {
    showFallback(els.dailyChart, els.dailyFallback,
      "No daily expenses logged for " + monthLabel(app.selectedKey) + " yet. Each one you add on the Daily expenses tab shows up here as a bar.");
    if (els.dailyKpi) els.dailyKpi.textContent = "";
    app.chartDaily = null;
  } else {
    var run = 0, now = new Date();
    var thisMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    var running = perDay.map(function (v, i) {
      run = Math.round((run + v) * 100) / 100;
      return app.selectedKey === thisMonth && i + 1 > now.getDate() ? null : run; /* no line into the future */
    });
    if (els.dailyKpi) els.dailyKpi.textContent = fmt(run) + " total";
    var dailyOpts = baseOptions();
    dailyOpts.scales.x.ticks.maxTicksLimit = 8;
    dailyOpts.scales.x.ticks.maxRotation = 0;
    /* Phones: drop the right-hand axis; the running total is in the
       header KPI and the tooltip. */
    dailyOpts.scales.y1 = { display: !isNarrow(), position: "right", border: { display: false }, grid: { display: false },
      ticks: { color: chartTextColor(), maxTicksLimit: 6, callback: money, font: { family: "Geist, system-ui, sans-serif", size: 12 } } };
    dailyOpts.onClick = function (evt, elements) {
      if (!elements.length) return;
      var dayKey = app.selectedKey + "-" + String(elements[0].index + 1).padStart(2, "0");
      showTransactions(fmtDate(dayKey), (app.state.dailyExpenses || []).filter(function (e) {
        return isSpending(e) && e.date === dayKey;
      }));
    };
    dailyOpts.onHover = function (evt, elements) { evt.native.target.style.cursor = elements.length ? "pointer" : ""; };
    app.chartDaily = new window.Chart(els.dailyChart, {
      type: "bar",
      data: { labels: perDay.map(function (v, i) { return String(i + 1); }), datasets: [
        Object.assign({ label: "Spent that day", data: perDay, backgroundColor: fade(C.expense, 1, 0.5),
          hoverBackgroundColor: C.expense, shadowColor: rgba(C.expense, isDark() ? 0.45 : 0.3), order: 2 },
          barStyle, { maxBarThickness: 12, borderRadius: 6 }),
        { type: "line", label: "Month to date", data: running, yAxisID: "y1", order: 1,
          borderColor: C.plan, backgroundColor: fade(C.plan, isDark() ? 0.28 : 0.18, 0), fill: "origin",
          borderWidth: 2.5, tension: 0.4, cubicInterpolationMode: "monotone", stepped: false,
          pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2 }
      ]},
      options: dailyOpts,
      plugins: [depthShadow]
    });
  }
}
