/* Settings additions for the new model: categories and groups, rules,
   export (JSON / CSV), and the migration check (classic actuals vs the
   new model, month by month). */
import { keepScroll } from "../scroll.js";
import { v2, api, h, clear, money, monthLabel, loadBasics, categorySelect, accountSelect, field, openDialog, section, button, errorState, loading, categoryName } from "./kit.js";
import { apiFetch } from "../storage.js";

let root = null;

function categoriesCard() {
  const body = h("div", { class: "v2-cats" });
  v2.groups.forEach(function (g) {
    const cats = v2.categories.filter(function (c) { return c.groupId === g.id; });
    body.appendChild(h("div", { class: "v2-group" },
      h("div", { class: "v2-group-head" }, h("h3", { text: g.name + " · " + g.kind }),
        h("span", { class: "actions" },
          button("+ Category", function () { addCategory(g); }, "v2-mini", { "aria-label": "Add a category to " + g.name }),
          button("Rename", function () { renameGroup(g); }, "v2-mini"))),
      h("div", { class: "v2-chips" }, cats.map(function (c) {
        return h("button", { class: "v2-chip big" + (c.archived ? " muted" : ""), text: (c.icon ? c.icon + " " : "") + c.name, attrs: { type: "button", title: "Edit " + c.name }, on: { click: function () { editCategory(c); } } });
      }))));
  });
  return section("Categories", [button("+ Group", addGroup, "v2-mini")], body);
}
function done(r) { v2.groups = r.groups; v2.categories = r.categories; draw(); }
function addGroup() {
  const name = h("input", { attrs: { type: "text", maxlength: "60" } });
  const kind = h("select", { attrs: { "aria-label": "Kind" } }, h("option", { value: "expense", text: "Spending" }), h("option", { value: "income", text: "Income" }), h("option", { value: "transfer", text: "Transfer (not counted)" }));
  openDialog("Add a group", h("div", { class: "v2-form" }, field("Name", name), field("Kind", kind)), [{ label: "Add", primary: true, onClick: function (close) {
    return api("POST", "categories", { type: "group", name: name.value.trim(), kind: kind.value }).then(function (r) { close(); done(r); });
  } }]);
}
function renameGroup(g) {
  const name = h("input", { attrs: { type: "text", maxlength: "60" }, value: g.name });
  const actions = [{ label: "Save", primary: true, onClick: function (close) { return api("PATCH", "categories", { type: "group", id: g.id, patch: { name: name.value.trim() } }).then(function (r) { close(); done(r); }); } }];
  if (!v2.categories.some(function (c) { return c.groupId === g.id; })) actions.push({ label: "Delete group", danger: true, onClick: function (close) { return api("DELETE", "categories?type=group&id=" + encodeURIComponent(g.id)).then(function (r) { close(); done(r); }); } });
  openDialog("Rename group", h("div", { class: "v2-form" }, field("Name", name)), actions);
}
function addCategory(g) {
  const name = h("input", { attrs: { type: "text", maxlength: "60" } });
  openDialog("Add a category to " + g.name, h("div", { class: "v2-form" }, field("Name", name)), [{ label: "Add", primary: true, onClick: function (close) {
    return api("POST", "categories", { type: "category", name: name.value.trim(), groupId: g.id }).then(function (r) { close(); done(r); });
  } }]);
}
function editCategory(c) {
  const name = h("input", { attrs: { type: "text", maxlength: "60" }, value: c.name });
  const icon = h("input", { attrs: { type: "text", maxlength: "8", placeholder: "🛒", "aria-label": "Emoji" }, value: c.icon || "" });
  const group = h("select", { attrs: { "aria-label": "Group" } }, v2.groups.map(function (g) { return h("option", { value: g.id, text: g.name }); }));
  group.value = c.groupId;
  const moveTo = categorySelect(null, { label: "Move its transactions to" });
  const archived = h("input", { attrs: { type: "checkbox" } }); archived.checked = c.archived;
  openDialog(c.name, h("div", { class: "v2-form" }, field("Name", name), field("Emoji", icon, "Optional. Shows next to the name everywhere."), field("Group", group),
    h("label", { class: "switch-label v2-check" }, archived, h("span", { text: "Archive (hide from pickers)" })),
    field("When deleting, move its transactions and budgets to", moveTo)), [
    { label: "Save", primary: true, onClick: function (close) {
      const patch = {};
      if (name.value.trim() !== c.name) patch.name = name.value.trim();
      if (icon.value.trim() !== (c.icon || "")) patch.icon = icon.value.trim();
      if (group.value !== c.groupId) patch.groupId = group.value;
      if (archived.checked !== c.archived) patch.archived = archived.checked;
      return api("PATCH", "categories", { type: "category", id: c.id, patch: patch }).then(function (r) { close(); done(r); });
    } },
    { label: "Delete", danger: true, onClick: function (close) {
      if (!window.confirm("Delete " + c.name + " and move everything in it to " + categoryName(moveTo.value) + "?")) return;
      return api("DELETE", "categories?type=category&id=" + encodeURIComponent(c.id) + "&moveTo=" + encodeURIComponent(moveTo.value)).then(function (r) { close(); done(r); });
    } }
  ]);
}

