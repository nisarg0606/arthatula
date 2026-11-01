/* Dashboard overview (top of the Dashboard tab): net worth, this
   month's spending and income against the budget, what needs review,
   what's due soon, and where the money went. */
import { keepScroll } from "../scroll.js";
import { api, h, clear, money, shortDay, monthLabel, loadBasics, categoryName, button, errorState, loading } from "./kit.js";

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
  if (!container.firstChild) loading(container);
  return loadBasics().then(function () { return api("GET", "reports?kind=summary"); }).then(function (s) {
    keepScroll(function () { draw(container, s); });
  }).catch(function (e) { errorState(container, e); });
}

function draw(container, s) {
    clear(container);
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
    container.appendChild(h("section", { class: "card v2-card v2-overview" },
      h("div", { class: "v2-card-head" }, h("h2", { class: "card-title", text: "Overview" }),
        h("div", { class: "actions" }, button("Transactions", function () { goTo && goTo("transactions"); }, "v2-mini"), button("Budget", function () { goTo && goTo("budget"); }, "v2-mini"))),
      tiles,
      h("div", { class: "v2-two" },
        h("div", null, h("h3", { class: "v2-sub-head", text: "Coming up · 14 days" }), due),
        h("div", null, h("h3", { class: "v2-sub-head", text: "Top spending this month" }), top))));
}
