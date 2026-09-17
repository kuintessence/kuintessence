import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "patchright/test";
import { chromium } from "patchright/test";
import { FakeGuiBackend } from "./fake-backend";
import { createGuiServer } from "./server";

/**
 * Full-stack real-browser e2e: a real {@link Bun.serve} socket runs
 * `kq gui serve` over a built SPA ({@link FakeGuiBackend}, so no scheduler is
 * needed), and headless chromium loads it. This is the only test that exercises
 * the whole all-in-one GUI path through a browser — static-serve + the injected
 * `window.__KQ_LOCAL__`, the SPA booting in local mode, auto-auth, and the
 * api-client calling `/api/*` (bearer) → Server-shaped mappers → backend.
 *
 * Gated on prerequisites (built `packages/web/dist` + a launchable chromium),
 * mirroring the Docker/Slurm-gated integration tests: when either is absent the
 * suite skips instead of failing, so plain `bun run test:unit` stays green.
 */
const WEB_DIST = resolve(import.meta.dir, "../../../web/dist");
const DIST_READY = existsSync(resolve(WEB_DIST, "index.html"));
const TOKEN = "browser-e2e-token";

describe.skipIf(!DIST_READY)("kq gui serve — real-browser all-in-one e2e", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined;
  let base = "";

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = undefined;
      return;
    }
    const gui = createGuiServer(new FakeGuiBackend(), { token: TOKEN, webDir: WEB_DIST });
    server = Bun.serve({ port: 0, fetch: gui.fetch });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  it("boots the SPA in local mode, auto-auths, and renders backend data over /api", async () => {
    if (!browser) {
      // chromium could not launch in this environment — nothing to assert.
      return;
    }
    const page = await browser.newPage();
    try {
      await page.goto(base, { waitUntil: "networkidle" });
      // Local-mode auto-auth must keep us out of /login (the seam that the
      // local-mode Patchright suite regressed before `ensureLocalSession`).
      expect(page.url()).not.toContain("/login");

      await page.goto(`${base}/jobs`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.body.innerText.includes("echo"), undefined, {
        timeout: 15_000,
      });
      const text = await page.evaluate(() => document.body.innerText);
      // Job names come only from the bearer-protected /api/jobs → mappers →
      // FakeGuiBackend chain, so their presence proves the full stack.
      expect(text).toContain("echo");
      expect(text).toContain("train");
    } finally {
      await page.close();
    }
  }, 30_000);
});
