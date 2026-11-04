/* Investments screen: the nightly market recap, then your investment
   accounts' total value over time (from the daily balances the sync
   records), how it changed, an optional S&P 500 line to compare, and
   each account. The recap card is shared with Home. */
import { keepScroll } from "../scroll.js";
import { amountsHidden } from "../../core/format.js";
import { api, h, clear, money, shortDay, dayLabel, section, button, emptyState, errorState, loading, drawChart, chartColors } from "./kit.js";
import { streamSymbols, nySession, seedQuote, applyTrade, parseStreamMessage, liveValueCents, dayTotals } from "../../core/v2/live.js";

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
   dust keeps the decimals it needs. Hidden with the eye button: shares
   times the price would give the amount away. */
function fmtQty(q) {
  if (q === null || q === undefined) return "";
  if (amountsHidden()) return "•••";
  const v = Math.abs(q) >= 100 ? Math.round(q * 100) / 100 : q;
  return String(Math.round(v * 1e8) / 1e8);
}

/* Live prices (js/core/v2/live.js): when the stream has a price for a
   holding it wins over the bank's last reported one, everywhere the
   holding is valued. Quantities and cost basis never move here. */
let liveState = {}, liveEls = null, liveStarted = false, liveRun = 0;
let liveWs = null, liveRetry = null, patchTimer = null, lastPrices = {};

function effPriceCents(hd) {
  const st = liveState[hd.ticker];
  return st && st.priceCents !== null && st.priceCents !== undefined ? st.priceCents : hd.priceCents;
}
function effValueCents(hd) {
  const lv = liveValueCents(hd, liveState);
  return lv !== null ? lv : hd.valueCents;
}

function gainOf(hd) {
  if (hd.kind === "cash" || hd.costBasisCents === null || hd.costBasisCents === undefined) return null;
  const v = effValueCents(hd);
  if (v === null || v === undefined) return null;
  const cents = v - hd.costBasisCents;
  return { cents: cents, pct: hd.costBasisCents ? Math.round(cents / hd.costBasisCents * 10000) / 100 : null };
}

/* Sort keys for positions; rows without the number being sorted on
   (cash, or a position with no cost basis) always sink to the end. */
function sortValue(hd, key) {
  const g = gainOf(hd);
  if (key === "gain") return g ? g.cents : null;
  if (key === "gainpct") return g ? g.pct : null;
  if (key === "name") return null;
  const v = effValueCents(hd);
  return v === undefined ? null : v;
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
    const v = effValueCents(hd);
    if (v !== null && v !== undefined) value += v;
    if (gainOf(hd)) { costedValue += v; cost += hd.costBasisCents; }
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
  const rows = [];
  const totalEl = h("span", { class: "v2-tile-value js-lt", text: money(value, { whole: true }) });
  const dayEl = h("span", { class: "v2-tile-sub js-ltd" });
  const gainEl = h("span", { class: "v2-tile-value v2-chg js-ltg " + cls(totalGain), text: totalGain ? changeText(totalGain) : "—" });
  const footEl = h("p", { class: "hint js-lf", text: "From your bank sync. Prices are the latest close your bank reports" + (d.holdingsAsOf ? " — holdings as of " + dayLabel(d.holdingsAsOf) : "") + "." });
  const statusText = h("span", { text: "" });
  const statusEl = h("span", { class: "v2-live off", attrs: { role: "status" } }, h("span", { class: "v2-live-dot" }), statusText);
  const body = h("div", null,
    h("div", { class: "v2-tiles" },
      h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: "Holdings value" }), totalEl, dayEl),
      h("div", { class: "v2-tile" }, h("span", { class: "v2-tile-label", text: "Gain / loss" }), gainEl, h("span", { class: "v2-tile-sub", text: "vs cost basis" }))),
    sortBar,
    h("div", { class: "v2-list" }, sortedHoldings(d.holdings).map(function (hd) {
      const a = byId[hd.accountId];
      const g = gainOf(hd);
      const title = hd.kind === "cash" ? "Cash" : (hd.ticker || hd.name || "Security");
      const ep = effPriceCents(hd);
      const priceEl = hd.kind !== "cash" && ep !== null && ep !== undefined ? h("span", { class: "js-lp", text: money(ep) + " / sh" }) : null;
      const rowDayEl = hd.kind !== "cash" ? h("span", { class: "js-ld" }) : null;
      const rest = [];
      if (a) rest.push(a.name + (a.mask ? " ··" + a.mask : ""));
      if (hd.asOf) rest.push("priced " + shortDay(hd.asOf));
      const valueEl = h("span", { class: "v2-amt js-lv", text: effValueCents(hd) === null || effValueCents(hd) === undefined ? "—" : money(effValueCents(hd), { whole: true }) });
      const rowGainEl = g ? h("span", { class: "v2-chg hint js-lg " + cls(g), text: changeText(g) }) : null;
      rows.push({ hd: hd, priceEl: priceEl, dayEl: rowDayEl, gainEl: rowGainEl, valueEl: valueEl });
      return h("div", { class: "v2-line" },
        h("span", { class: "v2-line-name" }, h("span", null, h("strong", { text: title }), hd.name && hd.kind !== "cash" ? h("span", { class: "hint", text: " " + hd.name }) : null),
          h("span", { class: "v2-tx-sub" },
            hd.kind !== "cash" ? h("span", { text: fmtQty(hd.quantity) + " sh" }) : null,
            priceEl ? h("span", { text: " · " }) : null, priceEl, rowDayEl,
            rest.length ? h("span", { text: (hd.kind !== "cash" ? " · " : "") + rest.join(" · ") }) : null)),
        rowGainEl,
        valueEl);
    })),
    footEl);
  liveEls = { rows: rows, totalEl: totalEl, gainEl: gainEl, dayEl: dayEl, footEl: footEl, statusEl: statusEl, statusText: statusText };
  return section("Holdings", streamSymbols(d.holdings).length ? [statusEl] : [], body);
}

