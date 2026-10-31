/*
 * v2 net worth (serves /api/v2/networth).
 *   GET -> { current: { assetsCents, liabilitiesCents, netWorthCents }, series, byType }
 *        series: one point per day that has a balance snapshot, each
 *        account's last known balance carried forward.
 */
import { handleV2 } from "../_v2http.js";
import { loadAccounts } from "../_v2store.js";
import { netWorthSeries } from "../../../js/core/v2/money.js";
import { netWorthNow } from "./accounts.js";

export const onRequestGet = (context) => handleV2(context, async ({ s }) => {
  const accounts = await loadAccounts(s);
  const idx = {};
  accounts.forEach((a) => { idx[a.id] = a; });
  const snaps = (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1 ORDER BY date"))
    .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }));
  const byType = {};
  accounts.forEach((a) => {
    if (a.hidden || !a.includeInNetWorth || a.balanceCents === null) return;
    byType[a.type] = (byType[a.type] || 0) + a.balanceCents;
  });
  return { current: netWorthNow(accounts), series: netWorthSeries(idx, snaps), byType };
});
