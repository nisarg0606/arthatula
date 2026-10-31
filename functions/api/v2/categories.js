/*
 * v2 categories and groups (serves /api/v2/categories).
 *   GET -> { groups, categories }
 *   POST { type: "group", name, kind } | { type: "category", name, groupId } -> 201 { groups, categories }
 *        A category takes its group's kind (income, expense, transfer).
 *   PATCH { type, id, patch: { name?, groupId?, archived?, sort? } } -> { groups, categories }
 *   DELETE ?type=category&id=…&moveTo=<category id>
 *        Moves its transactions, splits, budgets and rules to moveTo first.
 *   DELETE ?type=group&id=… -> only when the group is empty.
 */
import { handleV2, HttpError, cleanStr, oneOf, bodyOf } from "../_v2http.js";
import { newId } from "../_v2db.js";
import { loadCategories } from "../_v2store.js";

const KINDS = ["income", "expense", "transfer"];

async function getGroup(s, id) {
  const g = await s.first("SELECT * FROM category_groups WHERE owner_id = ?1 AND id = ?2", String(id || ""));
  if (!g) throw new HttpError(404, "Group not found.");
  return g;
}
async function getCategory(s, id) {
  const c = await s.first("SELECT * FROM categories WHERE owner_id = ?1 AND id = ?2", String(id || ""));
  if (!c) throw new HttpError(404, "Category not found.");
  return c;
}
async function nameFree(s, name, exceptId) {
  const c = await s.first("SELECT id FROM categories WHERE owner_id = ?1 AND lower(name) = lower(?2)", name);
  if (c && c.id !== exceptId) throw new HttpError(409, "A category named \"" + name + "\" already exists.");
}

export const onRequestGet = (context) => handleV2(context, async ({ s }) => loadCategories(s), { skipMirror: true });

export const onRequestPost = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const name = cleanStr(b.name, 60);
  if (!name) throw new HttpError(400, "name is required.");
  if (b.type === "group") {
    const kind = oneOf(b.kind || "expense", KINDS, "kind");
    const max = await s.first("SELECT IFNULL(MAX(sort), 0) AS m FROM category_groups WHERE owner_id = ?1");
    await s.run("INSERT INTO category_groups (id, owner_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5)", newId("grp_"), name, kind, max.m + 1);
  } else if (b.type === "category") {
    const g = await getGroup(s, b.groupId);
    await nameFree(s, name);
    const max = await s.first("SELECT IFNULL(MAX(sort), 0) AS m FROM categories WHERE owner_id = ?1 AND group_id = ?2", g.id);
    await s.run("INSERT INTO categories (id, owner_id, group_id, name, kind, sort) VALUES (?2, ?1, ?3, ?4, ?5, ?6)", newId("cat_"), g.id, name, g.kind, max.m + 1);
  } else {
    throw new HttpError(400, "type must be group or category.");
  }
  return new Response(JSON.stringify(await loadCategories(s)), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}, { skipMirror: true });

export const onRequestPatch = (context) => handleV2(context, async ({ s, request }) => {
  const b = await bodyOf(request);
  const p = b.patch && typeof b.patch === "object" ? b.patch : {};
  if (b.type === "group") {
    const g = await getGroup(s, b.id);
    if (p.name !== undefined) {
      const name = cleanStr(p.name, 60);
      if (!name) throw new HttpError(400, "name can't be empty.");
      await s.run("UPDATE category_groups SET name = ?3 WHERE owner_id = ?1 AND id = ?2", g.id, name);
    }
    if (p.sort !== undefined) await s.run("UPDATE category_groups SET sort = ?3 WHERE owner_id = ?1 AND id = ?2", g.id, Number(p.sort) || 0);
  } else if (b.type === "category") {
    const c = await getCategory(s, b.id);
    if (p.name !== undefined) {
      const name = cleanStr(p.name, 60);
      if (!name) throw new HttpError(400, "name can't be empty.");
      await nameFree(s, name, c.id);
      await s.run("UPDATE categories SET name = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, name);
    }
    if (p.groupId !== undefined) {
      const g = await getGroup(s, p.groupId);
      await s.run("UPDATE categories SET group_id = ?3, kind = ?4 WHERE owner_id = ?1 AND id = ?2", c.id, g.id, g.kind);
    }
    if (p.archived !== undefined) await s.run("UPDATE categories SET archived = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, p.archived ? 1 : 0);
    if (p.sort !== undefined) await s.run("UPDATE categories SET sort = ?3 WHERE owner_id = ?1 AND id = ?2", c.id, Number(p.sort) || 0);
  } else {
    throw new HttpError(400, "type must be group or category.");
  }
  return loadCategories(s);
}, { skipMirror: true });

export const onRequestDelete = (context) => handleV2(context, async ({ s, url }) => {
  const type = url.searchParams.get("type"), id = url.searchParams.get("id");
  if (type === "group") {
    const g = await getGroup(s, id);
    const n = await s.first("SELECT COUNT(*) AS n FROM categories WHERE owner_id = ?1 AND group_id = ?2", g.id);
    if (n.n) throw new HttpError(409, "Move or delete this group's categories first.");
    await s.run("DELETE FROM category_groups WHERE owner_id = ?1 AND id = ?2", g.id);
    return loadCategories(s);
  }
  const c = await getCategory(s, id);
  const to = await getCategory(s, url.searchParams.get("moveTo"));
  if (to.id === c.id) throw new HttpError(400, "moveTo must be a different category.");
  await s.batch([
    ["UPDATE transactions SET category_id = ?3 WHERE owner_id = ?1 AND category_id = ?2", c.id, to.id],
    ["UPDATE transaction_splits SET category_id = ?3 WHERE owner_id = ?1 AND category_id = ?2", c.id, to.id],
    ["INSERT INTO budgets (owner_id, month, category_id, amount_cents, rollover, source) SELECT owner_id, month, ?3, amount_cents, rollover, 'user' FROM budgets WHERE owner_id = ?1 AND category_id = ?2 " +
     "ON CONFLICT(owner_id, month, category_id) DO UPDATE SET amount_cents = budgets.amount_cents + excluded.amount_cents, source = 'user'", c.id, to.id],
    ["DELETE FROM budgets WHERE owner_id = ?1 AND category_id = ?2", c.id],
    ["UPDATE rules SET set_category_id = ?3 WHERE owner_id = ?1 AND set_category_id = ?2", c.id, to.id],
    ["UPDATE recurring SET category_id = ?3 WHERE owner_id = ?1 AND category_id = ?2", c.id, to.id],
    ["DELETE FROM categories WHERE owner_id = ?1 AND id = ?2", c.id]
  ]);
  return loadCategories(s);
}, { skipMirror: true });
