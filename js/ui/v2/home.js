/* Dashboard overview (top of the Dashboard tab): net worth, this
   month's spending and income against the budget, what needs review,
   what's due soon, and where the money went. Also the Dashboard's
   layout: which cards show and in what order (Customize). */
import { keepScroll } from "../scroll.js";
import { api, h, clear, money, shortDay, monthLabel, loadBasics, categoryName, button, errorState, loading, openDialog } from "./kit.js";
import { marketCard } from "./investments.js";

let goTo = null;
export function setNavigator(fn) { goTo = fn; }

function tile(label, value, sub, cls, onClick) {
  const el = h(onClick ? "button" : "div", { class: "v2-tile " + (cls || ""), attrs: onClick ? { type: "button" } : null, on: onClick ? { click: onClick } : null },
    h("span", { class: "v2-tile-label", text: label }), h("span", { class: "v2-tile-value", text: value }), sub ? h("span", { class: "v2-tile-sub", text: sub }) : null);
  return el;
}

/* A refresh (e.g. after auto-review) swaps the overview in place: no
   "Loading…" flash and the scroll position stays put. */
export function render(container) {
  loadLayout();
  if (!container.firstChild) loading(container);
  return loadBasics().then(function () { return api("GET", "reports?kind=summary"); }).then(function (s) {
    keepScroll(function () { draw(container, s); });
  }).catch(function (e) { errorState(container, e); });
}

function draw(container, s) {
    clear(container);
    /* The market recap is its own card (#v2Market) and loads on its own:
       a slow quote never holds up the overview. Empty until there's a key. */
    const marketBox = document.getElementById("v2Market");
    if (marketBox) api("GET", "market").then(function (m) { clear(marketBox); if (m.status !== "nokey" || m.latest) marketBox.appendChild(marketCard(m)); }, function () { /* the overview still shows */ });
    const nwDelta = s.netWorth30dAgoCents === null ? null : s.netWorthCents - s.netWorth30dAgoCents;
    const spendPct = s.plannedSpendingCents > 0 ? Math.round(s.spendingCents / s.plannedSpendingCents * 100) : null;
    const tiles = h("div", { class: "v2-tiles" },
      tile("Net worth", money(s.netWorthCents, { whole: true }), nwDelta === null ? "Grows into a trend as balances sync" : (nwDelta >= 0 ? "▲ " : "▼ ") + money(Math.abs(nwDelta), { whole: true }) + " in 30 days", "accent", function () { goTo && goTo("accounts"); }),
      tile("Spent in " + monthLabel(s.month), money(s.spendingCents, { whole: true }), s.plannedSpendingCents ? spendPct + "% of " + money(s.plannedSpendingCents, { whole: true }) + " budgeted" : "No budget this month", spendPct !== null && spendPct > 100 ? "neg" : "", function () { goTo && goTo("budget"); }),
      tile("Income in " + monthLabel(s.month), money(s.incomeCents, { whole: true }), s.plannedIncomeCents ? "of " + money(s.plannedIncomeCents, { whole: true }) + " planned" : "", "", function () { goTo && goTo("cashflow"); }),
      tile("To review", String(s.reviewCount), s.reviewCount ? "Bank rows waiting for a category" : "All caught up", s.reviewCount ? "warn" : "", function () { goTo && goTo("transactions", { review: true }); }),
      s.autoReviewedCount ? tile("Checked by AI", String(s.autoReviewedCount), "Matched your past payments and counted. Tap to check", "ai", function () { goTo && goTo("transactions", { auto: true }); }) : null);
    const due = h("div", { class: "v2-list" });
    if (!s.upcoming.length) due.appendChild(h("p", { class: "hint", text: "Nothing due in the next 14 days." }));
    s.upcoming.slice(0, 5).forEach(function (u) {
      due.appendChild(h("div", { class: "v2-line" }, h("span", { class: "v2-line-date", text: shortDay(u.date) }), h("span", { class: "v2-line-name", text: u.name }),
        h("span", { class: "v2-amt" + (u.amountCents > 0 ? " in" : ""), text: u.amountCents === null ? "Card bill" : money(u.amountCents, { signed: true }) })));
    });
    const top = h("div", { class: "v2-list" });
    if (!s.topCategories.length) top.appendChild(h("p", { class: "hint", text: "No spending yet this month." }));
    s.topCategories.forEach(function (t) {
      top.appendChild(h("button", { class: "v2-line v2-line-btn", attrs: { type: "button" }, on: { click: function () { goTo && goTo("transactions", { categoryId: t.categoryId, month: s.month }); } } },
        h("span", { class: "v2-line-name", text: categoryName(t.categoryId) }), h("span", { class: "v2-amt", text: money(t.cents, { whole: true }) })));
    });
    const heads = h("div", { class: "v2-list" });
    s.overBudget.forEach(function (o) {
      heads.appendChild(h("button", { class: "v2-line v2-line-btn", attrs: { type: "button" }, on: { click: function () { goTo && goTo("budget"); } } },
        h("span", { class: "v2-line-name", text: categoryName(o.categoryId) + " is over budget" }), h("span", { class: "v2-amt neg", text: money(o.overCents, { whole: true }) + " over" })));
    });
    s.largeExpenses.forEach(function (t) {
      heads.appendChild(h("button", { class: "v2-line v2-line-btn", attrs: { type: "button" }, on: { click: function () { goTo && goTo("transactions", { q: t.name, month: t.date.slice(0, 7) }); } } },
        h("span", { class: "v2-line-date", text: shortDay(t.date) }), h("span", { class: "v2-line-name", text: "Big expense · " + (t.name || categoryName(t.categoryId)) }),
        h("span", { class: "v2-amt", text: money(t.amountCents, { signed: true }) })));
    });
    container.appendChild(h("section", { class: "card v2-card v2-overview" },
      h("div", { class: "v2-card-head" }, h("h2", { class: "card-title", text: "Overview" }),
        h("div", { class: "actions" }, button("Transactions", function () { goTo && goTo("transactions"); }, "v2-mini"), button("Budget", function () { goTo && goTo("budget"); }, "v2-mini"), button("Customize", customize, "v2-mini", { "aria-label": "Customize dashboard" }))),
      tiles,
      heads.firstChild ? h("div", null, h("h3", { class: "v2-sub-head", text: "Heads up" }), heads) : null,
      h("div", { class: "v2-two" },
        h("div", null, h("h3", { class: "v2-sub-head", text: "Coming up · 14 days" }), due),
        h("div", null, h("h3", { class: "v2-sub-head", text: "Top spending this month" }), top))));
}

