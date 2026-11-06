import { defineConfig } from "patchright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ui-components.spec.ts",
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "../test-results/ui-components",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.KQ_UI_CHROMIUM_EXECUTABLE },
    viewport: { width: 1280, height: 960 },
    trace: "retain-on-failure",
  },
});
