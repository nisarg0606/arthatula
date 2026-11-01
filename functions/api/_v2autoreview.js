/*
 * Auto-review: Gemini looks at each bank row that is waiting for review
 * before you do. Each one is compared with what you did with similar
 * payments before. (Files starting with "_" are not Pages routes.)
 *
 *   "seen"      — you've had this kind of payment before: it gets the
 *                 category you gave the earlier ones, so it is counted,
 *                 and it leaves the To review list marked "Checked by
 *                 Gemini" with the reason.
 *   "duplicate" — the same amount is already in your daily log within a
 *                 few days, so it is already counted there: it leaves the
 *                 list and keeps its current (not counted) category.
 *   "ask"       — anything new or unclear stays on To review for you.
 *
 * Gemini only ever picks from the categories of the similar past rows it
 * is shown, so it can't invent a new treatment. With no Gemini key (or
 * when Gemini fails) a strict rule stands in: the payment name matches at
 * least two past rows that all share one category, or exactly one
 * same-amount daily-log entry is within 3 days.
 *
 * Every decision is stored in auto_reviews (one row per transaction), so
 * a payment is looked at once. "Not right" (needsReview: true) marks it
 * rejected: it goes back on To review and is never auto-reviewed again;
 * marking it reviewed yourself marks it confirmed.
 */
import { getGeminiConfig } from "./categorize.js";

export const BATCH = 30;
const NOISE = new Set(["pos", "debit", "credit", "purchase", "card", "ach", "web", "id", "ppd", "online", "payment", "pmt", "recurring", "checkcard", "visa", "mastercard", "the", "inc", "llc", "co", "sq", "tst", "sp"]);

/* "TRADER JOE'S #552 SEATTLE" -> ["trader", "joe", "seattle"] */
export function nameTokens(name) {
  return String(name || "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ")
    .filter((w) => w.length >= 2 && !NOISE.has(w));
}
export function nameKey(name) { return nameTokens(name).join(" "); }

/* 1 = same name; otherwise the share of words in common, but only when
   the first word matches (so "amazon" never matches "uber"). */
export function similarity(a, b) {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return 0;
  if (x.join(" ") === y.join(" ")) return 1;
  if (x[0] !== y[0]) return 0;
  const sy = new Set(y);
  const common = x.filter((w) => sy.has(w)).length;
  return common / Math.max(x.length, y.length);
}

const dayNum = (iso) => Date.parse(String(iso) + "T00:00:00Z") / 864e5;

/* What one waiting row is compared with: similar past rows you reviewed
   (same direction and first word, best matches first, at most 6) and daily-log or
   hand-added rows with the same amount within 3 days. */
export function evidenceFor(tx, history) {
  const similar = [];
  const duplicates = [];
  for (const h of history) {
    if (h.id === tx.id) continue;
    if (Math.sign(h.amountCents) === Math.sign(tx.amountCents)) {
      const sim = similarity(tx.merchant || tx.description, h.merchant || h.description);
      /* Loose on purpose: Gemini makes the call; the strict rule only
         ever uses exact name matches (sim 1). */
      if (sim >= 0.34) similar.push({ sim, row: h });
    }
    if ((h.source === "v1exp" || h.source === "manual") && h.amountCents === tx.amountCents &&
        Math.abs(dayNum(h.date) - dayNum(tx.date)) <= 3) duplicates.push(h);
  }
  similar.sort((a, b) => b.sim - a.sim || (a.row.date < b.row.date ? 1 : -1));
  return { similar: similar.slice(0, 6).map((x) => Object.assign({ sim: x.sim }, x.row)), duplicates: duplicates.slice(0, 3) };
}

