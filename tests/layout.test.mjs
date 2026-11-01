/*
 * Dashboard layout route (functions/api/v2/layout.js): sign-in, the
 * default, save/load, unknown keys refused, missing keys appended.
 * Run: node tests/layout.test.mjs
 */
import assert from "node:assert/strict";
import { FakeD1, makeCtx, setupTestAuth, authHeaders } from "./_fake-d1.mjs";
import * as layout from "../functions/api/v2/layout.js";

const env = { DB: new FakeD1() };
const token = await setupTestAuth(env);
async function call(method, body, tok) {
  const res = await layout["onRequest" + method[0] + method.slice(1).toLowerCase()](makeCtx(env, body, method, "http://local/api/v2/layout", authHeaders(tok === undefined ? token : tok)));
  return { status: res.status, data: await res.json() };
}

assert.equal((await call("GET", undefined, null)).status, 401);
assert.equal((await call("PUT", {}, null)).status, 401);
assert.deepEqual((await call("GET")).data, { order: layout.SECTIONS, hidden: [] }, "default");

const saved = await call("PUT", { order: ["trends", "ask", "trends"], hidden: ["month"] });
assert.equal(saved.status, 200);
assert.deepEqual(saved.data, { order: ["trends", "ask", "overview", "market", "month"], hidden: ["month"] }, "dupes dropped, missing appended");
assert.deepEqual((await call("GET")).data, saved.data, "loads what was saved");

assert.equal((await call("PUT", { order: ["nope"] })).status, 400);
assert.equal((await call("PUT", { hidden: "month" })).status, 400);
assert.equal((await call("PUT", null)).status, 200, "null body is the default");
assert.deepEqual((await call("GET")).data, { order: layout.SECTIONS, hidden: [] }, "reset");
console.log("layout tests passed");
