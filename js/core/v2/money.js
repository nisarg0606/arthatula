/* v2 money model — pure helpers shared by the API (functions/api/v2),
   the screens (js/ui/v2) and the unit tests. No DOM, no database.

   Conventions (the whole v2 model):
   - money is integer cents;
   - a transaction's amount is SIGNED: negative = money out of the
     account, positive = money in (Monarch's convention);
   - myShare (optional) is the owner's portion of a shared expense, with
     the same sign as the amount; reports count it instead of the amount;
   - a category has a kind: "income", "expense" or "transfer" — transfers
     (card payments, moving money between accounts) never count as
     income or spending;
   - hidden transactions count nowhere; excludeReports ones are listed
     but left out of totals (e.g. spending before the baseline date). */

export const ACCOUNT_TYPES = ["depository", "credit", "loan", "investment", "property", "cash", "other"];
export const LIABILITY_TYPES = ["credit", "loan"];
export const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
export const CADENCE_DAYS = { weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91.31, yearly: 365.25 };

export function isLiability(type) { return LIABILITY_TYPES.indexOf(type) !== -1; }

/* "2026-11-05" -> "2026-11" */
export function monthOf(date) { return String(date || "").slice(0, 7); }

export function addMonths(monthKey, n) {
  const y = Number(monthKey.slice(0, 4)), m = Number(monthKey.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return yy + "-" + String(mm + 1).padStart(2, "0");
}

export function monthRange(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 600; k = addMonths(k, 1)) out.push(k);
  return out;
}

export function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }

export function addDays(date, n) {
  return new Date(Date.parse(date) + Math.round(n) * 864e5).toISOString().slice(0, 10);
}

/* The lines a transaction contributes to reports: one per split, or one
   line for the whole (share-adjusted) amount. Each line is
   { categoryId, cents } with the transaction's sign. */
export function reportLines(tx) {
  if (!tx || tx.hidden || tx.excludeReports || tx.pending) return [];
  if (tx.splits && tx.splits.length) {
    return tx.splits.map(function (s) { return { categoryId: s.categoryId, cents: s.amountCents }; });
  }
  const cents = tx.myShareCents !== null && tx.myShareCents !== undefined ? tx.myShareCents : tx.amountCents;
  return [{ categoryId: tx.categoryId, cents: cents }];
}

/* Income and spending per category for the transactions given (filter
   by date before calling). Spending is reported POSITIVE (a refund in an
   expense category lowers it); income positive. Transfers are skipped.
   categories: { [id]: { kind } }. Uncategorized money is filed under
   the key "" with kind taken from its sign. */
export function summarize(transactions, categories) {
  const out = { incomeCents: 0, spendingCents: 0, byCategory: {} };
  (transactions || []).forEach(function (tx) {
    reportLines(tx).forEach(function (line) {
      const cat = categories[line.categoryId];
      const kind = cat ? cat.kind : (line.cents >= 0 ? "income" : "expense");
      if (kind === "transfer") return;
      const key = cat ? line.categoryId : "";
      if (kind === "income") {
        out.incomeCents += line.cents;
        out.byCategory[key] = (out.byCategory[key] || 0) + line.cents;
      } else {
        out.spendingCents += -line.cents;
        out.byCategory[key] = (out.byCategory[key] || 0) + -line.cents;
      }
    });
  });
  out.netCents = out.incomeCents - out.spendingCents;
  return out;
}

/* Cash flow by month for [from, to] (inclusive month keys). */
export function cashFlow(transactions, categories, from, to) {
  const byMonth = {};
  monthRange(from, to).forEach(function (k) { byMonth[k] = []; });
  (transactions || []).forEach(function (tx) {
    const k = monthOf(tx.date);
    if (byMonth[k]) byMonth[k].push(tx);
  });
  const months = Object.keys(byMonth).sort().map(function (k) {
    const s = summarize(byMonth[k], categories);
    return { month: k, incomeCents: s.incomeCents, spendingCents: s.spendingCents, netCents: s.netCents, byCategory: s.byCategory };
  });
  const total = summarize((transactions || []).filter(function (tx) {
    const k = monthOf(tx.date); return k >= from && k <= to;
  }), categories);
  return { months: months, total: total };
}

