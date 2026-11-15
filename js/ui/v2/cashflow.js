/* Cash flow screen: income vs spending by month over a range, spending
   by category for the range, the same months re-timed by when money
   actually leaves (Payments), and the rolling 12-month forecast. */
import { v2, api, h, clear, money, monthLabel, dayLabel, thisMonth, todayIso, loadBasics, section, button, errorState, loading, drawChart, chartColors, categoryName } from "./kit.js";
import { addMonths } from "../../core/v2/money.js";
import { paymentFlow, carryPlannedIncome, applyPlannedIncome, applyPlannedSpending, runningBalances, lowestBalance, fundedByPriorPaycheck } from "../../core/v2/payments.js";

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
    return { id: id, name: categoryName(id), kind: cat ? cat.kind : "expense", cents: cf.total.byCategory[id] };
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

/* ---- Payments: the same months by when money actually leaves ---- */
const payRange = { from: null, to: null };
const PAY_PRESETS = [
  { label: "Next 4 months", from: thisMonth, to: function () { return addMonths(thisMonth(), 3); } },
  { label: "Next 6 months", from: thisMonth, to: function () { return addMonths(thisMonth(), 5); } }
];

/* Every transaction in a window, paged (the endpoint caps a page). */
function fetchTransactions(from, to) {
  const page = function (offset, acc) {
    return api("GET", "transactions?from=" + from + "&to=" + to + "&limit=500&offset=" + offset).then(function (r) {
      const all = acc.concat(r.transactions || []);
      return all.length < (r.total || 0) && offset < 5000 ? page(offset + 500, all) : all;
    });
  };
  return page(0, []);
}

function drawPayments(data, box) {
  clear(box);
  const months = data.months;
  const inTotal = months.reduce(function (s, m) { return s + m.incomeCents; }, 0);
  const outTotal = months.reduce(function (s, m) { return s + m.outCents; }, 0);
  const net = inTotal - outTotal;
  const low = lowestBalance(months);
  box.appendChild(h("p", { class: "hint", text: "Card charges are counted in the month that card's statement is due — a charge in a statement closing in early December is paid in January — not the month you spent it. Everything else stays in its own month. Income for this month onward is your plan where you have one. Months after this one also include what is left of that month's planned spending — rent, utilities and other regular charges — until the real charges post. The balance starts from your cash today (" + money(data.cashCents, { whole: true }) + " in checking, savings and cash) and runs from " + monthLabel(thisMonth(), true) + " onward." }));
  box.appendChild(h("div", { class: "v2-tiles" },
    tileOf("Money in", money(inTotal, { whole: true })),
    tileOf("Money out", money(outTotal, { whole: true })),
    tileOf(net < 0 ? "Net (short)" : "Net", money(net, { whole: true }), net < 0 ? "neg" : "accent"),
    tileOf("Lowest cushion", low ? money(low.balanceCents, { whole: true }) + " · " + monthLabel(low.month) : "—", low && low.balanceCents < 0 ? "neg" : "")));
  box.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "v2-table" },
    h("thead", null, h("tr", null, ["Month", "Money in", "Money out", "Net", "Balance"].map(function (x) { return h("th", { text: x }); }))),
    h("tbody", null, months.map(function (m) {
      return h("tr", null, h("td", { text: monthLabel(m.month) }), h("td", { text: money(m.incomeCents, { whole: true }) }),
        h("td", { text: money(m.outCents, { whole: true }) }), h("td", { class: m.netCents < 0 ? "neg" : "pos", text: money(m.netCents, { whole: true }) }),
        h("td", { class: m.shortfall ? "neg" : "", text: m.balanceCents === null ? "—" : money(m.balanceCents, { whole: true }) + (m.shortfall ? " ⚠" : "") }));
    })))));
  const short = months.filter(function (m) { return m.shortfall; });
  if (short.length) box.appendChild(h("p", { class: "hint", text: "⚠ On this timing, " + short.map(function (m) { return monthLabel(m.month, true); }).join(", ") + (short.length > 1 ? " end" : " ends") + " below zero — the money going out lands before enough comes in." }));
  box.appendChild(h("h3", { class: "v2-sub-head", text: "Card bills by due date" }));
  box.appendChild(data.bills.length ? h("div", { class: "table-scroll" }, h("table", { class: "v2-table" },
    h("thead", null, h("tr", null, ["Due", "Card", "Charges", "Amount", ""].map(function (x) { return h("th", { text: x }); }))),
    h("tbody", null, data.bills.map(function (b) {
      const notes = [];
      if (b.closes && b.closes >= todayIso()) notes.push("Still open · closes " + dayLabel(b.closes) + " · amount so far");
      if (fundedByPriorPaycheck(b.dueDate)) notes.push("Lands right after the " + monthLabel(addMonths(b.month, -1)) + " end-of-month paycheck");
      return h("tr", null, h("td", { text: dayLabel(b.dueDate) }), h("td", { text: b.name + (b.mask ? " ··" + b.mask : "") }),
        h("td", { text: String(b.count) }), h("td", { text: money(b.cents, { whole: true }) }),
        h("td", { class: "hint", text: notes.join(" · ") }));
    })))) : h("p", { class: "hint", text: "No card bills due in this range." }));
  const rows = Object.keys(data.byCategory).map(function (id) {
    const cat = v2.categories.find(function (x) { return x.id === id; });
    return { id: id, name: categoryName(id), kind: cat ? cat.kind : "expense", cents: data.byCategory[id] };
  }).filter(function (r) { return r.kind === "expense" && r.cents !== 0; }).sort(function (a, b) { return b.cents - a.cents; });
  const total = outTotal || 1;
  box.appendChild(h("h3", { class: "v2-sub-head", text: "Spending by category (payment timing)" }));
  box.appendChild(rows.length ? h("div", { class: "v2-cat-table" }, rows.map(function (r) {
    return h("div", { class: "v2-cat-row" },
      h("span", { class: "v2-cat-name", text: r.name }),
      h("span", { class: "v2-bar" }, h("span", { class: "v2-bar-fill", style: { width: Math.max(Math.round(r.cents / total * 100), 1) + "%" } })),
      h("span", { class: "v2-cat-amt", text: money(r.cents, { whole: true }) }),
      h("span", { class: "hint v2-cat-pct", text: Math.round(r.cents / total * 100) + "%" }));
  })) : h("p", { class: "hint", text: "No spending in this range." }));
}

