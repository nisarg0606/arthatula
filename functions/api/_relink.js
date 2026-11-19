/*
 * Bank reconnects in the classic Bank tab snapshot (bank_accounts /
 * bank_transactions).
 *
 * When a bank is linked again from scratch in Plaid (a new Item, not
 * Link's update mode), Plaid issues every account and transaction a
 * new id. The snapshot is keyed by those ids, so the next push used to
 * add a second copy of every account, and the last few weeks of
 * payments showed twice on the Bank tab. The v2 money model already
 * re-keys its own accounts (see _v2identity.js and _v2mirror.js);
 * this does the same for the snapshot underneath it:
 *
 *   - an older generation of an account (same institution, mask and
 *     type, an id the latest push no longer sends) is folded into the
 *     new generation: its history moves over, so the Bank tab keeps
 *     months of payments while the new Item only reports a few weeks;
 *   - a transaction both generations hold (same date, same amount,
 *     same payee: one real payment under two ids) keeps the NEW id —
 *     the one the sync will keep sending — and takes over the old
 *     copy's links: the expense it was matched to and its Daily review
 *     mark; the old copy is deleted;
 *   - "always ignore" rules on the old account move to the new one.
 *
 * Nothing is merged on a guess. An identity needs a mask; a group
 * where more than one account is still being pushed (two live
 * accounts that look alike) is reported as ambiguous and left alone.
 *
 * Two entry points use it: every sync push (upsertBankData, with the
 * push's account ids as the live set) and the repair tool
 * (repair_relinked_accounts, which picks the newest generation by
 * updated_at). Pure planning is separate from the writes so tests and
 * the repair's dry run can show the plan without changing anything.
 */
import { identityKeyOf, namesCollide } from "./_v2identity.js";

const bankTypeOf = (subtype) => (/credit/i.test(String(subtype || "")) ? "credit" : "depository");
export const bankIdentityOf = (a) => identityKeyOf({ institution: a.institution, mask: a.mask, type: bankTypeOf(a.subtype) });

/* Which snapshot accounts are older generations of another?
   accounts: bank_accounts rows ({ plaid_account_id, institution, mask,
     subtype, updated_at }).
   liveIds: the account ids the current push sends, or null for the
     repair, which then takes the newest updated_at in each group.
   Returns { merges: [{ from, to, identity }], ambiguous: [{ identity, ids }] }. */