/* Budget for one month: per category planned vs actual, with rollover.
   budgets: [{ month, categoryId, amountCents, rollover }]. Rollover
   carries a category's leftover (planned − spent, can go negative) from
   each earlier budgeted month into the next while that category's
   rollover flag is on in the month being carried INTO. */
export function budgetMonth(month, budgets, transactions, categories) {
  const months = {};
  (budgets || []).forEach(function (b) {
    (months[b.month] = months[b.month] || {})[b.categoryId] = b;
  });
  const keys = Object.keys(months).filter(function (k) { return k <= month; }).sort();
  const spentBy = {};
  function spentIn(k) {
    if (!spentBy[k]) {
      spentBy[k] = summarize((transactions || []).filter(function (tx) { return monthOf(tx.date) === k; }), categories).byCategory;
    }
    return spentBy[k];
  }
  const carry = {};
  keys.forEach(function (k) {
    if (k === month) return;
    const plan = months[k], spent = spentIn(k);
    Object.keys(plan).forEach(function (cid) {
      const b = plan[cid];
      const next = months[addMonths(k, 1)];
      const rolls = next && next[cid] ? !!next[cid].rollover : !!b.rollover;
      const left = (carry[cid] || 0) + b.amountCents - (spent[cid] || 0);
      carry[cid] = rolls ? left : 0;
    });
  });
  const plan = months[month] || {};
  const spent = spentIn(month);
  const ids = {};
  Object.keys(plan).forEach(function (c) { ids[c] = true; });
  Object.keys(spent).forEach(function (c) { if (c) ids[c] = true; });
  const rows = Object.keys(ids).map(function (cid) {
    const b = plan[cid];
    const planned = b ? b.amountCents : 0;
    const rolled = b && b.rollover ? (carry[cid] || 0) : 0;
    const actual = spent[cid] || 0;
    const cat = categories[cid] || {};
    return {
      categoryId: cid, kind: cat.kind || "expense", plannedCents: planned, rolloverCents: rolled,
      actualCents: actual, remainingCents: planned + rolled - actual, rollover: !!(b && b.rollover)
    };
  });
  const sum = function (kind, f) {
    return rows.filter(function (r) { return r.kind === kind; }).reduce(function (s, r) { return s + r[f]; }, 0);
  };
  return {
    month: month, rows: rows,
    plannedIncomeCents: sum("income", "plannedCents"), actualIncomeCents: sum("income", "actualCents"),
    plannedSpendingCents: sum("expense", "plannedCents"), actualSpendingCents: sum("expense", "actualCents")
  };
}

/* Rolling forecast: from today's cash, month by month for `count` months
   starting with the current month. A future month without its own
   budget repeats the latest budgeted month (budgets usually repeat).
   The current month only adds what is still to come: planned income not
   yet received, minus planned spending not yet spent. Recurring one-off
   bills that are not covered by a budget can be passed as extras:
   [{ month, cents }] (signed). */
