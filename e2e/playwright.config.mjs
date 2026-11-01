import { defineConfig, devices } from "@playwright/test";

/* The app runs under `wrangler pages dev` with a fresh local D1 database
   (e2e/.state is wiped each run) and a throwaway setup secret. One worker:
   both browser projects share that database (in CI each project runs on
   its own runner, so each gets its own). Everything uses 127.0.0.1, not
   "localhost": inside Docker "localhost" can resolve to IPv6 ::1 while
   wrangler listens on IPv4, and the server then never looks ready. */
export default defineConfig({
  testDir: ".",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://127.0.0.1:8790", trace: "retain-on-failure" },
  projects: [
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: "rm -rf e2e/.state && node e2e/node_modules/wrangler/bin/wrangler.js pages dev . --ip 127.0.0.1 --port 8790 " +
      "--persist-to e2e/.state --binding SETUP_SECRET=e2e-setup-secret",
    cwd: "..",
    url: "http://127.0.0.1:8790",
    stdout: "pipe", /* show the server's own log (e.g. "Ready on …") in CI */
    timeout: 120_000,
    reuseExistingServer: false
  }
});