function rulesCard(rules) {
  const body = h("div", { class: "v2-list" });
  if (!rules.length) body.appendChild(h("p", { class: "hint", text: "No rules yet. A rule files new transactions for you: \"when the merchant contains UBER, set Fuel/Transport\"." }));
  rules.forEach(function (r) {
    const does = [r.setCategoryId ? "→ " + categoryName(r.setCategoryId) : null, r.addTag ? "#" + r.addTag : null, r.setHidden ? "hide" : null].filter(Boolean).join(" · ");
    body.appendChild(h("div", { class: "v2-line" },
      h("span", { class: "v2-line-name", text: "Contains \"" + (r.matchText || "anything") + "\"" + (r.minCents !== null || r.maxCents !== null ? " · " + (r.minCents !== null ? money(r.minCents) : "$0") + "–" + (r.maxCents !== null ? money(r.maxCents) : "any") : "") }),
      h("span", { class: "v2-tx-sub", text: does }),
      h("span", { class: "actions" },
        button("Apply to past", function () { api("POST", "rules", { action: "apply", id: r.id }).then(function (x) { window.alert("Updated " + x.changed + " change(s)."); }).catch(function (e) { window.alert(e.message); }); }, "v2-mini"),
        button("Edit", function () { editRule(r); }, "v2-mini"))));
  });
  return section("Rules", [button("+ Rule", function () { editRule(null); }, "v2-mini", { id: "v2AddRule" })], body);
}
function editRule(rule) {
  const r = rule || { matchText: "", matchAccountId: null, minCents: null, maxCents: null, setCategoryId: null, addTag: "", setHidden: false };
  const text = h("input", { attrs: { type: "text", maxlength: "120", placeholder: "e.g. uber" }, value: r.matchText });
  const acct = accountSelect(r.matchAccountId, { noneLabel: "Any account" });
  const min = h("input", { attrs: { type: "text", inputmode: "decimal", placeholder: "any" }, value: r.minCents === null ? "" : (r.minCents / 100).toFixed(2) });
  const max = h("input", { attrs: { type: "text", inputmode: "decimal", placeholder: "any" }, value: r.maxCents === null ? "" : (r.maxCents / 100).toFixed(2) });
  const cat = categorySelect(r.setCategoryId, { allowNone: true, noneLabel: "Don't change the category" });
  const tag = h("input", { attrs: { type: "text", maxlength: "40" }, value: r.addTag || "" });
  const hide = h("input", { attrs: { type: "checkbox" } }); hide.checked = r.setHidden;
  const cents = function (v) { const t = v.trim(); if (!t) return null; const n = Math.round(Math.abs(parseFloat(t.replace(/[$,]/g, ""))) * 100); if (!Number.isFinite(n)) throw new Error("Amounts must be numbers."); return n; };
  const actions = [{ label: rule ? "Save" : "Add rule", primary: true, onClick: function (close) {
    const body = { matchText: text.value.trim(), matchAccountId: acct.value || null, minCents: cents(min.value), maxCents: cents(max.value), setCategoryId: cat.value || null, addTag: tag.value.trim() || null, setHidden: hide.checked };
    return (rule ? api("PATCH", "rules", { id: rule.id, patch: body }) : api("POST", "rules", body)).then(function () { close(); draw(); });
  } }];
  if (rule) actions.push({ label: "Delete", danger: true, onClick: function (close) { return api("DELETE", "rules?id=" + encodeURIComponent(rule.id)).then(function () { close(); draw(); }); } });
  openDialog(rule ? "Edit rule" : "Add a rule", h("div", { class: "v2-form" },
    field("When the merchant contains", text), field("On account", acct),
    h("div", { class: "v2-form-row" }, field("Amount at least ($)", min), field("Amount at most ($)", max)),
    field("Set category", cat, "Rows from the classic daily log keep their own category; tags and hiding apply to all."), field("Add tag", tag),
    h("label", { class: "switch-label v2-check" }, hide, h("span", { text: "Hide matching transactions" }))), actions);
}

