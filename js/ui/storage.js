/* Saving and loading: local copy, sign-in session token, API calls, initial load. */
import { API_URL, STORAGE_KEY, blankState, localIso, sanitizeState } from "../core/plan.js";
import { showGate } from "./auth.js";
import { loadBank } from "./bank.js";
import { app, els } from "./context.js";
import { render } from "./dashboard.js";
import { loadPending } from "./pending.js";
import { checkSyncStatus } from "./sync.js";
import { refreshGeminiStatus } from "./settings.js";
import { setSignedIn, onShow as onShowV2 } from "./v2/index.js";

export function setMode(newMode) {
  var wasDb = app.mode === "database";
  app.mode = newMode;
  /* The new screens need the database; render the open one as soon as it's there. */
  setSignedIn(newMode === "database");
  if (newMode === "database" && !wasDb) onShowV2(document.body.getAttribute("data-tab") || "dashboard");
  if (els.storageMode) {
    els.storageMode.textContent = app.mode === "database" ? "● Saved" : "● This browser only";
    els.storageMode.className = "storage-badge " + app.mode;
    els.storageMode.title = app.mode === "database"
      ? "Saved online in your own database: your data follows you to every device you sign in on."
      : "Can't reach the server, so changes are saved only in this browser for now.";
  }
}

export function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(app.state)); } catch (e) { /* storage full/blocked */ }
}

export function loadLocal() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeState(JSON.parse(raw)) : null;
  } catch (e) { return null; }
}

/* ---------- sign-in session ----------
   The session token lives in localStorage ('arthatula-session')
   and rides on every /api call as a Bearer header (apiFetch). Any
   401 from the API means the session is gone (expired, revoked, or
   the code was changed on another device): drop the token and return
   to the sign-in gate. /api/auth itself is called with plain fetch
   (see authPost) so a wrong code typed at the gate doesn't trip this. */

export const SESSION_KEY = "arthatula-session";

export function getSessionToken() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }

export function setSessionToken(t) { try { if (t) localStorage.setItem(SESSION_KEY, t); } catch (e) { /* blocked */ } }

export function clearSessionToken() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* blocked */ } }

export function apiFetch(url, opts) {
  opts = opts || {};
  var headers = {};
  Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
  var token = getSessionToken();
  if (token && !headers.Authorization) headers.Authorization = "Bearer " + token;
  var finalOpts = {};
  Object.keys(opts).forEach(function (k) { finalOpts[k] = opts[k]; });
  finalOpts.headers = headers;
  return fetch(url, finalOpts).then(function (res) {
    if (res.status === 401 && String(url).indexOf("/api/auth") !== 0) onSessionEnded();
    return res;
  });
}

export function onSessionEnded() {
  if (!getSessionToken()) return; /* already signed out / at the gate */
  clearSessionToken();
  showGate("login", "Your session ended — sign in again.");
}

export function apiRequest(method, body) {
  var opts = { method: method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return apiFetch(API_URL, opts).then(function (res) {
    if (!res.ok) throw new Error("API " + res.status);
    return res.json();
  });
}

/* Persist the whole state. In database mode this PUTs to the API;
   on any failure we keep the data locally and flip to local mode. */

export function persist() {
  saveLocal(); /* always keep a local mirror as a safety net */
  if (app.mode !== "database") return;
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(function () {
    apiRequest("PUT", app.state).catch(function () { setMode("local"); });
  }, 350);
}

/* bootAuth starts the budget download alongside its sign-in check
   (they used to run one after the other); load() takes it once. */
var prefetched = null;
export function prefetchBudget() {
  var token = getSessionToken();
  if (!token) return;
  prefetched = fetch(API_URL, { headers: { Authorization: "Bearer " + token } }).catch(function () { return null; });
}

export function load() {
  var early = prefetched;
  prefetched = null;
  (early ? early.then(function (res) {
    return res && res.ok ? res.json() : apiRequest("GET");
  }) : apiRequest("GET")).then(function (data) {
    /* A new database: start its plan and baseline on the user's own
       today (the server only knows UTC). */
    if (data && data.planStart === null) {
      var today = localIso(new Date());
      return apiRequest("PATCH", { setup: { planStart: today.slice(0, 7), baselineDate: today } });
    }
    return data;
  }).then(function (data) {
    app.state = sanitizeState(data);
    setMode("database");
    saveLocal();
    /* Requests first, so they download while render() runs. */
    loadBank();
    loadPending();
    checkSyncStatus(true);
    refreshGeminiStatus();
    render();
  }).catch(function () {
    var local = loadLocal();
    app.state = local || blankState();
    setMode("local");
    render();
    loadBank();
    loadPending();
    refreshGeminiStatus();
  });
}
