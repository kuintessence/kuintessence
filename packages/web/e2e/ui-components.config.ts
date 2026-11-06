import { defineConfig } from "patchright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["ui-components.spec.ts", "ui-pages.spec.ts"],
  forbidOnly: !!process.env.CI,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "../test-results/ui-components",
  snapshotPathTemplate: "{testDir}/snapshots/ui/{arg}{ext}",
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.01 } },
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.KQ_UI_CHROMIUM_EXECUTABLE },
    viewport: { width: 1280, height: 960 },
    locale: "zh-CN",
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
});
