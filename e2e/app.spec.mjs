/*
 * Browser smoke tests for the flows that only show up in a real browser:
 * layout at phone width, the quick-add form, the calendar, the month
 * switcher and the chart popup. Dummy data only.
 */
import { test, expect } from "@playwright/test";

const SETUP = { action: "setup", setupSecret: "e2e-setup-secret", code: "e2e-access-code-123", label: "e2e" };

/* Sign in once per test: first run sets the access code, later runs log in. */
async function signIn(page, request) {
  let res = await request.post("/api/auth", { data: SETUP });
  if (!res.ok()) res = await request.post("/api/auth", { data: { action: "login", code: SETUP.code, label: "e2e" } });
  expect(res.ok()).toBeTruthy();
  const { token } = await res.json();
  await page.addInitScript((t) => localStorage.setItem("arthatula-session", t), token);
  return token;
}
const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
/* Pair a sync session the way the automation does; returns its auth header. */
async function pairSync(page, request, token, name) {
  const auth = { Authorization: "Bearer " + token };
  const raw = "e2e-sync-token-" + name + "-0123456789abcdef";
  const hash = await page.evaluate(async (r) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, raw);
  const code = (await (await request.post("/api/auth", { headers: auth, data: { action: "pair-open" } })).json()).code;
  const fp = (await (await request.post("/api/auth", { data: { action: "pair-request", pairCode: code, tokenHash: hash, label: "e2e sync" } })).json()).fingerprint;
  expect((await request.post("/api/auth", { headers: auth, data: { action: "pair-approve", fingerprint: fp } })).ok()).toBeTruthy();
  return { Authorization: "Bearer " + raw };
}
async function openTab(page, name) {
  await page.locator('.tab-btn[data-tab="' + name + '"]').click();
  await expect(page.locator('[data-section="' + name + '"]')).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await signIn(page, request);
  await page.goto("/");
  await expect(page.locator("#authGate")).toBeHidden();
});

test("no tab scrolls sideways", async ({ page }) => {
  for (const tab of ["dashboard", "accounts", "transactions", "cashflow", "budget", "recurring", "goals", "editor", "daily", "cards", "bank", "settings"]) {
    await openTab(page, tab);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, tab + " tab is wider than the screen").toBeLessThanOrEqual(0);
  }
});

test("add an expense from the Daily tab", async ({ page }, info) => {
  const desc = "E2E groceries " + info.project.name;
  await openTab(page, "daily");
  await page.fill("#expDescription", desc);
  await page.fill("#expAmount", "42.50");
  await page.selectOption("#expCategory", "Groceries");
  await page.locator("#expAddBtn").click();
  await expect(page.locator("#expenseList")).toContainText(desc);
  await openTab(page, "dashboard");
  await expect(page.locator("#statSpentMonth")).not.toHaveText("$0.00");
});

test("calendar arrows change month without closing", async ({ page }) => {
  await openTab(page, "daily");
  await page.locator("#expDateBtn").click();
  const pop = page.locator("#expDateCal");
  await expect(pop).toBeVisible();
  const title = pop.locator(".cal-title");
  const first = await title.textContent();
  await pop.locator('.cal-nav[data-nav="1"]').click();
  await pop.locator('.cal-nav[data-nav="1"]').click();
  await expect(pop).toBeVisible();
  await expect(title).not.toHaveText(first);
  const day = pop.locator(".cal-day:not(.dim)").nth(9);
  const iso = await day.getAttribute("data-iso");
  await day.click();
  await expect(pop).toBeHidden();
  await expect(page.locator("#expDate")).toHaveValue(iso);
});

test("dashboard month switcher stays in sync with the Month editor", async ({ page }) => {
  const start = await page.locator("#dashMonth").inputValue();
  const next = page.locator("#dashMonthNext");
  if (await next.isDisabled()) await page.locator("#dashMonthPrev").click();
  else await next.click();
  const moved = await page.locator("#dashMonth").inputValue();
  expect(moved).not.toBe(start);
  await openTab(page, "editor");
  await expect(page.locator("#monthSelect")).toHaveValue(moved);
});