export function forecast(opts) {
  const start = opts.cashCents || 0, current = opts.month, count = opts.count || 12;
  const budgets = opts.budgets || [], cats = opts.categories || {};
  const byMonth = {};
  budgets.forEach(function (b) { (byMonth[b.month] = byMonth[b.month] || []).push(b); });
  const budgeted = Object.keys(byMonth).sort();
  const oneOff = opts.oneOffCategoryIds || [];
  function planFor(k) {
    if (byMonth[k]) return byMonth[k];
    const earlier = budgeted.filter(function (m) { return m <= k; });
    /* A repeated month never repeats its one-off lines. */
    return earlier.length ? byMonth[earlier[earlier.length - 1]].filter(function (b) { return oneOff.indexOf(b.categoryId) === -1; }) : [];
  }
  function totals(list) {
    let inc = 0, exp = 0;
    list.forEach(function (b) {
      const kind = (cats[b.categoryId] || {}).kind || "expense";
      if (kind === "income") inc += b.amountCents; else if (kind === "expense") exp += b.amountCents;
    });
    return { inc: inc, exp: exp };
  }
  let balance = start;
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = addMonths(current, i);
    const t = totals(planFor(k));
    let net;
    if (i === 0) {
      const so = summarize((opts.transactions || []).filter(function (tx) { return monthOf(tx.date) === k; }), cats);
      net = Math.max(t.inc - so.incomeCents, 0) - Math.max(t.exp - so.spendingCents, 0);
    } else {
      net = t.inc - t.exp;
    }
    (opts.extras || []).forEach(function (x) { if (x.month === k) net += x.cents; });
    balance += net;
    out.push({ month: k, plannedIncomeCents: t.inc, plannedSpendingCents: t.exp, netCents: net, balanceCents: balance });
  }
  return out;
}

/* Net worth over time from balance snapshots: each account's last known
   balance carries forward; liabilities subtract. accounts: { [id]:
   { type, includeInNetWorth } }, snapshots: [{ accountId, date,
   balanceCents }] (liability balances are what is OWED, positive). */
