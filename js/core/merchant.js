/* "Always file this merchant under ..." rules: { match, category }.
   match is a cleaned-up piece of the description ("fox rent a car");
   an expense whose cleaned description contains it gets that category.
   The longest match wins, so "amazon prime" beats "amazon". */
import { DAILY_CATEGORIES } from "./categories.js";

export var MERCHANT_RULES_CAP = 200;

/* Lowercase, digits and punctuation dropped, spaces collapsed:
   "FOX RENT A CAR #123 PHOENIX" -> "fox rent a car phoenix". */
export function merchantKey(description) {
  return String(description || "").toLowerCase().replace(/[^a-z&]+/g, " ").replace(/\s+/g, " ").trim();
}

export function merchantCategory(rules, description) {
  var text = " " + merchantKey(description) + " ";
  var best = null;
  (rules || []).forEach(function (r) {
    if (r && r.match && text.indexOf(" " + r.match + " ") !== -1 && (!best || r.match.length > best.match.length)) best = r;
  });
  return best ? best.category : null;
}

export function sanitizeMerchantRules(rules) {
  var out = [], seen = {};
  (Array.isArray(rules) ? rules : []).slice(0, MERCHANT_RULES_CAP).forEach(function (r) {
    var match = r && merchantKey(r.match).slice(0, 100);
    if (!match || seen[match] || DAILY_CATEGORIES.indexOf(r.category) === -1) return;
    seen[match] = true;
    out.push({ match: match, category: r.category });
  });
  return out;
}