test("tapping a category opens its transactions and the × closes them", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const desc = "E2E fuel " + info.project.name;
  const res = await request.post("/api/expenses", {
    headers: { Authorization: "Bearer " + token },
    data: { date: today(), description: desc, amount: 30, category: "Fuel/Transport" }
  });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("#doughnutMode")).toHaveValue("actual");
  const canvas = page.locator("#doughnutChart");
  await canvas.scrollIntoViewIfNeeded();
  /* Click the legend entry for the category (Chart.js draws it on the canvas). */
  const box = await page.evaluate(() => {
    const ch = window.Chart.getChart(document.getElementById("doughnutChart"));
    const i = ch.legend.legendItems.findIndex((l) => l.text === "Fuel/Transport");
    const hb = ch.legend.legendHitBoxes[i];
    return { x: hb.left + hb.width / 2, y: hb.top + hb.height / 2 };
  });
  await canvas.click({ position: box });
  const dlg = page.locator("#txDialog");
  await expect(dlg).toBeVisible();
  await expect(page.locator("#txDialogTitle")).toContainText("Fuel/Transport");
  await expect(dlg).toContainText(desc);
  await page.locator("#txDialogClose").click();
  await expect(dlg).toBeHidden();
});

test("every screen works without a script error", async ({ page }, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.reload();
  await expect(page.locator("#authGate")).toBeHidden();

  // Month editor: switch views and edit a planned amount.
  await openTab(page, "editor");
  await page.locator("#viewActualBtn").click();
  await page.locator("#viewPlannedBtn").click();
  const field = page.locator('#monthForm input[type="number"]').first();
  await field.fill("123");
  await field.blur();
  await expect(page.locator("#monthTotals")).toBeVisible();

  // Cards: add a card using the calendar's Today buttons.
  await openTab(page, "cards");
  await page.fill("#cardName", "E2E card " + info.project.name);
  for (const id of ["cardStartBtn", "cardEndBtn", "cardDueBtn"]) {
    await page.locator("#" + id).click();
    await page.locator("#" + id.replace("Btn", "Cal") + " [data-today]").click();
  }
  await page.locator("#cardSaveBtn").click();
  await expect(page.locator("#cardList")).toContainText("E2E card " + info.project.name);

  // Bank, Settings, theme, and the dashboard's planned view.
  await openTab(page, "bank");
  await openTab(page, "settings");
  await page.locator("#themeToggle").click();
  await page.locator("#themeToggle").click();
  await openTab(page, "dashboard");
  /* Toggle compare on and off (a direct click: on phones the styled
     switch can sit under the bottom tab bar). */
  await page.locator("#compareToggle").evaluate((el) => el.click());
  await expect(page.locator("#compareToggle")).toBeChecked();
  await page.locator("#compareToggle").evaluate((el) => el.click());
  await expect(page.locator("#compareToggle")).not.toBeChecked();

  expect(errors, "script errors:\n" + errors.join("\n")).toEqual([]);
});

test("count a pending charge now; the posted charge updates it instead of adding another", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const sync = await pairSync(page, request, token, "pending-" + info.project.name);
  const pendId = "e2e-pend-" + info.project.name;
  const shop = "E2E Market " + info.project.name;
  expect((await request.post("/api/pending", { headers: sync, data: { transactions: [
    { id: pendId, date: today(), name: shop, amount: 25, accountLabel: "", category: "Groceries" }
  ] } })).ok()).toBeTruthy();

  await page.reload();
  await openTab(page, "daily");
  const row = page.locator(".pending-row", { hasText: shop });
  await row.getByRole("button", { name: "Count it now" }).click();
  await expect(row.locator(".pending-badge.counted")).toHaveText("Counted");
  const item = page.locator(".expense-item", { hasText: shop });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("counted from pending");
  await expect(item).toContainText("$25.00");

  /* The posted charge arrives at a different amount, carrying Plaid's pending id. */
  const posted = await request.post("/api/expenses", { headers: sync, data: {
    date: today(), description: shop.toUpperCase(), amount: 27.5, pendingTransactionId: pendId } });
  expect((await posted.json()).settled).toBe(true);
  await page.reload();
  await openTab(page, "daily");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("$27.50");
  await expect(item).not.toContainText("counted from pending");
});