function download(path, fallbackName) {
  apiFetch("/api/v2/" + path).then(function (res) {
    if (!res.ok) throw new Error("Export failed (" + res.status + ")");
    const name = ((res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    return res.blob().then(function (b) {
      const a = h("a", { attrs: { href: URL.createObjectURL(b), download: name } });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });
  }).catch(function (e) { window.alert(e.message); });
}

function migrationCard() {
  const box = h("div");
  const run = function (method) {
    loading(box);
    api(method, "migration").then(function (m) {
      clear(box);
      box.appendChild(h("p", { class: m.match ? "v2-ok" : "auth-error", text: m.match ? "Every plan month matches the classic app to the cent." : "Some months differ — see below." }));
      box.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "v2-table" },
        h("thead", null, h("tr", null, ["Month", "Income (classic / new)", "Spending (classic / new)", "", "New-app only"].map(function (x) { return h("th", { text: x }); }))),
        h("tbody", null, m.months.map(function (x) {
          return h("tr", null, h("td", { text: monthLabel(x.month) }),
            h("td", { text: money(x.v1IncomeCents) + " / " + money(x.v2IncomeCents) }),
            h("td", { text: money(x.v1SpendingCents) + " / " + money(x.v2SpendingCents) }),
            h("td", { class: x.match ? "pos" : "neg", text: x.match ? "✓" : "differs" }),
            h("td", { class: "hint", text: x.newOnlySpendingCents || x.newOnlyIncomeCents ? "+ " + money(x.newOnlySpendingCents) + " spent / " + money(x.newOnlyIncomeCents) + " in, added on the new screens" : "" }));
        })))));
      if (m.mirroredAt) box.appendChild(h("p", { class: "hint", text: "Last copied from the classic app: " + new Date(m.mirroredAt).toLocaleString() }));
    }).catch(function (e) { errorState(box, e); });
  };
  return { el: section("New model check", [button("Check now", function () { run("GET"); }, "v2-mini"), button("Re-copy everything", function () { run("POST"); }, "v2-mini")],
    h("div", null, h("p", { class: "hint", text: "The new screens read a copy of your classic data that refreshes whenever it changes. This compares the copy with the classic actuals, month by month; rows you add on the new screens are listed separately." }), box)), run: run };
}

/* Redraws keep the reader's place (see ../scroll.js). */
function draw() { return keepScroll(function () { return drawNow(); }); }

function drawNow() {
  clear(root);
  root.appendChild(categoriesCard());
  const rulesBox = h("div");
  root.appendChild(rulesBox);
  api("GET", "rules").then(function (r) { clear(rulesBox).appendChild(rulesCard(r.rules)); }).catch(function (e) { errorState(rulesBox, e); });
  root.appendChild(section("Export", [], h("div", null,
    h("p", { class: "hint", text: "Everything in the new model: accounts, transactions, categories, budgets, rules, recurring, goals and balance history." }),
    h("div", { class: "actions" }, button("Download JSON", function () { download("export?format=json", "money-export.json"); }), button("Transactions CSV", function () { download("export?format=csv", "transactions.csv"); })))));
  root.appendChild(migrationCard().el);
}

export function render(container) {
  root = container;
  loading(root);
  return loadBasics(true).then(draw).catch(function (e) { errorState(root, e); });
}