export function planBankRelinks(accounts, liveIds) {
  const live = liveIds ? new Set(liveIds) : null;
  const groups = new Map();
  for (const a of accounts || []) {
    const k = bankIdentityOf(a);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const merges = [], ambiguous = [];
  for (const [identity, rows] of groups) {
    if (rows.length < 2) continue;
    let winners;
    if (live) {
      winners = rows.filter((r) => live.has(r.plaid_account_id));
      if (!winners.length) continue; /* not this push's accounts */
    } else {
      const newest = rows.reduce((m, r) => (String(r.updated_at || "") > m ? String(r.updated_at || "") : m), "");
      winners = rows.filter((r) => String(r.updated_at || "") === newest);
    }
    if (winners.length !== 1) {
      ambiguous.push({ identity, ids: rows.map((r) => r.plaid_account_id) });
      continue;
    }
    const to = winners[0].plaid_account_id;
    for (const r of rows) if (r.plaid_account_id !== to) merges.push({ from: r.plaid_account_id, to, identity });
  }
  return { merges, ambiguous };
}

/* Pair the old account's transactions with the new account's: one
   real payment under two ids. Conservative: same date, same amount
   to the cent, payee names that collide (see namesCollide), and each
   new row is used at most once. Returns [{ oldTx, newTx }]. */
function daysApart(a, b) {
  return Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000;
}

export function pairCopies(oldTxs, newTxs) {
  const byKey = new Map();
  for (const t of newTxs || []) {
    const k = t.date + "|" + t.amount_cents;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const used = new Set();
  const pairs = [];
  for (const o of oldTxs || []) {
    const hit = (byKey.get(o.date + "|" + o.amount_cents) || []).find((n) => !used.has(n.plaid_transaction_id) && namesCollide(n.name, o.name));
    if (!hit) continue;
    used.add(hit.plaid_transaction_id);
    pairs.push({ oldTx: o, newTx: hit });
  }
  return pairs;
}

/* Fold older account generations into the live one.
   opts.liveIds: see planBankRelinks. opts.apply: false = plan only.
   opts.stamp: updated_at for the rows it moves (defaults to now).
   Returns { merges: [{ from, to, institution, mask, movedTransactions,
   removedDuplicates, keptBothCopies }], ambiguous, droppedIncome }.
   droppedIncome lists "income" review marks that stop standing (the
   new copy already had its own mark), so the caller can take that
   income back out of the month's actuals the way clearing the mark
   by hand would; budget.js does that. */
export async function relinkBankAccounts(db, opts) {
  const o = opts || {};
  const stamp = o.stamp || new Date().toISOString();
  const accounts = ((await db.prepare("SELECT plaid_account_id, institution, name, mask, subtype, updated_at FROM bank_accounts").all()).results) || [];
  const plan = planBankRelinks(accounts, o.liveIds || null);
  const out = { merges: [], ambiguous: plan.ambiguous, droppedIncome: [] };
  if (!plan.merges.length) return out;
  const acctById = {};
  accounts.forEach((a) => { acctById[a.plaid_account_id] = a; });

  const reviews = {};
  ((await db.prepare("SELECT plaid_transaction_id AS id, kind FROM bank_tx_review").all()).results || [])
    .forEach((r) => { reviews[r.id] = r.kind; });
  let links = {};
  try {
    ((await db.prepare("SELECT id, bank_tx_id FROM daily_expenses WHERE bank_tx_id IS NOT NULL").all()).results || [])
      .forEach((r) => { links[r.bank_tx_id] = r.id; });
  } catch (e) { links = {}; /* a database from before expense links */ }

  const stmts = [];
  for (const m of plan.merges) {
    const txOf = async (id) => ((await db.prepare(
      "SELECT plaid_transaction_id, account_id, date, name, amount_cents, pending FROM bank_transactions WHERE account_id = ?"
    ).bind(id).all()).results) || [];
    const oldTxs = await txOf(m.from);
    const newTxs = await txOf(m.to);
    let removed = 0, kept = 0;
    const deleted = new Set();
    /* Hand the old copy's expense link and review mark to the copy that
       stays, then delete the old copy. false = both copies are matched
       to different expenses: two expenses for one payment is a call for
       the owner, not for a merge, so both rows stay. */
    const takeOver = (oldTx, keepId) => {
      const oldId = oldTx.plaid_transaction_id;
      if (links[oldId] && links[keepId] && links[oldId] !== links[keepId]) return false;
      if (links[oldId] && !links[keepId]) {
        stmts.push(["UPDATE daily_expenses SET bank_tx_id = ? WHERE bank_tx_id = ?", keepId, oldId]);
        links[keepId] = links[oldId];
        delete links[oldId];
      }
      if (reviews[oldId]) {
        if (!reviews[keepId]) {
          stmts.push(["INSERT INTO bank_tx_review (plaid_transaction_id, kind, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(plaid_transaction_id) DO NOTHING", keepId, reviews[oldId], stamp]);
          reviews[keepId] = reviews[oldId];
        } else if (reviews[oldId] === "income") {
          out.droppedIncome.push({ date: oldTx.date, amountCents: oldTx.amount_cents });
        }
        stmts.push(["DELETE FROM bank_tx_review WHERE plaid_transaction_id = ?", oldId]);
        delete reviews[oldId];
      }
      stmts.push(["DELETE FROM bank_transactions WHERE plaid_transaction_id = ?", oldId]);
      deleted.add(oldId);
      removed++;
      return true;
    };
    /* Posted rows pair with posted rows and pending with pending, so a
       stale pending row can't take the posted copy's partner. */
    const posted = (list) => list.filter((t) => !t.pending);
    const pendingOf = (list) => list.filter((t) => t.pending);
    for (const pair of pairCopies(posted(oldTxs), posted(newTxs)).concat(pairCopies(pendingOf(oldTxs), pendingOf(newTxs)))) {
      if (!takeOver(pair.oldTx, pair.newTx.plaid_transaction_id)) kept++;
    }
    /* A pending row the old Item left behind never resolves: that Item
       no longer syncs. When the posted payment is on the account (same
       amount and payee, posted within a week), the pending row is a
       ghost of it and folds into it. One with no posted match stays. */
    const survivors = posted(newTxs).concat(posted(oldTxs).filter((t) => !deleted.has(t.plaid_transaction_id)));
    const usedPosted = new Set();
    for (const t of pendingOf(oldTxs)) {
      if (deleted.has(t.plaid_transaction_id)) continue;
      const hit = survivors.find((p) => !usedPosted.has(p.plaid_transaction_id) && p.amount_cents === t.amount_cents &&
        namesCollide(p.name, t.name) && p.date >= t.date && daysApart(t.date, p.date) <= 7);
      if (!hit) continue;
      usedPosted.add(hit.plaid_transaction_id);
      takeOver(t, hit.plaid_transaction_id);
    }
    const moved = oldTxs.filter((t) => !deleted.has(t.plaid_transaction_id)).length;
    stmts.push(["UPDATE bank_transactions SET account_id = ?, updated_at = ? WHERE account_id = ?", m.to, stamp, m.from]);
    stmts.push(["DELETE FROM bank_accounts WHERE plaid_account_id = ?", m.from]);
    const a = acctById[m.from] || {};
    out.merges.push({ from: m.from, to: m.to, institution: a.institution || "", name: a.name || "", mask: a.mask || "",
      movedTransactions: moved, removedDuplicates: removed, keptBothCopies: kept });
  }

  /* "Always ignore payments like this" rules are per account. */
  const rulesRow = await db.prepare("SELECT value FROM budget_settings WHERE key = 'review_ignore_rules'").first();
  let rules = [];
  try { rules = JSON.parse((rulesRow && rulesRow.value) || "[]"); } catch (e) { rules = []; }
  if (Array.isArray(rules) && rules.length) {
    const toOf = {};
    plan.merges.forEach((m) => { toOf[m.from] = m.to; });
    const seen = new Set();
    const next = [];
    let changed = false;
    for (const r of rules) {
      const accountId = r && toOf[r.accountId] ? (changed = true, toOf[r.accountId]) : r && r.accountId;
      const rule = Object.assign({}, r, { accountId });
      const k = rule.accountId + "|" + rule.direction + "|" + rule.name;
      if (seen.has(k)) { changed = true; continue; }
      seen.add(k);
      next.push(rule);
    }
    if (changed) stmts.push(["INSERT INTO budget_settings (key, value) VALUES ('review_ignore_rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next)]);
  }

  if (o.apply !== false) await db.batch(stmts.map(([sql, ...args]) => db.prepare(sql).bind(...args)));
  return out;
}
