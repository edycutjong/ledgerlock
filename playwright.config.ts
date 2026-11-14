import { defineConfig, devices } from "@playwright/test";

// Serves the Pages site (docs/, or the built _site/ in CI via SITE_DIR) the way GitHub Pages resolves paths.
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `node e2e/serve.mjs`,
    env: { PORT: String(PORT), SITE_DIR: process.env.SITE_DIR || "docs" },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