export function netWorthSeries(accounts, snapshots) {
  const dates = Array.from(new Set((snapshots || []).map(function (s) { return s.date; }))).sort();
  const last = {};
  const sorted = (snapshots || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  let i = 0;
  return dates.map(function (d) {
    while (i < sorted.length && sorted[i].date <= d) { last[sorted[i].accountId] = sorted[i].balanceCents; i++; }
    let assets = 0, liabilities = 0;
    Object.keys(last).forEach(function (id) {
      const a = accounts[id];
      if (!a || a.includeInNetWorth === false || a.hidden) return;
      if (isLiability(a.type)) liabilities += last[id]; else assets += last[id];
    });
    return { date: d, assetsCents: assets, liabilitiesCents: liabilities, netWorthCents: assets - liabilities };
  });
}

/* ---- merchant names + rules ---- */

/* "SQ *BLUE BOTTLE #123 SF" -> "sq blue bottle sf": lower case, digits
   and punctuation dropped, spaces squeezed — what rules and recurring
   detection compare. */
export function merchantKey(name) {
  return String(name || "").toLowerCase().replace(/[0-9]+/g, " ").replace(/[^a-z&' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/* Does a rule match a transaction? A rule: { matchText, matchAccountId?,
   minCents?, maxCents? } — text is a case-insensitive "contains" on the
   merchant/description; amounts compare the absolute amount. */
export function ruleMatches(rule, tx) {
  if (!rule || !tx) return false;
  const text = merchantKey(rule.matchText);
  if (!text && !rule.matchAccountId && rule.minCents == null && rule.maxCents == null) return false;
  if (text && merchantKey((tx.merchant || "") + " " + (tx.description || "")).indexOf(text) === -1) return false;
  if (rule.matchAccountId && rule.matchAccountId !== tx.accountId) return false;
  const abs = Math.abs(tx.amountCents || 0);
  if (rule.minCents != null && abs < rule.minCents) return false;
  if (rule.maxCents != null && abs > rule.maxCents) return false;
  return true;
}

/* What the first matching rule (in order) would change on a transaction,
   or null. */
export function applyRules(rules, tx) {
  for (let i = 0; i < (rules || []).length; i++) {
    const r = rules[i];
    if (ruleMatches(r, tx)) {
      const change = {};
      if (r.setCategoryId) change.categoryId = r.setCategoryId;
      if (r.addTag) change.addTag = r.addTag;
      if (r.setHidden) change.hidden = true;
      return { ruleId: r.id, change: change };
    }
  }
  return null;
}

/* ---- recurring detection ---- */

function median(xs) {
  const s = xs.slice().sort(function (a, b) { return a - b; });
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Find bills and income that repeat: the same merchant at least 3 times
   (2 for yearly/quarterly is too thin, so those need 3 as well), at a
   steady interval that matches a cadence within 20%, with amounts
   within 25% of the median. Returns [{ key, merchant, cadence,
   amountCents (signed median), lastDate, nextDate, count, categoryId,
   accountId }], soonest first. */
export function detectRecurring(transactions, today) {
  const groups = {};
  (transactions || []).forEach(function (tx) {
    if (tx.hidden || tx.pending || !tx.amountCents) return;
    const key = merchantKey(tx.merchant || tx.description) + (tx.amountCents < 0 ? "|out" : "|in");
    if (key.length < 5) return;
    (groups[key] = groups[key] || []).push(tx);
  });
  const found = [];
  Object.keys(groups).forEach(function (key) {
    const list = groups[key].slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (list.length < 3) return;
    const gaps = [];
    for (let i = 1; i < list.length; i++) gaps.push(daysBetween(list[i - 1].date, list[i].date));
    if (gaps.some(function (g) { return g <= 0; })) return;
    const g = median(gaps);
    let cadence = null;
    CADENCES.forEach(function (c) {
      if (!cadence && Math.abs(g - CADENCE_DAYS[c]) <= CADENCE_DAYS[c] * 0.2) cadence = c;
    });
    if (!cadence) return;
    if (gaps.some(function (x) { return Math.abs(x - CADENCE_DAYS[cadence]) > CADENCE_DAYS[cadence] * 0.35; })) return;
    const amounts = list.map(function (t) { return t.amountCents; });
    const med = median(amounts);
    if (amounts.some(function (a) { return Math.abs(a - med) > Math.abs(med) * 0.25; })) return;
    const last = list[list.length - 1];
    let next = addDays(last.date, CADENCE_DAYS[cadence]);
    if (today) { while (next < today) next = addDays(next, CADENCE_DAYS[cadence]); }
    found.push({
      key: key, merchant: last.merchant || last.description, cadence: cadence, amountCents: Math.round(med),
      lastDate: last.date, nextDate: next, count: list.length, categoryId: last.categoryId || null, accountId: last.accountId || null
    });
  });
  return found.sort(function (a, b) { return a.nextDate < b.nextDate ? -1 : 1; });
}

/* Upcoming occurrences of recurring items within [from, to]. */
export function upcoming(items, from, to) {
  const out = [];
  (items || []).forEach(function (r) {
    if (r.status === "dismissed" || !r.nextDate || !CADENCE_DAYS[r.cadence]) return;
    let d = r.nextDate, guard = 0;
    while (d < from && guard++ < 500) d = addDays(d, CADENCE_DAYS[r.cadence]);
    while (d <= to && guard++ < 500) {
      out.push({ id: r.id, name: r.name || r.merchant, date: d, amountCents: r.amountCents, cadence: r.cadence, categoryId: r.categoryId || null });
      d = addDays(d, CADENCE_DAYS[r.cadence]);
    }
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

/* ---- goals ---- */

/* Progress of a savings goal: saved = the linked account's balance (or
   the manual amount), needed per month to hit the target by its date. */
export function goalProgress(goal, accountBalanceCents, todayMonth) {
  const saved = goal.accountId && accountBalanceCents != null ? accountBalanceCents : (goal.savedCents || 0);
  const target = goal.targetCents || 0;
  const left = Math.max(target - saved, 0);
  let perMonth = null, monthsLeft = null;
  if (goal.targetDate && todayMonth) {
    const tm = monthOf(goal.targetDate);
    monthsLeft = Math.max(monthRange(todayMonth, tm).length, 1);
    perMonth = Math.ceil(left / monthsLeft);
  }
  return { savedCents: saved, targetCents: target, leftCents: left, pct: target > 0 ? Math.min(saved / target, 1) : 0, perMonthCents: perMonth, monthsLeft: monthsLeft, done: target > 0 && saved >= target };
}

export function centsToDollars(c) { return Math.round(c) / 100; }
export function dollarsToCents(d) {
  const n = typeof d === "number" ? d : parseFloat(d);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
