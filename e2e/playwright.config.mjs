import { defineConfig, devices } from "@playwright/test";

/* The app runs under `wrangler pages dev` with a fresh local D1 database
   (e2e/.state is wiped each run) and a throwaway setup secret. One worker:
   both browser projects share that database. */
export default defineConfig({
  testDir: ".",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://localhost:8790", trace: "retain-on-failure" },
  projects: [
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: "rm -rf e2e/.state && node e2e/node_modules/wrangler/bin/wrangler.js pages dev . --port 8790 " +
      "--persist-to e2e/.state --binding SETUP_SECRET=e2e-setup-secret",
    cwd: "..",
    url: "http://localhost:8790",
    timeout: 120_000,
    reuseExistingServer: false
  }
});
