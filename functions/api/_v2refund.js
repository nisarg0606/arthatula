/*
 * Refund linking: a refund row points at the charge it pays back
 * (transactions.refund_of). The link is what nullifies the charge:
 * the refund takes the charge's category, so the pair nets out in
 * that category — fully for a full refund, part-way for a partial
 * one. A charge can collect several refunds, but never more in
 * total than it cost. Imports auto-link a credit when exactly one
 * stored charge on the same card clearly matches; anything less
 * clear is left for a manual link (PATCH / update_transaction).
 */
import { HttpError } from "./_v2db.js";

/* Merchant core for matching a refund to its charge: feeds decorate
   the same name differently ("Refund: Target", "TARGET 0042",
   "EXPEDIA **************"), so compare the cleaned word stream. */
export function refundCoreName(name) {
  const s = String(name || "").toUpperCase()
    .replace(/^\s*REFUND\b\s*[:\-]?\s*/, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

export function refundNamesMatch(a, b) {
  const x = refundCoreName(a), y = refundCoreName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

/* Money back that is never a purchase refund: card payments,
   dividends, cashback and interest arrive as credits too. */
const NEVER_REFUND = /dividend|cash ?back|interest|autopay|payment|thank you/i;
export function looksLikeRefund(row) {
  return !!row && row.amountCents > 0 && !NEVER_REFUND.test(String(row.merchant || row.description || ""));
}

/* Cents already linked against a charge, ignoring one row (the one
   being re-linked). Refund amounts share the opposite sign of the
   charge, so the absolute sum is what counts against it. */
export async function linkedRefundTotal(s, targetId, exceptId) {
  const r = await s.first(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE owner_id = ?1 AND refund_of = ?2 AND id <> ?3",
    targetId, exceptId || "");
  return Math.abs((r && r.total) || 0);
}

/* Validate a manual link from tx (a transaction dto) to targetId.
   Returns the target's raw row. Throws HttpError(400) when the link
   would not make sense. */
export async function resolveRefundTarget(s, tx, targetId) {
  if (!targetId || typeof targetId !== "string") throw new HttpError(400, "refundOf must be a transaction id or null.");
  if (targetId === tx.id) throw new HttpError(400, "A transaction can't be a refund of itself.");
  const target = await s.first("SELECT * FROM transactions WHERE owner_id = ?1 AND id = ?2", targetId);
  if (!target) throw new HttpError(400, "The original transaction was not found.");
  if (target.refund_of) throw new HttpError(400, "That transaction is itself a refund — link to the original charge instead.");
  if (!tx.amountCents || !target.amount_cents || Math.sign(tx.amountCents) === Math.sign(target.amount_cents)) {
    throw new HttpError(400, "A refund and the charge it pays back must be opposite amounts.");
  }
  const already = await linkedRefundTotal(s, targetId, tx.id);
  if (already + Math.abs(tx.amountCents) > Math.abs(target.amount_cents)) {
    throw new HttpError(400, "Those refunds would add up to more than the original charge.");
  }
  return target;
}

/* The one candidate a fresh imported credit clearly pays back, or
   null. candidates: raw charge rows (amount_cents < 0) on the same
   card — the account itself or a twin from another feed — inside
   the refund's 180-day lookback. linkedTotals: { chargeId: cents }
   already refunded against each charge; updated in place when a
   pick is made, so one charge can't absorb two refunds past its
   amount within a batch. */
export function pickRefundOriginal(candidates, linkedTotals, row, familyIds) {
  const fits = (candidates || []).filter((c) =>
    familyIds.has(c.account_id) && !c.refund_of &&
    c.date <= row.date && c.date >= shiftDay(row.date, -180) &&
    refundNamesMatch(c.merchant, row.merchant) &&
    (linkedTotals[c.id] || 0) + row.amountCents <= Math.abs(c.amount_cents));
  if (fits.length !== 1) return null;
  linkedTotals[fits[0].id] = (linkedTotals[fits[0].id] || 0) + row.amountCents;
  return fits[0];
}

const shiftDay = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export { shiftDay as refundShiftDay };
