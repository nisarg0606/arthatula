/* The 13-month plan: months, fields, blank and sanitized state, monthly totals. */
import { sanitizeCard } from "./cards.js";
import { DAILY_CATEGORIES } from "./categories.js";
import { sanitizeMerchantRules } from "./merchant.js";
import { sanitizeMyShare } from "./spending.js";

/*
 * Arthatula — 12-month savings planner.
 *
 * Storage:
 *  - Primary: Cloudflare D1 via Pages Functions at /api/budget (same
 *    live-data model as a shared tracker: data follows you across devices).
 *  - Fallback: browser localStorage, used only when the API is unreachable
 *    (local development, or static hosting on Netlify/Vercel without D1).
 * The header badge shows which mode is active: "Database" or "Local only".
 *
 * Default state is blank: every amount starts at zero. Use Export/Import
 * JSON to move your own numbers between devices or back them up.
 */


export const MONTHS = [
  { key: "2026-10", label: "Oct 2026" },
  { key: "2026-11", label: "Nov 2026" },
  { key: "2026-12", label: "Dec 2026" },
  { key: "2027-01", label: "Jan 2027" },
  { key: "2027-02", label: "Feb 2027" },
  { key: "2027-03", label: "Mar 2027" },
  { key: "2027-04", label: "Apr 2027" },
  { key: "2027-05", label: "May 2027" },
  { key: "2027-06", label: "Jun 2027" },
  { key: "2027-07", label: "Jul 2027" },
  { key: "2027-08", label: "Aug 2027" },
  { key: "2027-09", label: "Sep 2027" },
  { key: "2027-10", label: "Oct 2027" }
];

export const NUMBER_FIELDS = [
  { key: "takeHomePay", label: "Take-home pay ($)", group: "Income" },
  { key: "otherIncome", label: "Other income ($)", group: "Income" },
  { key: "rent", label: "Rent ($)", group: "Expenses" },
  { key: "utilities", label: "Utilities ($)", group: "Expenses" },
  { key: "phoneInternet", label: "Phone & internet ($)", group: "Expenses" },
  { key: "groceries", label: "Groceries ($)", group: "Expenses" },
  { key: "eatingOut", label: "Eating out / coffee ($)", group: "Expenses" },
  { key: "gasTransport", label: "Gas / transport ($)", group: "Expenses" },
  { key: "insurance", label: "Insurance ($)", group: "Expenses" },
  { key: "subscriptions", label: "Subscriptions ($)", group: "Expenses" },
  { key: "shopping", label: "Shopping / personal ($)", group: "Expenses" },
  { key: "credilaEmi", label: "Credila loan EMI ($)", group: "Debts & one-offs" },
  { key: "creditCardPayment", label: "Credit card payment ($)", group: "Debts & one-offs" },
  { key: "otherLoan", label: "Other loan payment ($)", group: "Debts & one-offs" },
  { key: "oneOffs", label: "One-off expenses ($)", group: "Debts & one-offs" },
  { key: "otherExpenses", label: "Other expenses ($)", group: "Expenses" }
];

export const TEXT_FIELDS = [
  { key: "oneOffNote", label: "One-off note (what the one-off is)" },
  { key: "note", label: "Month note" }
];

export const INCOME_KEYS = ["takeHomePay", "otherIncome"];

export const EXPENSE_KEYS = NUMBER_FIELDS.map(function (f) { return f.key; })
  .filter(function (k) { return INCOME_KEYS.indexOf(k) === -1; });

export const STORAGE_KEY = "arthatula-v1";

export const API_URL = "/api/budget";

export const EXPENSE_FIELD_KEYS = NUMBER_FIELDS.map(function (f) { return f.key; })
  .filter(function (k) { return k !== "takeHomePay" && k !== "otherIncome"; });

export function blankMonth(key) {
  var m = { monthKey: key };
  NUMBER_FIELDS.forEach(function (f) { m[f.key] = 0; });
  TEXT_FIELDS.forEach(function (f) { m[f.key] = ""; });
  return m;
}

export function blankActualMonth(key) {
  var a = { monthKey: key, entered: false };
  NUMBER_FIELDS.forEach(function (f) { a[f.key] = 0; });
  return a;
}

