/* Sign-in gate, pairing and session security. */
import { deviceLabel } from "../core/format.js";
import { app, els } from "./context.js";
import { apiFetch, clearSessionToken, getSessionToken, load, prefetchBudget, setSessionToken } from "./storage.js";

/* ================= Sign-in gate + security =================
   Boot flow: ask /api/auth?action=status. setupRequired -> the
   create-code gate; authed -> straight into the app; otherwise the
   sign-in gate. If the API itself is unreachable (static hosting /
   local dev), boot falls back to local-only mode and SKIPS the gate
   entirely — in that mode data never leaves this browser, so there
   is nothing for a code to protect, and the Security section (which
   manages server sessions) stays hidden. */

export function showGate(kind, note) {
  if (!els.authGate) return;
  document.body.classList.add("auth-locked");
  els.authGate.hidden = false;
  if (els.gateSetupForm) els.gateSetupForm.hidden = kind !== "setup";
  if (els.gateLoginForm) els.gateLoginForm.hidden = kind !== "login";
  if (els.gateResetForm) els.gateResetForm.hidden = kind !== "reset";
  var errEl = gateErrorEl(kind);
  if (errEl) { errEl.hidden = !note; errEl.textContent = note || ""; }
  var input = kind === "setup" ? (els.gateSetupSecret || els.gateSetupCode) : kind === "reset" ? els.gateResetSecret : els.gateLoginCode;
  if (input) setTimeout(function () { try { input.focus(); } catch (e) { /* noop */ } }, 50);
}

export function hideGate() {
  document.body.classList.remove("auth-locked");
  if (els.authGate) els.authGate.hidden = true;
}

function gateErrorEl(kind) {
  return kind === "setup" ? els.gateSetupError : kind === "reset" ? els.gateResetError : els.gateLoginError;
}

export function gateError(kind, msg) {
  var errEl = gateErrorEl(kind);
  if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
}

/* /api/auth calls use PLAIN fetch (not apiFetch): a 401 here is an
   expected answer (wrong code), not a dead session. Errors carry the
   server's message so lockout notes reach the user verbatim. */

export function authPost(body) {
  return fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ("Sign-in failed (" + res.status + ")"));
        return data;
      });
    });
}

/* Authenticated /api/auth actions (logout, revoke, change-code) go
   through apiFetch so they carry the session token. */

export function authAction(body) {
  return apiFetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
        return data;
      });
    });
}

export function enterApp() { hideGate(); load(); }

export function bootAuth() {
  var headers = {};
  var token = getSessionToken();
  if (token) headers.Authorization = "Bearer " + token;
  prefetchBudget();
  fetch("/api/auth?action=status", { headers: headers }).then(function (res) {
    if (!res.ok) throw new Error("auth status " + res.status);
    return res.json();
  }).then(function (st) {
    if (st.setupRequired) { showGate("setup"); return; }
    if (st.authed) { enterApp(); return; }
    var had = !!getSessionToken();
    if (had) clearSessionToken();
    showGate("login", had ? "Your session ended — sign in again." : "");
  }).catch(function () {
    /* API unreachable: local-only fallback skips the gate (above). */
    enterApp();
  });
}

