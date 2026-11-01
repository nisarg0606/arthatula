/* Splitwise screen: live read-only balances from the owner's
   Splitwise account (friends, groups, recent shared expenses),
   served by /api/v2/splitwise. The API key never reaches the
   browser — connect it in Settings → Splitwise. */
import { api, h, clear, money, section, button, emptyState, errorState, loading, shortDay } from "./kit.js";

let goTo = null;
export function setNavigator(fn) { goTo = fn; }

function tile(label, value, sub, cls) {
  return h("div", { class: "v2-tile " + (cls || "") },
    h("span", { class: "v2-tile-label", text: label }),
    h("span", { class: "v2-tile-value", text: value }),
    sub ? h("span", { class: "v2-tile-sub", text: sub }) : null);
}

function otherCurrencies(balances) {
  return (balances || [])
    .filter((b) => b.currency !== "USD")
    .map((b) => b.currency + " " + (b.amountCents / 100).toFixed(2))
    .join(" · ");
}

function whenLabel(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function render(container) {
  load(container, false);
}

function load(container, refresh) {
  if (!container.firstChild || refresh) loading(container);
  api("GET", "splitwise" + (refresh ? "?refresh=1" : "")).then(function (data) {
    draw(container, data);
  }).catch(function (e) { errorState(container, e); });
}

function draw(container, data) {
  clear(container);
  if (!data.connected) {
    const body = h("div", {},
      data.error ? h("p", { class: "auth-error", text: data.error }) : null,
      h("p", { class: "hint", text: "See who owes you and whom you owe, live from Splitwise. To connect:" }),
      h("p", { class: "hint", text: "1. Sign in at splitwise.com → your account → Privacy and Security → Your Apps." }),
      h("p", { class: "hint", text: "2. Register an app (any name) and generate a personal API key on its page." }),
      h("p", { class: "hint", text: "3. Paste the key in Settings → Splitwise. It stays on the server; this view is read-only." }),
      button("Open Settings", function () { goTo && goTo("settings"); }, "btn-primary"));
    container.appendChild(section("Splitwise", [], body));
    return;
  }

  const meta = h("div", { class: "v2-card-head" },
    h("p", { class: "hint", text: "Live from Splitwise · as of " + whenLabel(data.fetchedAt) +
      (data.stale ? " · couldn't refresh, showing the last good snapshot" : data.cached ? " · cached snapshot" : "") }),
    button("Refresh", function () { load(container, true); }));
  container.appendChild(meta);
  if (data.error) container.appendChild(h("p", { class: "auth-error", text: data.error }));

  container.appendChild(h("div", { class: "v2-tiles" },
    tile("Net balance", money(data.netUsdCents, { signed: true }), data.netUsdCents > 0 ? "You are owed overall" : data.netUsdCents < 0 ? "You owe overall" : "All settled up", data.netUsdCents > 0 ? "accent" : ""),
    tile("Owed to you", money(data.owedToYouCents), "Across all friends", ""),
    tile("You owe", money(data.youOweCents), "Across all friends", data.youOweCents ? "neg" : "")));

  const friendRows = data.friends.length ? data.friends.map(function (f) {
    const other = otherCurrencies(f.balances);
    return h("div", { class: "v2-line" },
      h("span", { class: "v2-line-name", text: f.name }),
      h("span", { class: "hint", text: (f.usdCents > 0 ? "owes you" : "you owe") + (other ? " · also " + other : "") }),
      h("span", { class: "v2-amt" + (f.usdCents > 0 ? " in" : ""), text: money(f.usdCents, { signed: true }) }));
  }) : [emptyState("No open balances — everyone is settled up.")];
  container.appendChild(section("Friends", [], h("div", { class: "v2-list" }, friendRows)));

  if (data.groups.length) {
    const groupBlocks = data.groups.map(function (g) {
      const rows = g.members.filter((m) => m.balances.length).map(function (m) {
        const other = otherCurrencies(m.balances);
        return h("div", { class: "v2-line" },
          h("span", { class: "v2-line-name", text: m.name }),
          h("span", { class: "hint", text: (m.usdCents > 0 ? "is owed" : "owes") + (other ? " · also " + other : "") }),
          h("span", { class: "v2-amt" + (m.usdCents > 0 ? " in" : ""), text: money(m.usdCents, { signed: true }) }));
      });
      return h("div", { class: "v2-group" },
        h("h3", { class: "chart-title", text: g.name }),
        h("p", { class: "hint", text: g.myUsdCents === 0 ? "You are settled up in this group" :
          g.myUsdCents > 0 ? "Your net here: " + money(g.myUsdCents, { signed: true }) + " owed to you" :
          "Your net here: you owe " + money(-g.myUsdCents) }),
        h("div", { class: "v2-list" }, rows.length ? rows : [emptyState("Everyone is settled up in this group.")]));
    });
    container.appendChild(section("Groups", [], h("div", {}, groupBlocks)));
  }

  if (data.expenses.length) {
    const rows = data.expenses.map(function (e) {
      return h("div", { class: "v2-line" },
        h("span", { class: "v2-line-date", text: shortDay(e.date) }),
        h("span", { class: "v2-line-name", text: (e.payment ? "⇄ " : "") + e.description }),
        h("span", { class: "hint", text: e.paidBy ? "paid by " + e.paidBy : "" }),
        h("span", { class: "v2-amt" + (e.myNetCents > 0 ? " in" : ""), text: e.myNetCents ? money(e.myNetCents, { signed: true }) : money(e.costCents) }));
    });
    container.appendChild(section("Recent shared activity", [], h("div", { class: "v2-list" }, rows)));
  }
}
