import { defineConfig } from "patchright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "shared-motion.spec.ts",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  outputDir: "../test-results/motion",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.KQ_MOTION_CHROMIUM_EXECUTABLE },
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
