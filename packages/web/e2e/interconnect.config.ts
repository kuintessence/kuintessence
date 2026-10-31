import { defineConfig } from "patchright/test";
// Built assets are intercepted in the browser: no server or cluster is started.
export default defineConfig({
  testDir: ".",
  testMatch: "interconnect.spec.ts",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  workers: 1,
  use: {
    baseURL: "http://kq.test",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
