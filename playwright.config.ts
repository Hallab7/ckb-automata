import { defineConfig } from "@playwright/test";

const port = 3030;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 2 : 0,
  reporter: [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { browserName: "chromium", viewport: { height: 800, width: 1365 } },
    },
    {
      name: "mobile-chromium",
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { height: 800, width: 320 },
      },
    },
  ],
  webServer: {
    command: `npx --yes pnpm@12.5.1 --filter @ckb-automata/web dev --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    url: baseURL,
  },
});
