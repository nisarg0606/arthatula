/*
 * First-run checklist on Home (serves /api/v2/checklist).
 *   GET  -> { show, dismissed, items: { balance, expense, budget, ai, homescreen } }
 *        Each item is true once done, read from your data (sample rows
 *        don't count); homescreen is ticked by the app when it runs
 *        from the Home Screen, or by "I've added it".
 *        show: not dismissed, something left to do, no sample data
 *        loaded, and the sample-data welcome card is out of the way.
 *   POST { dismissed: true|false } | { done: "homescreen" } -> as GET
 */
import { handleV2, bodyOf, HttpError } from "../_v2http.js";
import { getAiConfig } from "../_ai.js";
import { status as demoStatus } from "./demo.js";

const DEMO = "demo_*";

async function state(s, env) {
  const [r, home, dismissed, demo, ai] = await Promise.all([
    s.first(
      "SELECT (SELECT COUNT(*) FROM accounts WHERE owner_id = ?1 AND id NOT GLOB ?2) AS accounts, " +
      "(SELECT COUNT(*) FROM transactions WHERE owner_id = ?1 AND id NOT GLOB ?2 AND amount_cents < 0) AS spent, " +
      "(SELECT COUNT(*) FROM budgets WHERE owner_id = ?1 AND source <> 'demo') AS budgets, " +
      /* The classic plan's starting balance (one owner, not scoped). */
      "(SELECT value FROM budget_settings WHERE key = 'starting_balance_cents') AS start", DEMO),
    s.getSetting("checklist:homescreen"), s.getSetting("checklist:dismissed"), demoStatus(s), getAiConfig(env)
  ]);
  const items = {
    balance: !!(r && r.accounts) || !!(r && Number(r.start)),
    expense: !!(r && r.spent),
    budget: !!(r && r.budgets),
    ai: !!ai.key,
    homescreen: home === "1"
  };
  const off = dismissed === "1";
  const todo = Object.keys(items).some((k) => !items[k]);
  return { show: !off && todo && !demo.demo && (demo.dismissed || !demo.empty), dismissed: off, items };
}

export const onRequestGet = (context) => handleV2(context, async ({ s, env }) => state(s, env));

export const onRequestPost = (context) => handleV2(context, async ({ s, env, request }) => {
  const b = await bodyOf(request);
  if (typeof b.dismissed === "boolean") await s.setSetting("checklist:dismissed", b.dismissed ? "1" : "0");
  else if (b.done === "homescreen") await s.setSetting("checklist:homescreen", "1");
  else throw new HttpError(400, "Send { dismissed } or { done: \"homescreen\" }.");
  return state(s, env);
});