test("Sync now keeps watching a slow sync and shows the result when it finishes", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const sync = await pairSync(page, request, token, "syncnow-" + info.project.name);
  await page.clock.install();
  await page.reload();
  await openTab(page, "daily");
  const btn = page.locator("#syncNowBtn");
  await btn.click();
  await expect(btn).toHaveText("Queued…");
  /* Nudge the page's clock forward 10 s at a time (one status check
     each) until the button shows `text`. A button that stopped watching
     never gets there, which is the bug this test guards against. */
  const advanceUntil = async (text) => {
    for (let i = 0; i < 12; i++) {
      await page.clock.fastForward("00:10");
      try { await expect(btn).toHaveText(text, { timeout: 4000 }); return; } catch (e) { /* not yet */ }
    }
    await expect(btn).toHaveText(text, { timeout: 1 });
  };
  /* Well past the old 3-minute limit, the button must still be watching. */
  await page.clock.fastForward("04:00");
  const claim = await (await request.get("/api/sync-requests/claim", { headers: sync })).json();
  expect(claim.request && claim.request.status).toBe("running");
  await advanceUntil("Syncing…");
  await request.post("/api/sync-requests/" + claim.request.id + "/complete", { headers: sync,
    data: { status: "done", result: { addedCount: 2, addedTotal: 30 } } });
  await advanceUntil("Sync now");
  await expect(btn).toBeEnabled();
  await expect(page.locator("#syncStatus")).toContainText("Added 2 expenses");
});

test("Ask: a question goes to the server and the reply shows in the conversation", async ({ page }) => {
  /* The test server has no Gemini key, so the real /api/ask answers with
     its "add your key" hint; this proves the whole round trip works. */
  await openTab(page, "dashboard");
  await page.locator(".ask-suggest button").first().click();
  await expect(page.locator(".ask-msg.user")).toHaveText("Can I afford $1,300 in December?");
  await expect(page.locator(".ask-msg.note")).toContainText("Add your Gemini key in Settings");
  await page.fill("#askInput", "Where did my money go?");
  await page.locator("#askBtn").click();
  await expect(page.locator(".ask-msg.user")).toHaveCount(2);
  await expect(page.locator("#askInput")).toHaveValue("");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Ask: the chat survives a reload, clears only after confirming, and expires after 3 hours", async ({ page }) => {
  let seen = null;
  await page.route("**/api/ask", async (route) => {
    seen = route.request().postDataJSON();
    await route.fulfill({ json: { answer: "Made-up answer.", affordability: null } });
  });
  await openTab(page, "dashboard");
  await page.fill("#askInput", "Can I afford a $40 lamp?");
  await page.locator("#askBtn").click();
  await expect(page.locator(".ask-msg.assistant")).toHaveText("Made-up answer.");
  await page.reload();
  await openTab(page, "dashboard");
  await expect(page.locator(".ask-msg.user")).toHaveText("Can I afford a $40 lamp?");
  /* The follow-up carries the earlier turn. */
  await page.fill("#askInput", "What about in March?");
  await page.locator("#askBtn").click();
  await expect(page.locator(".ask-msg.assistant")).toHaveCount(2);
  expect(seen.history[0].text).toBe("Can I afford a $40 lamp?");
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#askClear").click();
  await expect(page.locator(".ask-msg")).toHaveCount(4);
  page.once("dialog", (d) => d.accept());
  await page.locator("#askClear").click();
  await expect(page.locator(".ask-msg")).toHaveCount(0);
  await expect(page.locator("#askClear")).toBeHidden();
  /* A chat last used over 3 hours ago is gone on the next visit. */
  await page.evaluate(() => localStorage.setItem("arthatula-ask", JSON.stringify({ at: Date.now() - 3 * 3600 * 1000 - 1000,
    history: [], shown: [{ cls: "user", text: "Old question" }] })));
  await page.reload();
  await openTab(page, "dashboard");
  await expect(page.locator(".ask-msg")).toHaveCount(0);
});

