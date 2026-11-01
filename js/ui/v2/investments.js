/* Investments screen: the nightly market recap, then your investment
   accounts' total value over time (from the daily balances the sync
   records), how it changed, an optional S&P 500 line to compare, and
   each account. The recap card is shared with Home. */
import { keepScroll } from "../scroll.js";
import { api, h, clear, money, shortDay, dayLabel, section, button, emptyState, errorState, loading, drawChart, chartColors } from "./kit.js";

let root = null, range = "3m", data = null, goTo = null;
let sortKey = "value", sortDir = -1; /* holdings sort: -1 = high first */
const SORTS = [["value", "Value"], ["gain", "Gain $"], ["gainpct", "Gain %"], ["name", "Name"]];
export function setNavigator(fn) { goTo = fn; }

const RANGES = [["1m", "1M", 30], ["3m", "3M", 91], ["1y", "1Y", 365], ["all", "All", null]];
const pct = function (v) { return v === null || v === undefined ? "" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; };

function changeText(c) {
  if (!c) return "—";
  return money(c.cents, { signed: true, whole: true }) + (c.pct === null ? "" : " (" + pct(c.pct) + ")");
}
function cls(c) { return !c || !c.cents ? "" : c.cents > 0 ? "pos" : "neg"; }

/* The recap card: summary, one chip per fund, headlines. */
export function marketCard(m, opts) {
  const o = opts || {};
  const body = h("div", { class: "v2-market" });
  if (m.status === "nokey" && !m.latest) {
    body.appendChild(h("p", { class: "hint", text: "Add a free Finnhub key in Settings → Market data to get a short recap of the US market every evening after the close." }));
    body.appendChild(button("Open Settings", function () { goTo && goTo("settings"); }, "v2-mini"));
  } else if (!m.latest) {
    body.appendChild(h("p", { class: "hint", text: m.status === "error" ? "Couldn't get market data: " + (m.error || "unknown error") + ". It tries again in a few minutes." : "The first recap appears after the next market close (4 pm New York)." }));
  } else {
    const l = m.latest;
    body.appendChild(h("p", { class: "v2-market-date hint", text: dayLabel(l.date) + (l.by && l.by !== "numbers" ? " · written by AI from the day's numbers and headlines" : "") }));
    body.appendChild(h("div", { class: "v2-market-chips" }, l.quotes.map(function (q) {
      return h("span", { class: "v2-market-chip " + (q.changePct >= 0 ? "pos" : "neg"), attrs: { title: q.symbol + " closed at " + q.close.toFixed(2) } },
        h("strong", { text: q.name }), h("span", { text: pct(q.changePct) }));
    })));
    body.appendChild(h("p", { class: "v2-market-text", text: l.summary }));
    if (m.status === "error") body.appendChild(h("p", { class: "hint neg", text: "Couldn't get today's update: " + (m.error || "unknown error") + "." }));
    if (o.full && l.news && l.news.length) {
      body.appendChild(h("details", { class: "v2-market-news" }, h("summary", { text: "Headlines" }),
        h("ul", null, l.news.map(function (n) {
          return h("li", null, n.url ? h("a", { text: n.headline, attrs: { href: n.url, target: "_blank", rel: "noopener noreferrer" } }) : h("span", { text: n.headline }), n.source ? h("span", { class: "hint", text: " · " + n.source }) : null);
        }))));
    }
    if (o.full && m.history && m.history.length) {
      body.appendChild(h("details", { class: "v2-market-news" }, h("summary", { text: "Earlier days" }),
        h("ul", null, m.history.map(function (d) {
          return h("li", null, h("strong", { text: dayLabel(d.date) + ": " }), h("span", { text: d.summary }));
        }))));
    }
  }
  const actions = o.full ? [] : [button("Investments", function () { goTo && goTo("investments"); }, "v2-mini")];
  return section("Market today", actions, body, "v2-market-card");
}

function inRange(series) {
  const r = RANGES.find(function (x) { return x[0] === range; });
  if (!r[2] || !series.length) return series;
  const end = Date.parse(series[series.length - 1].date);
  return series.filter(function (p) { return end - Date.parse(p.date) <= r[2] * 864e5; });
}

/* SPY scaled to start where your line starts, for days both have. */
function benchmarkLine(points, bench) {
  if (bench.length < 2 || points.length < 2) return null;
  const closeOn = function (d) { let c = null; for (let i = 0; i < bench.length && bench[i].date <= d; i++) c = bench[i].close; return c; };
  const base = closeOn(points[0].date);
  if (!base) return null;
  const line = points.map(function (p) { const c = closeOn(p.date); return c ? Math.round(points[0].valueCents * c / base) / 100 : null; });
  return line.filter(function (v) { return v !== null; }).length >= 2 ? line : null;
}

