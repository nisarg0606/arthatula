/* Cash flow screen: income vs spending by month over a range, spending
   by category for the range, and the rolling 12-month forecast. */
import { v2, api, h, clear, money, monthLabel, thisMonth, loadBasics, section, button, errorState, loading, drawChart, chartColors } from "./kit.js";
import { addMonths } from "../../core/v2/money.js";

let root = null;
const range = { from: null, to: null };
const PRESETS = [
  { label: "Last 6 months", from: function () { return addMonths(thisMonth(), -5); }, to: thisMonth },
  { label: "Last 12 months", from: function () { return addMonths(thisMonth(), -11); }, to: thisMonth },
  { label: "This year", from: function () { return thisMonth().slice(0, 4) + "-01"; }, to: thisMonth }
];

function drawFlow(cf, box) {
  clear(box);
  const c = chartColors();
  const canvas = h("canvas", { attrs: { role: "img", "aria-label": "Income and spending by month" } });
  box.appendChild(h("div", { class: "v2-tiles" },
    tileOf("Income", money(cf.total.incomeCents, { whole: true })),
    tileOf("Spending", money(cf.total.spendingCents, { whole: true })),
    tileOf(cf.total.netCents < 0 ? "Net (spent more)" : "Saved", money(cf.total.netCents, { whole: true }), cf.total.netCents < 0 ? "neg" : "accent"),
    tileOf("Savings rate", cf.total.incomeCents > 0 ? Math.round(cf.total.netCents / cf.total.incomeCents * 100) + "%" : "—")));
  box.appendChild(h("div", { class: "chart-box v2-chart" }, canvas));
  drawChart("cashflow", canvas, {
    type: "bar",
    data: {
      labels: cf.months.map(function (m) { return monthLabel(m.month); }),
      datasets: [
        { label: "Income", data: cf.months.map(function (m) { return m.incomeCents / 100; }), backgroundColor: c.income, borderRadius: 6 },
        { label: "Spending", data: cf.months.map(function (m) { return m.spendingCents / 100; }), backgroundColor: c.spend, borderRadius: 6 },
        { label: "Net", type: "line", data: cf.months.map(function (m) { return m.netCents / 100; }), borderColor: c.accent, backgroundColor: c.accent, tension: .3 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: c.text } } }, scales: { x: { ticks: { color: c.text }, grid: { display: false } }, y: { ticks: { color: c.text }, grid: { color: c.grid } } } }
  }, cf.months.map(function (m) { return monthLabel(m.month) + ": in " + money(m.incomeCents) + ", out " + money(m.spendingCents); }).join("\n"));
  const rows = Object.keys(cf.total.byCategory).map(function (id) {
    const cat = v2.categories.find(function (x) { return x.id === id; });
    return { id: id, name: cat ? cat.name : "Uncategorized", kind: cat ? cat.kind : "expense", cents: cf.total.byCategory[id] };
  }).filter(function (r) { return r.kind === "expense" && r.cents !== 0; }).sort(function (a, b) { return b.cents - a.cents; });
  const total = cf.total.spendingCents || 1;
  box.appendChild(h("h3", { class: "v2-sub-head", text: "Spending by category" }));
  box.appendChild(rows.length ? h("div", { class: "v2-cat-table" }, rows.map(function (r) {
    return h("div", { class: "v2-cat-row" },
      h("span", { class: "v2-cat-name", text: r.name }),
      h("span", { class: "v2-bar" }, h("span", { class: "v2-bar-fill", style: { width: Math.max(Math.round(r.cents / total * 100), 1) + "%" } })),
      h("span", { class: "v2-cat-amt", text: money(r.cents, { whole: true }) }),
      h("span", { class: "hint v2-cat-pct", text: Math.round(r.cents / total * 100) + "%" }));
  })) : h("p", { class: "hint", text: "No spending in this range." }));
}

function tileOf(label, value, cls) {
  return h("div", { class: "v2-tile " + (cls || "") }, h("span", { class: "v2-tile-label", text: label }), h("span", { class: "v2-tile-value", text: value }));
}

