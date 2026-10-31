/*
 * Arthatula — "Ask about my budget" (Dashboard Ask box).
 *
 * Routes (this file serves /api/ask):
 *   POST /api/ask { question, history?, today? } -> { answer, affordability }
 *        Device sessions only. Uses the Gemini key saved in Settings.
 *        1. The app reads any purchase out of the question itself
 *           (amount, month, monthly or one-time; js/core/question.js).
 *        2. The app does the math: the month-by-month forecast and, for
 *           a purchase, its effect (js/core/afford.js, the same code the
 *           dashboard uses).
 *        3. One Gemini call writes a short answer from those computed
 *           FACTS only.
 *        Without a Gemini key the reply is 409 with a hint to add one.
 */
import { ensureTables, readState, getBankSnapshot, getPendingSnapshot, requireAuth } from "./budget.js";
import { getGeminiConfig } from "./categorize.js";
import { MONTHS, sanitizeState } from "../../js/core/plan.js";
import { isSpending, expenseShare } from "../../js/core/spending.js";
import { owedToMe } from "../../js/core/review.js";
import { countedPending } from "../../js/core/pending.js";
import { computeDashboard } from "../../js/core/summary.js";
import { forecast, affordCheck } from "../../js/core/afford.js";
import { parsePurchase } from "../../js/core/question.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
const round = (n) => Math.round((n || 0) * 100) / 100;

async function gemini(cfg, prompt, asJson, fetchImpl) {
  const res = await (fetchImpl || fetch)(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(cfg.model) + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: asJson ? { responseMimeType: "application/json", temperature: 0 } : { temperature: 0.3 }
      })
    }
  );
  if (!res.ok) {
    /* Pass on Gemini's own reason (bad key, quota, retired model...);
       it never contains the key. */
    let reason = "HTTP " + res.status;
    try {
      const err = (await res.json()).error || {};
      reason = [err.status, err.message].filter(Boolean).join(": ").slice(0, 200) || reason;
    } catch (e) { /* keep the HTTP status */ }
    throw Object.assign(new Error(reason), { status: 502 });
  }
  const payload = await res.json();
  return ((payload.candidates && payload.candidates[0] && payload.candidates[0].content &&
    payload.candidates[0].content.parts) || []).map((p) => p.text || "").join("").trim();
}

/* What Gemini is told about the budget: computed totals, not raw data. */
export function buildFacts(state, bank, pending, todayIso) {
  const todayKey = todayIso.slice(0, 7);
  const rows = forecast(state, todayKey);
  const thisMonth = {};
  const recent = [];
  const since = new Date(Date.parse(todayIso + "T00:00:00Z") - 30 * 864e5).toISOString().slice(0, 10);
  (state.dailyExpenses || []).forEach((e) => {
    if (!isSpending(e)) return;
    if (e.date.slice(0, 7) === todayKey) thisMonth[e.category] = round((thisMonth[e.category] || 0) + expenseShare(e));
    if (e.date >= since && e.date <= todayIso) recent.push(e);
  });
  const counted = countedPending(state.dailyExpenses);
  const pendingTotal = round(((pending && pending.transactions) || [])
    .filter((t) => !counted[t.id]).reduce((s, t) => s + (t.amount || 0), 0));
  return {
    today: todayIso,
    planRange: MONTHS[0].label + " to " + MONTHS[MONTHS.length - 1].label,
    startingBalance: state.startingBalance, actualsStart: state.baselineDate,
    latestActualBalance: computeDashboard(state, false).totals.ending,
    months: rows.map((r) => {
      const m = state.months.find((x) => x.monthKey === r.monthKey) || {};
      return { month: r.label, basis: r.source, net: r.net, balanceAtEnd: r.balance,
        freeAfterBillsAndLoans: r.freeAfterBills, oneOffs: m.oneOffs || 0, oneOffNote: m.oneOffNote || "" };
    }),
    spendingThisMonthByCategory: thisMonth,
    last30Days: {
      total: round(recent.reduce((s, e) => s + expenseShare(e), 0)),
      biggest: recent.slice().sort((a, b) => expenseShare(b) - expenseShare(a)).slice(0, 5)
        .map((e) => ({ date: e.date, description: e.description, amount: expenseShare(e), category: e.category, note: e.note || "" }))
    },
    owedToMeByHousemates: owedToMe(state, bank),
    pendingChargesNotCountedYet: pendingTotal
  };
}