/* Quantity without trailing zeros: whole shares stay "10", crypto
   dust keeps the decimals it needs. */
function fmtQty(q) {
  if (q === null || q === undefined) return "";
  const v = Math.abs(q) >= 100 ? Math.round(q * 100) / 100 : q;
  return String(Math.round(v * 1e8) / 1e8);
}

function gainOf(hd) {
  if (hd.kind === "cash" || hd.costBasisCents === null || hd.costBasisCents === undefined || hd.valueCents === null || hd.valueCents === undefined) return null;
  const cents = hd.valueCents - hd.costBasisCents;
  return { cents: cents, pct: hd.costBasisCents ? Math.round(cents / hd.costBasisCents * 10000) / 100 : null };
}

/* Sort keys for positions; rows without the number being sorted on
   (cash, or a position with no cost basis) always sink to the end. */
function sortValue(hd, key) {
  const g = gainOf(hd);
  if (key === "gain") return g ? g.cents : null;
  if (key === "gainpct") return g ? g.pct : null;
  if (key === "name") return null;
  return hd.valueCents === undefined ? null : hd.valueCents;
}
function sortedHoldings(list) {
  const out = list.slice();
  out.sort(function (x, y) {
    if (sortKey === "name") {
      const a = (x.ticker || x.name || "").toLowerCase(), b = (y.ticker || y.name || "").toLowerCase();
      return a < b ? -sortDir : a > b ? sortDir : 0;
    }
    const a = sortValue(x, sortKey), b = sortValue(y, sortKey);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * (sortDir < 0 ? -1 : 1); /* sortDir -1 = high first */
  });
  return out;
}

function holdingsSection(d) {
  const byId = {};
  d.accounts.forEach(function (a) { byId[a.id] = a; });
  let value = 0, costedValue = 0, cost = 0;
  d.holdings.forEach(function (hd) {
    if (hd.valueCents !== null && hd.valueCents !== undefined) value += hd.valueCents;
    if (gainOf(hd)) { costedValue += hd.valueCents; cost += hd.costBasisCents; }
  });
  const totalGain = cost ? { cents: costedValue - cost, pct: Math.round((costedValue - cost) / cost * 10000) / 100 } : null;
  const sortBar = h("div", { class: "v2-range", attrs: { role: "group", "aria-label": "Sort holdings" } },
    h("span", { class: "hint", text: "Sort" }),
    SORTS.map(function (sk) {
      const active = sortKey === sk[0];
      const label = sk[1] + (active ? (sortDir < 0 ? " ↓" : " ↑") : "");
      return button(label, function () {
        if (active) sortDir = -sortDir;
        else { sortKey = sk[0]; sortDir = sk[0] === "name" ? 1 : -1; }
        draw();
      }, "v2-mini" + (active ? " on" : ""), { "aria-pressed": String(active) });
    }));
  const body = h("div", null,
    h("div", { class: "v2-tiles" },
      h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: "Holdings value" }), h("span", { class: "v2-tile-value", text: money(value, { whole: true }) })),
      h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: "Gain / loss" }), h("span", { class: "v2-tile-value v2-chg " + cls(totalGain), text: totalGain ? changeText(totalGain) : "—" }), h("span", { class: "v2-tile-sub", text: "vs cost basis" }))),
    sortBar,
    h("div", { class: "v2-list" }, sortedHoldings(d.holdings).map(function (hd) {
      const a = byId[hd.accountId];
      const g = gainOf(hd);
      const title = hd.kind === "cash" ? "Cash" : (hd.ticker || hd.name || "Security");
      const sub = [];
      if (hd.kind !== "cash") sub.push(fmtQty(hd.quantity) + " sh");
      if (hd.kind !== "cash" && hd.priceCents !== null && hd.priceCents !== undefined) sub.push(money(hd.priceCents) + " / sh");
      if (a) sub.push(a.name + (a.mask ? " ··" + a.mask : ""));
      if (hd.asOf) sub.push("priced " + shortDay(hd.asOf));
      return h("div", { class: "v2-line" },
        h("span", { class: "v2-line-name" }, h("span", null, h("strong", { text: title }), hd.name && hd.kind !== "cash" ? h("span", { class: "hint", text: " " + hd.name }) : null), h("span", { class: "hint", text: sub.join(" · ") })),
        g ? h("span", { class: "v2-chg hint " + cls(g), text: changeText(g) }) : null,
        h("span", { class: "v2-amt", text: hd.valueCents === null || hd.valueCents === undefined ? "—" : money(hd.valueCents, { whole: true }) }));
    })),
    h("p", { class: "hint", text: "From your bank sync. Prices are the latest close your bank reports" + (d.holdingsAsOf ? " — holdings as of " + dayLabel(d.holdingsAsOf) : "") + "." }));
  return section("Holdings", [], body);
}

