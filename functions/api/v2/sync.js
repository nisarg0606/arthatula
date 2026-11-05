/*
 * v2 sync push for the paired automation (serves /api/v2/sync).
 *   POST { accounts: [{ id, name, institution?, type, subtype?, mask?, balanceCents, availableCents?, isoCurrency? }],
 *          holdings?: [{ accountId, securityId, ticker?, name?, quantity, costBasisCents?, priceCents?, valueCents?, kind?, asOf? }],
 *          asOf? }
 *        -> { ok, accounts, holdings }
 *        When the holdings key is present it is the COMPLETE position
 *        set for the pushed accounts: their stored holdings are
 *        replaced (changed rows only), so a sold position disappears. When the key is
 *        absent (older sync), stored holdings are left untouched.
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
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function dateStr(v, fallback) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : fallback; }

/* Upsert one bank account by its feed id (ext, e.g. "plaid:…") and
   record the day's balance snapshot. Also used by ./simplefin.js. */
export function accountStmts(ext, a, asOf, source) {
  const type = ACCOUNT_TYPES.indexOf(a.type) !== -1 ? a.type : "other";
  const bal = cents(a.balanceCents);
  const stmts = [[
    "INSERT INTO accounts (id, owner_id, external_id, name, institution, type, subtype, mask, balance_cents, available_cents, balance_at, source) " +
    "VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) " +
    "ON CONFLICT(owner_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = excluded.name, institution = excluded.institution, type = excluded.type, " +
    "subtype = excluded.subtype, mask = excluded.mask, balance_cents = excluded.balance_cents, available_cents = excluded.available_cents, " +
    "balance_at = excluded.balance_at, updated_at = datetime('now') " +
    /* Unchanged rows are skipped: D1 bills every row an upsert rewrites. */
    "WHERE accounts.name IS NOT excluded.name OR accounts.institution IS NOT excluded.institution OR accounts.type IS NOT excluded.type " +
    "OR accounts.subtype IS NOT excluded.subtype OR accounts.mask IS NOT excluded.mask OR accounts.balance_cents IS NOT excluded.balance_cents " +
    "OR accounts.available_cents IS NOT excluded.available_cents OR accounts.balance_at IS NOT excluded.balance_at",
    newId("acc_"), ext, str(a.name, 200) || "Account", str(a.institution, 200), type, str(a.subtype, 60), str(a.mask, 20),
    bal, cents(a.availableCents), asOf, source
  ]];
  if (bal !== null) {
    stmts.push([
      "INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) " +
      "SELECT ?1, id, ?3, ?4 FROM accounts WHERE owner_id = ?1 AND external_id = ?2 " +
      "ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents WHERE balance_snapshots.balance_cents IS NOT excluded.balance_cents",
      ext, asOf, bal
    ]);
  }
  return stmts;
}

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  if (!Array.isArray(b.accounts)) throw new HttpError(400, "accounts must be a list.");
  const asOf = typeof b.asOf === "string" && /^\d{4}-\d{2}-\d{2}/.test(b.asOf) ? b.asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const stmts = [];
  let n = 0;
  for (const a of b.accounts.slice(0, CAP)) {
    if (!a || typeof a !== "object" || !str(a.id, 200)) continue;
    stmts.push(...accountStmts("plaid:" + str(a.id, 200), a, asOf, "plaid"));
    n++;
  }
  let holdingsCount = 0;
  if (Array.isArray(b.holdings)) {
    const pushedExts = [...new Set(b.accounts.slice(0, CAP).filter((a) => a && str(a.id, 200)).map((a) => "plaid:" + str(a.id, 200)))];
    /* Still a full replace, but as upserts plus deletes of positions that
       vanished: an hourly delete-all + re-insert was most of D1's writes. */
    const pushed = new Set();
    for (const hd of b.holdings.slice(0, 500)) {
      if (!hd || typeof hd !== "object" || !str(hd.accountId, 200) || !str(hd.securityId, 200)) continue;
      const qty = num(hd.quantity);
      if (qty === null) continue;
      pushed.add("plaid:" + str(hd.accountId, 200) + "|" + str(hd.securityId, 200));
      stmts.push([
        "INSERT INTO holdings (owner_id, account_id, security_id, ticker, name, quantity, cost_basis_cents, price_cents, value_cents, kind, as_of) " +
        "SELECT ?1, id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 FROM accounts WHERE owner_id = ?1 AND external_id = ?2 " +
        "ON CONFLICT(owner_id, account_id, security_id) DO UPDATE SET ticker = excluded.ticker, name = excluded.name, quantity = excluded.quantity, " +
        "cost_basis_cents = excluded.cost_basis_cents, price_cents = excluded.price_cents, value_cents = excluded.value_cents, kind = excluded.kind, " +
        "as_of = excluded.as_of, updated_at = datetime('now') " +
        "WHERE holdings.ticker IS NOT excluded.ticker OR holdings.name IS NOT excluded.name OR holdings.quantity IS NOT excluded.quantity " +
        "OR holdings.cost_basis_cents IS NOT excluded.cost_basis_cents OR holdings.price_cents IS NOT excluded.price_cents " +
        "OR holdings.value_cents IS NOT excluded.value_cents OR holdings.kind IS NOT excluded.kind OR holdings.as_of IS NOT excluded.as_of",
        "plaid:" + str(hd.accountId, 200), str(hd.securityId, 200), str(hd.ticker, 20), str(hd.name, 200), qty,
        cents(hd.costBasisCents), cents(hd.priceCents), cents(hd.valueCents), str(hd.kind, 20), dateStr(hd.asOf, asOf)
      ]);
      holdingsCount++;
    }
    const stored = await s.all("SELECT a.external_id AS ext, h.security_id AS sec FROM holdings h JOIN accounts a ON a.id = h.account_id WHERE h.owner_id = ?1 AND a.owner_id = ?1");
    for (const r of stored) {
      if (pushedExts.indexOf(r.ext) === -1 || pushed.has(r.ext + "|" + r.sec)) continue;
      stmts.push(["DELETE FROM holdings WHERE owner_id = ?1 AND security_id = ?3 AND account_id IN (SELECT id FROM accounts WHERE owner_id = ?1 AND external_id = ?2)", r.ext, r.sec]);
    }
  }
  await s.batch(stmts);
  await s.setSetting("mirror_fp", ""); /* re-run the mirror: a synced card may now pair with a classic one */
  return { ok: true, accounts: n, holdings: holdingsCount };
}, { allowSync: true, syncOnly: true, skipMirror: true });