test("a merchant rule re-files past expenses and shows in Settings; the pace card and 4-week owed line appear", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const auth = { Authorization: "Bearer " + token };
  const who = info.project.name.replace(/[^a-z]+/g, " ").trim(); /* letters only, so it survives merchantKey */
  const first = "Acme Rentals " + who + " 101", second = "ACME RENTALS " + who.toUpperCase() + " #202";
  for (const [description, category] of [[first, "Fuel/Transport"], [second, "Rent"]]) {
    expect((await request.post("/api/expenses", { headers: auth, data: { date: today(), description, amount: 25, category } })).ok()).toBeTruthy();
  }
  /* A shared expense nobody has paid back yet. */
  expect((await request.post("/api/expenses", { headers: auth,
    data: { date: today(), description: "E2E shared " + who, amount: 40, myShare: 10, category: "Groceries" } })).ok()).toBeTruthy();
  await page.reload();
  await openTab(page, "daily");
  const item = page.locator(".expense-item", { hasText: first });
  await item.locator("summary").click();
  await item.getByRole("button", { name: "Always use this category…" }).click();
  await item.getByLabel("Merchant name to match").fill("acme rentals " + who);
  await item.getByRole("button", { name: "File as Fuel/Transport" }).click();
  await expect(page.locator(".expense-item", { hasText: second }).locator(".tx-sub").first()).toContainText("Fuel/Transport");
  await openTab(page, "settings");
  await expect(page.locator("#merchantRulesList")).toContainText("acme rentals " + who);
  await openTab(page, "dashboard");
  await expect(page.locator("#pacePanel")).toBeVisible();
  await expect(page.locator("#paceList")).toContainText("Gas / transport");
  await page.locator(".pace-btn", { hasText: "Gas / transport" }).click();
  await expect(page.locator("#txDialog")).toBeVisible();
  await expect(page.locator("#txDialogList")).toContainText(first);
  await expect(page.locator("#txDialogList")).toContainText(second);
  await page.locator("#txDialogClose").click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator("#statOwedOld")).toBeHidden();
  /* Five weeks later it is still unpaid. */
  await page.clock.install({ time: new Date(Date.now() + 35 * 864e5) });
  await page.reload();
  await expect(page.locator("#statOwedOld")).toBeVisible();
  await expect(page.locator("#statOwedOld")).toContainText("waiting over 4 weeks");
});

test("add a note to an expense; it stays after a reload and shows in the popup", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const desc = "E2E loan " + info.project.name;
  const note = "Premium processing fee " + info.project.name;
  expect((await request.post("/api/expenses", { headers: { Authorization: "Bearer " + token },
    data: { date: today(), description: desc, amount: 45, category: "Loan/Debt Payment" } })).ok()).toBeTruthy();
  await page.reload();
  await openTab(page, "daily");
  const item = page.locator(".expense-item", { hasText: desc });
  await item.locator("summary").click();
  await item.locator(".note-input").fill(note);
  await item.locator(".note-input").press("Enter");
  await expect(item.locator(".tx-note")).toHaveText(note);
  await page.reload();
  await openTab(page, "daily");
  await expect(page.locator(".expense-item", { hasText: desc }).locator(".tx-note")).toHaveText(note);
  /* The chart popup shows it too. */
  await openTab(page, "dashboard");
  const box = await page.evaluate(() => {
    const ch = window.Chart.getChart(document.getElementById("doughnutChart"));
    const i = ch.legend.legendItems.findIndex((l) => l.text === "Loan/Debt Payment");
    const hb = ch.legend.legendHitBoxes[i];
    return { x: hb.left + hb.width / 2, y: hb.top + hb.height / 2 };
  });
  await page.locator("#doughnutChart").scrollIntoViewIfNeeded();
  await page.locator("#doughnutChart").click({ position: box });
  await expect(page.locator("#txDialog")).toContainText(note);
});

