/* Budget screen: any month, planned vs actual per category grouped like
   Monarch (income, then each spending group), editable planned amounts,
   rollover per category, copy and repeat. */
import { keepScroll } from "../scroll.js";
import { v2, api, h, clear, money, parseMoney, monthLabel, thisMonth, loadBasics, categorySelect, section, button, errorState, loading } from "./kit.js";
import { addMonths } from "../../core/v2/money.js";

let root = null, month = null;

function bar(actual, plan, income) {
  const pct = plan > 0 ? Math.min(actual / plan, 1.5) : (actual > 0 ? 1.5 : 0);
  const over = !income && plan >= 0 && actual > plan;
  return h("div", { class: "v2-bar" + (over ? " over" : "") + (income ? " income" : ""), attrs: { role: "img", "aria-label": money(actual) + " of " + money(plan) } },
    h("span", { class: "v2-bar-fill", style: { width: Math.round(Math.min(pct, 1) * 100) + "%" } }));
}

function save(categoryId, cents, rollover) {
  return api("PUT", "budgets", { month: month, categoryId: categoryId, amountCents: cents, rollover: rollover }).then(draw);
}

function row(r) {
  const cat = v2.categories.find(function (c) { return c.id === r.categoryId; });
  const income = r.kind === "income";
  const input = h("input", { class: "v2-plan-input", attrs: { type: "text", inputmode: "decimal", "aria-label": "Planned for " + (cat ? cat.name : "category") }, value: (r.plannedCents / 100).toFixed(0) });
  input.addEventListener("change", function () {
    const c = parseMoney(input.value);
    if (c === null || c < 0) { input.value = (r.plannedCents / 100).toFixed(0); return; }
    save(r.categoryId, c, r.rollover).catch(function (e) { window.alert(e.message); });
  });
  const roll = h("input", { attrs: { type: "checkbox", "aria-label": "Roll leftover into next month", title: "Roll what's left into next month" } });
  roll.checked = r.rollover;
  roll.addEventListener("change", function () { save(r.categoryId, r.plannedCents, roll.checked).catch(function (e) { window.alert(e.message); }); });
  const avail = r.plannedCents + r.rolloverCents;
  return h("div", { class: "v2-budget-row" },
    h("div", { class: "v2-budget-name" }, h("span", { text: cat ? cat.name : "Uncategorized" }),
      r.rolloverCents ? h("span", { class: "v2-chip muted", text: (r.rolloverCents > 0 ? "+" : "") + money(r.rolloverCents, { whole: true }) + " rolled over" }) : null),
    bar(r.actualCents, avail, income),
    h("div", { class: "v2-budget-nums" },
      h("span", { class: "v2-budget-actual", text: money(r.actualCents, { whole: true }) }),
      h("span", { class: "hint", text: "of" }),
      input,
      income ? null : h("span", { class: "v2-budget-left" + (r.remainingCents < 0 ? " neg" : ""), text: r.remainingCents < 0 ? money(-r.remainingCents, { whole: true }) + " over" : money(r.remainingCents, { whole: true }) + " left" }),
      income ? null : h("label", { class: "v2-roll" }, roll, h("span", { text: "Roll over" }))));
}

/* Redraws keep the reader's place (see ../scroll.js). */
function draw(view) { return keepScroll(function () { return drawNow(view); }); }

