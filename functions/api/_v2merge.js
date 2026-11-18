/*
 * Merge one money-model account into another: the repair for a feed
 * reconnect that minted a duplicate account before re-keying existed
 * (see _v2identity.js). Everything the source account holds moves to
 * the target — transactions, holdings, balance snapshots, goals —
 * except rows the target already has: a transaction that collides
 * with a target row (same date, same amount, same payee — the same
 * real charge issued under two feed ids) is deleted from the source
 * instead of moved, and likewise for a holding or a day's balance
 * snapshot. Hand-added (manual) transactions always move: they exist
 * nowhere else. Statement fields the target lacks are filled from
 * the source. The source account is then deleted, so the duplicate
 * is gone — not hidden.
 */
import { HttpError } from "./_v2http.js";
import { namesCollide } from "./_v2identity.js";

export async function mergeAccounts(s, fromId, toId) {
  if (!fromId || !toId || fromId === toId) throw new HttpError(400, "fromId and toId must be two different accounts.");
  const from = await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", String(fromId));
  if (!from) throw new HttpError(404, "Source account not found.");
  const to = await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", String(toId));
  if (!to) throw new HttpError(404, "Target account not found.");
  if (from.type !== to.type) throw new HttpError(400, "Only accounts of the same type can be merged.");

  const fromTxs = await s.all("SELECT id, date, amount_cents, merchant, source FROM transactions WHERE owner_id = ?1 AND account_id = ?2", from.id);
  const toTxs = await s.all("SELECT id, date, amount_cents, merchant FROM transactions WHERE owner_id = ?1 AND account_id = ?2", to.id);
  const toByKey = new Map();
  for (const t of toTxs) {
    const k = t.date + "|" + t.amount_cents;
    if (!toByKey.has(k)) toByKey.set(k, []);
    toByKey.get(k).push(t);
  }
  const consumed = new Set();
  const duplicateIds = [];
  for (const t of fromTxs) {
    if (t.source === "manual") continue;
    const hit = (toByKey.get(t.date + "|" + t.amount_cents) || []).find((x) => !consumed.has(x.id) && namesCollide(x.merchant, t.merchant));
    if (hit) { consumed.add(hit.id); duplicateIds.push(t.id); }
  }

  const stmts = [];
  for (const id of duplicateIds) {
    stmts.push(["DELETE FROM transaction_splits WHERE owner_id = ?1 AND transaction_id = ?2", id]);
    stmts.push(["DELETE FROM transactions WHERE owner_id = ?1 AND id = ?2", id]);
  }
  stmts.push(["DELETE FROM holdings WHERE owner_id = ?1 AND account_id = ?2 AND security_id IN (SELECT security_id FROM holdings WHERE owner_id = ?1 AND account_id = ?3)", from.id, to.id]);
  stmts.push(["DELETE FROM balance_snapshots WHERE owner_id = ?1 AND account_id = ?2 AND date IN (SELECT date FROM balance_snapshots WHERE owner_id = ?1 AND account_id = ?3)", from.id, to.id]);
  stmts.push(["UPDATE transactions SET account_id = ?3, updated_at = datetime('now') WHERE owner_id = ?1 AND account_id = ?2", from.id, to.id]);
  stmts.push(["UPDATE holdings SET account_id = ?3, updated_at = datetime('now') WHERE owner_id = ?1 AND account_id = ?2", from.id, to.id]);
  stmts.push(["UPDATE balance_snapshots SET account_id = ?3 WHERE owner_id = ?1 AND account_id = ?2", from.id, to.id]);
  stmts.push(["UPDATE goals SET account_id = ?3 WHERE owner_id = ?1 AND account_id = ?2", from.id, to.id]);
  stmts.push(["UPDATE accounts SET statement_start = COALESCE(statement_start, ?3), statement_end = COALESCE(statement_end, ?4), due_date = COALESCE(due_date, ?5), updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2",
    to.id, from.statement_start, from.statement_end, from.due_date]);
  stmts.push(["DELETE FROM accounts WHERE owner_id = ?1 AND id = ?2", from.id]);
  await s.batch(stmts);
  return { merged: from.id, into: to.id, movedTransactions: fromTxs.length - duplicateIds.length, removedDuplicates: duplicateIds.length };
}
