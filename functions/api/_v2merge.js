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
 *
 * The merge also records an alias (account_aliases): the source's
 * feed id now points at the target, and aliases that pointed at the
 * source are re-pointed too. Every ingest path checks the aliases
 * before creating an account, so a feed that still pushes the
 * merged-away id lands on the survivor instead of resurrecting the
 * duplicate — a merge is permanent, not a tidy-up a sync undoes.
 */
import { HttpError } from "./_v2http.js";
import { identityKeyOf, namesCollide } from "./_v2identity.js";

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
  stmts.push(["UPDATE account_aliases SET account_id = ?3 WHERE owner_id = ?1 AND account_id = ?2", from.id, to.id]);
  if (from.external_id) {
    stmts.push(["INSERT INTO account_aliases (owner_id, external_id, account_id) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(owner_id, external_id) DO UPDATE SET account_id = excluded.account_id", from.external_id, to.id]);
  }
  stmts.push(["DELETE FROM accounts WHERE owner_id = ?1 AND id = ?2", from.id]);
  await s.batch(stmts);
  return { merged: from.id, into: to.id, movedTransactions: fromTxs.length - duplicateIds.length, removedDuplicates: duplicateIds.length };
}

/*
 * Find and fold money-model accounts that are two generations of one
 * real account: synced (source plaid), same institution, mask and type
 * (identityKeyOf), created before re-keying existed (PR 64) or by a
 * link that re-issued ids while both were still around. The newest
 * account (by created_at) is the one the sync now pushes to, so it
 * stays and the older ones merge into it (mergeAccounts: history,
 * holdings, snapshots, goals and statement/due dates move over).
 * When the owner had hidden all but one copy, the copy they kept
 * visible says how the account should show: the survivor takes its
 * hidden and net-worth settings. A group whose newest account isn't
 * unique is left alone and reported.
 * apply false: plan only.
 */
export function planV2Duplicates(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = identityKeyOf(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const merges = [], ambiguous = [];
  for (const [identity, list] of groups) {
    if (list.length < 2) continue;
    const newest = list.reduce((m, r) => (String(r.created_at || "") > m ? String(r.created_at || "") : m), "");
    const top = list.filter((r) => String(r.created_at || "") === newest);
    if (top.length !== 1) { ambiguous.push({ identity, ids: list.map((r) => r.id) }); continue; }
    const to = top[0];
    const visible = list.filter((r) => !r.hidden);
    const flagsFrom = visible.length === 1 ? visible[0] : to;
    merges.push({
      identity, toId: to.id, fromIds: list.filter((r) => r.id !== to.id).map((r) => r.id),
      name: to.name, institution: to.institution, mask: to.mask, type: to.type,
      hidden: flagsFrom.hidden ? 1 : 0, includeInNetWorth: flagsFrom.include_in_net_worth ? 1 : 0
    });
  }
  return { merges, ambiguous };
}

export async function mergeDuplicatePlaidAccounts(s, opts) {
  const rows = await s.all("SELECT id, external_id, name, institution, mask, type, hidden, include_in_net_worth, created_at FROM accounts WHERE owner_id = ?1 AND source = 'plaid'");
  const plan = planV2Duplicates(rows);
  if (!opts || opts.apply === false) return plan;
  for (const m of plan.merges) {
    m.results = [];
    for (const fromId of m.fromIds) m.results.push(await mergeAccounts(s, fromId, m.toId));
    await s.batch([["UPDATE accounts SET hidden = ?3, include_in_net_worth = ?4, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", m.toId, m.hidden, m.includeInNetWorth]]);
  }
  return plan;
}
