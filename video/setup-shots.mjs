/* The first-run screen for the setup video (public/shots/setup*.png): the
   real index.html with /api stubbed out, so no Worker or database is
   needed. Usage: node setup-shots.mjs <repo> <out dir> (npm run shots:setup). */
import { createRequire } from "node:module";
import fs from "node:fs"; import path from "node:path";
const repo = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const { chromium } = createRequire(path.join(repo, "e2e/package.json"))("@playwright/test");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
const b = await chromium.launch(), page = await b.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
await page.route("http://app.test/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname.startsWith("/api/")) return r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "setup required", needsSetup: true, setup: true }) });
  const f = path.join(repo, u.pathname === "/" ? "index.html" : u.pathname);
  if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: "" });
  r.fulfill({ status: 200, contentType: types[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
});
await page.goto("http://app.test/");
await page.waitForTimeout(2500);
await page.evaluate(() => {
  document.getElementById("authGate").hidden = false;
  for (const f of document.querySelectorAll("#authGate form")) f.hidden = f.id !== "gateSetupForm";
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "setup.png") });
for (const id of ["#gateSetupSecret", "#gateSetupCode", "#gateSetupConfirm"]) await page.fill(id, "demo-setup-code");
await page.screenshot({ path: path.join(out, "setup-filled.png") });
await b.close();
