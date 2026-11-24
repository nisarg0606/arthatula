/* The bank feed's part of a feed-claimed month, shaped for the two
   Dashboard graphs that draw from the daily log. The server marker
   on the month's stored actual (actual.feedRollup) carries the
   feed's spending in cents, by day of month and by category name,
   next to its per-field shares (see the feed rollup in
   functions/api/budget.js). This reader turns those two maps into
   dollars for the graphs to add on top of the log's figures.
   A month the feed never claimed, and a marker written before the
   by-day and by-category sums existed, both yield two empty maps:
   the graphs then draw the log alone, exactly as they always have. */

function dollarMap(raw, daysOnly) {
  var out = {};
  if (!raw || typeof raw !== "object") return out;
  Object.keys(raw).forEach(function (k) {
    var v = raw[k];
    if (typeof v !== "number" || !isFinite(v) || v === 0) return;
    if (daysOnly) {
      var d = Number(k);
      if (d < 1 || d > 31 || Math.floor(d) !== d) return;
      out[String(d)] = Math.round(v) / 100;
    } else {
      out[k] = Math.round(v) / 100;
    }
  });
  return out;
}

export function feedChartData(actual) {
  var marker = actual && typeof actual === "object" ? actual.feedRollup : null;
  if (!marker || typeof marker !== "object") return { perDay: {}, byCategory: {} };
  return {
    perDay: dollarMap(marker.perDayCents, true),
    byCategory: dollarMap(marker.byCategoryCents, false)
  };
}

/* The feed's charges in a feed-claimed month, shaped like daily-log
   entries so the Dashboard's lists (Pace, a day's bar, a category
   slice) can show them next to the log's own rows: { date,
   description, amount (dollars; a refund is negative), category
   (the money model's name), field (the classic actual field),
   fromFeed: true }. A marker written before the items existed, or
   none at all, yields an empty list. */
export function feedItems(actual) {
  var marker = actual && typeof actual === "object" ? actual.feedRollup : null;
  var raw = marker && Array.isArray(marker.items) ? marker.items : [];
  var out = [];
  raw.forEach(function (it) {
    if (!it || typeof it !== "object") return;
    if (typeof it.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) return;
    if (typeof it.cents !== "number" || !isFinite(it.cents) || it.cents === 0) return;
    out.push({
      date: it.date,
      description: typeof it.merchant === "string" && it.merchant ? it.merchant : "Bank charge",
      amount: Math.round(it.cents) / 100,
      myShare: null,
      category: typeof it.category === "string" && it.category ? it.category : "Misc/Other",
      field: typeof it.field === "string" ? it.field : "otherExpenses",
      card: "Bank feed",
      fromFeed: true
    });
  });
  return out;
}

/* The feed's share of one classic expense field, in dollars (the
   marker's per-field cents), and its total spending in the month
   (the sum of its by-day spending, which is what the Daily spending
   chart adds). 0 for an unclaimed month. */
export function feedFieldDollars(actual, field) {
  var marker = actual && typeof actual === "object" ? actual.feedRollup : null;
  var v = marker ? marker[field] : 0;
  return typeof v === "number" && isFinite(v) ? Math.round(v) / 100 : 0;
}

export function feedSpendingDollars(actual) {
  var perDay = feedChartData(actual).perDay;
  var total = 0;
  Object.keys(perDay).forEach(function (k) { total += perDay[k]; });
  return Math.round(total * 100) / 100;
}
