/*
 * Shared expense categories + keyword-rule fallback categorizer.
 * (Files starting with "_" are not Pages routes.)
 * No API keys or personal data live here.
 */

export const CATEGORIES = [
  "Groceries", "Eating Out", "Rent", "Utilities", "Phone & Internet",
  "Fuel/Transport", "Insurance", "Subscriptions", "Shopping/Personal",
  "Gym", "Loan/Debt Payment", "One-off", "Misc/Other"
];

/* Daily-expense category -> monthly_actuals field used by the rollup.
   Gym and Misc/Other both live in otherExpenses; a Loan/Debt Payment
   rolls into otherLoan. Every other category maps to its own field. */
export const CATEGORY_TO_FIELD = {
  "Groceries": "groceries",
  "Eating Out": "eatingOut",
  "Rent": "rent",
  "Utilities": "utilities",
  "Phone & Internet": "phoneInternet",
  "Fuel/Transport": "gasTransport",
  "Insurance": "insurance",
  "Subscriptions": "subscriptions",
  "Shopping/Personal": "shopping",
  "Gym": "otherExpenses",
  "Loan/Debt Payment": "otherLoan",
  "One-off": "oneOffs",
  "Misc/Other": "otherExpenses"
};

const RULES = [
  ["Groceries", ["walmart", "fry's", "frys", "kroger", "safeway", "aldi", "trader joe", "whole foods", "costco", "grocery", "groceries", "supermarket", "instacart", "sprouts", "target grocery"]],
  ["Eating Out", ["restaurant", "cafe", "coffee", "starbucks", "dutch bros", "mcdonald", "chipotle", "pizza", "burger", "taco", "sushi", "doordash", "uber eats", "ubereats", "grubhub", "dining", "bakery", "dunkin"]],
  ["Rent", ["rent", "landlord", "apartment lease", "property management"]],
  ["Utilities", ["srp", "aps", "electric bill", "water bill", "utility", "utilities", "gas bill", "sewer", "trash bill"]],
  ["Phone & Internet", ["t-mobile", "tmobile", "verizon", "at&t", "xfinity", "comcast", "cox internet", "internet bill", "phone bill", "mint mobile"]],
  ["Fuel/Transport", ["shell", "chevron", "circle k", "qt", "quiktrip", "gas station", "fuel", "petrol", "uber", "lyft", "parking", "waymo", "valley metro", "car wash"]],
  ["Insurance", ["insurance", "geico", "progressive", "state farm", "allstate", "usaa"]],
  ["Subscriptions", ["netflix", "spotify", "hulu", "youtube premium", "apple.com/bill", "icloud", "amazon prime", "prime membership", "subscription", "chatgpt", "claude", "gym membership app"]],
  ["Gym", ["gym", "fitness", "eos fitness", "planet fitness", "la fitness", "yoga", "crossfit"]],
  ["Loan/Debt Payment", ["credila", "loan payment", "emi", "credit card payment", "card payment", "chase card", "amex payment", "discover card", "student loan", "navient", "mohela"]],
  ["Shopping/Personal", ["amazon", "target", "best buy", "nike", "h&m", "zara", "clothing", "haircut", "barber", "salon", "walgreens", "cvs"]]
];

export function categorizeByRules(description) {
  const text = String(description || "").toLowerCase();
  for (const [category, keywords] of RULES) {
    for (const kw of keywords) {
      if (text.includes(kw)) return category;
    }
  }
  return "Misc/Other";
}

export function isValidCategory(category) {
  return CATEGORIES.includes(category);
}
