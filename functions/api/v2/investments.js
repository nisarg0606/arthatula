/*
 * v2 investments (serves /api/v2/investments).
 *   GET -> { accounts, series, change }
 *        accounts: the investment accounts, each with its own 1-day and
 *        30-day change; series: total value per day from the balance
 *        snapshots the sync records; change: { day, week, month, year }
 *        of the total (see changeOver in js/core/v2/money.js);
 *        benchmark: SPY closes from the saved market recaps, to compare.
 */
import { handleV2 } from "../_v2http.js";
import { loadAccounts } from "../_v2store.js";
import { investmentSeries, changeOver } from "../../../js/core/v2/money.js";
import { marketHistory } from "../_market.js";

export const onRequestGet = (context) => handleV2(context, async ({ s }) => {
  const accounts = (await loadAccounts(s)).filter((a) => a.type === "investment" && !a.hidden);
  const snaps = (await s.all("SELECT account_id, date, balance_cents FROM balance_snapshots WHERE owner_id = ?1 ORDER BY date"))
    .map((r) => ({ accountId: r.account_id, date: r.date, balanceCents: r.balance_cents }));
  const series = investmentSeries(accounts, snaps);
  const benchmark = (await marketHistory(s, 400))
    .map((m) => { const q = (m.quotes || []).find((x) => x.symbol === "SPY"); return q ? { date: m.date, close: q.close } : null; })
    .filter(Boolean).reverse();
  return {
    accounts: accounts.map((a) => {
      const own = investmentSeries([a], snaps);
      return { id: a.id, name: a.name, institution: a.institution, mask: a.mask, balanceCents: a.balanceCents, balanceAt: a.balanceAt, day: changeOver(own, 1), month: changeOver(own, 30) };
    }),
    series,
    change: { day: changeOver(series, 1), week: changeOver(series, 7), month: changeOver(series, 30), year: changeOver(series, 365) },
    benchmark
  };
}, { skipMirror: true });
