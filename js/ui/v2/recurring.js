/* Recurring screen: the next 30 days of bills and income, your saved
   recurring items, suggestions found in your transactions (confirm or
   dismiss), and each card's due date. */
import { keepScroll } from "../scroll.js";
import { v2, api, h, clear, money, parseMoney, shortDay, dayLabel, todayIso, loadBasics, categorySelect, field, openDialog, section, button, emptyState, errorState, loading, categoryName } from "./kit.js";

let root = null;
const CADENCE_LABEL = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

function editItem(item) {
  const isNew = !item;
  const it = item || { name: "", amountCents: -0, cadence: "monthly", nextDate: todayIso(), categoryId: null };
  const name = h("input", { attrs: { type: "text", maxlength: "120" }, value: it.name });
  const dir = h("select", { attrs: { "aria-label": "Bill or income" } }, h("option", { value: "out", text: "Bill (money out)" }), h("option", { value: "in", text: "Income (money in)" }));
  dir.value = it.amountCents > 0 ? "in" : "out";
  const amt = h("input", { attrs: { type: "text", inputmode: "decimal" }, value: it.amountCents ? (Math.abs(it.amountCents) / 100).toFixed(2) : "" });
  const cad = h("select", { attrs: { "aria-label": "How often" } }, Object.keys(CADENCE_LABEL).map(function (k) { return h("option", { value: k, text: CADENCE_LABEL[k] }); }));
  cad.value = it.cadence;
  const next = h("input", { attrs: { type: "date" }, value: it.nextDate || todayIso() });
  const cat = categorySelect(it.categoryId, { allowNone: true });
  const actions = [{
    label: isNew ? "Add" : "Save", primary: true, onClick: function (close) {
      const c = parseMoney(amt.value);
      if (c === null || c === 0) throw new Error("Enter an amount.");
      const body = { name: name.value.trim(), amountCents: (dir.value === "in" ? 1 : -1) * Math.abs(c), cadence: cad.value, nextDate: next.value, categoryId: cat.value || null };
      return (isNew ? api("POST", "recurring", body) : api("PATCH", "recurring", { id: it.id, patch: body })).then(function (v) { close(); draw(v); });
    }
  }];
  if (!isNew) actions.push({ label: "Delete", danger: true, onClick: function (close) { return api("DELETE", "recurring?id=" + encodeURIComponent(it.id)).then(function (v) { close(); draw(v); }); } });
  openDialog(isNew ? "Add a recurring bill or income" : it.name, h("div", { class: "v2-form" },
    field("Name", name), h("div", { class: "v2-form-row" }, field("Type", dir), field("Amount ($)", amt)),
    h("div", { class: "v2-form-row" }, field("How often", cad), field("Next date", next)), field("Category", cat)), actions);
}

/* Redraws keep the reader's place (see ../scroll.js). */
function draw(v) { return keepScroll(function () { return drawNow(v); }); }

function drawNow(v) {
  clear(root);
  const up = h("div", { class: "v2-list" });
  if (!v.upcoming.length) up.appendChild(emptyState("Nothing due in the next 30 days."));
  v.upcoming.forEach(function (u) {
    up.appendChild(h("div", { class: "v2-line" },
      h("span", { class: "v2-line-date", text: shortDay(u.date) }),
      h("span", { class: "v2-line-name", text: u.name }),
      h("span", { class: "v2-amt" + (u.amountCents > 0 ? " in" : ""), text: u.amountCents === null ? "Card bill" : money(u.amountCents, { signed: true }) })));
  });
  root.appendChild(section("Coming up · next 30 days", [], up));

  const items = h("div", { class: "v2-list" });
  if (!v.items.length) items.appendChild(emptyState("No recurring items yet. Confirm a suggestion below or add one."));
  v.items.forEach(function (it) {
    items.appendChild(h("button", { class: "v2-line v2-line-btn", attrs: { type: "button" }, on: { click: function () { editItem(it); } } },
      h("span", { class: "v2-line-name", text: it.name }),
      h("span", { class: "v2-tx-sub" }, h("span", { class: "v2-chip", text: CADENCE_LABEL[it.cadence] || it.cadence }), h("span", { text: "next " + dayLabel(it.nextDate) }), it.categoryId ? h("span", { text: categoryName(it.categoryId) }) : null),
      h("span", { class: "v2-amt" + (it.amountCents > 0 ? " in" : ""), text: money(it.amountCents, { signed: true }) })));
  });
  root.appendChild(section("Your recurring", [button("+ Add", function () { editItem(null); }, "btn-primary", { id: "v2AddRecurring" })], items));

  const sugg = h("div", { class: "v2-list" });
  if (!v.suggestions.length) sugg.appendChild(emptyState("No new repeating charges found. They show up after the same merchant charges you 3 times on a regular schedule."));
  v.suggestions.forEach(function (sg) {
    sugg.appendChild(h("div", { class: "v2-line" },
      h("span", { class: "v2-line-name", text: sg.merchant }),
      h("span", { class: "v2-tx-sub" }, h("span", { class: "v2-chip", text: CADENCE_LABEL[sg.cadence] }), h("span", { text: sg.count + " times · next ~" + shortDay(sg.nextDate) })),
      h("span", { class: "v2-amt" + (sg.amountCents > 0 ? " in" : ""), text: money(sg.amountCents, { signed: true }) }),
      h("span", { class: "actions" },
        button("Confirm", function () { api("POST", "recurring", { action: "confirm", detectKey: sg.key }).then(draw).catch(function (e) { window.alert(e.message); }); }, "v2-mini"),
        button("Dismiss", function () { api("POST", "recurring", { action: "dismiss", detectKey: sg.key }).then(draw).catch(function (e) { window.alert(e.message); }); }, "v2-mini"))));
  });
  root.appendChild(section("Suggestions", [], sugg));

  if (v.cardBills.length) {
    root.appendChild(section("Card due dates", [], h("div", { class: "v2-list" }, v.cardBills.map(function (cb) {
      return h("div", { class: "v2-line" }, h("span", { class: "v2-line-date", text: shortDay(cb.nextDate) }), h("span", { class: "v2-line-name", text: cb.name }));
    }))));
  }
}

export function render(container) {
  root = container;
  loading(root);
  return loadBasics().then(function () { return api("GET", "recurring"); }).then(draw).catch(function (e) { errorState(root, e); });
}
