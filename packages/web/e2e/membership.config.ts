import { defineConfig } from "patchright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "membership-management.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://kq.test",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
