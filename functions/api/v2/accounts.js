/*
 * v2 accounts (serves /api/v2/accounts).
 *   GET                         -> { accounts, netWorth: { assetsCents, liabilitiesCents, netWorthCents } }
 *   POST   { name, type, balanceCents?, institution? } -> 201 { account }
 *          A manual account (house, car, cash, a loan Plaid can't see).
 *   PATCH  { id, patch: { name?, hidden?, includeInNetWorth?, balanceCents? } } -> { account }
 *          balanceCents only for manual accounts; it also records today's
 *          balance snapshot so net worth moves.
 *   DELETE ?id=…                -> { deleted }  (manual accounts only; their
 *          transactions keep their history with no account)
 * Balances of credit and loan accounts are what is OWED (positive).
 */
import { handleV2, HttpError, cleanStr, cleanCents, oneOf, bodyOf, todayIso } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { loadAccounts, rowToAccount } from "../_v2store.js";
import { ACCOUNT_TYPES, isLiability } from "../../../js/core/v2/money.js";

export function netWorthNow(accounts) {
  let assets = 0, liabilities = 0;
  accounts.forEach((a) => {
    if (a.hidden || !a.includeInNetWorth || a.balanceCents === null) return;
    if (isLiability(a.type)) liabilities += a.balanceCents; else assets += a.balanceCents;
  });
  return { assetsCents: assets, liabilitiesCents: liabilities, netWorthCents: assets - liabilities };
}

async function getAccount(s, id) {
  const r = await s.first("SELECT * FROM accounts WHERE owner_id = ?1 AND id = ?2", String(id || ""));
  if (!r) throw new HttpError(404, "Account not found.");
  return r;
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => {
  const accounts = await loadAccounts(s);
  return { accounts, netWorth: netWorthNow(accounts) };
});

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const name = cleanStr(b.name, 100);
  if (!name) throw new HttpError(400, "name is required.");
  const type = oneOf(b.type || "depository", ACCOUNT_TYPES, "type");
  const balance = cleanCents(b.balanceCents, "balanceCents", { nullable: true, min: 0 });
  const id = newId("acc_");
  const today = todayIso();
  await s.run(
    "INSERT INTO accounts (id, owner_id, name, institution, type, balance_cents, balance_at, source) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'manual')",
    id, name, cleanStr(b.institution, 100), type, balance, balance === null ? null : today
  );
  if (balance !== null) {
    await s.run("INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4)", id, today, balance);
  }
  return new Response(JSON.stringify({ account: rowToAccount(await getAccount(s, id)) }), {
    status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
});

export const onRequestPatch = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const row = await getAccount(s, b.id);
  const p = b.patch && typeof b.patch === "object" ? b.patch : {};
  if (p.name !== undefined) {
    const name = cleanStr(p.name, 100);
    if (!name) throw new HttpError(400, "name can't be empty.");
    await s.run("UPDATE accounts SET name = ?3, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", row.id, name);
  }
  if (p.hidden !== undefined) await s.run("UPDATE accounts SET hidden = ?3 WHERE owner_id = ?1 AND id = ?2", row.id, p.hidden ? 1 : 0);
  if (p.includeInNetWorth !== undefined) await s.run("UPDATE accounts SET include_in_net_worth = ?3 WHERE owner_id = ?1 AND id = ?2", row.id, p.includeInNetWorth ? 1 : 0);
  if (p.balanceCents !== undefined) {
    if (row.source !== "manual") throw new HttpError(409, "This balance comes from your bank sync; it can't be edited here.");
    const bal = cleanCents(p.balanceCents, "balanceCents", { min: 0 });
    const today = todayIso();
    await s.batch([
      ["UPDATE accounts SET balance_cents = ?3, balance_at = ?4, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", row.id, bal, today],
      ["INSERT INTO balance_snapshots (owner_id, account_id, date, balance_cents) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id, account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents", row.id, today, bal]
    ]);
  }
  return { account: rowToAccount(await getAccount(s, row.id)) };
});

export const onRequestDelete = (context) => handleV2(context, async ({ s, url }) => {
  const row = await getAccount(s, url.searchParams.get("id"));
  if (row.source !== "manual") throw new HttpError(409, "Only accounts you added by hand can be deleted; hide synced accounts instead.");
  await s.batch([
    ["UPDATE transactions SET account_id = NULL WHERE owner_id = ?1 AND account_id = ?2", row.id],
    ["DELETE FROM balance_snapshots WHERE owner_id = ?1 AND account_id = ?2", row.id],
    ["UPDATE goals SET account_id = NULL WHERE owner_id = ?1 AND account_id = ?2", row.id],
    ["DELETE FROM accounts WHERE owner_id = ?1 AND id = ?2", row.id]
  ]);
  return { deleted: row.id };
});
