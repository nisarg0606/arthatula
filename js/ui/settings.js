/* AI provider + Splitwise settings. app.geminiInfo holds the active AI
   provider's status from GET /api/settings (its "ai" object). */
import { app, els } from "./context.js";
import { apiFetch } from "./storage.js";

/* ================= AI provider settings ================= */

var SHORT = { gemini: "Gemini", grok: "Grok", openai: "AI" };

function info() { return app.geminiInfo || {}; }

export function renderGeminiStatus() {
  var ai = info(), name = SHORT[ai.provider] || "AI";
  var txt = ai.hasKey
    ? "✦ " + name + ": on (key ••••" + (ai.last4 || "") + ", " + (ai.model || "") + ")"
    : "✦ AI: off — keyword rules";
  if (els.geminiStatus) {
    els.geminiStatus.textContent = txt;
    els.geminiStatus.className = "storage-badge " + (ai.hasKey ? "database" : "local");
  }
  if (els.geminiSettingsStatus) {
    els.geminiSettingsStatus.textContent = app.mode !== "database"
      ? "Local-only mode: an AI key can only be saved with the database connected. Categories currently use keyword rules."
      : ai.hasKey
        ? (ai.label || name) + " is on (key " + (ai.source === "env" ? "from a Cloudflare secret" : "saved in the app") +
          ", ••••" + (ai.last4 || "") + "). Model: " + (ai.model || "") + "."
        : "No key for " + (ai.label || "this provider") + " yet — expenses are sorted by keyword rules until you add one.";
  }
  if (els.aiProviderSelect && ai.provider) els.aiProviderSelect.value = ai.provider;
  /* The box holds a model only when one is saved; empty means "use the
     default", which the greyed-out hint names. */
  if (els.geminiModelInput) {
    els.geminiModelInput.value = ai.modelSource === "saved" ? ai.model : "";
    els.geminiModelInput.placeholder = ai.defaultModel ? "Default: " + ai.defaultModel : "Required, e.g. gpt-5-mini";
  }
  if (els.aiBaseUrlField) els.aiBaseUrlField.hidden = ai.provider !== "openai";
  if (els.aiBaseUrlInput && ai.provider === "openai") els.aiBaseUrlInput.value = ai.baseUrl || "";
  var p = (ai.providers || []).filter(function (x) { return x.id === ai.provider; })[0];
  if (els.aiKeyHelp) els.aiKeyHelp.textContent = p && p.keyUrl ? "Get a key: " + p.keyUrl : "";
}

export function refreshGeminiStatus() {
  if (app.mode !== "database") { app.geminiInfo = { hasKey: false, last4: null, model: "", source: null }; app.splitwiseInfo = { hasKey: false, last4: null, source: null }; renderGeminiStatus(); renderSplitwiseStatus(); return; }
  apiFetch("/api/settings").then(function (res) { if (!res.ok) throw new Error("settings"); return res.json(); })
    .then(function (data) { app.geminiInfo = data.ai || data.gemini || app.geminiInfo; app.splitwiseInfo = data.splitwise || app.splitwiseInfo; app.finnhubInfo = data.finnhub || null; renderGeminiStatus(); renderSplitwiseStatus(); })
    .catch(function () { renderGeminiStatus(); renderSplitwiseStatus(); });
}

function putAi(body) {
  return apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "settings");
        app.geminiInfo = data.ai || data.gemini || app.geminiInfo;
        renderGeminiStatus();
        return data;
      });
    });
}

/* ================= Splitwise settings ================= */

export function renderSplitwiseStatus() {
  if (!els.splitwiseSettingsStatus) return;
  els.splitwiseSettingsStatus.textContent = app.mode !== "database"
    ? "Local-only mode: the Splitwise key can only be saved with the database connected."
    : app.splitwiseInfo.hasKey
      ? "Connected (key " + (app.splitwiseInfo.source === "env" ? "from the Cloudflare secret" : "saved in the app") +
        ", ••••" + (app.splitwiseInfo.last4 || "") + "). Open the Splitwise tab to see live balances."
      : "Not connected — paste your Splitwise personal API key below to see live balances in the Splitwise tab.";
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.aiProviderSelect) {
    els.aiProviderSelect.addEventListener("change", function () {
      putAi({ aiProvider: els.aiProviderSelect.value })
        .catch(function (e) { alert("Could not switch: " + e.message); renderGeminiStatus(); });
    });
  }
  if (els.geminiSaveBtn) {
    els.geminiSaveBtn.addEventListener("click", function () {
      var key = els.geminiKeyInput.value.trim();
      var model = els.geminiModelInput.value.trim();
      var body = { aiApiKey: key || undefined, aiModel: model };
      if (info().provider === "openai" && els.aiBaseUrlInput) body.aiBaseUrl = els.aiBaseUrlInput.value.trim();
      if (!key && !model && info().modelSource !== "saved" && body.aiBaseUrl === undefined) { alert("Paste a key (or a model name) first."); return; }
      putAi(body).then(function () {
        els.geminiKeyInput.value = "";
        alert(key ? "Saved. The key is stored on the server and never shown again." : "Saved.");
      }).catch(function (e) { alert("Could not save: " + (e.message === "settings" ? "settings need the database (Database mode)." : e.message)); });
    });
  }
  if (els.geminiClearBtn) {
    els.geminiClearBtn.addEventListener("click", function () {
      if (!confirm("Clear the " + (info().label || "AI") + " key saved in the app? (A Cloudflare secret, if set, is unaffected.)")) return;
      putAi({ clearAiKey: true }).catch(function () { alert("Could not clear — settings need the database (Database mode)."); });
    });
  }
  if (els.splitwiseSaveBtn) {
    els.splitwiseSaveBtn.addEventListener("click", function () {
      var key = els.splitwiseKeyInput.value.trim();
      if (!key) { alert("Paste your Splitwise API key first."); return; }
      apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ splitwiseApiKey: key }) })
        .then(function (res) { if (!res.ok) throw new Error("settings"); return res.json(); })
        .then(function (data) {
          app.splitwiseInfo = data.splitwise || app.splitwiseInfo;
          els.splitwiseKeyInput.value = "";
          renderSplitwiseStatus();
          alert("Saved. The key is stored server-side and never shown again — open the Splitwise tab to see your live balances.");
        })
        .catch(function () { alert("Could not save — settings need the database (Database mode)."); });
    });
  }
  if (els.splitwiseClearBtn) {
    els.splitwiseClearBtn.addEventListener("click", function () {
      if (!confirm("Disconnect Splitwise? This clears the API key saved in the app. (A Cloudflare SPLITWISE_API_KEY secret, if set, is unaffected.)")) return;
      apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearSplitwiseKey: true }) })
        .then(function (res) { if (!res.ok) throw new Error("settings"); return res.json(); })
        .then(function (data) { app.splitwiseInfo = data.splitwise || app.splitwiseInfo; renderSplitwiseStatus(); })
        .catch(function () { alert("Could not clear — settings need the database (Database mode)."); });
    });
  }
}