function drawForecast(fc, box) {
  clear(box);
  const c = chartColors();
  const canvas = h("canvas", { attrs: { role: "img", "aria-label": "Forecast balance by month" } });
  const low = fc.months.reduce(function (m, x) { return x.balanceCents < m.balanceCents ? x : m; }, fc.months[0]);
  box.appendChild(h("p", { class: "hint", text: "Starts from your cash today (" + money(fc.cashCents, { whole: true }) + " in checking, savings and cash) and adds each month's planned income minus planned spending. Months without a budget repeat the last one, minus its one-offs." }));
  box.appendChild(h("div", { class: "v2-tiles" },
    tileOf("In 12 months", money(fc.months[fc.months.length - 1].balanceCents, { whole: true }), "accent"),
    tileOf("Lowest point", money(low.balanceCents, { whole: true }) + " · " + monthLabel(low.month), low.balanceCents < 0 ? "neg" : "")));
  box.appendChild(h("div", { class: "chart-box v2-chart" }, canvas));
  drawChart("forecast", canvas, {
    type: "line",
    data: { labels: fc.months.map(function (m) { return monthLabel(m.month); }), datasets: [{ label: "Balance", data: fc.months.map(function (m) { return m.balanceCents / 100; }), borderColor: c.plan, backgroundColor: "rgba(139,92,246,.15)", fill: true, tension: .3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: c.text }, grid: { display: false } }, y: { ticks: { color: c.text }, grid: { color: c.grid } } } }
  }, fc.months.map(function (m) { return monthLabel(m.month) + ": " + money(m.balanceCents); }).join("\n"));
  box.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "v2-table" },
    h("thead", null, h("tr", null, ["Month", "Planned in", "Planned out", "Net", "Balance"].map(function (x) { return h("th", { text: x }); }))),
    h("tbody", null, fc.months.map(function (m) {
      return h("tr", null, h("td", { text: monthLabel(m.month) }), h("td", { text: money(m.plannedIncomeCents, { whole: true }) }),
        h("td", { text: money(m.plannedSpendingCents, { whole: true }) }), h("td", { class: m.netCents < 0 ? "neg" : "pos", text: money(m.netCents, { whole: true }) }),
        h("td", { text: money(m.balanceCents, { whole: true }) }));
    })))));
}

function load(flowBox) {
  loading(flowBox);
  return api("GET", "reports?kind=cashflow&from=" + range.from + "&to=" + range.to).then(function (cf) { drawFlow(cf, flowBox); }).catch(function (e) { errorState(flowBox, e); });
}

export function render(container) {
  root = container;
  if (!range.from) { range.from = PRESETS[0].from(); range.to = PRESETS[0].to(); }
  loading(root);
  return loadBasics().then(function () {
    clear(root);
    const flowBox = h("div");
    const from = h("input", { attrs: { type: "month", "aria-label": "From month" }, value: range.from });
    const to = h("input", { attrs: { type: "month", "aria-label": "To month" }, value: range.to });
    const apply = function () { if (from.value && to.value) { range.from = from.value; range.to = to.value; load(flowBox); } };
    from.addEventListener("change", apply); to.addEventListener("change", apply);
    const presets = PRESETS.map(function (p) { return button(p.label, function () { from.value = p.from(); to.value = p.to(); apply(); }, "v2-mini"); });
    root.appendChild(section("Cash flow", [], h("div", null, h("div", { class: "v2-filters" }, from, h("span", { class: "hint", text: "to" }), to, presets), flowBox)));
    const fcBox = h("div");
    root.appendChild(section("Forecast · next 12 months", [], fcBox));
    loading(fcBox);
    api("GET", "reports?kind=forecast&months=12").then(function (fc) { drawForecast(fc, fcBox); }).catch(function (e) { errorState(fcBox, e); });
    return load(flowBox);
  }).catch(function (e) { errorState(root, e); });
}
