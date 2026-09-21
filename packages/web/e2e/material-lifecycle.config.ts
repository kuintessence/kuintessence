import { defineConfig } from "patchright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "material-lifecycle.spec.ts",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "../test-results/material-lifecycle",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.KQ_LIFECYCLE_CHROMIUM_EXECUTABLE },
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    contextOptions: { reducedMotion: "reduce" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
