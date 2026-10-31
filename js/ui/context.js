/* Shared app state (one object every screen reads and writes) and the element registry. */
import { MONTHS, blankState } from "../core/plan.js";

/* Everything the screens change at runtime lives here, so every module sees the same values. */
export const app = {};

/* Open on the current month when it's in the plan, else the first. */

export const nowKey = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");

export const els = {};

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  app.state = blankState();
  app.mode = "local"; /* "database" | "local" */
  app.editMode = "planned"; /* "planned" | "actual" */
  app.selectedKey = MONTHS.some(function (m) { return m.key === nowKey; }) ? nowKey : MONTHS[0].key;
  app.saveTimer = null;
  ["startingBalance", "baselineDate", "headerBaseline", "statIncome", "statExpenses", "statNet", "statEnding", "statAverage", "statRate",
   "statActualNet", "statVariance", "statFreeMonth", "statSpentMonth", "statSpentPending", "statOwed", "reviewBanner", "reviewBadge", "askForm", "askInput", "askBtn", "askLog", "askClear", "reviewBox", "reviewList", "compareToggle", "actualEmptyNote",
   "chart", "chartFallback", "barsChart", "barsFallback", "doughnutChart", "doughnutFallback", "doughnutMode", "doughnutMonthLabel",
   "chartLineTitle", "chartBarsTitle", "compareTableWrap",
   "dailyChart", "dailyFallback", "dailyMonthLabel", "lineKpi", "dailyKpi",
   "monthSelect", "monthForm", "monthTotals", "monthsTableBody", "storageMode", "geminiStatus",
   "viewPlannedBtn", "viewActualBtn",
   "copyAllBtn", "copyPrevBtn", "exportBtn", "importFile", "resetBtn",
   "expenseForm", "expDate", "expDateBtn", "expDateDisplay", "expDateCal", "expDescription", "expAmount", "expCategory", "expCard", "expShare", "expCatHint", "expenseList",
   "pendingSection", "pendingList", "pendingMeta",
   "syncNowBtn", "syncStatus",
   "cardForm", "cardFormTitle", "cardName", "cardStart", "cardStartBtn", "cardStartDisplay", "cardStartCal", "cardEnd", "cardEndBtn", "cardEndDisplay", "cardEndCal", "cardDue", "cardDueBtn", "cardDueDisplay", "cardDueCal", "cardCancelEditBtn", "cardList",
   "bankSyncedAt", "bankIgnoreRules", "bankAccounts", "bankAccountFilter", "bankTxList",
   "baselineDateDisplay",
   "geminiKeyInput", "geminiModelInput", "geminiSaveBtn", "geminiClearBtn", "geminiSettingsStatus",
   "authGate", "gateSetupForm", "gateSetupSecret", "gateSetupCode", "gateSetupConfirm", "gateSetupError",
   "gateLoginForm", "gateLoginCode", "gateLoginError",
   "securitySection", "secChangeForm", "secCurrentCode", "secNewCode", "secNewConfirm", "secChangeStatus",
   "pairCard", "pairLabel", "pairWhen", "pairFingerprint", "pairApproveBtn", "pairDenyBtn",
   "pairOpenBtn", "pairOpenStatus",
   "sessionList", "signOutBtn",
   "themeToggle", "addExpenseTopBtn"]
    .forEach(function (id) { els[id] = document.getElementById(id); });
  /* Dashboard display mode: false = actuals only (the default),
     true = compare actuals with the plan. Persisted per browser. */

  app.compareWithPlan = false;
  try { app.compareWithPlan = localStorage.getItem("arthatula-compare") === "1"; } catch (e) {}
  app.editingCardId = null; /* id of the card being edited, or null when adding */
  app.bankData = null; /* latest GET /api/bank snapshot, or null before the first load */
  app.pendingData = null; /* latest GET /api/pending snapshot, or null before the first load */
  app.bankFilter = ""; /* Bank tab account filter: a plaid account id, or "" for all */
  app.chartLine = null;
  app.chartBars = null;
  app.chartDough = null;
  app.chartDaily = null;
  app.geminiInfo = { hasKey: false, last4: null, model: "", source: null };
}
