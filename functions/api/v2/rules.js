/*
 * v2 rules (serves /api/v2/rules): "when a transaction's merchant
 * contains X (optionally: on this account, within this amount range),
 * set its category / add a tag / hide it". Rules run in order on every
 * new transaction the mirror brings in; "apply" runs one on what is
 * already there.
 *   GET -> { rules }
 *   POST { matchText, matchAccountId?, minCents?, maxCents?, setCategoryId?, addTag?, setHidden? } -> 201 { rules }
 *   PATCH { id, patch } -> { rules }
 *   DELETE ?id=… -> { rules }
 *   POST { action: "apply", id } -> { rules, changed }
 *        Rows from the classic daily log only take tags and hiding: their
 *        category belongs to the classic log (change it there, or per row).
 */
import { handleV2, HttpError, cleanStr, cleanCents, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { loadRules, loadTransactions } from "../_v2store.js";
import { ruleMatches } from "../../../js/core/v2/money.js";

async function cleanRule(s, b) {
  const r = {
    matchText: cleanStr(b.matchText, 120),
    matchAccountId: b.matchAccountId ? String(b.matchAccountId) : null,
    minCents: cleanCents(b.minCents, "minCents", { nullable: true, min: 0 }),
    maxCents: cleanCents(b.maxCents, "maxCents", { nullable: true, min: 0 }),
    setCategoryId: b.setCategoryId ? String(b.setCategoryId) : null,
    addTag: cleanStr(b.addTag, 40) || null,
    setHidden: !!b.setHidden
  };
  if (!r.matchText && !r.matchAccountId && r.minCents === null && r.maxCents === null) throw new HttpError(400, "A rule needs something to match.");
  if (!r.setCategoryId && !r.addTag && !r.setHidden) throw new HttpError(400, "A rule needs something to do.");
  if (r.minCents !== null && r.maxCents !== null && r.minCents > r.maxCents) throw new HttpError(400, "minCents is above maxCents.");
  if (r.setCategoryId && !(await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND id = ?2", r.setCategoryId))) throw new HttpError(400, "Unknown category.");
  if (r.matchAccountId && !(await s.first("SELECT id FROM accounts WHERE owner_id = ?1 AND id = ?2", r.matchAccountId))) throw new HttpError(400, "Unknown account.");
  return r;
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => ({ rules: await loadRules(s) }), { skipMirror: true });

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  if (b.action === "apply") {
    const rule = (await loadRules(s)).find((r) => r.id === b.id);
    if (!rule) throw new HttpError(404, "Rule not found.");
    const txs = await loadTransactions(s);
    const stmts = [];
    txs.forEach((t) => {
      if (!ruleMatches(rule, t)) return;
      const classic = t.source === "v1exp";
      if (rule.setCategoryId && !classic && t.categoryId !== rule.setCategoryId) {
        stmts.push(["UPDATE transactions SET category_id = ?3, category_locked = 1, needs_review = 0, updated_at = datetime('now') WHERE owner_id = ?1 AND id = ?2", t.id, rule.setCategoryId]);
      }
      if (rule.addTag && t.tags.indexOf(rule.addTag) === -1) {
        stmts.push(["UPDATE transactions SET tags = ?3 WHERE owner_id = ?1 AND id = ?2", t.id, JSON.stringify(t.tags.concat([rule.addTag]))]);
      }
      if (rule.setHidden && !t.hidden) stmts.push(["UPDATE transactions SET hidden = 1 WHERE owner_id = ?1 AND id = ?2", t.id]);
    });
    await s.batch(stmts);
    return { rules: await loadRules(s), changed: stmts.length };
  }
  const r = await cleanRule(s, b);
  const max = await s.first("SELECT IFNULL(MAX(sort), 0) AS m FROM rules WHERE owner_id = ?1");
  await s.run(
    "INSERT INTO rules (id, owner_id, sort, match_text, match_account_id, min_cents, max_cents, set_category_id, add_tag, set_hidden) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    newId("rul_"), max.m + 1, r.matchText, r.matchAccountId, r.minCents, r.maxCents, r.setCategoryId, r.addTag, r.setHidden ? 1 : 0
  );
  return new Response(JSON.stringify({ rules: await loadRules(s) }), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}, { skipMirror: true });

export const onRequestPatch = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const cur = (await loadRules(s)).find((r) => r.id === b.id);
  if (!cur) throw new HttpError(404, "Rule not found.");
  const r = await cleanRule(s, Object.assign({}, cur, b.patch || {}));
  await s.run(
    "UPDATE rules SET match_text = ?3, match_account_id = ?4, min_cents = ?5, max_cents = ?6, set_category_id = ?7, add_tag = ?8, set_hidden = ?9, sort = ?10 WHERE owner_id = ?1 AND id = ?2",
    cur.id, r.matchText, r.matchAccountId, r.minCents, r.maxCents, r.setCategoryId, r.addTag, r.setHidden ? 1 : 0,
    b.patch && b.patch.sort !== undefined ? Number(b.patch.sort) || 0 : cur.sort
  );
  return { rules: await loadRules(s) };
}, { skipMirror: true });

export const onRequestDelete = (context) => handleV2(context, async ({ s, url }) => {
  await s.run("DELETE FROM rules WHERE owner_id = ?1 AND id = ?2", String(url.searchParams.get("id") || ""));
  return { rules: await loadRules(s) };
}, { skipMirror: true });
