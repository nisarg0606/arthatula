/* "Ask about your budget" (Dashboard). */
import { fmt } from "../core/format.js";
import { app, els } from "./context.js";
import { todayLocal } from "./daily.js";
import { apiFetch } from "./storage.js";

/* The question goes to /api/ask, which does the math in the app and has
   Gemini explain it. The last few turns go along so follow-ups make sense.
   The chat is kept in this browser (not the database) so it survives a
   reload, and is dropped 3 hours after the last message or when "Clear
   chat" is confirmed. */
var CHAT_KEY = "arthatula-ask", CHAT_TTL_MS = 3 * 60 * 60 * 1000;
var history = [];
var shown = []; /* { cls, text, facts } for every finished bubble */
var savedAt = 0;
var busy = false;

function bubble(role, text, facts) {
  var b = document.createElement("div");
  b.className = "ask-msg " + role;
  b.textContent = text;
  if (facts) addFacts(b, facts);
  els.askLog.appendChild(b);
  els.askLog.hidden = false;
  els.askClear.hidden = false;
  b.scrollIntoView({ block: "nearest" });
  return b;
}

function addFacts(b, line) {
  var f = document.createElement("span");
  f.className = "ask-facts";
  f.textContent = line;
  b.appendChild(f);
}

function save() {
  savedAt = Date.now();
  try { localStorage.setItem(CHAT_KEY, JSON.stringify({ at: savedAt, history: history, shown: shown })); } catch (e) {}
}

function clearChat() {
  history = []; shown = []; savedAt = 0;
  els.askLog.textContent = "";
  els.askLog.hidden = true;
  els.askClear.hidden = true;
  try { localStorage.removeItem(CHAT_KEY); } catch (e) {}
}

function restore() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(CHAT_KEY) || "null"); } catch (e) {}
  if (!saved || !(Date.now() - saved.at < CHAT_TTL_MS) || !Array.isArray(saved.shown)) { clearChat(); return; }
  history = Array.isArray(saved.history) ? saved.history : [];
  shown = saved.shown;
  savedAt = saved.at;
  shown.forEach(function (m) { bubble(m.cls, m.text, m.facts); });
}

/* The app's own numbers behind an affordability answer. */
function factsLine(a) {
  if (!a || a.error) return a && a.error ? a.error : "";
  return "Balance end of " + a.month + ": " + fmt(a.balanceAfter) + " (was " + fmt(a.balanceBefore) + ") · Lowest after: " +
    a.lowestAfter.month + " " + fmt(a.lowestAfter.balance) + " · " + a.endMonth + ": " + fmt(a.endingAfter);
}

function ask(question) {
  question = String(question || "").trim();
  if (!question || busy) return;
  if (app.mode !== "database") { bubble("note", "Ask needs database mode; you're in local-only mode."); return; }
  if (savedAt && Date.now() - savedAt >= CHAT_TTL_MS) clearChat(); /* tab left open past 3 hours */
  busy = true;
  els.askBtn.disabled = true;
  els.askInput.value = "";
  bubble("user", question);
  var pending = bubble("assistant thinking", "Thinking…");
  apiFetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: question, history: history, today: todayLocal() }) })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (r) {
      pending.classList.remove("thinking");
      if (!r.ok) { pending.classList.add("note"); pending.textContent = r.data.error || "Couldn't get an answer. Try again."; return; }
      pending.textContent = r.data.answer;
      var line = factsLine(r.data.affordability);
      if (line) addFacts(pending, line);
      history.push({ role: "user", text: question }, { role: "assistant", text: r.data.answer });
      history = history.slice(-6);
      shown.push({ cls: "user", text: question }, { cls: "assistant", text: r.data.answer, facts: line });
      shown = shown.slice(-40);
      save();
    })
    .catch(function () { pending.classList.remove("thinking"); pending.classList.add("note"); pending.textContent = "Couldn't reach the app. Check your connection and try again."; })
    .then(function () { busy = false; els.askBtn.disabled = false; });
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (!els.askForm) return;
  restore();
  els.askClear.addEventListener("click", function () {
    if (!busy && window.confirm("Clear this chat? The assistant will forget it too.")) clearChat();
  });
  els.askForm.addEventListener("submit", function (e) { e.preventDefault(); ask(els.askInput.value); });
  document.querySelectorAll(".ask-suggest button").forEach(function (b) {
    b.addEventListener("click", function () { ask(b.textContent); });
  });
}
