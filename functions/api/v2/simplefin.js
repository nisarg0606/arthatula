/*
 * SimpleFIN Bridge bank sync (serves /api/v2/simplefin) — no Plaid, no
 * always-on computer. Protocol: https://www.simplefin.org/protocol.html
 *   GET                         -> { connected, lastSyncAt, lastError }
 *   POST { setupToken }         -> connect: the one-time setup token
 *        (base64 of a claim URL) is POSTed to once, which returns the
 *        access URL. Then it syncs. -> { connected, ...sync result }
 *   POST { action: "sync", auto? } -> { accounts, added, duplicates, categorized, toReview, errors }
 *        auto: only when the last sync is AUTO_HOURS old (the app calls
 *        this on open; Pages has no cron). -> { skipped: true } otherwise.
 *   DELETE                      -> forget the access URL (accounts and
 *        transactions already imported stay).
 *
 * The access URL carries the credentials (https://user:pass@host/…). It
 * lives server-side in budget_settings (settings.js) and is never sent
 * to the browser. Accounts are upserted like the Plaid push
 * (./sync.js accountStmts, ext "sfin:<id>", source "simplefin");
 * transactions go through ../_v2import.js with ext
 * "sfin:<account>:<transaction>", so each one comes in once.
 *
 * SimpleFIN Bridge covers US (and some Canadian) institutions, refreshes
 * about once a day, and serves up to 90 days of history.
 */
import { handleV2, HttpError, bodyOf, cleanStr } from "../_v2http.js";
import { accountStmts } from "./sync.js";
import { importRows } from "../_v2import.js";
import { getSimplefinUrl, setSimplefinUrl } from "../settings.js";

export const AUTO_HOURS = 4;
const DAY = 86400;

/* setup token -> access URL. */
export async function claim(setupToken, fetchImpl) {
  let claimUrl = "";
  try { claimUrl = atob(String(setupToken || "").trim()); } catch (e) { /* below */ }
  if (!/^https:\/\/[^\s]+$/.test(claimUrl)) throw new HttpError(400, "That doesn't look like a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.");
  let res;
  try { res = await (fetchImpl || fetch)(claimUrl, { method: "POST", headers: { "Content-Length": "0" } }); }
  catch (e) { throw new HttpError(502, "Couldn't reach SimpleFIN. Try again in a minute."); }
  if (res.status === 403) throw new HttpError(400, "That setup token was already used. Make a new one at SimpleFIN Bridge (and if you didn't use it, tell SimpleFIN: someone else may have).");
  if (!res.ok) throw new HttpError(502, "SimpleFIN refused the setup token (" + res.status + ").");
  const access = (await res.text()).trim();
  let u = null;
  try { u = new URL(access); } catch (e) { /* below */ }
  if (!u || u.protocol !== "https:" || !u.username) throw new HttpError(502, "SimpleFIN sent back something that isn't an access URL.");
  return access;
}

/* GET {access}/accounts, with the URL's credentials moved into a Basic
   Authorization header (fetch won't take them in the URL). */
export async function fetchAccounts(accessUrl, startSec, fetchImpl) {
  const u = new URL(accessUrl);
  const auth = "Basic " + btoa(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password));
  u.username = ""; u.password = "";
  const url = u.toString().replace(/\/$/, "") + "/accounts?start-date=" + Math.floor(startSec);
  let res;
  try { res = await (fetchImpl || fetch)(url, { headers: { Authorization: auth } }); }
  catch (e) { throw new HttpError(502, "Couldn't reach SimpleFIN. Try again later."); }
  if (res.status === 402) throw new HttpError(402, "Your SimpleFIN Bridge subscription needs attention: check it at beta-bridge.simplefin.org.");
  if (res.status === 403) throw new HttpError(403, "SimpleFIN no longer accepts this connection. Disconnect, then connect again with a new setup token.");
  if (!res.ok) throw new HttpError(502, "SimpleFIN answered " + res.status + ". Try again later.");
  return res.json();
}