/* The Dashboard's cards: [key, name, selector]. Keys match SECTIONS in
   functions/api/v2/layout.js, which saves the layout per owner so it
   follows you across devices. */
const CARDS = [["overview", "Overview", "#v2Overview"], ["market", "Market today", "#v2Market"], ["month", "This month", ".month-card"], ["ask", "Ask about your budget", ".ask-card"], ["trends", "Trends & plan settings", ".dash-card"]];
let layout = null;

function loadLayout() {
  if (layout) return applyLayout();
  api("GET", "layout").then(function (l) { layout = l; applyLayout(); }, function () { /* keep the default */ });
}

/* Moves the cards into the saved order; anything else in the section
   (a card added later) follows them. Charts in a card shown again fit
   their new box by themselves (Chart.js watches it). */
function applyLayout() {
  const dash = document.querySelector('[data-section="dashboard"]');
  if (!dash) return;
  const cards = layout.order.map(function (k) {
    const c = CARDS.find(function (x) { return x[0] === k; });
    const el = c && dash.querySelector(c[2]);
    if (el) { el.hidden = layout.hidden.indexOf(k) !== -1; dash.appendChild(el); }
    return el;
  });
  Array.from(dash.children).forEach(function (el) { if (cards.indexOf(el) === -1) dash.appendChild(el); });
  /* With the overview hidden, Customize lives at the bottom instead. */
  const alt = document.getElementById("dashCustomize");
  if (alt) alt.hidden = layout.hidden.indexOf("overview") === -1;
}

function save(l) {
  return api("PUT", "layout", l).then(function (saved) { layout = saved; applyLayout(); });
}

export function customize() {
  const order = (layout ? layout.order : CARDS.map(function (c) { return c[0]; })).slice();
  const hidden = (layout ? layout.hidden : []).slice();
  const list = h("div", { class: "v2-list" });
  /* Focus follows the moved card's arrow, so a keyboard can keep going. */
  const move = function (i, d) {
    order.splice(i + d, 0, order.splice(i, 1)[0]);
    fill();
    const btns = list.children[i + d].querySelectorAll("button");
    (btns[d < 0 ? 0 : 1].disabled ? btns[d < 0 ? 1 : 0] : btns[d < 0 ? 0 : 1]).focus();
  };
  const fill = function () {
    clear(list);
    order.forEach(function (k, i) {
      const name = CARDS.find(function (c) { return c[0] === k; })[1];
      const box = h("input", { attrs: { type: "checkbox" } });
      box.checked = hidden.indexOf(k) === -1;
      box.addEventListener("change", function () {
        if (box.checked) hidden.splice(hidden.indexOf(k), 1); else hidden.push(k);
      });
      list.appendChild(h("div", { class: "v2-line layout-row" },
        h("label", { class: "switch-label v2-check v2-line-name" }, box, h("span", { text: name })),
        button("↑", function () { move(i, -1); }, "v2-mini", { "aria-label": "Move " + name + " up", disabled: i === 0 }),
        button("↓", function () { move(i, 1); }, "v2-mini", { "aria-label": "Move " + name + " down", disabled: i === order.length - 1 })));
    });
  };
  fill();
  openDialog("Customize dashboard", h("div", null, h("p", { class: "hint", text: "Tick what to show; the arrows set the order. Saved to your account, so it follows you to every device." }), list), [
    { label: "Reset to default", onClick: function (close) { return save({}).then(close); } },
    { label: "Save", primary: true, onClick: function (close) { return save({ order: order, hidden: hidden }).then(close); } }
  ]);
}