test("Sync now still updates when each status check is slow to answer", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const token = await signIn(page, request);
  const sync = await pairSync(page, request, token, "slowcheck-" + info.project.name);
  /* Every status answer takes 5 s, longer than the gap between the
     test's clock nudges: a button that throws away late answers while
     starting new checks never moves. */
  await page.route("**/api/sync-requests/latest", async (route) => {
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 5000));
    await route.fulfill({ response: res });
  });
  await page.clock.install();
  await page.reload();
  await openTab(page, "daily");
  const btn = page.locator("#syncNowBtn");
  await btn.click();
  await expect(btn).toHaveText("Queued…", { timeout: 15000 });
  const claim = await (await request.get("/api/sync-requests/claim", { headers: sync })).json();
  await request.post("/api/sync-requests/" + claim.request.id + "/complete", { headers: sync,
    data: { status: "done", result: { addedCount: 1, addedTotal: 9 } } });
  for (let i = 0; i < 12; i++) {
    await page.clock.fastForward("00:10");
    try { await expect(btn).toHaveText("Sync now", { timeout: 4000 }); break; } catch (e) { /* not yet */ }
  }
  await expect(page.locator("#syncStatus")).toContainText("Added 1 expense", { timeout: 1 });
});

test("Settings: a blank Gemini model box means the default model", async ({ page }) => {
  page.on("dialog", (d) => d.accept()); /* "Saved…" alerts */
  const box = page.locator("#geminiModelInput");
  const save = async (value) => {
    await openTab(page, "settings");
    await box.fill(value);
    const saved = page.waitForResponse((r) => r.url().includes("/api/settings") && r.request().method() === "PUT");
    await page.locator("#geminiSaveBtn").click();
    await saved;
    await page.reload();
    await openTab(page, "settings");
  };
  /* Start from the default (both browsers share the test database). */
  await openTab(page, "settings");
  if (await box.inputValue()) await save("");
  await expect(box).toHaveValue("");
  await expect(box).toHaveAttribute("placeholder", /^Default: /);
  await save("gemini-test-model");
  await expect(box).toHaveValue("gemini-test-model");
  await save("");
  await expect(box).toHaveValue("");
  await expect(box).toHaveAttribute("placeholder", /^Default: /);
});

/* ================= new screens (v2 model) ================= */

/* Fill the open edit dialog's field by its label. */
async function dialogField(page, label) {
  return page.locator("dialog.v2-dialog .field").filter({ has: page.locator("label", { hasText: label }) }).locator("input,select,textarea").first();
}
async function saveDialog(page) {
  await page.locator("dialog.v2-dialog .btn-primary").click();
  await expect(page.locator("dialog.v2-dialog[open]")).toHaveCount(0);
}

test("new screens: every tab renders without a script error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await expect(page.locator("#v2Overview .v2-tile").first()).toBeVisible();
  for (const [tab, sel] of [["accounts", "#v2Accounts .v2-tiles"], ["transactions", "#v2Transactions .v2-filters"], ["cashflow", "#v2Cashflow .v2-tiles"],
    ["budget", "#v2Budget .v2-month-nav"], ["recurring", "#v2Recurring .v2-card"], ["goals", "#v2Goals .v2-card"], ["settings", "#v2Manage .v2-cats"]]) {
    await openTab(page, tab);
    await expect(page.locator(sel).first()).toBeVisible();
  }
  expect(errors, "script errors:\n" + errors.join("\n")).toEqual([]);
});

