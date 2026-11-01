/* Accounts screen: net worth (now + over time), then every account
   grouped by type with its balance. Manual accounts (a car, a house,
   cash, a loan the sync can't see) are added and updated here. */
import { keepScroll } from "../scroll.js";
import { v2, api, h, clear, money, parseMoney, dayLabel, shortDay, loadBasics, field, openDialog, section, button, emptyState, errorState, loading, drawChart, chartColors } from "./kit.js";

const TYPE_LABEL = { depository: "Cash & checking", credit: "Credit cards", loan: "Loans", investment: "Investments", property: "Property", cash: "Cash", other: "Other" };
const ORDER = ["depository", "cash", "investment", "property", "other", "credit", "loan"];
let root = null;
let onOpenAccount = null;
export function setOpenAccount(fn) { onOpenAccount = fn; }

function addAccount() {
  const name = h("input", { attrs: { type: "text", maxlength: "100", placeholder: "e.g. Car, Emergency cash" } });
  const type = h("select", { attrs: { "aria-label": "Type" } }, ["property", "cash", "investment", "loan", "credit", "depository", "other"].map(function (t) { return h("option", { value: t, text: TYPE_LABEL[t] }); }));
  const bal = h("input", { attrs: { type: "text", inputmode: "decimal", placeholder: "0.00" } });
  openDialog("Add an account", h("div", { class: "v2-form" }, field("Name", name), field("Type", type), field("Balance ($)", bal, "For a loan or card: what you owe.")), [{
    label: "Add account", primary: true, onClick: function (close) {
      const cents = bal.value.trim() ? parseMoney(bal.value) : null;
      if (bal.value.trim() && cents === null) throw new Error("Balance must be a number.");
      return api("POST", "accounts", { name: name.value.trim(), type: type.value, balanceCents: cents === null ? null : Math.abs(cents) })
        .then(function () { close(); return refresh(); });
    }
  }]);
}

function editAccount(a) {
  const name = h("input", { attrs: { type: "text", maxlength: "100" }, value: a.name });
  const hidden = h("input", { attrs: { type: "checkbox" } }); hidden.checked = a.hidden;
  const inNw = h("input", { attrs: { type: "checkbox" } }); inNw.checked = a.includeInNetWorth;
  const bal = h("input", { attrs: { type: "text", inputmode: "decimal" }, value: a.balanceCents === null ? "" : (a.balanceCents / 100).toFixed(2) });
  const manual = a.source === "manual";
  const body = h("div", { class: "v2-form" }, field("Name", name),
    manual ? field("Balance ($)", bal, "Updating it records today's balance for the net-worth chart.") : h("p", { class: "hint", text: "Balance from your bank sync" + (a.balanceAt ? ", as of " + dayLabel(a.balanceAt) : "") + "." }),
    h("label", { class: "switch-label v2-check" }, inNw, h("span", { text: "Count in net worth" })),
    h("label", { class: "switch-label v2-check" }, hidden, h("span", { text: "Hide this account" })));
  const actions = [{
    label: "Save", primary: true, onClick: function (close) {
      const patch = {};
      if (name.value.trim() !== a.name) patch.name = name.value.trim();
      if (hidden.checked !== a.hidden) patch.hidden = hidden.checked;
      if (inNw.checked !== a.includeInNetWorth) patch.includeInNetWorth = inNw.checked;
      if (manual && bal.value.trim() !== "") {
        const c = parseMoney(bal.value);
        if (c === null) throw new Error("Balance must be a number.");
        if (Math.abs(c) !== a.balanceCents) patch.balanceCents = Math.abs(c);
      }
      return api("PATCH", "accounts", { id: a.id, patch: patch }).then(function () { close(); return refresh(); });
    }
  }];
  if (manual) actions.push({ label: "Delete", danger: true, onClick: function (close) {
    if (!window.confirm("Delete " + a.name + "? Its transactions stay, with no account.")) return;
    return api("DELETE", "accounts?id=" + encodeURIComponent(a.id)).then(function () { close(); return refresh(); });
  } });
  openDialog(a.name, body, actions);
}

