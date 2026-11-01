/* worker.js serves the API from the same functions/ files Pages routes
   by file name: every endpoint file must have a route, and paths must
   resolve the way Pages resolves them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { ROUTES, match } from "../worker.js";

test("every functions/api endpoint file has a Worker route", () => {
  const files = readdirSync(new URL("../functions/api/", import.meta.url), { recursive: true })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".js") && !f.split("/").some((p) => p.startsWith("_")))
    .map((f) => "api/" + f);
  assert.deepEqual(ROUTES.map((r) => r[2]).sort(), files.sort());
});

test("paths resolve like Pages: exact segments beat parameters", () => {
  assert.equal(match("/api/budget").mod, ROUTES.find((r) => r[0] === "/api/budget")[1]);
  assert.equal(match("/api/budget/").mod, ROUTES.find((r) => r[0] === "/api/budget")[1]);
  assert.equal(match("/api/sync-requests/claim").mod, ROUTES.find((r) => r[0] === "/api/sync-requests/claim")[1]);
  const done = match("/api/sync-requests/abc%2D1/complete");
  assert.equal(done.mod, ROUTES.find((r) => r[0] === "/api/sync-requests/:id/complete")[1]);
  assert.deepEqual(done.params, { id: "abc-1" });
  assert.equal(match("/api/nope"), null);
  assert.equal(match("/api/budget/extra"), null);
});