test("new screens: add a transaction, file it, and see it in the budget and cash flow", async ({ page }, info) => {
  const name = "E2E farm stand " + info.project.name;
  await openTab(page, "transactions");
  await page.locator("#v2AddTx").click();
  await (await dialogField(page, "Merchant")).fill(name);
  await (await dialogField(page, "Amount")).fill("37.25");
  await (await dialogField(page, "Category")).selectOption({ label: "Groceries" });
  await (await dialogField(page, "Tags")).fill("e2e");
  await saveDialog(page);
  const row = page.locator("#v2Transactions .v2-tx", { hasText: name });
  await expect(row).toContainText("Groceries");
  await expect(row).toContainText("#e2e");
  await expect(row).toContainText("-$37.25");

  /* Edit: a shared expense, my share is a third. */
  await row.click();
  await (await dialogField(page, "My share")).fill("12.41");
  await saveDialog(page);
  await expect(page.locator("#v2Transactions .v2-tx", { hasText: name })).toContainText("mine -$12.41");

  /* Search finds it; the budget counts my share against Groceries. */
  await page.fill("#v2Transactions .v2-search", name);
  await expect(page.locator("#v2Transactions .v2-tx")).toHaveCount(1);
  await openTab(page, "budget");
  const groceries = page.locator("#v2Budget .v2-budget-row", { hasText: "Groceries" });
  await expect(groceries).toBeVisible();
  const input = groceries.locator(".v2-plan-input");
  await input.fill("500");
  await input.press("Enter");
  await expect(page.locator("#v2Budget .v2-budget-row", { hasText: "Groceries" }).locator(".v2-plan-input")).toHaveValue("500");
  await openTab(page, "cashflow");
  await expect(page.locator("#v2Cashflow .v2-cat-row", { hasText: "Groceries" })).toBeVisible();
  await expect(page.locator("#v2Cashflow .v2-table")).toBeVisible();

  /* Delete it again. */
  await openTab(page, "transactions");
  page.once("dialog", (d) => d.accept());
  await page.locator("#v2Transactions .v2-tx", { hasText: name }).first().click();
  await page.locator("dialog.v2-dialog button.danger", { hasText: "Delete" }).click();
  await expect(page.locator("dialog.v2-dialog[open]")).toHaveCount(0);
  await expect(page.locator("#v2Transactions .v2-tx", { hasText: name })).toHaveCount(0);
});

test("new screens: a manual account counts in net worth", async ({ page }, info) => {
  const name = "E2E car " + info.project.name;
  await openTab(page, "accounts");
  const before = await page.locator("#v2Accounts .v2-tile-value").first().textContent();
  await page.locator("#v2AddAccount").click();
  await (await dialogField(page, "Name")).fill(name);
  await (await dialogField(page, "Type")).selectOption("property");
  await (await dialogField(page, "Balance")).fill("12000");
  await saveDialog(page);
  await expect(page.locator("#v2Accounts .v2-acct", { hasText: name })).toContainText("$12,000.00");
  await expect(page.locator("#v2Accounts .v2-tile-value").first()).not.toHaveText(before);
});

test("new screens: a recurring bill shows as coming up, and a goal shows its progress", async ({ page }, info) => {
  const bill = "E2E bill " + info.project.name;
  await openTab(page, "recurring");
  await page.locator("#v2AddRecurring").click();
  await (await dialogField(page, "Name")).fill(bill);
  await (await dialogField(page, "Amount")).fill("49.99");
  await (await dialogField(page, "Next date")).fill(today());
  await saveDialog(page);
  await expect(page.locator("#v2Recurring .v2-card").first()).toContainText(bill);
  await expect(page.locator("#v2Recurring .v2-line-btn", { hasText: bill })).toContainText("-$49.99");

  const goal = "E2E goal " + info.project.name;
  await openTab(page, "goals");
  await page.locator("#v2AddGoal").click();
  await (await dialogField(page, "Name")).fill(goal);
  await (await dialogField(page, "Target")).fill("1000");
  await (await dialogField(page, "Saved so far")).fill("250");
  await saveDialog(page);
  await expect(page.locator("#v2Goals .v2-goal", { hasText: goal })).toContainText("25%");
});

test("new screens: Settings — rules, categories, and the migration check", async ({ page }, info) => {
  await openTab(page, "settings");
  await page.locator("#v2AddRule").click();
  await (await dialogField(page, "When the merchant contains")).fill("e2e-coffee-" + info.project.name);
  await (await dialogField(page, "Add tag")).fill("coffee");
  await saveDialog(page);
  await expect(page.locator("#v2Manage .v2-line", { hasText: "e2e-coffee-" + info.project.name })).toContainText("#coffee");
  await page.locator("#v2Manage button", { hasText: "Check now" }).click();
  await expect(page.locator("#v2Manage .v2-ok")).toContainText("matches the classic app");
});

/* ================= no jump on review ================= */