function loadPayments(box, fcPromise) {
  loading(box);
  /* Charges up to two months before the range can be due inside it.
     Planned income comes from the same forecast the section below
     uses — one shared call, and the two sections then agree — not
     from a budget call per month. */
  const jobs = [fetchTransactions(addMonths(payRange.from, -2) + "-01", payRange.to + "-31"),
    fcPromise.catch(function () { return null; })];
  return Promise.all(jobs).then(function (res) {
    const plannedRaw = {};
    const plannedSpendRaw = {};
    if (res[1]) res[1].months.forEach(function (m) { plannedRaw[m.month] = m.plannedIncomeCents; plannedSpendRaw[m.month] = m.plannedSpendingCents; });
    const idx = {};
    v2.categories.forEach(function (c) { idx[c.id] = c; });
    const flow = paymentFlow(res[0], idx, v2.accounts, payRange.from, payRange.to);
    const planned = carryPlannedIncome(plannedRaw, payRange.from, payRange.to);
    const cash = v2.accounts.filter(function (a) { return !a.hidden && (a.type === "depository" || a.type === "cash") && a.balanceCents !== null; })
      .reduce(function (s, a) { return s + a.balanceCents; }, 0);
    const months = runningBalances(applyPlannedSpending(applyPlannedIncome(flow.months, planned, thisMonth()), plannedSpendRaw, flow.chargeOutByMonth, thisMonth()), cash, thisMonth());
    drawPayments({ months: months, bills: flow.bills, byCategory: flow.total.byCategory, cashCents: cash }, box);
  }).catch(function (e) { errorState(box, e); });
}

export function render(container) {
  root = container;
  if (!range.from) { range.from = PRESETS[0].from(); range.to = PRESETS[0].to(); }
  if (!payRange.from) { payRange.from = thisMonth(); payRange.to = addMonths(thisMonth(), 3); }
  loading(root);
  return loadBasics().then(function () {
    clear(root);
    /* One forecast call per visit, shared by the Payments and
       Forecast sections. */
    const fcPromise = api("GET", "reports?kind=forecast&months=12");
    const flowBox = h("div");
    const from = h("input", { attrs: { type: "month", "aria-label": "From month" }, value: range.from });
    const to = h("input", { attrs: { type: "month", "aria-label": "To month" }, value: range.to });
    const apply = function () { if (from.value && to.value) { range.from = from.value; range.to = to.value; load(flowBox); } };
    from.addEventListener("change", apply); to.addEventListener("change", apply);
    const presets = PRESETS.map(function (p) { return button(p.label, function () { from.value = p.from(); to.value = p.to(); apply(); }, "v2-mini"); });
    root.appendChild(section("Cash flow", [], h("div", null, h("div", { class: "v2-filters" }, from, h("span", { class: "hint", text: "to" }), to, presets), flowBox)));
    const payBox = h("div");
    const pFrom = h("input", { attrs: { type: "month", "aria-label": "Payments from month" }, value: payRange.from });
    const pTo = h("input", { attrs: { type: "month", "aria-label": "Payments to month" }, value: payRange.to });
    const applyPay = function () { if (pFrom.value && pTo.value) { payRange.from = pFrom.value; payRange.to = pTo.value; loadPayments(payBox, fcPromise); } };
    pFrom.addEventListener("change", applyPay); pTo.addEventListener("change", applyPay);
    const payPresets = PAY_PRESETS.map(function (p) { return button(p.label, function () { pFrom.value = p.from(); pTo.value = p.to(); applyPay(); }, "v2-mini"); });
    root.appendChild(section("Payments · by due date", [], h("div", null, h("div", { class: "v2-filters" }, pFrom, h("span", { class: "hint", text: "to" }), pTo, payPresets), payBox)));
    loadPayments(payBox, fcPromise);
    const fcBox = h("div");
    root.appendChild(section("Forecast · next 12 months", [], fcBox));
    loading(fcBox);
    fcPromise.then(function (fc) { drawForecast(fc, fcBox); }).catch(function (e) { errorState(fcBox, e); });
    return load(flowBox);
  }).catch(function (e) { errorState(root, e); });
}