function draw() { return keepScroll(drawNow); }

function drawNow() {
  clear(root);
  const marketBox = h("div");
  root.appendChild(marketBox);
  api("GET", "market").then(function (m) { clear(marketBox).appendChild(marketCard(m, { full: true })); })
    .catch(function (e) { errorState(marketBox, e); });

  const d = data;
  if (!d.accounts.length) {
    root.appendChild(section("Investments", [], emptyState("No investment accounts yet. Brokerage and retirement accounts from your bank sync show up here, or add one by hand on Accounts (type: Investments) and update its balance now and then.")));
    return;
  }
  const total = d.accounts.reduce(function (s, a) { return s + (a.balanceCents || 0); }, 0);
  const tiles = h("div", { class: "v2-tiles" },
    h("div", { class: "v2-tile accent" }, h("span", { class: "v2-tile-label", text: "Value" }), h("span", { class: "v2-tile-value", text: money(total, { whole: true }) })),
    [["Today", d.change.day], ["This week", d.change.week], ["30 days", d.change.month], ["1 year", d.change.year]].map(function (x) {
      return h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: x[0] }), h("span", { class: "v2-tile-value v2-chg " + cls(x[1]), text: changeText(x[1]) }),
        x[1] ? h("span", { class: "v2-tile-sub", text: "since " + shortDay(x[1].since) }) : null);
    }));
  const pts = inRange(d.series);
  const rangeBar = h("div", { class: "v2-range", attrs: { role: "group", "aria-label": "Chart range" } }, RANGES.map(function (r) {
    return button(r[1], function () { range = r[0]; draw(); }, "v2-mini" + (range === r[0] ? " on" : ""), { "aria-pressed": String(range === r[0]) });
  }));
  const canvas = h("canvas", { attrs: { role: "img", "aria-label": "Investment value over time" } });
  const body = h("div", null, tiles, rangeBar, pts.length > 1 ? h("div", { class: "chart-box v2-chart" }, canvas) : h("p", { class: "hint", text: "The chart fills in as daily balances arrive from your sync." }));
  root.appendChild(section("Investments", [], body));
  if (pts.length > 1) {
    const c = chartColors();
    const sets = [{ label: "Your investments", data: pts.map(function (p) { return p.valueCents / 100; }), borderColor: c.accent, backgroundColor: "rgba(20,184,166,.15)", fill: true, tension: .3, pointRadius: 0 }];
    const bench = benchmarkLine(pts, d.benchmark);
    if (bench) sets.push({ label: "S&P 500 (SPY), same start", data: bench, borderColor: c.plan, borderDash: [5, 4], fill: false, tension: .3, pointRadius: 0, spanGaps: true });
    drawChart("investments", canvas, {
      type: "line",
      data: { labels: pts.map(function (p) { return shortDay(p.date); }), datasets: sets },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: !!bench, labels: { color: c.text } } },
        scales: { x: { ticks: { color: c.text, maxTicksLimit: 6 }, grid: { color: c.grid } }, y: { ticks: { color: c.text, callback: function (v) { return money(v * 100, { whole: true }); } }, grid: { color: c.grid } } } }
    }, pts.map(function (p) { return p.date + ": " + money(p.valueCents); }).join("\n"));
  }
  root.appendChild(section("Accounts", [], h("div", { class: "v2-list" }, d.accounts.map(function (a) {
    return h("div", { class: "v2-line" },
      h("span", { class: "v2-line-name" }, h("span", { text: a.name + (a.mask ? " ··" + a.mask : "") }), a.institution ? h("span", { class: "hint", text: " · " + a.institution }) : null),
      h("span", { class: "v2-chg hint " + cls(a.day), text: a.day ? "Today " + changeText(a.day) : "" }),
      h("span", { class: "v2-amt", text: a.balanceCents === null ? "—" : money(a.balanceCents, { whole: true }) }));
  }))));
  if (d.holdings && d.holdings.length) root.appendChild(holdingsSection(d));
}

export function render(container) {
  root = container;
  if (!root.firstChild) loading(root);
  return api("GET", "investments").then(function (r) { data = r; draw(); }).catch(function (e) { errorState(root, e); });
}
