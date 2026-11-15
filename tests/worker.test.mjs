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

import { readFileSync } from "node:fs";
import { isInternalPath, withSecurityHeaders } from "../functions/_middleware.js";

test("repository files outside the app are never served, on Pages or the Worker", () => {
  /* Every .assetsignore entry (what the Worker leaves out) is also
     refused by the shared path check, which the Pages middleware uses. */
  const ignored = readFileSync(new URL("../.assetsignore", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const entry of ignored) {
    const p = "/" + entry.replace(/\*$/, "");
    assert.equal(isInternalPath(p), true, p + " should be refused");
    assert.equal(isInternalPath(p + "/x.js"), true, p + "/x.js should be refused");
  }
  for (const p of ["/tests/auth.test.mjs", "/TOOLS/sync-poller.mjs", "/%74ests/x", "//tests/x", "/.dev.vars", "/.dev.vars.example", "/budget-data.json"]) {
    assert.equal(isInternalPath(p), true, p);
  }
  for (const p of ["/", "/index.html", "/js/main.js", "/vendor/chart-4.4.1.umd.js", "/styles.css", "/tailwind.css",
    "/theme-init.js", "/manifest.webmanifest", "/icons/icon.svg", "/favicon.ico", "/testsuite.html"]) {
    assert.equal(isInternalPath(p), false, p);
  }
});

test("versioned vendor files are cached long; API responses never", () => {
  const vendor = withSecurityHeaders(new Response("x"), "https://a.example/vendor/chart-4.4.1.umd.js");
  assert.match(vendor.headers.get("Cache-Control"), /immutable/);
  const api = withSecurityHeaders(new Response("{}"), "https://a.example/api/budget");
  assert.equal(api.headers.get("Cache-Control"), "no-store");
  const page = withSecurityHeaders(new Response("<html>"), "https://a.example/index.html");
  assert.equal(page.headers.get("Cache-Control"), null);
  const missing = withSecurityHeaders(new Response("no", { status: 404 }), "https://a.example/vendor/chart-9.9.9.umd.js");
  assert.equal(missing.headers.get("Cache-Control"), null);
});
