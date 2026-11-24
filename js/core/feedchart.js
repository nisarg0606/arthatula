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
