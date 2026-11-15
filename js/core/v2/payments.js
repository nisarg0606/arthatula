/* Payment timing: the pure half of the Cash flow screen's Payments
   section (the DOM lives in js/ui/v2/cashflow.js).
 *
 * The expense log and the charge-date cash flow answer "what did I
 * spend, by the day I spent it". This answers the other question:
 * "when does the money actually leave, and will I have it?" A charge
 * on a credit card leaves when that card's statement is paid, so each
 * card charge is filed under the month of the DUE DATE of the
 * statement period it falls in. Everything else (rent from checking,
 * income, cash) stays in its own month.
 *
 * No double counting: the classic log's pre-filed "One-off" entries
 * are card-bill settlements — placeholders for paying charges that
 * are already in the log on their own dates (see isSpending in
 * js/core/spending.js) — so they are left out here; the charges
 * themselves land at their due month instead. Real card payments
 * (the "Credit card payment" transfer) are transfers, which reports
 * never count, so the payment itself is not counted either.
 *
 * Statement cycles: an account carries the current cycle
 * (statementStart, statementEnd, dueDate). Cycles before or after it
 * are the same cycle rolled by whole months, so future charges get a
 * projected due date from the card's current rhythm. All money stays
 * integer cents, like the rest of the v2 model. */
import { monthOf, addDays, monthRange, reportLines } from "./money.js";

/* A date shifted by whole months, the day clamped to the target
   month's length (Jan 31 + 1 month = Feb 28). */
export function addMonthsToDate(date, n) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1 + n, d = Number(date.slice(8, 10));
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return yy + "-" + String(mm + 1).padStart(2, "0") + "-" + String(Math.min(d, last)).padStart(2, "0");
}

/* The statement cycle of a credit account that contains `date`:
   { start, end, due } or null when the account has no statement
   dates. A card with an end but no due date gets the usual
   grace-period guess of 21 days after the statement closes. */
export function cycleFor(account, date) {
  if (!account || !account.statementStart || !account.statementEnd || !date) return null;
  /* Synced accounts carry the current (open) statement period with
     the PREVIOUS statement's due date — Plaid reports the last issued
     statement's due date, and a statement is never due before it
     closes. A due date on or before the close therefore belongs to
     the cycle before, and this cycle's due date is one month on. */
  let due0 = account.dueDate || addDays(account.statementEnd, 21);
  if (account.dueDate && account.dueDate <= account.statementEnd) due0 = addMonthsToDate(account.dueDate, 1);
  let n = 0;
  while (date > addMonthsToDate(account.statementEnd, n) && n < 240) n++;
  while (date < addMonthsToDate(account.statementStart, n) && n > -240) n--;
  return {
    start: addMonthsToDate(account.statementStart, n),
    end: addMonthsToDate(account.statementEnd, n),
    due: addMonthsToDate(due0, n)
  };
}

/* When the money for a transaction leaves: the due date of its card
   statement, or the transaction's own date for anything not charged
   to a card with a known cycle. */
export function paymentDateFor(tx, account) {
  if (tx && account && account.type === "credit") {
    const c = cycleFor(account, tx.date);
    if (c) return c.due;
  }
  return tx ? tx.date : null;
}

/* A pre-filed card-bill settlement (see the header): its category is
   the one named "One-off", the same marker the forecast uses. */
export function isCardBillTx(tx, categories) {
  if (!tx) return false;
  const cat = (categories || {})[tx.categoryId];
  return !!cat && cat.name === "One-off";
}

/* A bill due in the first days of a month lands just after the
   previous month's end-of-month paycheck (paydays: mid-month and
   month-end), so that paycheck is the one that covers it. */
export function fundedByPriorPaycheck(dueDate) {
  return !!dueDate && Number(dueDate.slice(8, 10)) <= 10;
}

/* Income and money out per month over [from, to] on the payment
   basis. transactions / categories / accounts are the v2 shapes
   (categories as an id -> category index). Returns
   { months: [{ month, incomeCents, outCents, netCents, byCategory }],
     bills: [{ accountId, name, mask, dueDate, month, cents, count }],
     total: { incomeCents, outCents, netCents, byCategory } }
   with outCents positive (money leaving) and byCategory in the same
   signed style as summarize(): income positive, spending positive. */