/* The strict no-Gemini rule (see the header). */
export function ruleDecision(tx, ev) {
  if (ev.duplicates.length === 1) {
    const d = ev.duplicates[0];
    return { decision: "duplicate", reason: "Already in your daily log: \"" + (d.merchant || d.description) + "\" on " + d.date + "." };
  }
  const exact = ev.similar.filter((x) => x.sim === 1 && x.categoryId);
  if (exact.length >= 2 && exact.every((x) => x.categoryId === exact[0].categoryId)) {
    return { decision: "seen", categoryId: exact[0].categoryId, reason: "Same as " + exact.length + " earlier payments you filed this way." };
  }
  return { decision: "ask" };
}

export function buildReviewPrompt(items, catName) {
  const fmt = (c) => (c < 0 ? "-" : "+") + "$" + (Math.abs(c) / 100).toFixed(2);
  const lines = [
    "You help one person review their bank transactions. For each NEW transaction below, decide:",
    '- "seen": the same kind of payment appears in its PAST list (same merchant or payee, same purpose; the amount may differ for things like groceries or bills). Pick the categoryId the past rows used.',
    '- "duplicate": it is the same payment as one of its DAILY LOG entries (same amount, a few days apart, plausibly the same merchant).',
    '- "ask": anything else, including a first-time payee, an unusual amount for a fixed bill, or when you are not sure. Prefer "ask" when in doubt.',
    "Reply with JSON only: an array of {\"id\": \"...\", \"decision\": \"seen\"|\"duplicate\"|\"ask\", \"categoryId\": \"...\" (only for seen), \"confidence\": 0..1, \"reason\": \"one short sentence for the person\"}.",
    ""
  ];
  items.forEach((it) => {
    lines.push("NEW id=" + it.tx.id + " | " + it.tx.date + " | " + String(it.tx.merchant || it.tx.description).slice(0, 120) + " | " + fmt(it.tx.amountCents));
    it.ev.similar.forEach((h) => lines.push("  PAST " + h.date + " | " + String(h.merchant || h.description).slice(0, 120) + " | " + fmt(h.amountCents) + " | categoryId=" + h.categoryId + " (" + catName(h.categoryId) + ")"));
    it.ev.duplicates.forEach((d) => lines.push("  DAILY LOG " + d.date + " | " + String(d.merchant || d.description).slice(0, 120) + " | " + fmt(d.amountCents)));
  });
  return lines.join("\n");
}

/* Parse Gemini's answer and keep only decisions its evidence allows. */
export function parseReviewAnswer(payload, items) {
  let arr = null;
  try {
    const text = payload.candidates[0].content.parts.map((p) => p.text || "").join("").trim();
    const m = text.match(/\[[\s\S]*\]/);
    arr = JSON.parse(m ? m[0] : text);
  } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  const byId = {};
  items.forEach((it) => { byId[it.tx.id] = it; });
  const out = {};
  for (const a of arr) {
    const it = a && byId[a.id];
    if (!it) continue;
    const conf = typeof a.confidence === "number" ? a.confidence : 0;
    const reason = String(a.reason || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (a.decision === "seen" && conf >= 0.7 && it.ev.similar.some((h) => h.categoryId === a.categoryId)) {
      out[a.id] = { decision: "seen", categoryId: a.categoryId, reason: reason || "Looks like payments you had before." };
    } else if (a.decision === "duplicate" && conf >= 0.7 && it.ev.duplicates.length) {
      out[a.id] = { decision: "duplicate", reason: reason || "Already in your daily log." };
    } else {
      out[a.id] = { decision: "ask", reason };
    }
  }
  return out;
}

async function askGemini(env, items, catName, fetchImpl) {
  const { key, model } = await getGeminiConfig(env || {});
  if (!key) return null;
  try {
    const res = await (fetchImpl || fetch)(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildReviewPrompt(items, catName) }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 }
        })
      }
    );
    if (!res.ok) return null;
    return parseReviewAnswer(await res.json(), items);
  } catch (e) { return null; }
}

