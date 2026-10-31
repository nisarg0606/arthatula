/*
 * v2 sync push for the paired automation (serves /api/v2/sync).
 *   POST { accounts: [{ id, name, institution?, type, subtype?, mask?, balanceCents, availableCents?, isoCurrency? }], asOf? }
 *        -> { ok, accounts }
 *        Sync sessions ONLY. Upserts every account by its Plaid id —
 *        including credit cards, loans and investment accounts the
 *        classic Bank tab never saw — and records the day's balance
 *        snapshot, which is what the net-worth chart is drawn from.
 *        type is Plaid's: depository, credit, loan, investment, other.
 *        Credit and loan balances are what is owed (positive).
 *        Transactions keep arriving through the classic endpoints
 *        (/api/expenses, /api/bank, /api/pending) as before.
 */
import { handleV2, HttpError, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { ACCOUNT_TYPES } from "../../../js/core/v2/money.js";

const CAP = 100;
function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function cents(v) { return typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 1e12 ? v : null; }

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  if (!Array.isArray(b.accounts)) throw new HttpError(400, "accounts must be a list.");
  const asOf = typeof b.asOf === "string" && /^\d{4}-\d{2}-\d{2}/.test(b.asOf) ? b.asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const stmts = [];
  let n = 0;
  for (const a of b.accounts.slice(0, CAP)) {
    if (!a || typeof a !== "object" || !str(a.id, 200)) continue;
    const type = ACCOUNT_TYPES.indexOf(a.type) !== -1 ? a.type : "other";
    const bal = cents(a.balanceCents);
    const ext = "plaid:" + str(a.id, 200);
    stmts.push([
      "INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, available_cents, balance_at, source) " +
      "VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'plaid') " +
      "ON CONFLICT(owner_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET institution = excluded.institution, type = excluded.type, " +
      "subtype = excluded.subtype, mask = excluded.mask, balance_cents = excluded.balance_cents, available_cents = excluded.available_cents, " +
      "balance_at = excluded.balance_at, updated_at = datetime('now')",
      newId("acc_"), ext, str(a.name, 200) || "Account", str(a.institution, 200), type, str(a.subtype, 60), str(a.mask, 20),
      bal, cents(a.availableCents), asOf
    ]);
    if (bal !== null) {
      stmts.push([
        "INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) " +
        "SELECT ?1, id, ?3, ?4 FROM accounts WHERE owner_id = ?1 AND external_id = ?2 " +
        "ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents",
        ext, asOf, bal
      ]);
    }
    n++;
  }
  await s.batch(stmts);
  await s.setSetting("mirror_fp", ""); /* re-run the mirror: a synced card may now pair with a classic one */
  return { ok: true, accounts: n };
}, { allowSync: true, syncOnly: true, skipMirror: true });
