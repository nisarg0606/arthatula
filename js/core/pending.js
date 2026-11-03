/* Pending charges counted early ("Count it now"): which pending charges
   are already expenses, and which counted ones never posted. */

/* Pending charge id -> the expense counted from it. */
export function countedPending(expenses) {
  var out = {};
  (expenses || []).forEach(function (e) { if (e && e.pendingTxId) out[e.pendingTxId] = e; });
  return out;
}

/* Counted expenses whose charge has left the pending list without
   posting (a hold that was dropped, or a posted charge the sync could not
   match), once they are more than 5 days old. The owner removes or keeps
   each one; nothing is deleted automatically. */
export function unpostedCounted(expenses, pendingList, todayIso) {
  if (!pendingList) return [];
  var stillPending = {};
  pendingList.forEach(function (t) { if (t && t.id) stillPending[t.id] = true; });
  var cutoff = Date.parse(todayIso + "T00:00:00Z") - 5 * 864e5;
  return (expenses || []).filter(function (e) {
    return e && e.pendingTxId && !e.pendingSettled && !stillPending[e.pendingTxId] &&
      Date.parse(String(e.date) + "T00:00:00Z") < cutoff;
  });
}

/* Charges whose final amount often differs from the pending one. */
export function likelyToChange(t) {
  return t && (t.category === "Eating Out" || t.category === "Fuel/Transport" ||
    /hotel|resort|motel|inn\b|rent a car|rental|airbnb/i.test(t.name || ""));
}

/* Pending rows that are card PAYMENTS in flight (money moving onto a
   card), not charges: the sync tags them with this category. They are
   shown in the pending list so a payment is visible while it settles,
   but a payment is not spending — it is never totalled with the pending
   charges, never previews next to Spent, and never gets "Count it now"
   (counting it would book the payment as an expense). */
export var PENDING_PAYMENT_CATEGORY = "Credit card payment";
export function isPendingPayment(t) {
  return !!t && t.category === PENDING_PAYMENT_CATEGORY;
}
