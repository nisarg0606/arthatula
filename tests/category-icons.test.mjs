/*
 * Default category emoji: a new owner gets them, an owner from before
 * them gets them once where the icon is empty, an emoji you set is
 * kept, and one you clear stays cleared. The classic screens' copy
 * matches. Run: node tests/category-icons.test.mjs
 */
import assert from "node:assert/strict";
import { FakeD1 } from "./_fake-d1.mjs";
import { ensureV2, ensureOwner, scope, DEFAULT_ICONS, DEFAULT_GROUPS } from "../functions/api/_v2db.js";
import { CATEGORY_ICONS } from "../js/core/categories.js";

const db = new FakeD1();
await ensureV2(db);
const s = scope(db, "old");
const icons = async () => Object.fromEntries((await s.all("SELECT name, icon FROM categories WHERE owner_id = ?1")).map((r) => [r.name, r.icon]));

/* New owner: every default category starts with its emoji. */
await ensureOwner(db, "old");
const fresh = await icons();
DEFAULT_GROUPS.flatMap((g) => g.cats).forEach((c) => assert.ok(DEFAULT_ICONS[c], "default icon for " + c));
assert.deepEqual(fresh, DEFAULT_ICONS);

/* Owner from before default emoji: no icons, no flag, one set by hand. */
await s.run("UPDATE categories SET icon = '' WHERE owner_id = ?1");
await s.run("DELETE FROM v2_settings WHERE owner_id = ?1 AND key = 'default_icons'");
await s.run("UPDATE categories SET icon = '🥦' WHERE owner_id = ?1 AND name = 'Groceries'");
await ensureOwner(db, "old");
let now = await icons();
assert.equal(now.Groceries, "🥦", "your own emoji is kept");
assert.equal(now.Rent, "🏠", "empty icons are filled");

/* Cleared after the fill: stays cleared on later ensures. */
await s.run("UPDATE categories SET icon = '' WHERE owner_id = ?1 AND name = 'Rent'");
await ensureOwner(db, "old");
now = await icons();
assert.equal(now.Rent, "", "a cleared emoji does not come back");

/* Names never carry the emoji. */
assert.ok(Object.keys(now).every((n) => /^[\w &/-]+$/.test(n)), "plain names");

/* The classic list's emoji match the money model's. */
for (const [c, i] of Object.entries(CATEGORY_ICONS)) assert.equal(i, DEFAULT_ICONS[c], c);

console.log("category-icons tests passed");
