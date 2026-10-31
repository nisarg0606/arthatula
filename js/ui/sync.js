/* Manual "Sync now" (Daily tab). */
import { fmt } from "../core/format.js";
import { syncResultExpired } from "../core/sync.js";
import { app, els } from "./context.js";
import { apiFetch, load } from "./storage.js";

/* ================= Manual sync =================
   "Sync now" asks the paired automation to run the Plaid sync
   right away instead of waiting for its nightly run. The app
   can't pull Plaid itself, so the button files a request (POST
   /api/sync-requests); the automation's poller claims it, runs
   the engine on the VM, and completes it with the run summary.
   This polls /api/sync-requests/latest until the request finishes
   (every 3 seconds for the first minute, then every 10) and shows the
   outcome next to the button. The server expires a request that waits
   or runs 10 minutes, so polling always ends; the 25-minute cap is
   only a backstop if the network drops. When a
   sync finishes "done" the page reloads its data (load()) so the
   new expenses and snapshots appear. On page load, an in-flight
   request resumes its progress state here. */

var syncPollTimer = null;
var POLL_FAST_MS = 3000, POLL_SLOW_MS = 10000, FAST_FOR_MS = 60 * 1000, POLL_CAP_MS = 25 * 60 * 1000;
var syncWasActive = false;

function syncIsActive(req) { return !!req && (req.status === "pending" || req.status === "running"); }

function stopSyncPolling() { if (syncPollTimer) { clearTimeout(syncPollTimer); syncPollTimer = null; } }

/* Keeps checking while the request is active; checkSyncStatus stops it
   as soon as the request is done or failed. */
function startSyncPolling() {
  stopSyncPolling();
  var started = Date.now();
  (function next() {
    var elapsed = Date.now() - started;
    if (elapsed > POLL_CAP_MS) { syncPollTimer = null; return; }
    syncPollTimer = setTimeout(function () {
      /* Skip a tick while the last check is still waiting for its answer:
         otherwise, on a slow connection, every answer would arrive after
         a newer check and be discarded, and the button would never move. */
      if (!syncInFlight) checkSyncStatus(false);
      if (syncPollTimer) next();
    }, elapsed < FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);
  })();
}

function syncOutcomeText(req) {
  var r = (req && req.result) || {};
  if (req.status === "failed") return "Sync failed" + (r.error ? ": " + r.error : ".");
  var parts = [];
  var n = typeof r.addedCount === "number" ? r.addedCount : 0;
  parts.push(n === 1 ? "Added 1 expense" : "Added " + n + " expenses");
  if (typeof r.addedTotal === "number" && r.addedTotal > 0) parts.push(fmt(r.addedTotal) + " total");
  var pend = r.pending && typeof r.pending.transactions === "number" ? r.pending.transactions : 0;
  if (pend > 0) parts.push(pend + (pend === 1 ? " charge" : " charges") + " still pending");
  if (typeof r.failedCount === "number" && r.failedCount > 0) parts.push(r.failedCount + " failed to import");
  return parts.join(" · ");
}

function renderSyncRequest(req) {
  if (!els.syncNowBtn) return false;
  var active = syncIsActive(req);
  els.syncNowBtn.disabled = active;
  els.syncNowBtn.textContent = !req ? "Sync now"
    : req.status === "pending" ? "Queued…"
    : req.status === "running" ? "Syncing…"
    : "Sync now";
  if (els.syncStatus) {
    els.syncStatus.textContent = !req ? ""
      : req.status === "pending" ? "Queued — the sync automation will pick this up shortly."
      : req.status === "running" ? "Syncing with Plaid…"
      : syncResultExpired(req, Date.now()) ? "" /* last result is over a day old */
      : syncOutcomeText(req);
  }
  return active;
}

var syncCheckSeq = 0; /* only the newest status answer is shown */
var syncInFlight = 0; /* status checks still waiting for an answer */
export function checkSyncStatus(resume) {
  if (app.mode !== "database" || !els.syncNowBtn) return;
  var seq = ++syncCheckSeq;
  syncInFlight++;
  apiFetch("/api/sync-requests/latest").then(function (res) {
    if (!res.ok) throw new Error("sync latest " + res.status);
    return res.json();
  }).then(function (data) {
    if (seq !== syncCheckSeq) return; /* an older check answered late */
    var req = data && data.request;
    if (renderSyncRequest(req)) {
      syncWasActive = true;
      if (resume && !syncPollTimer) startSyncPolling();
    } else {
      var finished = syncWasActive;
      syncWasActive = false;
      stopSyncPolling();
      if (finished && req && req.status === "done") load(); /* fresh expenses + snapshots */
    }
  }).catch(function () { /* leave the button as-is; the next check retries */ })
    .then(function () { syncInFlight--; });
}

function onSyncNow() {
  if (app.mode !== "database") {
    if (els.syncStatus) els.syncStatus.textContent = "Sync needs database mode — you're in local-only mode.";
    return;
  }
  if (els.syncNowBtn) els.syncNowBtn.disabled = true;
  if (els.syncStatus) els.syncStatus.textContent = "Queuing…";
  apiFetch("/api/sync-requests", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  }).then(function (res) {
    if (!res.ok) throw new Error("sync request " + res.status);
    return res.json();
  }).then(function () {
    syncWasActive = true;
    startSyncPolling();
    checkSyncStatus(false);
  }).catch(function () {
    if (els.syncNowBtn) els.syncNowBtn.disabled = false;
    if (els.syncStatus) els.syncStatus.textContent = "Couldn't queue a sync — try again.";
  });
}

/* Wires up this part of the app; main.js calls every init() in order. */
export function init() {
  if (els.syncNowBtn) {
    els.syncNowBtn.addEventListener("click", onSyncNow);
  }
}
