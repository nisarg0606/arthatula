/* Gemini settings. */
import { app, els } from "./context.js";
import { apiFetch } from "./storage.js";

/* ================= Gemini settings ================= */

export function renderGeminiStatus() {
  var txt = app.geminiInfo.hasKey
    ? "✦ Gemini: on (key ••••" + (app.geminiInfo.last4 || "") + ", " + (app.geminiInfo.model || "") + ")"
    : "✦ Gemini: off — keyword rules";
  if (els.geminiStatus) {
    els.geminiStatus.textContent = txt;
    els.geminiStatus.className = "storage-badge " + (app.geminiInfo.hasKey ? "database" : "local");
  }
  if (els.geminiSettingsStatus) {
    els.geminiSettingsStatus.textContent = app.mode !== "database"
      ? "Local-only mode: a Gemini key can only be saved with the database connected. Categories currently use keyword rules."
      : app.geminiInfo.hasKey
        ? "A key is configured (" + (app.geminiInfo.source === "env" ? "Cloudflare secret" : "saved in the app") +
          ", ••••" + (app.geminiInfo.last4 || "") + "). Model: " + (app.geminiInfo.model || "") + "."
        : "No key configured — daily expenses are categorized by keyword rules. Add a key below or set the GEMINI_API_KEY secret.";
  }
  /* The box holds a model only when one is saved; empty means "use the
     default", which the greyed-out hint names. */
  if (els.geminiModelInput) {
    els.geminiModelInput.value = app.geminiInfo.modelSource === "saved" ? app.geminiInfo.model : "";
    els.geminiModelInput.placeholder = "Default: " + (app.geminiInfo.defaultModel || app.geminiInfo.model || "");
  }
}

export function refreshGeminiStatus() {
  if (app.mode !== "database") { app.geminiInfo = { hasKey: false, last4: null, model: "", source: null }; renderGeminiStatus(); return; }
  apiFetch("/api/settings").then(function (res) { if (!res.ok) throw new Error("settings"); return res.json(); })
    .then(function (data) { app.geminiInfo = data.gemini || app.geminiInfo; renderGeminiStatus(); })
    .catch(function () { renderGeminiStatus(); });
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.geminiSaveBtn) {
    els.geminiSaveBtn.addEventListener("click", function () {
      var key = els.geminiKeyInput.value.trim();
      var model = els.geminiModelInput.value.trim();
      if (!key && !model && app.geminiInfo.modelSource !== "saved") { alert("Paste a key (or a model name) first."); return; }
      apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: key || undefined, geminiModel: model }) })
        .then(function (res) { if (!res.ok) throw new Error("settings"); return res.json(); })
        .then(function (data) {
          app.geminiInfo = data.gemini || app.geminiInfo;
          els.geminiKeyInput.value = "";
          renderGeminiStatus();
          alert(key ? "Saved. The key is stored server-side and never shown again."
            : model ? "Saved. Gemini now uses " + model + "." : "Saved. Gemini now uses the default model.");
        })
        .catch(function () { alert("Could not save — settings need the database (Database mode)."); });
    });
  }
  if (els.geminiClearBtn) {
    els.geminiClearBtn.addEventListener("click", function () {
      if (!confirm("Clear the Gemini key saved in the app? (A Cloudflare GEMINI_API_KEY secret, if set, is unaffected.)")) return;
      apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearGeminiKey: true }) })
        .then(function (res) { if (!res.ok) throw new Error("settings"); return res.json(); })
        .then(function (data) { app.geminiInfo = data.gemini || app.geminiInfo; renderGeminiStatus(); })
        .catch(function () { alert("Could not clear — settings need the database (Database mode)."); });
    });
  }
}
