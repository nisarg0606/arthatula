/* Cards tab: statement cycles, add/edit/delete cards. */
import { sanitizeCard, statementExpenses } from "../core/cards.js";
import { fmt } from "../core/format.js";
import { isValidDateStrJs } from "../core/plan.js";
import { fillCardSelect } from "./banklink.js";
import { app, els } from "./context.js";
import { renderDaily } from "./daily.js";
import { refreshDatePickers } from "./datepicker.js";
import { apiFetch, persist, setMode } from "./storage.js";

export function fmtDate(iso) {
  var d = new Date(String(iso) + "T00:00:00");
  return isNaN(d.getTime()) ? String(iso)
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function renderCards() {
  if (!els.cardList) return;
  if (els.expCard) fillCardSelect(els.expCard, els.expCard.value || "");
  els.cardList.innerHTML = "";
  var cards = app.state.cards || [];
  if (!cards.length) {
    var p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No cards yet. Add a card above with its statement start and end dates, " +
      "then tag daily expenses with that card — the expenses inside the statement window will group here as the estimated statement balance.";
    els.cardList.appendChild(p);
    return;
  }
  cards.forEach(function (card) {
    var panel = document.createElement("div");
    panel.className = "card-panel";
    var head = document.createElement("div");
    head.className = "card-panel-head";
    var title = document.createElement("h3");
    title.className = "chart-title";
    title.textContent = card.name;
    head.appendChild(title);
    var actions = document.createElement("div");
    actions.className = "actions";
    var editBtn = document.createElement("button");
    editBtn.type = "button"; editBtn.textContent = "Edit";
    editBtn.addEventListener("click", function () { startEditCard(card); });
    actions.appendChild(editBtn);
    var delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "Delete"; delBtn.className = "danger";
    delBtn.addEventListener("click", function () {
      if (confirm("Delete card “" + card.name + "”? Expenses already tagged with this name keep the tag.")) {
        deleteCardById(card.id, card.name);
      }
    });
    actions.appendChild(delBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    var period = document.createElement("p");
    period.className = "hint";
    if (!card.statementStart || !card.statementEnd) {
      period.textContent = "No statement dates set for this card yet — edit the card and add a statement start and end date to see this cycle's expenses.";
      panel.appendChild(period);
      els.cardList.appendChild(panel);
      return;
    }
    period.textContent = "Statement period: " + fmtDate(card.statementStart) + " – " + fmtDate(card.statementEnd) +
      (card.dueDate ? " · Bill due: " + fmtDate(card.dueDate) : " · No due date set");
    panel.appendChild(period);

    var result = statementExpenses(card, app.state.dailyExpenses);
    if (!result.items.length) {
      var none2 = document.createElement("p");
      none2.className = "hint";
      none2.textContent = "No expenses charged to this card in this statement period yet — tag expenses with this card on the Daily expenses tab and they'll appear here.";
      panel.appendChild(none2);
    } else {
      var wrap = document.createElement("div");
      wrap.className = "table-scroll";
      var table = document.createElement("table");
      table.innerHTML = "<thead><tr><th>Date</th><th>Description</th><th class=\"col-cat\">Category</th><th>Amount</th></tr></thead>";
      var tbody = document.createElement("tbody");
      result.items.forEach(function (e) {
        var tr = document.createElement("tr");
        [fmtDate(e.date), e.description || "(no description)", e.category || "", fmt(e.amount || 0)]
          .forEach(function (txt, i) {
            var td = document.createElement("td");
            td.textContent = txt;
            if (i === 1 || i === 2) td.style.textAlign = "left";
            if (i === 1) td.className = "col-desc";
            if (i === 2) td.className = "col-cat"; /* hidden on phones */
            tr.appendChild(td);
          });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      var tfoot = document.createElement("tfoot");
      var ftr = document.createElement("tr");
      var ftd1 = document.createElement("td");
      ftd1.colSpan = 2; ftd1.textContent = "Estimated statement balance";
      ftd1.style.textAlign = "left"; ftd1.style.fontWeight = "800";
      var ftd2 = document.createElement("td");
      ftd2.textContent = fmt(result.total); ftd2.style.fontWeight = "800";
      var ftdCat = document.createElement("td"); ftdCat.className = "col-cat";
      ftr.appendChild(ftd1); ftr.appendChild(ftdCat); ftr.appendChild(ftd2);
      tfoot.appendChild(ftr);
      table.appendChild(tfoot);
      wrap.appendChild(table);
      panel.appendChild(wrap);
      /* The statement total above is the FULL amount (what he owes
         the bank); when shares are set on any of these expenses, also
         show his portion of this cycle. */
      var anyShare = result.items.some(function (e) { return typeof e.myShare === "number"; });
      if (anyShare) {
        var shareNote = document.createElement("p");
        shareNote.className = "hint";
        shareNote.textContent = "Your share of these: " + fmt(result.shareTotal) +
          " — the rest is other people's portion of shared expenses on this card.";
        panel.appendChild(shareNote);
      }
    }
    els.cardList.appendChild(panel);
  });
}

export function applyCards(cards) {
  app.state.cards = (cards || []).map(sanitizeCard).filter(function (c) { return !!c; });
  persist();
  renderCards();
  renderDaily();
}

export function cardsApi(method, body) {
  var opts = { method: method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return apiFetch("/api/cards", opts).then(function (res) {
    if (!res.ok) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        throw new Error(d.error || ("cards " + res.status));
      });
    }
    return res.json();
  });
}

export function saveCard(cardInput) {
  if (app.mode === "database") {
    var promise = app.editingCardId !== null
      ? cardsApi("PUT", { id: app.editingCardId, patch: cardInput })
      : cardsApi("POST", cardInput);
    promise.then(function (data) {
      cancelEditCard();
      applyCards(data.cards);
    }).catch(function () {
      /* Same fallback pattern as expenses: if the API is unreachable,
         flip to local mode and save in the browser instead. The form
         already validated name/dates before we get here. */
      setMode("local"); saveCardLocal(cardInput);
    });
  } else {
    saveCardLocal(cardInput);
  }
}

export function saveCardLocal(cardInput) {
  var clean = sanitizeCard({
    id: app.editingCardId !== null ? app.editingCardId : Date.now(),
    name: cardInput.name, statementStart: cardInput.statementStart,
    statementEnd: cardInput.statementEnd, dueDate: cardInput.dueDate
  });
  if (!clean) { alert("Check the card name and statement dates (end must be on or after start)."); return; }
  if (app.editingCardId !== null) {
    app.state.cards = (app.state.cards || []).map(function (c) { return c.id === app.editingCardId ? clean : c; });
  } else {
    app.state.cards = (app.state.cards || []).concat([clean]);
  }
  cancelEditCard();
  persist();
  renderCards();
  renderDaily();
}

export function deleteCardById(id, name) {
  if (app.mode === "database" && typeof id === "number") {
    apiFetch("/api/cards?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (res) { if (!res.ok) throw new Error("cards " + res.status); return res.json(); })
      .then(function (data) { applyCards(data.cards); })
      .catch(function () {
        setMode("local");
        app.state.cards = (app.state.cards || []).filter(function (c) { return c.id !== id && c.name !== name; });
        persist(); renderCards(); renderDaily();
      });
  } else {
    app.state.cards = (app.state.cards || []).filter(function (c) { return c.id !== id; });
    persist(); renderCards(); renderDaily();
  }
}

export function startEditCard(card) {
  app.editingCardId = card.id;
  if (els.cardFormTitle) els.cardFormTitle.textContent = "Edit card — " + card.name;
  els.cardName.value = card.name || "";
  els.cardStart.value = card.statementStart || "";
  els.cardEnd.value = card.statementEnd || "";
  els.cardDue.value = card.dueDate || "";
  refreshDatePickers();
  if (els.cardCancelEditBtn) els.cardCancelEditBtn.hidden = false;
  if (els.cardName) els.cardName.focus();
}

export function cancelEditCard() {
  app.editingCardId = null;
  if (els.cardFormTitle) els.cardFormTitle.textContent = "Add a card";
  if (els.cardForm) els.cardForm.reset();
  refreshDatePickers();
  if (els.cardCancelEditBtn) els.cardCancelEditBtn.hidden = true;
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.cardForm) {
    els.cardForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var cardInput = {
        name: els.cardName.value.trim(),
        statementStart: els.cardStart.value,
        statementEnd: els.cardEnd.value,
        dueDate: els.cardDue.value || null
      };
      if (!cardInput.name) { alert("Give the card a name first."); return; }
      if (!isValidDateStrJs(cardInput.statementStart) || !isValidDateStrJs(cardInput.statementEnd)) {
        alert("Add a valid statement start and end date."); return;
      }
      if (cardInput.statementEnd < cardInput.statementStart) {
        alert("The statement end date must be on or after the start date."); return;
      }
      saveCard(cardInput);
    });
  }
  if (els.cardCancelEditBtn) {
    els.cardCancelEditBtn.addEventListener("click", function () { cancelEditCard(); });
  }
}