/* Review up to BATCH waiting rows. Returns { reviewed, duplicates, asked, remaining, by }. */
export async function runAutoReview(s, env, fetchImpl) {
  const done = {};
  (await s.all("SELECT transaction_id, verdict FROM auto_reviews WHERE owner_id = ?1")).forEach((r) => { done[r.transaction_id] = r.verdict; });
  const waiting = (await s.all(
    "SELECT id, source, date, merchant, description, amount_cents FROM transactions WHERE owner_id = ?1 AND needs_review = 1 AND hidden = 0 AND pending = 0 ORDER BY date DESC"
  )).filter((r) => !done[r.id]);
  if (!waiting.length) return { reviewed: 0, duplicates: 0, asked: 0, remaining: 0, by: null };
  const batch = waiting.slice(0, BATCH).map((r) => ({ id: r.id, source: r.source, date: r.date, merchant: r.merchant, description: r.description, amountCents: r.amount_cents }));

  /* What you decided yourself: reviewed, visible, categorised rows from
     the last 18 months. Unconfirmed auto-reviews and rejected ones are
     left out, so Gemini only learns from you. */
  const since = new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
  const history = (await s.all(
    "SELECT id, source, date, merchant, description, amount_cents, category_id FROM transactions WHERE owner_id = ?1 AND needs_review = 0 AND hidden = 0 AND date >= ?2 AND source <> 'v1actual'",
    since
  )).filter((r) => done[r.id] !== "reviewed" && done[r.id] !== "rejected")
    .map((r) => ({ id: r.id, source: r.source, date: r.date, merchant: r.merchant, description: r.description, amountCents: r.amount_cents, categoryId: r.category_id }));
  const cats = {};
  (await s.all("SELECT id, name FROM categories WHERE owner_id = ?1")).forEach((c) => { cats[c.id] = c.name; });
  const catName = (id) => cats[id] || "Uncategorized";

  const items = batch.map((tx) => ({ tx, ev: evidenceFor(tx, history) }));
  /* Only rows with something to compare against go to Gemini; a
     payment with no similar past row and no daily-log match is new. */
  const withEvidence = items.filter((it) => it.ev.similar.length || it.ev.duplicates.length);
  const ai = withEvidence.length ? await askGemini(env, withEvidence, catName, fetchImpl) : null;
  const by = ai ? "gemini" : "rules";

  const stmts = [];
  const counts = { reviewed: 0, duplicates: 0, asked: 0 };
  for (const it of items) {
    let d = ai ? ai[it.tx.id] : null;
    if (!d) d = ruleDecision(it.tx, it.ev);
    /* Every Gemini "seen" is also checked against the strict rule's
       floor: at least one past row with that very category. */
    if (d.decision === "seen" && !it.ev.similar.some((h) => h.categoryId === d.categoryId)) d = { decision: "ask" };
    const verdict = d.decision === "ask" ? "ask" : "reviewed";
    stmts.push([
      "INSERT INTO auto_reviews (owner_id, transaction_id, verdict, decision, reviewer, category_id, reason, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now')) " +
      "ON CONFLICT(owner_id, transaction_id) DO UPDATE SET verdict = excluded.verdict, decision = excluded.decision, reviewer = excluded.reviewer, category_id = excluded.category_id, reason = excluded.reason, checked_at = excluded.checked_at",
      it.tx.id, verdict, d.decision, ai && ai[it.tx.id] ? "gemini" : "rules", d.categoryId || null, d.reason || ""
    ]);
    if (d.decision === "seen") {
      counts.reviewed++;
      stmts.push(["UPDATE transactions SET category_id = ?3, category_locked = 1, needs_review = 0, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", it.tx.id, d.categoryId]);
    } else if (d.decision === "duplicate") {
      counts.duplicates++;
      stmts.push(["UPDATE transactions SET category_locked = 1, needs_review = 0, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", it.tx.id]);
    } else counts.asked++;
  }
  await s.batch(stmts);
  return Object.assign(counts, { remaining: Math.max(0, waiting.length - batch.length), by });
}
