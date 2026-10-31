/* Reads a purchase out of an Ask question without an AI call:
   "Can I afford a $1,300 iPhone in December?" ->
   { amount: 1300, monthKey: "2026-12", monthly: false, months: 1 }.
   Returns null when the question isn't about spending a specific
   amount (then Ask answers it as a general question). */
import { MONTHS } from "./plan.js";

var MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parsePurchase(question, todayIso) {
  var q = String(question || "").toLowerCase();
  if (!/\b(afford|buy|spend|purchase|pay for|get|book|order)\b/.test(q)) return null;
  var m = q.match(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b)?/) ||
    q.match(/\b([\d,]+(?:\.\d{1,2})?)\s*(k)?\s*(?:dollars|usd|bucks)\b/) ||
    q.match(/\b(\d+(?:\.\d+)?)(k)\b/);
  if (!m) return null;
  var amount = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  if (!(amount > 0)) return null;

  var keys = MONTHS.map(function (x) { return x.key; });
  var today = String(todayIso || "").slice(0, 7);
  var year = parseInt(today.slice(0, 4), 10), month = parseInt(today.slice(5, 7), 10);
  var shift = function (n) {
    var d = new Date(Date.UTC(year, month - 1 + n, 1));
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  };
  var monthKey = today;
  var named = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(20\d\d))?/);
  var inN = q.match(/\bin\s+(\d+)\s+months?\b/);
  if (/\bnext month\b/.test(q)) monthKey = shift(1);
  else if (inN) monthKey = shift(parseInt(inN[1], 10));
  else if (named && !(named[1] === "may" && !/\bin may\b|\bmay\s+20\d\d\b/.test(q))) {
    var idx = MONTH_NAMES.indexOf(named[1]) + 1;
    var y = named[2] ? parseInt(named[2], 10) : idx >= month ? year : year + 1; /* the next one coming up */
    monthKey = y + "-" + String(idx).padStart(2, "0");
  }
  if (keys.indexOf(monthKey) === -1) monthKey = keys.indexOf(today) !== -1 ? today : keys[0];

  var monthly = /\b(per month|a month|monthly|each month|every month|\/\s?mo\b|a mo\b)/.test(q);
  var forN = q.match(/\bfor\s+(\d+)\s+months?\b/);
  var left = keys.length - keys.indexOf(monthKey);
  var months = monthly ? Math.min(left, forN ? parseInt(forN[1], 10) : left) : 1;
  return { amount: Math.round(amount * 100) / 100, monthKey: monthKey, monthly: monthly, months: months };
}
