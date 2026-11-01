/* Registry for the new screens: shell.showTab() calls onShow(tab) and
   each screen renders into its section's container on every visit (so
   it always shows fresh data). */
import { render as renderAccounts, setOpenAccount } from "./accounts.js";
import { render as renderTransactions, showFiltered, refresh as refreshTransactions } from "./transactions.js";
import { render as renderBudget } from "./budget.js";
import { render as renderCashflow } from "./cashflow.js";
import { render as renderRecurring } from "./recurring.js";
import { render as renderGoals } from "./goals.js";
import { render as renderInvestments, setNavigator as setInvestmentsNavigator } from "./investments.js";
import { render as renderHome, setNavigator, customize } from "./home.js";
import { render as renderSplitwise, setNavigator as setSplitwiseNavigator } from "./splitwise.js";
import { render as renderManage } from "./manage.js";
import { api } from "./kit.js";
import { check as checkDemo } from "./demo.js";
import { autoSync } from "./bankimport.js";

const SCREENS = {
  accounts: ["v2Accounts", renderAccounts],
  transactions: ["v2Transactions", renderTransactions],
  budget: ["v2Budget", renderBudget],
  cashflow: ["v2Cashflow", renderCashflow],
  recurring: ["v2Recurring", renderRecurring],
  goals: ["v2Goals", renderGoals],
  investments: ["v2Investments", renderInvestments],
  splitwise: ["v2Splitwise", renderSplitwise]
};
let show = null;
let signedIn = false;

/* Only render once the app is in database mode (signed in): the new
   screens have no local-only fallback. */
export function setSignedIn(on) {
  signedIn = on;
  /* SimpleFIN first, so auto-review sees what it brought in. */
  if (on) { autoSync().then(function (added) { if (added && document.body.getAttribute("data-tab") === "transactions") refreshTransactions(); autoReview(); }); checkDemo(); }
}

/* Once per app open: let Gemini look at new bank rows before you do
   (see functions/api/_v2autoreview.js), in batches, in the background.
   When it took anything off To review, the open screen refreshes in
   place. A failure is silent: the rows just stay on To review. */
let autoRan = false;
function autoReview() {
  if (autoRan) return;
  autoRan = true;
  let changed = 0, rounds = 0;
  const step = function () {
    return api("POST", "autoreview").then(function (r) {
      changed += (r.reviewed || 0) + (r.duplicates || 0);
      if (r.remaining > 0 && ++rounds < 6) return step();
    });
  };
  step().then(function () {
    if (!changed || !signedIn) return;
    const tab = document.body.getAttribute("data-tab") || "dashboard";
    if (tab === "transactions") refreshTransactions();
    if (tab === "dashboard") {
      const el = document.getElementById("v2Overview");
      if (el) renderHome(el);
    }
  }, function () { /* leave them on To review */ });
}

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
  const alt = document.getElementById("dashCustomize");
  if (alt) alt.addEventListener("click", customize);
  setSplitwiseNavigator(go);
  setInvestmentsNavigator(go);
  setOpenAccount(function (a) { go("transactions", { accountId: a.id }); });
}
