/* "Always file this merchant under ..." (Daily list + Settings). */
import { merchantKey } from "../core/merchant.js";
import { app } from "./context.js";
import { afterExpensesChanged } from "./daily.js";
import { apiFetch } from "./storage.js";

/* Saving re-files matching expenses on the server, so the whole state
   comes back. */
export function saveMerchantRules(rules) {
  return apiFetch("/api/budget", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantRules: rules }) })
    .then(function (res) { if (!res.ok) throw new Error("budget " + res.status); return res.json(); })
    .then(function (data) { afterExpensesChanged(data); renderMerchantRules(); });
}

/* The "Always file here" control under an expense's category picker. */
export function merchantRuleControl(e, sel) {
  var wrap = document.createElement("div");
  wrap.className = "merchant-rule";
  var open = document.createElement("button");
  open.type = "button";
  open.textContent = "Always use this category…";
  wrap.appendChild(open);
  open.addEventListener("click", function () {
    wrap.innerHTML = "";
    var input = document.createElement("input");
    input.type = "text"; input.maxLength = 100; input.className = "note-input";
    input.setAttribute("aria-label", "Merchant name to match");
    input.value = merchantKey(e.description);
    var save = document.createElement("button");
    save.type = "button";
    save.textContent = "File as " + sel.value;
    sel.addEventListener("change", function () { save.textContent = "File as " + sel.value; });
    var hint = document.createElement("span");
    hint.className = "meta";
    hint.textContent = "Every expense whose name contains these words, past and future, goes under this category. Shorten it to just the merchant.";
    save.addEventListener("click", function () {
      var match = merchantKey(input.value);
      if (!match) return;
      save.disabled = true;
      var rules = (app.state.merchantRules || []).filter(function (r) { return r.match !== match; });
      rules.push({ match: match, category: sel.value });
      saveMerchantRules(rules).catch(function () { save.disabled = false; hint.textContent = "Couldn't save the rule. Try again."; });
    });
    wrap.appendChild(input); wrap.appendChild(save); wrap.appendChild(hint);
    input.focus();
  });
  return wrap;
}

/* Settings: the saved rules, each removable. */
export function renderMerchantRules() {
  var list = document.getElementById("merchantRulesList");
  if (!list) return;
  var rules = app.state.merchantRules || [];
  list.innerHTML = "";
  if (!rules.length) {
    var none = document.createElement("li");
    none.className = "hint";
    none.textContent = "No merchant rules yet. Open an expense on the Daily tab and choose “Always use this category…”.";
    list.appendChild(none);
  }
  rules.forEach(function (r) {
    var li = document.createElement("li");
    var text = document.createElement("span");
    text.textContent = "“" + r.match + "” → " + r.category;
    var del = document.createElement("button");
    del.type = "button"; del.className = "danger";
    del.textContent = "Remove";
    del.setAttribute("aria-label", "Remove the rule for " + r.match);
    del.addEventListener("click", function () {
      del.disabled = true;
      saveMerchantRules(rules.filter(function (x) { return x.match !== r.match; })).catch(function () { del.disabled = false; });
    });
    li.appendChild(text); li.appendChild(del);
    list.appendChild(li);
  });
}