export function paymentFlow(transactions, categories, accounts, from, to) {
  const cats = categories || {};
  const acctById = {};
  (accounts || []).forEach(function (a) { if (a && a.id) acctById[a.id] = a; });
  const months = {};
  monthRange(from, to).forEach(function (k) { months[k] = { month: k, incomeCents: 0, outCents: 0, netCents: 0, byCategory: {} }; });
  const billByKey = {};
  const chargeOut = {};
  (transactions || []).forEach(function (tx) {
    if (!tx || isCardBillTx(tx, cats)) return;
    const lines = reportLines(tx);
    if (!lines.length) return;
    const acct = tx.accountId ? acctById[tx.accountId] : null;
    const payMonth = monthOf(paymentDateFor(tx, acct));
    const bucket = months[payMonth];
    if (!bucket) return;
    let billCents = 0;
    lines.forEach(function (line) {
      const cat = cats[line.categoryId];
      const kind = cat ? cat.kind : (line.cents >= 0 ? "income" : "expense");
      if (kind === "transfer") return;
      const key = cat ? line.categoryId : "";
      if (kind === "income") {
        bucket.incomeCents += line.cents;
        bucket.byCategory[key] = (bucket.byCategory[key] || 0) + line.cents;
        billCents -= line.cents;
      } else {
        bucket.outCents += -line.cents;
        bucket.byCategory[key] = (bucket.byCategory[key] || 0) + -line.cents;
        billCents -= line.cents;
        const cm = monthOf(tx.date);
        chargeOut[cm] = (chargeOut[cm] || 0) + -line.cents;
      }
    });
    /* Every transaction in the cycle moves the statement total —
       a refund lowers it — so bills accumulate signed deltas and
       only a statement that ends up owed nothing drops out. */
    if (acct && acct.type === "credit" && billCents !== 0) {
      const due = paymentDateFor(tx, acct);
      if (due !== tx.date) {
        const key = acct.id + "|" + due;
        const cyc = cycleFor(acct, tx.date);
        const b = billByKey[key] || (billByKey[key] = {
          accountId: acct.id, name: acct.name || "Card", mask: acct.mask || "",
          dueDate: due, month: monthOf(due), cents: 0, count: 0,
          closes: cyc ? cyc.end : null
        });
        b.cents += billCents;
        b.count += 1;
      }
    }
  });
  const list = Object.keys(months).sort().map(function (k) {
    const m = months[k];
    m.netCents = m.incomeCents - m.outCents;
    return m;
  });
  const total = { incomeCents: 0, outCents: 0, netCents: 0, byCategory: {} };
  list.forEach(function (m) {
    total.incomeCents += m.incomeCents;
    total.outCents += m.outCents;
    Object.keys(m.byCategory).forEach(function (id) { total.byCategory[id] = (total.byCategory[id] || 0) + m.byCategory[id]; });
  });
  total.netCents = total.incomeCents - total.outCents;
  const bills = Object.keys(billByKey).map(function (k) { return billByKey[k]; })
    .filter(function (b) { return b.cents > 0; })
    .sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0; });
  return { months: list, bills: bills, total: total, chargeOutByMonth: chargeOut };
}

/* Planned income for the range with the forecast's convention: a
   month with no plan of its own repeats the most recent planned
   month before it. planned: { month: cents } as far as known. */
export function carryPlannedIncome(planned, from, to) {
  const out = {};
  let last = 0;
  monthRange(from, to).forEach(function (k) {
    const v = (planned || {})[k];
    if (typeof v === "number" && v > 0) last = v;
    out[k] = last;
  });
  return out;
}

/* For the current month onward, a month's income is its plan when it
   has one — the paychecks have not all landed yet — or what already
   came in, when that is more. Earlier months keep their actuals.
   Returns fresh month rows with netCents recomputed. */
export function applyPlannedIncome(months, planned, currentMonth) {
  return (months || []).map(function (m) {
    const p = (planned || {})[m.month] || 0;
    const income = m.month >= currentMonth && p > 0 ? Math.max(m.incomeCents, p) : m.incomeCents;
    return { month: m.month, incomeCents: income, outCents: m.outCents, netCents: income - m.outCents, byCategory: m.byCategory };
  });
}

/* Months after the current one also carry what is still to come
   from the plan: planned spending for the month minus what has
   already been spent in it on a charge basis — the remainder
   convention the forecast uses for the current month. Regular
   charges like rent and utilities live in the plan until they post,
   so a future month is not just the card bills already visible.
   The current month and earlier stay on actuals alone: their
   regular charges have largely posted already. */
export function applyPlannedSpending(months, planned, chargeOutByMonth, currentMonth) {
  return (months || []).map(function (m) {
    if (m.month <= currentMonth) return m;
    const add = Math.max(((planned || {})[m.month] || 0) - ((chargeOutByMonth || {})[m.month] || 0), 0);
    if (!add) return m;
    const out = m.outCents + add;
    return { month: m.month, incomeCents: m.incomeCents, outCents: out, netCents: m.incomeCents - out, byCategory: m.byCategory };
  });
}

/* Running balance from startCents (cash today), applied from
   anchorMonth onward; earlier months get balanceCents null (their
   money already moved before the anchor). shortfall marks a month
   whose balance ends under zero. */
export function runningBalances(months, startCents, anchorMonth) {
  let bal = startCents || 0;
  return (months || []).map(function (m) {
    if (m.month < anchorMonth) return Object.assign({}, m, { balanceCents: null, shortfall: false });
    bal += m.netCents;
    return Object.assign({}, m, { balanceCents: bal, shortfall: bal < 0 });
  });
}

/* The tightest month of a running-balance list, or null. */
export function lowestBalance(months) {
  let low = null;
  (months || []).forEach(function (m) {
    if (m.balanceCents === null || m.balanceCents === undefined) return;
    if (!low || m.balanceCents < low.balanceCents) low = { month: m.month, balanceCents: m.balanceCents };
  });
  return low;
}