function drawNow(view) {
  clear(root);
  const left = view.plannedIncomeCents - view.plannedSpendingCents;
  const nav = h("div", { class: "v2-month-nav" },
    button("‹", function () { month = addMonths(month, -1); load(); }, "v2-mini", { "aria-label": "Previous month" }),
    h("strong", { text: monthLabel(month, true) }),
    button("›", function () { month = addMonths(month, 1); load(); }, "v2-mini", { "aria-label": "Next month" }));
  const tiles = h("div", { class: "v2-tiles" },
    h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: "Income" }), h("span", { class: "v2-tile-value", text: money(view.actualIncomeCents, { whole: true }) }), h("span", { class: "v2-tile-sub", text: "of " + money(view.plannedIncomeCents, { whole: true }) + " planned" })),
    h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: "Spending" }), h("span", { class: "v2-tile-value", text: money(view.actualSpendingCents, { whole: true }) }), h("span", { class: "v2-tile-sub", text: "of " + money(view.plannedSpendingCents, { whole: true }) + " planned" })),
    h("div", { class: "v2-tile " + (left < 0 ? "neg" : "accent") }, h("span", { class: "v2-tile-label", text: left < 0 ? "Over-planned by" : "Left to budget" }), h("span", { class: "v2-tile-value", text: money(Math.abs(left), { whole: true }) }), h("span", { class: "v2-tile-sub", text: "planned income − planned spending" })));
  const body = h("div", null, nav, tiles);
  const rowsBy = {};
  view.rows.forEach(function (r) {
    const c = v2.categories.find(function (x) { return x.id === r.categoryId; });
    const g = c ? c.groupId : "_none";
    (rowsBy[g] = rowsBy[g] || []).push(r);
  });
  v2.groups.filter(function (g) { return g.kind !== "transfer"; }).forEach(function (g) {
    const rows = rowsBy[g.id];
    if (!rows) return;
    const plan = rows.reduce(function (s, r) { return s + r.plannedCents; }, 0), act = rows.reduce(function (s, r) { return s + r.actualCents; }, 0);
    body.appendChild(h("div", { class: "v2-group" },
      h("div", { class: "v2-group-head" }, h("h3", { text: g.name }), h("span", { class: "v2-group-total", text: money(act, { whole: true }) + " / " + money(plan, { whole: true }) })),
      rows.map(row)));
  });
  if (rowsBy._none) body.appendChild(h("div", { class: "v2-group" }, h("div", { class: "v2-group-head" }, h("h3", { text: "Uncategorized" })), rowsBy._none.map(row)));
  const used = {};
  view.rows.forEach(function (r) { used[r.categoryId] = true; });
  const addSel = categorySelect(null, { allowNone: true, noneLabel: "+ Budget another category…", kinds: ["income", "expense"], label: "Add a category to this month's budget" });
  addSel.addEventListener("change", function () {
    if (!addSel.value) return;
    const v = window.prompt("Planned amount for " + (v2.categories.find(function (c) { return c.id === addSel.value; }) || {}).name + " ($):", "0");
    const c = parseMoney(v);
    if (c === null) { addSel.value = ""; return; }
    save(addSel.value, Math.abs(c), false).catch(function (e) { window.alert(e.message); });
  });
  body.appendChild(h("div", { class: "v2-budget-tools" }, addSel,
    button("Copy last month", function () {
      if (!window.confirm("Replace " + monthLabel(month, true) + "'s budget with " + monthLabel(addMonths(month, -1), true) + "'s?")) return;
      api("POST", "budgets", { action: "copy", from: addMonths(month, -1), to: month }).then(draw).catch(function (e) { window.alert(e.message); });
    }, "v2-mini"),
    button("Repeat this month ahead", function () {
      const through = window.prompt("Repeat " + monthLabel(month, true) + "'s budget into every later month without one, through (YYYY-MM):", addMonths(month, 11));
      if (!through) return;
      api("POST", "budgets", { action: "fill", from: month, through: through.trim() })
        .then(function (r) { window.alert(r.months.length ? "Filled " + r.months.length + " month(s)." : "Every month up to then already has a budget."); })
        .catch(function (e) { window.alert(e.message); });
    }, "v2-mini")));
  root.appendChild(section("Budget", [], body));
}

function load() {
  if (!root.firstChild) loading(root); /* first visit only: later loads swap in place */
  return api("GET", "budgets?month=" + month).then(draw).catch(function (e) { errorState(root, e); });
}

export function render(container) {
  root = container;
  if (!month) month = thisMonth();
  return loadBasics().then(load).catch(function (e) { errorState(root, e); });
}