export function blankState() {
  return {
    /* The prediction is anchored to actuals: the starting balance is the
       actual balance on the baseline date (default 2026-10-26). */
    baselineDate: "2026-10-26",
    baselineNote: "",
    startingBalance: 0,
    months: MONTHS.map(function (m) { return blankMonth(m.key); }),
    actuals: MONTHS.map(function (m) { return blankActualMonth(m.key); }),
    dailyExpenses: [],
    cards: [],
    merchantRules: []
  };
}

/* ---- Credit cards (statement cycles) ----
 * A card bill is due in a later month/paycheck than the spending, so a
 * card records its statement period; the Cards page groups that card's
 * daily expenses inside the window. Cards are matched to expenses by
 * NAME (the tag picked when the expense was logged). */

export function isValidDateStrJs(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  var p = v.split("-").map(Number);
  var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return dt.getUTCFullYear() === p[0] && dt.getUTCMonth() === p[1] - 1 && dt.getUTCDate() === p[2];
}

export function toNumber(v) {
  var n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function sanitizeState(raw) {
  var state = blankState();
  if (!raw || typeof raw !== "object") return state;
  state.startingBalance = toNumber(raw.startingBalance);
  if (typeof raw.baselineDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.baselineDate)) {
    state.baselineDate = raw.baselineDate;
  }
  if (typeof raw.baselineNote === "string") state.baselineNote = raw.baselineNote.slice(0, 500);
  if (Array.isArray(raw.months)) {
    raw.months.forEach(function (rm) {
      if (!rm || typeof rm !== "object") return;
      var target = null;
      state.months.forEach(function (m) { if (m.monthKey === rm.monthKey) target = m; });
      if (!target) return;
      NUMBER_FIELDS.forEach(function (f) { if (rm[f.key] !== undefined) target[f.key] = toNumber(rm[f.key]); });
      TEXT_FIELDS.forEach(function (f) { if (typeof rm[f.key] === "string") target[f.key] = rm[f.key].slice(0, 500); });
    });
  }
  if (Array.isArray(raw.actuals)) {
    raw.actuals.forEach(function (ra) {
      if (!ra || typeof ra !== "object") return;
      var target = null;
      state.actuals.forEach(function (a) { if (a.monthKey === ra.monthKey) target = a; });
      if (!target) return;
      NUMBER_FIELDS.forEach(function (f) { if (ra[f.key] !== undefined) target[f.key] = toNumber(ra[f.key]); });
      target.entered = ra.entered === true ||
        NUMBER_FIELDS.some(function (f) { return target[f.key] !== 0; });
    });
  }
  if (Array.isArray(raw.dailyExpenses)) {
    raw.dailyExpenses.forEach(function (re) {
      if (!re || typeof re !== "object") return;
      if (typeof re.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(re.date)) return;
      var amt = toNumber(re.amount);
      state.dailyExpenses.push({
        id: re.id !== undefined ? re.id : null,
        date: re.date,
        description: typeof re.description === "string" ? re.description.slice(0, 300) : "",
        amount: amt,
        category: DAILY_CATEGORIES.indexOf(re.category) !== -1 ? re.category : "Misc/Other",
        categorizationSource: ["gemini", "rules", "manual", "merchant"].indexOf(re.categorizationSource) !== -1
          ? re.categorizationSource : "rules",
        card: typeof re.card === "string" && re.card.trim() ? re.card.trim().slice(0, 100) : null,
        myShare: sanitizeMyShare(re.myShare, amt),
        bankTxId: typeof re.bankTxId === "string" && re.bankTxId ? re.bankTxId.slice(0, 200) : null,
        pendingTxId: typeof re.pendingTxId === "string" && re.pendingTxId ? re.pendingTxId.slice(0, 200) : null,
        pendingSettled: re.pendingSettled === true,
        note: typeof re.note === "string" ? re.note.slice(0, 500) : ""
      });
    });
    state.dailyExpenses.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }
  state.merchantRules = sanitizeMerchantRules(raw.merchantRules);
  if (Array.isArray(raw.cards)) {
    raw.cards.forEach(function (rc) {
      var c = sanitizeCard(rc);
      if (c) state.cards.push(c);
    });
  }
  return state;
}

export function monthIncome(m) { return INCOME_KEYS.reduce(function (s, k) { return s + (m[k] || 0); }, 0); }

export function monthExpenses(m) { return EXPENSE_KEYS.reduce(function (s, k) { return s + (m[k] || 0); }, 0); }