function cents(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function isoDay(sec) { return new Date(sec * 1000).toISOString().slice(0, 10); }

/* SimpleFIN doesn't say what kind of account it is: guess from the name
   and the sign (a card or loan reports what you owe as negative). */
export function guessType(name, balanceCents) {
  const n = String(name || "").toLowerCase();
  if (/loan|mortgage/.test(n)) return "loan";
  if (/credit|card|visa|mastercard|amex|discover|sapphire|freedom/.test(n)) return "credit";
  if (/brokerage|invest|401k|\bira\b|roth|hsa|retire/.test(n)) return "investment";
  return balanceCents !== null && balanceCents < 0 ? "credit" : "depository";
}

/* A SimpleFIN account set -> [{ ext, account (for accountStmts), asOf, rows }]. */
export function mapAccounts(set) {
  const conns = {};
  (set.connections || []).forEach((c) => { conns[c.conn_id] = c.name || ""; });
  return (set.accounts || []).filter((a) => a && a.id).map((a) => {
    const bal = cents(a.balance);
    const type = guessType(a.name, bal);
    const owed = type === "credit" || type === "loan";
    const avail = cents(a["available-balance"]);
    return {
      ext: "sfin:" + a.id,
      asOf: a["balance-date"] ? isoDay(a["balance-date"]) : isoDay(Date.now() / 1000),
      account: {
        name: cleanStr(a.name, 200) || "Account", institution: cleanStr(conns[a.conn_id] || (a.org && a.org.name) || "", 200),
        type, balanceCents: bal === null ? null : (owed ? -bal : bal), availableCents: avail === null || owed ? null : avail
      },
      rows: (a.transactions || []).filter((t) => t && t.id && !t.pending && (t.posted || t.transacted_at)).map((t) => ({
        externalId: "sfin:" + a.id + ":" + t.id,
        date: isoDay(t.posted || t.transacted_at),
        description: cleanStr(t.description || t.payee || "", 300) || "(no description)",
        amountCents: cents(t.amount)
      })).filter((r) => r.amountCents)
    };
  });
}

/* Pull and store. Also run by the Worker's cron (../../../worker.js). */
export async function syncSimplefin(s, db, fetchImpl) {
  const access = await getSimplefinUrl(db);
  if (!access) throw new HttpError(400, "SimpleFIN isn't connected.");
  const now = Date.now() / 1000;
  const last = Date.parse((await s.getSetting("simplefin_last_sync")) || "") / 1000;
  /* A week of overlap catches rows that posted late; the first sync takes all 90 days. */
  const start = Number.isFinite(last) ? last - 7 * DAY : now - 90 * DAY;
  let set;
  try { set = await fetchAccounts(access, start, fetchImpl); }
  catch (e) { await s.setSetting("simplefin_last_error", e.message); throw e; }
  const mapped = mapAccounts(set);
  await s.batch(mapped.flatMap((m) => accountStmts(m.ext, m.account, m.asOf, "simplefin")));
  const ids = {};
  (await s.all("SELECT id, external_id FROM accounts WHERE owner_id = ?1 AND source = 'simplefin'")).forEach((r) => { ids[r.external_id] = r.id; });
  const total = { accounts: mapped.length, added: 0, duplicates: 0, categorized: 0, toReview: 0 };
  for (const m of mapped) {
    const r = await importRows(s, db, ids[m.ext], m.rows, "simplefin");
    Object.keys(r).forEach((k) => { total[k] += r[k]; });
  }
  /* Bank-side problems (a login that needs fixing) come back as messages. */
  const errors = (set.errlist || []).map((e) => e && e.msg).concat(set.errors || []).filter(Boolean).map(String).slice(0, 5);
  await s.setSetting("simplefin_last_sync", new Date(now * 1000).toISOString());
  await s.setSetting("simplefin_last_error", errors.join(" · "));
  return Object.assign(total, { errors });
}

async function status(s, db) {
  return {
    connected: !!(await getSimplefinUrl(db)),
    lastSyncAt: (await s.getSetting("simplefin_last_sync")) || null,
    lastError: (await s.getSetting("simplefin_last_error")) || ""
  };
}

export const onRequestGet = (context) => handleV2(context, ({ s, db }) => status(s, db), { skipMirror: true });

export const onRequestPost = (context) => handleV2(context, async ({ s, db, request }) => {
  const b = await bodyOf(request);
  if (b.setupToken !== undefined) {
    await setSimplefinUrl(db, await claim(b.setupToken));
    await s.setSetting("simplefin_last_sync", "");
    return Object.assign({ connected: true }, await syncSimplefin(s, db));
  }
  if (b.action !== "sync") throw new HttpError(400, "POST expects { setupToken } or { action: \"sync\" }.");
  if (b.auto) {
    const st = await status(s, db);
    if (!st.connected || (st.lastSyncAt && Date.now() - Date.parse(st.lastSyncAt) < AUTO_HOURS * 3600e3)) return { skipped: true };
  }
  return syncSimplefin(s, db);
});

export const onRequestDelete = (context) => handleV2(context, async ({ s, db }) => {
  await setSimplefinUrl(db, "");
  await s.setSetting("simplefin_last_sync", "");
  await s.setSetting("simplefin_last_error", "");
  return status(s, db);
}, { skipMirror: true });
