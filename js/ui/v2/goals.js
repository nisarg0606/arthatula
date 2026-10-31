/* Goals screen: savings goals with progress, linked to an account's
   balance or updated by hand, and what it takes per month. */
import { api, h, clear, money, parseMoney, dayLabel, loadBasics, accountSelect, field, openDialog, section, button, emptyState, errorState, loading } from "./kit.js";

let root = null;

function editGoal(goal) {
  const isNew = !goal;
  const g = goal || { name: "", targetCents: 0, targetDate: null, accountId: null, savedCents: 0 };
  const name = h("input", { attrs: { type: "text", maxlength: "100", placeholder: "e.g. Emergency fund" }, value: g.name });
  const target = h("input", { attrs: { type: "text", inputmode: "decimal" }, value: g.targetCents ? (g.targetCents / 100).toFixed(2) : "" });
  const date = h("input", { attrs: { type: "date" }, value: g.targetDate || "" });
  const acct = accountSelect(g.accountId, { noneLabel: "Not linked — I'll update it by hand" });
  const saved = h("input", { attrs: { type: "text", inputmode: "decimal" }, value: (g.savedCents / 100).toFixed(2) });
  const savedField = field("Saved so far ($)", saved);
  const sync = function () { savedField.hidden = !!acct.value; };
  acct.addEventListener("change", sync); sync();
  const actions = [{
    label: isNew ? "Add goal" : "Save", primary: true, onClick: function (close) {
      const t = parseMoney(target.value);
      if (!t || t <= 0) throw new Error("Enter a target amount.");
      const body = { name: name.value.trim(), targetCents: Math.abs(t), targetDate: date.value || null, accountId: acct.value || null, savedCents: Math.abs(parseMoney(saved.value) || 0) };
      return (isNew ? api("POST", "goals", body) : api("PATCH", "goals", { id: g.id, patch: body })).then(function (v) { close(); draw(v); });
    }
  }];
  if (!isNew) actions.push({ label: "Delete", danger: true, onClick: function (close) {
    if (!window.confirm("Delete the goal " + g.name + "?")) return;
    return api("DELETE", "goals?id=" + encodeURIComponent(g.id)).then(function (v) { close(); draw(v); });
  } });
  openDialog(isNew ? "Add a goal" : g.name, h("div", { class: "v2-form" }, field("Name", name),
    h("div", { class: "v2-form-row" }, field("Target ($)", target), field("By (optional)", date)),
    field("Linked account", acct, "Linked: the account's balance is what you've saved."), savedField), actions);
}

function draw(v) {
  clear(root);
  const list = h("div", { class: "v2-goals" });
  if (!v.goals.length) list.appendChild(emptyState("No goals yet. Add one — e.g. a trip, a down payment or an emergency fund."));
  v.goals.forEach(function (g) {
    const p = g.progress;
    list.appendChild(h("button", { class: "v2-goal", attrs: { type: "button" }, on: { click: function () { editGoal(g); } } },
      h("div", { class: "v2-goal-head" }, h("span", { class: "v2-goal-name", text: g.name }), p.done ? h("span", { class: "v2-chip", text: "Reached" }) : null),
      h("div", { class: "v2-bar big" + (p.done ? " income" : "") }, h("span", { class: "v2-bar-fill", style: { width: Math.round(p.pct * 100) + "%" } })),
      h("div", { class: "v2-goal-nums" },
        h("span", { text: money(p.savedCents, { whole: true }) + " of " + money(p.targetCents, { whole: true }) }),
        h("span", { class: "hint", text: Math.round(p.pct * 100) + "%" })),
      g.targetDate ? h("p", { class: "hint", text: p.done ? "Target date " + dayLabel(g.targetDate) + "." : money(p.perMonthCents, { whole: true }) + " a month for " + p.monthsLeft + " month" + (p.monthsLeft === 1 ? "" : "s") + " to reach it by " + dayLabel(g.targetDate) + "." }) : null));
  });
  root.appendChild(section("Goals", [button("+ Add goal", function () { editGoal(null); }, "btn-primary", { id: "v2AddGoal" })], list));
}

export function render(container) {
  root = container;
  loading(root);
  return loadBasics().then(function () { return api("GET", "goals"); }).then(draw).catch(function (e) { errorState(root, e); });
}
