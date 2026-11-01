/*
 * Bank statement import (serves /api/v2/import). The browser reads the
 * CSV and maps its columns (js/core/csvimport.js); this route checks the
 * rows and adds them.
 *   POST { accountId | newAccount: { name, type? }, rows: [{ date, description, amountCents, balanceCents? }] }
 *        -> { added, duplicates, categorized, toReview, accountId, balanceUpdated }
 *        Amounts are signed cents (negative = money out). Duplicates are
 *        skipped (see ../_v2import.js), so importing an overlapping
 *        statement again is safe. When the rows carry a running balance,
 *        a bank account you added here or by hand takes the newest one.
 */
import { handleV2, HttpError, cleanStr, cleanCents, cleanDate, oneOf, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { ACCOUNT_TYPES } from "../../../js/core/v2/money.js";
import { importRows, csvIds } from "../_v2import.js";

const MAX_ROWS = 3000;

async function accountFor(s, b) {
  if (b.accountId) {
    const a = await s.first("SELECT id, type, source FROM accounts WHERE owner_id = ?1 AND id = ?2", String(b.accountId));
    if (!a) throw new HttpError(400, "Unknown account.");
    return a;
  }
  const n = b.newAccount && typeof b.newAccount === "object" ? b.newAccount : null;
  const name = n ? cleanStr(n.name, 100) : "";
  if (!name) throw new HttpError(400, "Pick an account or name a new one.");
  const a = { id: newId("acc_"), type: oneOf(n.type || "depository", ACCOUNT_TYPES, "type"), source: "manual" };
  await s.run("INSERT INTO accounts (id, owner_id, name, type, source) VALUES (?2, ?1, ?3, ?4, 'manual')", a.id, name, a.type);
  return a;
}

export const onRequestPost = (context) => handleV2(context, async ({ s, db, request }) => {
  const b = await bodyOf(request);
  if (!Array.isArray(b.rows) || !b.rows.length) throw new HttpError(400, "No rows to import.");
  if (b.rows.length > MAX_ROWS) throw new HttpError(413, "That's more than " + MAX_ROWS + " rows: import a shorter date range.");
  const rows = b.rows.map((r, i) => {
    const amount = cleanCents(r && r.amountCents, "Row " + (i + 1) + " amount");
    if (!amount) throw new HttpError(400, "Row " + (i + 1) + " has no amount.");
    return {
      date: cleanDate(r.date, "Row " + (i + 1) + " date"),
      description: cleanStr(r.description, 300) || "(no description)",
      amountCents: amount,
      balanceCents: cleanCents(r.balanceCents, "Row " + (i + 1) + " balance", { nullable: true })
    };
  });
  const acct = await accountFor(s, b);
  const ids = csvIds(acct.id, rows);
  const out = await importRows(s, db, acct.id, rows.map((r, i) => Object.assign({ externalId: ids[i] }, r)), "csv");

  /* The newest running balance. Statements list oldest- or newest-first,
     so among rows of the latest date take the one listed last in an
     oldest-first file and first in a newest-first one. */
  let balanceUpdated = false;
  const withBal = rows.filter((r) => r.balanceCents !== null);
  if (withBal.length && acct.source === "manual" && acct.type === "depository") {
    const newestFirst = rows[0].date > rows[rows.length - 1].date;
    const latest = withBal.reduce((best, r) => (r.date > best.date || (r.date === best.date && !newestFirst) ? r : best));
    const cur = await s.first("SELECT balance_at FROM accounts WHERE owner_id = ?1 AND id = ?2", acct.id);
    if (!cur.balance_at || latest.date >= cur.balance_at) {
      await s.batch([
        ["UPDATE accounts SET balance_cents = ?3, balance_at = ?4, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", acct.id, latest.balanceCents, latest.date],
        ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents", acct.id, latest.date, latest.balanceCents]
      ]);
      balanceUpdated = true;
    }
  }
  return Object.assign(out, { accountId: acct.id, balanceUpdated });
});