test("marking a bank payment reviewed keeps your place and doesn't reload the page", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const sync = await pairSync(page, request, token, "review-" + info.project.name);
  const auth = { Authorization: "Bearer " + token };
  /* Enough expenses that the Daily tab scrolls. */
  for (let i = 0; i < 14; i++) {
    expect((await request.post("/api/expenses", { headers: auth, data: { date: today(), description: "E2E filler " + i + " " + info.project.name, amount: 3 + i, category: "Groceries" } })).ok()).toBeTruthy();
  }
  const names = ["ZELLE FROM E2E ONE", "ZELLE FROM E2E TWO"].map((n) => n + " " + info.project.name);
  expect((await request.post("/api/bank", { headers: sync, data: {
    accounts: [{ id: "e2e-chk-" + info.project.name, institution: "E2E Bank", name: "Checking", subtype: "checking", currentBalance: 100 }],
    transactions: names.map((n, i) => ({ id: "e2e-zelle-" + i + "-" + info.project.name, accountId: "e2e-chk-" + info.project.name, date: today(), name: n, amount: -(20 + i) }))
  } })).ok()).toBeTruthy();

  await page.reload();
  await openTab(page, "daily");
  const first = page.locator(".review-item", { hasText: names[0] });
  await expect(first).toBeVisible();
  /* Scroll so the item sits mid-screen, well away from the top. */
  await first.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);

  const budgetLoads = [];
  page.on("request", (r) => { if (r.method() === "GET" && /\/api\/(budget|bank|pending)\b/.test(r.url())) budgetLoads.push(r.url()); });
  const saved = page.waitForResponse((r) => r.url().includes("/api/bank") && r.request().method() === "PATCH");
  await first.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(first).toHaveCount(0); /* gone at once, before the save returns */
  expect((await saved).ok()).toBeTruthy();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.scrollY);
  expect(Math.abs(after - before), "scroll moved from " + before + " to " + after).toBeLessThanOrEqual(2);
  expect(budgetLoads, "no reload of the budget, bank or pending data").toEqual([]);
  await expect(page.locator(".review-item", { hasText: names[1] })).toBeVisible();

  /* It stays reviewed after a reload. */
  await page.reload();
  await openTab(page, "daily");
  await expect(page.locator(".review-item", { hasText: names[0] })).toHaveCount(0);
});

test("new screens: Mark reviewed keeps your place in Transactions", async ({ page, request }, info) => {
  const token = await signIn(page, request);
  const sync = await pairSync(page, request, token, "v2review-" + info.project.name);
  const auth = { Authorization: "Bearer " + token };
  for (let i = 0; i < 14; i++) {
    expect((await request.post("/api/expenses", { headers: auth, data: { date: today(), description: "E2E row " + i + " " + info.project.name, amount: 2 + i, category: "Groceries" } })).ok()).toBeTruthy();
  }
  const name = "E2E TRANSFER OUT " + info.project.name;
  expect((await request.post("/api/bank", { headers: sync, data: {
    accounts: [{ id: "e2e-chk2-" + info.project.name, institution: "E2E Bank", name: "Checking 2", subtype: "checking", currentBalance: 100 }],
    transactions: [{ id: "e2e-out-" + info.project.name, accountId: "e2e-chk2-" + info.project.name, date: "2026-01-02", name, amount: 75 }]
  } })).ok()).toBeTruthy();

  await openTab(page, "transactions");
  const row = page.locator("#v2Transactions .v2-tx", { hasText: name });
  await expect(row).toBeVisible();
  await row.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  await row.click();
  await page.locator("dialog.v2-dialog button", { hasText: "Mark reviewed" }).click();
  await expect(page.locator("dialog.v2-dialog[open]")).toHaveCount(0);
  await expect(page.locator("#v2Transactions .v2-tx", { hasText: name })).not.toHaveClass(/review/);
  await page.waitForTimeout(600); /* the background save and in-place refresh */
  const after = await page.evaluate(() => window.scrollY);
  expect(Math.abs(after - before), "scroll moved from " + before + " to " + after).toBeLessThanOrEqual(2);
  await expect(page.locator("#v2Transactions .v2-loading")).toHaveCount(0);
});
