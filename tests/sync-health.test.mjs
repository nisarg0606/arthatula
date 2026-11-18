/*
 * A stopped sync is no longer silent: a sync request that times out
 * says so in the bell (and on Telegram), and bank data older than a
 * night raises one "No bank data" alert per stale stretch. Also checks
 * lastBankSyncAt falls back to the bank accounts' push stamp.
 * Run: node --test tests/sync-health.test.mjs — dummy data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeD1 } from "./_fake-d1.mjs";
import {
  ensureTables, createSession, requestSync, getLatestSyncRequest, lastBankSyncAt,
  checkSyncHealth, SYNC_STALE_MS, SYNC_REQUEST_ACTIVE_MS
} from "../functions/api/budget.js";
import { listNotifications } from "../functions/api/_notify.js";

const iso = (ms) => new Date(ms).toISOString();
const sqlTime = (ms) => iso(ms).slice(0, 19).replace("T", " ");

test("a sync request that times out raises one 'Sync didn't run' alert", async () => {
  const db = new FakeD1();
  await ensureTables(db);
  const { request } = await requestSync(db);
  assert.equal((await listNotifications(db)).notifications.length, 0, "a waiting request says nothing yet");
  db.db.prepare("UPDATE sync_requests SET requested_at = ? WHERE id = ?").run(sqlTime(Date.now() - SYNC_REQUEST_ACTIVE_MS - 60e3), request.id);
  assert.equal((await getLatestSyncRequest(db)).status, "failed");
  let out = await listNotifications(db);
  assert.equal(out.notifications.length, 1);
  assert.equal(out.notifications[0].kind, "sync");
  assert.equal(out.notifications[0].title, "Sync didn't run");
  await getLatestSyncRequest(db);
  assert.equal((await listNotifications(db)).notifications.length, 1, "only once per expiry");
});

test("lastBankSyncAt falls back to the bank accounts' push stamp", async () => {
  const db = new FakeD1();
  await ensureTables(db);
  db.db.exec("INSERT INTO bank_accounts (plaid_account_id, updated_at) VALUES ('a1', '2026-11-16T15:20:32.837Z')");
  assert.equal(await lastBankSyncAt(db), "2026-11-16T15:20:32.837Z", "no bank_synced_at setting, still answers");
});

test("stale bank data with a paired sync raises one alert per stale stretch", async () => {
  const db = new FakeD1();
  await ensureTables(db);
  const now = Date.now();
  const old = iso(now - SYNC_STALE_MS - 3600e3);
  db.db.prepare("INSERT INTO budget_settings (key, value) VALUES ('bank_synced_at', ?)").run(old);

  let r = await checkSyncHealth(db, now);
  assert.equal(r.alerted, false, "no paired sync: nothing expected, nothing said");
  assert.equal((await listNotifications(db)).notifications.length, 0);

  await createSession(db, { kind: "sync", label: "Plaid sync" });
  r = await checkSyncHealth(db, now);
  assert.equal(r.stale, true);
  assert.equal(r.alerted, true);
  let n = (await listNotifications(db)).notifications;
  assert.equal(n.length, 1);
  assert.match(n[0].title, /^No bank data for \d+ hours$/);

  r = await checkSyncHealth(db, now + 3600e3);
  assert.equal(r.alerted, false, "quiet until new data arrives");
  assert.equal((await listNotifications(db)).notifications.length, 1);

  db.db.prepare("UPDATE budget_settings SET value = ? WHERE key = 'bank_synced_at'").run(iso(now - 3600e3));
  r = await checkSyncHealth(db, now);
  assert.equal(r.stale, false, "fresh data is fine");

  const later = now + SYNC_STALE_MS + 3 * 86400e3;
  r = await checkSyncHealth(db, later);
  assert.equal(r.alerted, true, "a new stale stretch alerts again");
  n = (await listNotifications(db)).notifications;
  assert.equal(n.length, 2);
  assert.match(n[0].title, /^No bank data for \d+ days$/);
});