function accountRow(a) {
  const liab = a.type === "credit" || a.type === "loan";
  return h("div", { class: "v2-acct" + (a.hidden ? " hidden-acct" : "") },
    h("button", { class: "v2-acct-main", attrs: { type: "button", title: "Show this account's transactions" }, on: { click: function () { if (onOpenAccount) onOpenAccount(a); } } },
      h("span", { class: "v2-acct-name", text: a.name + (a.mask ? " ··" + a.mask : "") }),
      h("span", { class: "v2-tx-sub" },
        a.institution ? h("span", { text: a.institution }) : null,
        h("span", { class: "v2-chip muted", text: a.source === "manual" ? "Manual" : a.source === "v1card" ? "Card (statement dates)" : "Synced" }),
        a.dueDate ? h("span", { text: "Due " + dayLabel(a.dueDate) }) : null,
        a.hidden ? h("span", { class: "v2-chip muted", text: "Hidden" }) : null,
        !a.includeInNetWorth ? h("span", { class: "v2-chip muted", text: "Not in net worth" }) : null)),
    h("span", { class: "v2-acct-bal" + (liab ? " owed" : "") }, a.balanceCents === null ? "—" : (liab ? "-" : "") + money(a.balanceCents)),
    button("Edit", function () { editAccount(a); }, "v2-mini", { "aria-label": "Edit " + a.name }));
}

/* Redraws keep the reader's place (see ../scroll.js). */
function draw(nw) { return keepScroll(function () { return drawNow(nw); }); }

function drawNow(nw) {
  clear(root);
  const tiles = h("div", { class: "v2-tiles" },
    tile("Net worth", money(nw.current.netWorthCents, { whole: true }), "accent"),
    tile("Assets", money(nw.current.assetsCents, { whole: true })),
    tile("Liabilities", money(nw.current.liabilitiesCents, { whole: true })));
  const canvas = h("canvas", { attrs: { role: "img", "aria-label": "Net worth over time" } });
  const chartBox = h("div", { class: "chart-box v2-chart" }, canvas);
  root.appendChild(section("Net worth", [], h("div", null, tiles, nw.series.length > 1 ? chartBox : h("p", { class: "hint", text: "The chart fills in as daily balances arrive from your sync (and when you update a manual account)." }))));
  if (nw.series.length > 1) {
    const c = chartColors();
    drawChart("networth", canvas, {
      type: "line",
      data: { labels: nw.series.map(function (p) { return shortDay(p.date); }), datasets: [{ label: "Net worth", data: nw.series.map(function (p) { return p.netWorthCents / 100; }), borderColor: c.accent, backgroundColor: "rgba(20,184,166,.15)", fill: true, tension: .3, pointRadius: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: c.text, maxTicksLimit: 6 }, grid: { color: c.grid } }, y: { ticks: { color: c.text }, grid: { color: c.grid } } } }
    }, nw.series.map(function (p) { return p.date + ": " + money(p.netWorthCents); }).join("\n"));
  }
  const list = h("div", { class: "v2-acct-list" });
  const byType = {};
  v2.accounts.forEach(function (a) { (byType[a.type] = byType[a.type] || []).push(a); });
  ORDER.forEach(function (t) {
    if (!byType[t]) return;
    const total = byType[t].filter(function (a) { return !a.hidden && a.balanceCents !== null; }).reduce(function (s, a) { return s + a.balanceCents; }, 0);
    list.appendChild(h("div", { class: "v2-group" },
      h("div", { class: "v2-group-head" }, h("h3", { text: TYPE_LABEL[t] }), h("span", { class: "v2-group-total", text: (t === "credit" || t === "loan" ? "-" : "") + money(total, { whole: true }) })),
      byType[t].map(accountRow)));
  });
  if (!v2.accounts.length) list.appendChild(emptyState("No accounts yet. Synced bank accounts and your cards appear here; add a car, house or cash by hand."));
  root.appendChild(section("Accounts", [button("+ Add account", addAccount, "btn-primary", { id: "v2AddAccount" })], list));
}

function tile(label, value, cls) {
  return h("div", { class: "v2-tile " + (cls || "") }, h("span", { class: "v2-tile-label", text: label }), h("span", { class: "v2-tile-value", text: value }));
}

function refresh() {
  return Promise.all([loadBasics(true), api("GET", "networth")]).then(function (r) { draw(r[1]); });
}

export function render(container) {
  root = container;
  loading(root);
  return refresh().catch(function (e) { errorState(root, e); });
}
export { tile };