/* ---- live streaming: quotes seed the day, trades tick the price ---- */

function setLiveStatus(mode, text) {
  if (!liveEls) return;
  liveEls.statusEl.className = "v2-live " + mode;
  liveEls.statusText.textContent = text;
}

function stopLive() {
  liveRun++;
  liveStarted = false;
  if (liveRetry) { clearTimeout(liveRetry); liveRetry = null; }
  if (patchTimer) { clearTimeout(patchTimer); patchTimer = null; }
  if (liveWs) { try { liveWs.close(); } catch (e) { /* already gone */ } liveWs = null; }
}

function startLive() {
  if (liveStarted || !data || !data.holdings || !liveEls) return;
  const symbols = streamSymbols(data.holdings);
  if (!symbols.length) return;
  liveStarted = true;
  const run = liveRun;
  const session = nySession(Date.now());
  setLiveStatus("warn", "Connecting…");
  api("GET", "quotes?symbols=" + encodeURIComponent(symbols.join(","))).then(function (r) {
    if (run !== liveRun) return;
    if (r.status === "nokey") { liveEls.statusEl.style.display = "none"; return; }
    Object.keys(r.quotes || {}).forEach(function (s) { seedQuote(liveState, s, r.quotes[s]); });
    applyLive();
    if (session === "closed") setLiveStatus("off", "Market closed · latest prices");
    else connectStream(run, symbols, 0);
  }).catch(function () {
    if (run !== liveRun) return;
    if (session === "closed") setLiveStatus("off", "Market closed");
    else connectStream(run, symbols, 0);
  });
}

function connectStream(run, symbols, attempt) {
  if (run !== liveRun) return;
  api("POST", "stream-ticket").then(function (t) {
    if (run !== liveRun) return;
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/v2/stream?ticket=" + encodeURIComponent(t.ticket));
    liveWs = ws;
    ws.onopen = function () {
      if (run !== liveRun) return;
      setLiveStatus("warn", "Connected · waiting for trades");
      symbols.forEach(function (s) { try { ws.send(JSON.stringify({ type: "subscribe", symbol: s })); } catch (e) { /* closed mid-send */ } });
    };
    ws.onmessage = function (ev) {
      if (run !== liveRun) return;
      const trades = parseStreamMessage(ev.data);
      if (!trades.length) return;
      trades.forEach(function (tr) { applyTrade(liveState, tr.symbol, tr.price, tr.t); });
      setLiveStatus("on", "Live");
      schedulePatch();
    };
    ws.onclose = function () {
      if (run !== liveRun) return;
      liveWs = null;
      if (typeof document !== "undefined" && document.hidden) return; /* suspended; visibilitychange reconnects */
      if (nySession(Date.now()) === "closed") { setLiveStatus("off", "Market closed · latest prices"); return; }
      setLiveStatus("warn", "Reconnecting…");
      const delay = [2000, 5000, 10000, 30000][Math.min(attempt, 3)];
      liveRetry = setTimeout(function () { connectStream(run, symbols, attempt + 1); }, delay);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* onclose follows */ } };
  }).catch(function () {
    if (run !== liveRun) return;
    setLiveStatus("off", "Live unavailable · bank prices");
  });
}

