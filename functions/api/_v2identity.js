/*
 * Account identity across feed-id generations.
 *
 * A bank feed (Plaid) re-issues its account ids when the user
 * reconnects an institution. The money model keys accounts by the
 * feed id (accounts.external_id), so a reconnect used to mint a
 * second account for every real account — same name, same mask,
 * new id — and net worth counted both. These helpers recognise
 * "same real account, new feed id" so the ingest paths can re-key
 * the existing account instead of duplicating it, and so duplicate
 * detection can tell two copies of one bank transaction apart from
 * two genuinely identical charges.
 */

/* Identity of a real-world account within one feed: the institution,
   the card/account mask and the account type. The mask is what makes
   it specific (one institution can host several accounts); without a
   mask there is no safe identity, so the key is null and callers must
   fall back to the feed id alone. */
export function identityKeyOf(a) {
  const mask = String((a && a.mask) || "").trim();
  if (!mask) return null;
  const inst = String((a && a.institution) || "").trim().toLowerCase().replace(/\s+/g, " ");
  const type = String((a && a.type) || "").trim().toLowerCase();
  if (!inst || !type) return null;
  return inst + "|" + mask + "|" + type;
}

/* Merchant-name comparison for "same bank transaction, re-issued
   under a new feed id": names are compared alphanumerics-only, and
   one may be a prefix of the other (one generation of a feed often
   truncates or extends the payee string). A minimum length keeps
   short generic names ("ACH", "FEE") from colliding. */
export function normalizeMerchant(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export function namesCollide(a, b) {
  const x = normalizeMerchant(a), y = normalizeMerchant(b);
  if (!x || !y) return false;
  if (Math.min(x.length, y.length) < 12) return x === y;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/* Plan account re-keys for one ingest batch.
   existing: [{ id, external_id, institution, mask, type }] — the
     accounts the feed already has in the money model.
   pushed:   [{ ext, institution, mask, type }] — the accounts in
     this batch, keyed by their (possibly new) feed id.
   Returns [{ accountId, fromExt, toExt }] — one entry per pushed
   account whose feed id is new but which uniquely matches an
   existing account that this batch does not otherwise claim.
   Ambiguous matches (two existing accounts with the same identity)
   are left alone: a wrong re-key is worse than a duplicate. */
export function planRekeys(existing, pushed) {
  const byExt = new Map();
  for (const r of existing || []) if (r.external_id) byExt.set(r.external_id, r);
  const pushedExts = new Set((pushed || []).map((p) => p.ext));
  const claimed = new Set();
  for (const p of pushed || []) {
    const cur = byExt.get(p.ext);
    if (cur) claimed.add(cur.id);
  }
  const candidates = new Map();
  for (const r of existing || []) {
    if (!r.external_id || pushedExts.has(r.external_id) || claimed.has(r.id)) continue;
    const k = identityKeyOf(r);
    if (!k) continue;
    if (!candidates.has(k)) candidates.set(k, []);
    candidates.get(k).push(r);
  }
  const out = [];
  for (const p of pushed || []) {
    if (byExt.has(p.ext)) continue;
    const k = identityKeyOf(p);
    if (!k) continue;
    const list = candidates.get(k) || [];
    if (list.length !== 1) continue;
    const row = list[0];
    if (claimed.has(row.id)) continue;
    claimed.add(row.id);
    candidates.set(k, []);
    out.push({ accountId: row.id, fromExt: row.external_id, toExt: p.ext });
  }
  return out;
}
