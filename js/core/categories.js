/* Daily expense categories, how they map to plan fields, and keyword categorization. */

/* ---- Daily expenses + categories (mirrors functions/api/_categories.js) ---- */

export const DAILY_CATEGORIES = [
  "Groceries", "Eating Out", "Rent", "Utilities", "Phone & Internet",
  "Fuel/Transport", "Insurance", "Subscriptions", "Shopping/Personal",
  "Gym", "Loan/Debt Payment", "One-off", "Misc/Other"
];

export const CATEGORY_TO_FIELD = {
  "Groceries": "groceries", "Eating Out": "eatingOut", "Rent": "rent",
  "Utilities": "utilities", "Phone & Internet": "phoneInternet",
  "Fuel/Transport": "gasTransport", "Insurance": "insurance",
  "Subscriptions": "subscriptions", "Shopping/Personal": "shopping",
  "Gym": "otherExpenses", "Loan/Debt Payment": "otherLoan",
  "One-off": "oneOffs", "Misc/Other": "otherExpenses"
};

export const RULE_KEYWORDS = [
  ["Groceries", ["walmart", "fry's", "frys", "kroger", "safeway", "aldi", "trader joe", "whole foods", "costco", "grocery", "groceries", "supermarket", "instacart", "sprouts"]],
  ["Eating Out", ["restaurant", "cafe", "coffee", "starbucks", "mcdonald", "chipotle", "pizza", "burger", "taco", "sushi", "doordash", "uber eats", "grubhub", "dining", "dunkin"]],
  ["Rent", ["rent", "landlord", "apartment lease"]],
  ["Utilities", ["srp", "aps", "electric bill", "water bill", "utility", "utilities", "gas bill"]],
  ["Phone & Internet", ["t-mobile", "tmobile", "verizon", "at&t", "xfinity", "comcast", "cox internet", "internet bill", "phone bill", "mint mobile"]],
  ["Fuel/Transport", ["shell", "chevron", "circle k", "quiktrip", "gas station", "fuel", "uber", "lyft", "parking", "waymo", "car wash"]],
  ["Insurance", ["insurance", "geico", "progressive", "state farm", "allstate", "usaa"]],
  ["Subscriptions", ["netflix", "spotify", "hulu", "youtube premium", "icloud", "amazon prime", "subscription", "chatgpt", "claude"]],
  ["Gym", ["gym", "fitness", "eos fitness", "planet fitness", "la fitness", "yoga", "crossfit"]],
  ["Loan/Debt Payment", ["credila", "loan payment", "emi", "credit card payment", "card payment", "student loan"]],
  ["Shopping/Personal", ["amazon", "target", "best buy", "nike", "h&m", "zara", "clothing", "haircut", "barber", "salon", "walgreens", "cvs"]]
];

export function categorizeByRulesJs(description) {
  var text = String(description || "").toLowerCase();
  for (var i = 0; i < RULE_KEYWORDS.length; i++) {
    for (var j = 0; j < RULE_KEYWORDS[i][1].length; j++) {
      if (text.indexOf(RULE_KEYWORDS[i][1][j]) !== -1) return RULE_KEYWORDS[i][0];
    }
  }
  return "Misc/Other";
}