function schedulePatch() {
  if (patchTimer) return;
  patchTimer = setTimeout(function () { patchTimer = null; applyLive(); }, 200);
}

function flash(el, clsName) {
  el.classList.remove("tick-up", "tick-down");
  void el.offsetWidth; /* restart the transition */
  el.classList.add(clsName);
  setTimeout(function () { el.classList.remove(clsName); }, 900);
}

/* Repaint every number the live prices touch: rows, tiles, footer. */
function applyLive() {
  if (!liveEls || !data || !data.holdings) return;
  liveEls.rows.forEach(function (row) {
    const hd = row.hd, st = liveState[hd.ticker];
    if (row.priceEl && st && st.priceCents !== null && st.priceCents !== undefined) {
      const prev = lastPrices[hd.ticker];
      row.priceEl.textContent = money(st.priceCents) + " / sh";
      if (prev !== null && prev !== undefined && prev !== st.priceCents) flash(row.priceEl, st.priceCents > prev ? "tick-up" : "tick-down");
      lastPrices[hd.ticker] = st.priceCents;
    }
    if (row.dayEl && st && st.dayPct !== null && st.dayPct !== undefined) {
      row.dayEl.textContent = " · " + pct(st.dayPct) + " today";
      row.dayEl.className = "js-ld " + (st.dayPct > 0 ? "pos" : st.dayPct < 0 ? "neg" : "");
    }
    const v = effValueCents(hd);
    if (row.valueEl && v !== null && v !== undefined) row.valueEl.textContent = money(v, { whole: true });
    if (row.gainEl) {
      const g = gainOf(hd);
      if (g) { row.gainEl.textContent = changeText(g); row.gainEl.className = "v2-chg hint js-lg " + cls(g); }
    }
  });
  let value = 0, costedValue = 0, cost = 0;
  data.holdings.forEach(function (hd) {
    const v = effValueCents(hd);
    if (v !== null && v !== undefined) value += v;
    if (gainOf(hd)) { costedValue += v; cost += hd.costBasisCents; }
  });
  liveEls.totalEl.textContent = money(value, { whole: true });
  const totalGain = cost ? { cents: costedValue - cost, pct: Math.round((costedValue - cost) / cost * 10000) / 100 } : null;
  if (totalGain) { liveEls.gainEl.textContent = changeText(totalGain); liveEls.gainEl.className = "v2-tile-value v2-chg js-ltg " + cls(totalGain); }
  const dt = dayTotals(data.holdings, liveState);
  liveEls.dayEl.textContent = dt ? "Today " + money(dt.cents, { signed: true, whole: true }) + " (" + pct(dt.pct) + ")" : "";
  liveEls.dayEl.className = "v2-tile-sub js-ltd " + (dt ? (dt.cents > 0 ? "pos" : dt.cents < 0 ? "neg" : "") : "");
  const anySeeded = Object.keys(liveState).length > 0;
  const anyLive = Object.keys(liveState).some(function (s) { return liveState[s].live; });
  if (anyLive) liveEls.footEl.textContent = "Prices streaming live from Finnhub · quantities and cost basis from your bank sync" + (data.holdingsAsOf ? " — holdings as of " + dayLabel(data.holdingsAsOf) : "") + ".";
  else if (anySeeded) liveEls.footEl.textContent = "Prices are Finnhub's latest · quantities and cost basis from your bank sync" + (data.holdingsAsOf ? " — holdings as of " + dayLabel(data.holdingsAsOf) : "") + ".";
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (liveRetry) { clearTimeout(liveRetry); liveRetry = null; }
      if (liveWs) { const ws = liveWs; liveWs = null; try { ws.close(); } catch (e) { /* ignore */ } }
    } else if (liveStarted && !liveWs && data && data.holdings && nySession(Date.now()) !== "closed") {
      connectStream(liveRun, streamSymbols(data.holdings), 0);
    }
  });
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
  if (d.holdings && d.holdings.length) {
    root.appendChild(holdingsSection(d));
    if (!liveStarted) startLive(); else applyLive();
  }
}

export function render(container) {
  root = container;
  stopLive();
  liveState = {};
  lastPrices = {};
  if (!root.firstChild) loading(root);
  return api("GET", "investments").then(function (r) { data = r; draw(); }).catch(function (e) { errorState(root, e); });
}