function answerPrompt(question, history, facts, afford) {
  const convo = history.map((h) => (h.role === "user" ? "Owner: " : "Assistant: ") + h.text).join("\n");
  return [
    "You are the assistant inside a personal budget app, answering its owner.",
    "Use ONLY the FACTS below; the app computed them. Do not do your own arithmetic beyond reading them, and quote amounts as given.",
    "If the facts can't answer the question, say what is missing.",
    afford ? 'This is an affordability question: start with a one-line verdict that matches affordability.verdict ("comfortable" = Yes, "tight" = it\'s tight, "no" = not without changes), then the 2 or 3 numbers that matter (balance after that month, the lowest point and when, the ending balance). Mention the cushion rule only if the verdict is tight.' : "",
    "Keep it under 120 words, plain sentences, no tables or markdown headings.",
    "FACTS: " + JSON.stringify(Object.assign({}, facts, afford ? { affordability: afford } : {})),
    convo ? "Conversation so far:\n" + convo : "",
    "Owner's question: " + question
  ].filter(Boolean).join("\n");
}

/* "What about in March?" / "And if it was $1,500?" after an affordability
   question: read the purchase from the new words first, then the earlier
   question for whatever they leave out. */
export function followUpPurchase(question, history, todayIso) {
  if (!/\b(it|that|this|instead|what about|what if|how about)\b/i.test(question)) return null;
  const last = history.filter((h) => h.role === "user").pop();
  if (!last) return null;
  const when = /\b(next month|in \d+ months?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s+20\d\d)?)\b/gi;
  const earlier = when.test(question) ? last.text.replace(when, "") : last.text; /* the new month wins */
  return parsePurchase(question + " " + earlier, todayIso);
}

export async function answerQuestion(env, body, fetchImpl) {
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";
  if (!question) return { status: 400, data: { error: "Ask a question first." } };
  const cfg = await getGeminiConfig(env);
  if (!cfg.key) return { status: 409, data: { error: "Add your Gemini key in Settings to use Ask." } };
  const todayIso = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
    ? body.today : new Date().toISOString().slice(0, 10);
  const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
    .filter((h) => h && typeof h.text === "string" && (h.role === "user" || h.role === "assistant"))
    .map((h) => ({ role: h.role, text: h.text.slice(0, 1000) }));

  const db = env.DB;
  const state = sanitizeState(await readState(db));
  const facts = buildFacts(state, await getBankSnapshot(db), await getPendingSnapshot(db), todayIso);

  /* The app reads the purchase itself, so a question costs one Gemini call. */
  const purchase = parsePurchase(question, todayIso) || followUpPurchase(question, history, todayIso);
  const afford = purchase ? affordCheck(state, { amount: purchase.amount, monthKey: purchase.monthKey,
    todayKey: todayIso.slice(0, 7), months: purchase.months }) : null;
  const answer = await gemini(cfg, answerPrompt(question, history, facts, afford), false, fetchImpl);
  return { status: 200, data: { answer: answer || "I couldn't come up with an answer. Try asking another way.", affordability: afford } };
}

export async function onRequestPost(context) {
  if (!context.env.DB) return json({ error: "No database bound. Bind a D1 database as DB (see README)." }, 503);
  try {
    const auth = await requireAuth(context.env.DB, context.request);
    if (auth.response) return auth.response;
    await ensureTables(context.env.DB);
    let body = {};
    try { body = await context.request.json(); } catch (e) { /* empty body */ }
    const out = await answerQuestion(context.env, body || {});
    return json(out.data, out.status);
  } catch (err) {
    return json({ error: err.status === 502 ? "Gemini couldn't answer (" + err.message + "). Check the key in Settings, or try again in a moment." : String((err && err.message) || err) }, err.status || 500);
  }
}
