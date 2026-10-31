/* Registry for the new screens: shell.showTab() calls onShow(tab) and
   each screen renders into its section's container on every visit (so
   it always shows fresh data). */
import { render as renderAccounts, setOpenAccount } from "./accounts.js";
import { render as renderTransactions, showFiltered } from "./transactions.js";
import { render as renderBudget } from "./budget.js";
import { render as renderCashflow } from "./cashflow.js";
import { render as renderRecurring } from "./recurring.js";
import { render as renderGoals } from "./goals.js";
import { render as renderHome, setNavigator } from "./home.js";
import { render as renderManage } from "./manage.js";

const SCREENS = {
  accounts: ["v2Accounts", renderAccounts],
  transactions: ["v2Transactions", renderTransactions],
  budget: ["v2Budget", renderBudget],
  cashflow: ["v2Cashflow", renderCashflow],
  recurring: ["v2Recurring", renderRecurring],
  goals: ["v2Goals", renderGoals]
};
let show = null;
let signedIn = false;

/* Only render once the app is in database mode (signed in): the new
   screens have no local-only fallback. */
export function setSignedIn(on) { signedIn = on; }

export function onShow(name) {
  if (!signedIn) return;
  if (SCREENS[name]) {
    const el = document.getElementById(SCREENS[name][0]);
    if (el) SCREENS[name][1](el);
  }
  if (name === "dashboard") {
    const el = document.getElementById("v2Overview");
    if (el) renderHome(el);
  }
  if (name === "settings") {
    const el = document.getElementById("v2Manage");
    if (el) renderManage(el);
  }
}

export function init(showTab) {
  show = showTab;
  const go = function (tab, filter) {
    if (tab === "transactions") showFiltered(filter || {});
    show(tab);
    window.scrollTo(0, 0);
  };
  setNavigator(go);
  setOpenAccount(function (a) { go("transactions", { accountId: a.id }); });
}
