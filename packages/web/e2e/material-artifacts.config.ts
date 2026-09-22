import { fileURLToPath } from "node:url";
import { defineConfig } from "patchright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "material-artifacts.spec.ts",
  timeout: 600_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["./material-artifacts.reporter.ts"]],
  quiet: true,
  preserveOutput: "never",
  outputDir: "../test-results/material-artifacts",
  use: {
    baseURL: "http://127.0.0.1:15173",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 15173 --strictPort",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:15173",
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "ignore",
    timeout: 120_000,
  },
});
