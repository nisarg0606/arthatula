#!/usr/bin/env node
/*
 * Arthatula — manual sync poller (VM side of "Sync now").
 *
 * The budget app cannot pull Plaid itself, so its "Sync now" button
 * only queues a request (POST /api/sync-requests). This poller is the
 * other half: a plain Node loop — no agent, no LLM — that every 30
 * seconds asks the app for work with the SAME least-privilege sync
 * session the nightly cron sync uses (token in
 * ~/workspace/budget-sync/.access-token, sent as
 * "Authorization: Bearer <token>", exactly like sync.mjs):
 *
 *   GET  /api/sync-requests/claim            -> claim the oldest
 *                                               pending request
 *   POST /api/sync-requests/:id/complete     -> report the outcome
 *
 * On a claim it runs the real engine — `node
 * ~/workspace/budget-sync/sync.mjs`, which stays the single place
 * that knows the import rules and dedupe state — parses the JSON
 * summary the engine prints on stdout, shapes it to the compact
 * result the app displays, and completes the request "done". A
 * non-zero exit, a spawn error or an unparseable summary completes
 * it "failed" with the error text. Runs are single-flight: while one
 * sync is running, ticks are skipped, so two engines never overlap.
 * Every event is logged with a timestamp to
 * ~/workspace/budget-sync/poller.log (and stdout).
 *
 * Env overrides (defaults are Nisarg's deployment):
 *   BUDGET_API_BASE   default https://monthly-budget-6sw.pages.dev/api
 *   BUDGET_SYNC_DIR   default ~/workspace/budget-sync
 *   BUDGET_POLL_MS    default 30000
 *
 * Run it under the systemd user unit next to this file
 * (tools/budget-sync-poller.service), or by hand:
 *   node tools/sync-poller.mjs
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_BASE = (process.env.BUDGET_API_BASE || "https://monthly-budget-6sw.pages.dev/api").replace(/\/+$/, "");
const SYNC_DIR = process.env.BUDGET_SYNC_DIR || path.join(os.homedir(), "workspace", "budget-sync");
const TOKEN_PATH = path.join(SYNC_DIR, ".access-token");
const SYNC_SCRIPT = path.join(SYNC_DIR, "sync.mjs");
const LOG_PATH = path.join(SYNC_DIR, "poller.log");
const POLL_MS = Math.max(5000, parseInt(process.env.BUDGET_POLL_MS || "30000", 10) || 30000);
const FETCH_TIMEOUT_MS = 20000;
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch (e) { /* log file is best-effort */ }
}

/* Same token handling as sync.mjs: read fresh on every claim so a
   re-pair (which replaces the file) needs no poller restart. The
   token itself is never logged. */
function loadSyncToken() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    return t || null;
  } catch (e) {
    return null;
  }
}

function authHeaders(token, extra) {
  return { Authorization: `Bearer ${token}`, ...(extra || {}) };
}

async function claimRequest(token) {
  const res = await fetch(`${API_BASE}/sync-requests/claim`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`claim answered HTTP ${res.status}`);
  const data = await res.json();
  return data && data.request ? data.request : null;
}

async function completeRequest(token, id, status, result) {
  const res = await fetch(`${API_BASE}/sync-requests/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ status, result }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`complete answered HTTP ${res.status}`);
  return res.json();
}

function runSyncEngine() {
  return new Promise((resolve) => {
    execFile(process.execPath, [SYNC_SCRIPT], {
      cwd: SYNC_DIR,
      timeout: SYNC_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/* The engine prints exactly one JSON document (its run summary) on
   stdout; parse it directly, with a first-brace fallback in case a
   future version logs a line ahead of it. */
function parseSummary(stdout) {
  const text = String(stdout || "").trim();
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("could not parse the sync summary from stdout");
}

/* Shape the engine's full summary down to what the app displays and
   stores: counts, the added total, and anything still pending. */
function shapeResult(summary) {
  const added = Array.isArray(summary.added) ? summary.added : [];
  const addedTotal = Math.round(
    added.reduce((sum, e) => sum + (Number(e && e.amount) || 0), 0) * 100
  ) / 100;
  return {
    addedCount: typeof summary.addedCount === "number" ? summary.addedCount : added.length,
    addedTotal,
    added: added.map((e) => ({
      date: e && e.date,
      description: e && e.description,
      amount: e && e.amount,
      category: e && e.category,
      card: (e && (e.card || e.cardName)) || null
    })),
    skippedCounts: summary.skippedCounts || {},
    failedCount: Array.isArray(summary.failed) ? summary.failed.length : 0,
    bank: summary.bank || null,
    bankError: summary.bankError || null,
    pending: summary.pending || null,
    pendingError: summary.pendingError || null,
    window: summary.window || null
  };
}

let running = false;

async function tick() {
  if (running) return; /* single-flight: never overlap sync runs */
  const token = loadSyncToken();
  if (!token) {
    log(`no sync token at ${TOKEN_PATH} — skipping (pair the automation first)`);
    return;
  }
  let request;
  try {
    request = await claimRequest(token);
  } catch (err) {
    log(`claim failed: ${String((err && err.message) || err)}`);
    return;
  }
  if (!request) return; /* empty queue — the normal case */

  running = true;
  log(`claimed sync request ${request.id} (requested ${request.requestedAt || "?"}); running the sync engine`);
  let status = "done";
  let result;
  try {
    const { err, stdout, stderr } = await runSyncEngine();
    if (err) {
      const code = typeof err.code === "number" ? `exit ${err.code}` : String(err.code || "spawn error");
      throw new Error(`sync.mjs ${code}: ${(stderr || err.message || "").trim().slice(0, 500)}`);
    }
    result = shapeResult(parseSummary(stdout));
    log(`sync finished: added ${result.addedCount} expense(s), ${result.failedCount} failed, ` +
        `${result.pending && typeof result.pending.transactions === "number" ? result.pending.transactions : "?"} still pending`);
  } catch (err) {
    status = "failed";
    result = { error: String((err && err.message) || err).slice(0, 500) };
    log(`sync failed for request ${request.id}: ${result.error}`);
  }
  try {
    await completeRequest(token, request.id, status, result);
    log(`completed sync request ${request.id} as ${status}`);
  } catch (err) {
    /* The app expires a stuck "running" request after 10 minutes, so
       a lost completion unblocks the button on its own. */
    log(`could not complete request ${request.id}: ${String((err && err.message) || err)}`);
  } finally {
    running = false;
  }
}

log(`poller started: API ${API_BASE}, sync dir ${SYNC_DIR}, every ${POLL_MS / 1000}s`);
tick();
setInterval(tick, POLL_MS);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { log(`poller stopping (${sig})`); process.exit(0); });
}
