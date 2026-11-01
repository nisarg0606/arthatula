/*
 * v2 Splitwise view (serves /api/v2/splitwise) — READ-ONLY.
 *   GET            -> live balances from the Splitwise API: who owes
 *                     the owner, whom the owner owes, per-group member
 *                     balances, and the most recent shared expenses.
 *   GET ?refresh=1 -> bypass the 5-minute server cache.
 *
 * The owner's Splitwise personal API key lives server-side only
 * (Settings → Splitwise, or the SPLITWISE_API_KEY env secret — see
 * settings.js getSplitwiseApiKey). It is used here, in the Function,
 * and never sent to the browser. Nothing is ever written back to
 * Splitwise: settlements still count in the budget only when the cash
 * lands, per the owner's cash-basis rule.
 *
 * Responses are cached in budget_settings for 5 minutes so opening
 * the app doesn't hammer Splitwise; a failed refresh falls back to
 * the last good snapshot, marked stale.
 *
 * Sign convention (Splitwise API): a friend's balance amount is from
 * the owner's point of view — positive means that friend owes the
 * owner money. A group member's balance is that member's net in the
 * group — positive means the group owes them. (Verified against the
 * owner's known balances at first connection.)
 */
import { handleV2 } from "../_v2http.js";
import { getSplitwiseApiKey, getSplitwiseCache, setSplitwiseCache } from "../settings.js";

export const SPLITWISE_API = "https://secure.splitwise.com/api/v3.0";
const CACHE_MS = 5 * 60 * 1000;
const EXPENSE_LIMIT = 25;

/* "754.26" / -12.5 / 0 -> integer cents. Splitwise sends amounts as
   decimal strings in major units. */
export function toCents(amount) {
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function personName(u) {
  const name = [u && u.first_name, u && u.last_name].filter(Boolean).join(" ").trim();
  return name || (u && u.email) || "Someone";
}

function usdOf(balances) {
  const b = (balances || []).find((x) => x.currency_code === "USD");
  return b ? toCents(b.amount) : 0;
}

function cleanBalances(balances) {
  return (balances || [])
    .map((b) => ({ currency: b.currency_code, amountCents: toCents(b.amount) }))
    .filter((b) => b.amountCents !== 0);
}

/* Friends with a non-zero balance, biggest debt first. Positive USD
   = they owe the owner; negative = the owner owes them. */
export function normalizeFriends(friends) {
  return (friends || [])
    .map((f) => ({
      id: f.id,
      name: personName(f),
      balances: cleanBalances(f.balance),
      usdCents: usdOf(f.balance)
    }))
    .filter((f) => f.balances.length)
    .sort((a, b) => Math.abs(b.usdCents) - Math.abs(a.usdCents));
}

export function normalizeGroups(groups, myId) {
  return (groups || [])
    .filter((g) => g.id !== 0) /* id 0 is the "non-group expenses" pseudo-group */
    .map((g) => {
      const members = (g.members || []).map((m) => ({
        id: m.id,
        name: personName(m),
        balances: cleanBalances(m.balance),
        usdCents: usdOf(m.balance)
      }));
      const me = members.find((m) => m.id === myId);
      return {
        id: g.id,
        name: g.name || "Group",
        members,
        myUsdCents: me ? me.usdCents : 0
      };
    })
    .sort((a, b) => Math.abs(b.myUsdCents) - Math.abs(a.myUsdCents));
}

/* Recent shared expenses. myNetCents is the owner's net for the row:
   positive = others owe the owner for it, negative = the owner owes.
   Settlements arrive as expenses with payment: true. */
export function normalizeExpenses(expenses, myId) {
  return (expenses || [])
    .filter((e) => !e.deleted_at)
    .map((e) => {
      const mine = (e.users || []).find((u) => u.user && u.user.id === myId);
      const payer = (e.users || []).find((u) => toCents(u.paid_share) > 0);
      return {
        id: e.id,
        date: String(e.date || "").slice(0, 10),
        description: e.description || (e.payment ? "Settlement" : "Expense"),
        costCents: toCents(e.cost),
        currency: e.currency_code || "USD",
        groupId: e.group_id || null,
        payment: !!e.payment,
        paidBy: payer ? (payer.user.id === myId ? "You" : personName(payer.user)) : null,
        myNetCents: mine ? toCents(mine.net_balance) : 0
      };
    });
}

async function swGet(fetchImpl, key, path) {
  const res = await fetchImpl(SPLITWISE_API + path, {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" }
  });
  if (!res.ok) {
    const err = new Error("Splitwise request failed (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* One live pull from Splitwise, normalized. Exported for tests. */
export async function fetchSplitwise(key, fetchImpl) {
  const f = fetchImpl || fetch;
  const [me, friends, groups, expenses] = await Promise.all([
    swGet(f, key, "/get_current_user"),
    swGet(f, key, "/get_friends"),
    swGet(f, key, "/get_groups"),
    swGet(f, key, "/get_expenses?limit=" + EXPENSE_LIMIT)
  ]);
  const myId = me.user ? me.user.id : null;
  const friendList = normalizeFriends(friends.friends);
  const netUsdCents = friendList.reduce((sum, x) => sum + x.usdCents, 0);
  return {
    connected: true,
    fetchedAt: new Date().toISOString(),
    me: me.user ? { id: myId, name: personName(me.user) } : null,
    netUsdCents,
    owedToYouCents: friendList.filter((x) => x.usdCents > 0).reduce((s, x) => s + x.usdCents, 0),
    youOweCents: friendList.filter((x) => x.usdCents < 0).reduce((s, x) => s - x.usdCents, 0),
    friends: friendList,
    groups: normalizeGroups(groups.groups, myId),
    expenses: normalizeExpenses(expenses.expenses, myId)
  };
}

export const onRequestGet = (context) => handleV2(context, async ({ db, url, env }) => {
  const key = await getSplitwiseApiKey(env);
  if (!key) return { connected: false };
  const cached = await getSplitwiseCache(db);
  const fresh = cached && Date.now() - cached.at < CACHE_MS;
  if (fresh && url.searchParams.get("refresh") !== "1") {
    return Object.assign({}, cached.payload, { cached: true });
  }
  try {
    const payload = await fetchSplitwise(key);
    await setSplitwiseCache(db, payload);
    return payload;
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      return { connected: false, error: "Splitwise didn't accept the saved API key. Paste a fresh one in Settings → Splitwise." };
    }
    if (cached) return Object.assign({}, cached.payload, { stale: true, error: "Couldn't reach Splitwise just now — showing the last good snapshot." });
    return { connected: false, error: "Couldn't reach Splitwise just now. Try Refresh in a moment." };
  }
}, { skipMirror: true });
