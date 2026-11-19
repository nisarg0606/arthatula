/* Daily review list: own-account transfer pairing, what needs review, owed to me, ignore rules. */

/* ---- Daily review (pure) ----
   Transfers between the owner's own accounts: money out of one account
   and the same amount into a DIFFERENT account within 3 days. Both
   sides are returned (id -> true) and never reach the review list. */

export function internalTransferIds(txs) {
  var ids = {}, used = {};
  var day = function (d) { return Date.parse(String(d) + "T00:00:00Z") / 864e5; };
  var cents = function (v) { return Math.round(Math.abs(v || 0) * 100); };
  var ins = (txs || []).filter(function (t) { return (t.amount || 0) < 0; });
  (txs || []).forEach(function (o) {
    if (!((o.amount || 0) > 0)) return;
    var best = null;
    ins.forEach(function (i) {
      if (used[i.id] || i.accountId === o.accountId || cents(i.amount) !== cents(o.amount)) return;
      var gap = Math.abs(day(i.date) - day(o.date));
      if (gap <= 3 && (!best || gap < best.gap)) best = { tx: i, gap: gap };
    });
    if (best) { used[best.tx.id] = true; ids[o.id] = ids[best.tx.id] = true; }
  });
  return ids;
}

/* Bank transactions that still need a decision: money to or from a
   PERSON (Zelle/Venmo/etc. or Plaid's transfer/other categories), dated
   on or after the baseline, not an own-account transfer, not already
   linked to an expense, and not already reviewed. Card bills, payroll,
   interest and merchant bills are left out by category. */

export const REVIEW_PFC = ["TRANSFER_IN", "TRANSFER_OUT", "OTHER", ""];

/* "Payments like this": the name without digits or punctuation, so a
   monthly payment matches even when its reference number changes. */

export function paymentKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

export function ignoreRuleFor(t) {
  return { accountId: t.accountId, direction: (t.amount || 0) < 0 ? "in" : "out", name: paymentKey(t.name) };
}

export function ignoredByRule(t, rules) {
  var r0 = ignoreRuleFor(t);
  return (rules || []).some(function (r) {
    return r && r.accountId === r0.accountId && r.direction === r0.direction && r.name === r0.name;
  });
}

export function reviewQueue(state, bank) {
  if (!bank || !state) return [];
  var baseline = typeof state.baselineDate === "string" ? state.baselineDate : "";
  var internal = internalTransferIds(bank.transactions);
  var reviews = bank.reviews || {};
  var linked = {};
  (state.dailyExpenses || []).forEach(function (e) { if (e && e.bankTxId) linked[e.bankTxId] = true; });
  return (bank.transactions || []).filter(function (t) {
    return t && t.amount && String(t.date) >= baseline && !internal[t.id] && !linked[t.id] && !reviews[t.id] &&
      !ignoredByRule(t, bank.ignoreRules) &&
      (REVIEW_PFC.indexOf(t.pfc || "") !== -1 || /zelle|venmo|cash app|paypal/i.test(t.name || ""));
  });
}

/* What housemates still owe for shared expenses since the baseline:
   the part of each expense that isn't the owner's share, minus money IN
   marked "repayment" in the review list. */

export function owedToMe(state, bank) {
  if (!state) return 0;
  var baseline = typeof state.baselineDate === "string" ? state.baselineDate : "";
  var owed = 0;
  (state.dailyExpenses || []).forEach(function (e) {
    if (!e || String(e.date) < baseline || typeof e.myShare !== "number") return;
    owed += Math.max(0, (e.amount || 0) - e.myShare);
  });
  var reviews = (bank && bank.reviews) || {};
  ((bank && bank.transactions) || []).forEach(function (t) {
    if (reviews[t.id] === "repayment") owed -= Math.abs(t.amount || 0);
  });
  return Math.round(owed * 100) / 100;
}

/* How much of owedToMe has been waiting longer than OWED_STALE_DAYS:
   repayments pay off the oldest shared expenses first. */
export var OWED_STALE_DAYS = 28;

export function owedOverdue(state, bank, todayIso) {
  if (!state) return 0;
  var baseline = typeof state.baselineDate === "string" ? state.baselineDate : "";
  var shares = (state.dailyExpenses || []).filter(function (e) {
    return e && String(e.date) >= baseline && typeof e.myShare === "number" && (e.amount || 0) > e.myShare;
  }).map(function (e) { return { date: String(e.date), owed: (e.amount || 0) - e.myShare }; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var repaid = 0, reviews = (bank && bank.reviews) || {};
  ((bank && bank.transactions) || []).forEach(function (t) {
    if (reviews[t.id] === "repayment") repaid += Math.abs(t.amount || 0);
  });
  var cutoff = new Date(Date.parse(String(todayIso).slice(0, 10) + "T00:00:00Z") - OWED_STALE_DAYS * 864e5).toISOString().slice(0, 10);
  var overdue = 0;
  shares.forEach(function (s) {
    var left = Math.max(0, s.owed - repaid);
    repaid = Math.max(0, repaid - s.owed);
    if (s.date <= cutoff) overdue += left;
  });
  return Math.round(overdue * 100) / 100;
}
