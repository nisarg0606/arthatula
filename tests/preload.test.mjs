/* index.html preloads every app module (see the comment there); a module
   missing from the list still works but loads a round trip later. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

test("index.html has a modulepreload link for every module under js/", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const files = readdirSync(new URL("../js/", import.meta.url), { recursive: true })
    .filter((f) => f.endsWith(".js") && f !== "main.js").map((f) => "js/" + f.split("\\").join("/"));
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(preloaded.sort(), files.sort());
});