export function fmtSessionTime(s) {
  if (!s) return "never";
  var d = new Date(String(s).replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? String(s) : d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function renderSecurity(force) {
  if (!els.securitySection) return;
  var inDb = app.mode === "database";
  els.securitySection.hidden = !inDb; /* local-only: no server sessions to manage */
  var adv = document.getElementById("securityAdvanced");
  if (adv) adv.hidden = !inDb;
  if (inDb && (force || Date.now() - app.sessionsLoadedAt > 15000)) { loadSessions(); loadPairing(); }
}

export function loadPairing() {
  if (!els.pairCard) return;
  apiFetch("/api/auth?action=pairing").then(function (res) {
    if (!res.ok) throw new Error("pairing " + res.status);
    return res.json();
  }).then(function (data) {
    renderPairing(data.pending || null);
    if (els.pairOpenStatus && !data.pending && !data.window) els.pairOpenStatus.textContent = "";
  })
    .catch(function () { /* a 401 already returned us to the gate */ });
}

export function renderPairing(pending) {
  if (!els.pairCard) return;
  els.pairCard.hidden = !pending;
  app.pendingFingerprint = pending ? pending.fingerprint || null : null;
  if (!pending) return;
  if (els.pairFingerprint) els.pairFingerprint.textContent = pending.fingerprint || "";
  if (els.pairLabel) els.pairLabel.textContent = pending.label || "Plaid sync";
  if (els.pairWhen) els.pairWhen.textContent = fmtSessionTime(pending.requestedAt);
}

export function loadSessions() {
  app.sessionsLoadedAt = Date.now();
  apiFetch("/api/auth?action=sessions").then(function (res) {
    if (!res.ok) throw new Error("sessions " + res.status);
    return res.json();
  }).then(function (data) { renderSessionList(data.sessions || []); })
    .catch(function () { /* a 401 already returned us to the gate */ });
}

export function renderSessionList(sessions) {
  if (!els.sessionList) return;
  els.sessionList.innerHTML = "";
  if (!sessions.length) {
    var p = document.createElement("p");
    p.className = "hint"; p.textContent = "No signed-in devices.";
    els.sessionList.appendChild(p);
    return;
  }
  sessions.forEach(function (s) {
    var row = document.createElement("div");
    row.className = "session-row";
    var label = document.createElement("span");
    label.className = "s-label";
    label.textContent = s.label || (s.kind === "sync" ? "Sync token" : s.kind === "mcp" ? "AI assistant (MCP)" : "Device");
    if (s.kind === "sync") {
      var sb = document.createElement("span");
      sb.className = "kind-badge sync"; sb.textContent = "Sync";
      label.appendChild(sb);
    }
    if (s.kind === "mcp") {
      var mb = document.createElement("span");
      mb.className = "kind-badge mcp"; mb.textContent = "MCP";
      label.appendChild(mb);
    }
    if (s.current) {
      var cb = document.createElement("span");
      cb.className = "kind-badge"; cb.textContent = "This device";
      label.appendChild(cb);
    }
    row.appendChild(label);
    if (!s.current) {
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "danger"; btn.textContent = "Revoke";
      btn.addEventListener("click", function () {
        var msg = s.kind === "mcp"
          ? "Revoke this AI assistant token? The assistant loses access immediately and needs a new token to reconnect."
          : s.kind === "sync"
            ? "Revoke the sync token? The automatic expense sync stops until you pair it again."
            : "Sign this device out? It will need the access code to sign in again.";
        if (!confirm(msg)) return;
        authAction({ action: "revoke", id: s.id }).then(function () {
          app.sessionsLoadedAt = 0; loadSessions();
        }).catch(function (e) { alert(e.message || "Could not revoke that session."); });
      });
      row.appendChild(btn);
    }
    var meta = document.createElement("span");
    meta.className = "s-meta";
    meta.textContent = "Signed in " + fmtSessionTime(s.createdAt) + " · Last active " + fmtSessionTime(s.lastSeenAt) +
      (s.expiresAt ? " · Session expires " + fmtSessionTime(s.expiresAt) : " · No expiry");
    row.appendChild(meta);
    els.sessionList.appendChild(row);
  });
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.gateSetupForm) {
    els.gateSetupForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = els.gateSetupCode.value, confirm = els.gateSetupConfirm.value;
      var secret = els.gateSetupSecret ? els.gateSetupSecret.value : "";
      if (code.length < 12) { gateError("setup", "Access code must be at least 12 characters."); return; }
      if (code !== confirm) { gateError("setup", "The two codes don't match — type the same code twice."); return; }
      authPost({ action: "setup", setupSecret: secret, code: code, label: deviceLabel() }).then(function (data) {
        setSessionToken(data.token);
        els.gateSetupCode.value = ""; els.gateSetupConfirm.value = "";
        if (els.gateSetupSecret) els.gateSetupSecret.value = "";
        enterApp();
      }).catch(function (e) { gateError("setup", e.message); });
    });
  }
  if (els.gateLoginForm) {
    els.gateLoginForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      authPost({ action: "login", code: els.gateLoginCode.value, label: deviceLabel() }).then(function (data) {
        setSessionToken(data.token);
        els.gateLoginCode.value = "";
        enterApp();
      }).catch(function (e) { gateError("login", e.message); });
    });
  }
  /* Forgotten code: the setup secret sets a new one (signs out everything else). */
  if (els.gateForgotBtn) els.gateForgotBtn.addEventListener("click", function () { showGate("reset"); });
  if (els.gateResetBack) els.gateResetBack.addEventListener("click", function () { showGate("login"); });
  if (els.gateResetForm) {
    els.gateResetForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = els.gateResetCode.value;
      if (code.length < 12) { gateError("reset", "Access code must be at least 12 characters."); return; }
      if (code !== els.gateResetConfirm.value) { gateError("reset", "The two codes don't match — type the same code twice."); return; }
      authPost({ action: "reset-code", setupSecret: els.gateResetSecret.value, newCode: code, label: deviceLabel() }).then(function (data) {
        setSessionToken(data.token);
        els.gateResetSecret.value = ""; els.gateResetCode.value = ""; els.gateResetConfirm.value = "";
        enterApp();
      }).catch(function (e) { gateError("reset", e.message); });
    });
  }
  /* ---------- Settings -> Security ---------- */

  app.sessionsLoadedAt = 0;
  /* Automation pairing (v7): "Pair automation" opens a 10-minute window
     and shows a one-time code for the sync script; the script registers
     only the hash of its own token, and the pending request shows here
     with a fingerprint the owner compares against the script's output
     before approving. Checked whenever the Settings view opens. */

  app.pendingFingerprint = null;
  if (els.pairApproveBtn) {
    els.pairApproveBtn.addEventListener("click", function () {
      if (!app.pendingFingerprint) return;
      if (!confirm("Approve only if the sync script printed the fingerprint " + app.pendingFingerprint + ". Approve?")) return;
      authAction({ action: "pair-approve", fingerprint: app.pendingFingerprint }).then(function () {
        renderPairing(null);
        app.sessionsLoadedAt = 0; loadSessions(); /* the new sync session appears in the list */
      }).catch(function (e) { alert(e.message || "Could not approve that pairing request."); });
    });
  }
  if (els.pairOpenBtn) {
    els.pairOpenBtn.addEventListener("click", function () {
      authAction({ action: "pair-open" }).then(function (data) {
        if (els.pairOpenStatus) {
          els.pairOpenStatus.textContent = "Pairing code: " + data.code + " — give it to the sync script now. It works once and expires at " +
            fmtSessionTime(data.expiresAt) + ". Opening a new window replaces this code.";
        }
      }).catch(function (e) { alert(e.message || "Could not open a pairing window."); });
    });
  }
  if (els.pairDenyBtn) {
    els.pairDenyBtn.addEventListener("click", function () {
      authAction({ action: "pair-deny" }).then(function () {
        renderPairing(null);
      }).catch(function (e) { alert(e.message || "Could not deny that pairing request."); });
    });
  }
  /* MCP token: the server returns the raw token exactly once, so the
     reveal panel fills the endpoint, token and a ready-to-paste client
     config. The token then lives only in the owner's MCP client and in
     the sessions list below (as a hash) for revoking. */
  if (els.mcpCreateBtn) {
    els.mcpCreateBtn.addEventListener("click", function () {
      authAction({ action: "mcp-create", label: "AI assistant (MCP)" }).then(function (data) {
        var url = location.origin + "/api/mcp";
        els.mcpEndpoint.value = url;
        els.mcpToken.value = data.token;
        els.mcpConfig.value = JSON.stringify({
          mcpServers: { arthatula: { type: "http", url: url, headers: { Authorization: "Bearer " + data.token } } }
        }, null, 2);
        els.mcpReveal.hidden = false;
        els.mcpStatus.textContent = "Token created — copy it now, it won't be shown again. Revoke it any time from the list below.";
        app.sessionsLoadedAt = 0; loadSessions();
      }).catch(function (e) { alert(e.message || "Could not create an MCP token."); });
    });
  }
  if (els.secChangeForm) {
    els.secChangeForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var status = function (m) { if (els.secChangeStatus) els.secChangeStatus.textContent = m; };
      var nw = els.secNewCode.value, cf = els.secNewConfirm.value;
      if (nw.length < 12) { status("New code must be at least 12 characters."); return; }
      if (nw !== cf) { status("The new codes don't match."); return; }
      authAction({ action: "change-code", currentCode: els.secCurrentCode.value, newCode: nw }).then(function () {
        els.secCurrentCode.value = ""; els.secNewCode.value = ""; els.secNewConfirm.value = "";
        status("Access code changed. Every other device was signed out.");
        app.sessionsLoadedAt = 0; loadSessions();
      }).catch(function (e) { status(e.message); });
    });
  }
  if (els.signOutBtn) {
    els.signOutBtn.addEventListener("click", function () {
      authAction({ action: "logout" }).catch(function () { /* sign out locally regardless */ }).then(function () {
        clearSessionToken();
        showGate("login", "You signed out of this device.");
      });
    });
  }
}
