import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Outside the repo on purpose: `wrangler dev` serves the repo folder as
   the Worker's assets and restarts on every change in it, so a database
   (or test results) written there restarted the server on every write
   and hung the run. */
const STATE = join(tmpdir(), "arthatula-e2e-state");
export const RESULTS = join(tmpdir(), "arthatula-e2e-results");

/* The app runs as the Worker (worker.js, `wrangler dev`) — what the Deploy
   to Cloudflare button sets up — with a fresh local D1 database
   (in the temp folder, wiped each run) and a throwaway setup secret. One worker:
   both browser projects share that database (in CI each project runs on
   its own runner, so each gets its own). Everything uses 127.0.0.1, not
   "localhost": inside Docker "localhost" can resolve to IPv6 ::1 while
   wrangler listens on IPv4, and the server then never looks ready. */
export default defineConfig({
  testDir: ".",
  outputDir: RESULTS,
  timeout: 45_000,
  /* Assertions get 10 s instead of the 5 s default: on a loaded CI
     runner the page can need longer than 5 s to reflect a save, and a
     short expect window turned that into intermittent failures whose
     retries then collided with the first attempt's leftovers. */
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://127.0.0.1:8790", trace: "retain-on-failure" },
  projects: [
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: "rm -rf " + JSON.stringify(STATE) + " && node e2e/node_modules/wrangler/bin/wrangler.js dev --ip 127.0.0.1 --port 8790 " +
      "--persist-to " + JSON.stringify(STATE) + " --var SETUP_SECRET:e2e-setup-secret",
    cwd: "..",
    url: "http://127.0.0.1:8790",
    stdout: "pipe", /* show the server's own log (e.g. "Ready on …") in CI */
    timeout: 120_000,
    reuseExistingServer: false
  }
});
