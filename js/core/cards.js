/* Credit card statement cycles. */
import { isValidDateStrJs } from "./plan.js";
import { expenseShare } from "./spending.js";

export function sanitizeCard(raw) {
  if (!raw || typeof raw !== "object") return null;
  var name = typeof raw.name === "string" ? raw.name.trim().slice(0, 100) : "";
  if (!name) return null;
  if (!isValidDateStrJs(raw.statementStart) || !isValidDateStrJs(raw.statementEnd)) return null;
  if (raw.statementEnd < raw.statementStart) return null;
  return {
    id: typeof raw.id === "number" && isFinite(raw.id) ? raw.id : null,
    name: name,
    statementStart: raw.statementStart,
    statementEnd: raw.statementEnd,
    dueDate: isValidDateStrJs(raw.dueDate) ? raw.dueDate : null
  };
}

/* Pure statement-window filter: the expenses charged to this card whose
 * date is inside [statementStart, statementEnd] (inclusive), sorted by
 * date, plus their total — the estimated statement balance, always the
 * FULL amount (that is what he owes the bank for the cycle). shareTotal
 * is the same window summed at his-share value (COALESCE(myShare,
 * amount)) for display alongside. Expenses tagged to another card, or
 * to no card, are NOT included. A card missing either date matches
 * nothing. */

export function statementExpenses(card, expenses) {
  var items = [];
  var total = 0;
  var shareTotal = 0;
  if (card && card.name && isValidDateStrJs(card.statementStart) && isValidDateStrJs(card.statementEnd)) {
    (expenses || []).forEach(function (e) {
      if (!e || e.card !== card.name) return;
      if (typeof e.date !== "string") return;
      if (e.date < card.statementStart || e.date > card.statementEnd) return;
      items.push(e);
      total += e.amount || 0;
      shareTotal += expenseShare(e);
    });
    items.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0);
    });
  }
  return { items: items, total: Math.round(total * 100) / 100,
    shareTotal: Math.round(shareTotal * 100) / 100 };
}
