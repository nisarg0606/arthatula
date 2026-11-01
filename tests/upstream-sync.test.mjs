/*
 * .github/upstream-sync.sh against throwaway git repos: an "original" and
 * a copy laid out the way the Deploy to Cloudflare button makes one (its
 * own first commit, then Cloudflare's upload with wrangler.toml edited).
 * Covers the first update, workflow files held back or included, the
 * next update starting from the recorded commit, nothing to do, and a
 * clash with the copy's own edit (nothing committed).
 * Run: node tests/upstream-sync.test.mjs — needs git and bash.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../.github/upstream-sync.sh");
const root = mkdtempSync(join(tmpdir(), "upstream-sync-"));
const up = join(root, "up"), copy = join(root, "copy");
let clock = Date.parse("2026-01-01T00:00:00Z");

function git(dir, args, author = "Dev <dev@example.com>") {
  const date = new Date(clock += 60_000).toISOString();
  const [name, email] = author.match(/^(.*) <(.*)>$/).slice(1);
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}
function commit(dir, files, msg, author) { write(dir, files); git(dir, ["add", "-A"], author); git(dir, ["commit", "-qm", msg], author); }
function sync(includeWorkflows = false) {
  git(copy, ["fetch", "-q", up, "main"]);
  const out = join(root, "out"); writeFileSync(out, "");
  execFileSync("bash", [script, "FETCH_HEAD", String(includeWorkflows)], { cwd: copy,
    env: { ...process.env, GITHUB_OUTPUT: out, GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@x", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "bot@x" } });
  return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map(l => l.split(/=(.*)/).slice(0, 2)));
}
const read = f => readFileSync(join(copy, f), "utf8");
const toml = id => `name = "arthatula"\n\n[[d1]]\nbinding = "DB"\n${id}\n\n\n\n[triggers]\ncrons = ["a"]\n`;

try {
  mkdirSync(up); mkdirSync(copy);
  git(up, ["init", "-qb", "main"]);
  commit(up, { "app.js": "v1\n", "wrangler.toml": toml(""), ".github/workflows/ci.yml": "ci v1\n" }, "v1");
  const v1Files = { "app.js": "v1\n", "wrangler.toml": toml(""), ".github/workflows/ci.yml": "ci v1\n" };
  commit(up, { "app.js": "v2\n" }, "v2"); // the version the copy is made from

  git(copy, ["init", "-qb", "main"]);
  commit(copy, { "README.md": "hi\n" }, "Initial commit", "me <me@example.com>");
  commit(copy, { ...v1Files, "app.js": "v2\n", "wrangler.toml": toml('database_id = "mine"') },
    "Uploading template.", "cloudflare-workers-and-pages[bot] <bot@cloudflare.com>");

  // Nothing new upstream yet: base is the original's main when the copy was made.
  assert.deepEqual(sync(), { status: "current" });

  // First update: app and wrangler.toml change, a workflow too (held back).
  commit(up, { "app.js": "v3\n", "wrangler.toml": toml("").replace('["a"]', '["b"]'), ".github/workflows/ci.yml": "ci v2\n" }, "v3");
  assert.deepEqual(sync(), { status: "updated", workflows: ".github/workflows/ci.yml" });
  assert.equal(read("app.js"), "v3\n");
  assert.match(read("wrangler.toml"), /database_id = "mine"[\s\S]*\["b"\]/, "keeps the copy's id, takes the new cron");
  assert.equal(read(".github/workflows/ci.yml"), "ci v1\n");
  assert.equal(git(copy, ["log", "-1", "--format=%(trailers:key=Upstream-Commit,valueonly)"]), git(up, ["rev-parse", "HEAD"]));

  // Next update starts from the recorded commit; with the token, workflow
  // files are copied whole, so the one held back last time catches up.
  commit(copy, { ".github/workflows/mine.yml": "my own\n" }, "my workflow", "me <me@example.com>");
  commit(up, { "app.js": "v4\n", ".github/workflows/ci.yml": "ci v3\n", ".github/workflows/new.yml": "new\n" }, "v4");
  assert.deepEqual(sync(true), { status: "updated" });
  assert.equal(read("app.js"), "v4\n");
  assert.equal(read(".github/workflows/ci.yml"), "ci v3\n");
  assert.equal(read(".github/workflows/new.yml"), "new\n");
  git(up, ["rm", "-q", ".github/workflows/new.yml"]); git(up, ["commit", "-qm", "drop new"]);
  assert.deepEqual(sync(true), { status: "updated" });
  assert.equal(git(copy, ["ls-files", ".github"]), ".github/workflows/ci.yml\n.github/workflows/mine.yml");
  assert.deepEqual(sync(), { status: "current" });

  // The copy's own edit clashes with the original's: nothing is committed.
  commit(copy, { "app.js": "my app\n" }, "my edit", "me <me@example.com>");
  commit(up, { "app.js": "v5\n", "other.js": "x\n" }, "v5");
  const before = git(copy, ["rev-parse", "HEAD"]);
  assert.deepEqual(sync(), { status: "conflict", conflicts: "app.js" });
  assert.equal(git(copy, ["rev-parse", "HEAD"]), before);
  assert.equal(git(copy, ["status", "--porcelain"]), "");
  assert.equal(read("app.js"), "my app\n");
  console.log("upstream-sync: all passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
