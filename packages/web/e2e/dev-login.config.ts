import { fileURLToPath } from "node:url";
import { defineConfig } from "patchright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "dev-login.spec.ts",
  forbidOnly: !!process.env.CI,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:15176",
    browserName: "chromium",
    launchOptions: { executablePath: process.env.KQ_UI_CHROMIUM_EXECUTABLE },
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 15176 --strictPort",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:15176",
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "ignore",
    timeout: 120_000,
  },
});
