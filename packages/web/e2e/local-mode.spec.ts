import { expect, test } from "patchright/test";

/**
 * Local-mode GUI real-browser acceptance:
 *   1. Auto-auth — `window.__KQ_LOCAL__` injects a trusted token, so the SPA
 *      enters authenticated without the dev-login form (no /login bounce).
 *   2. Nav gating — Server-only surfaces (cp/terminal/files) are always hidden,
 *      and capability-gated items track `/api/capabilities` (here agents:false
 *      hides /agents while jobs/workflows/software stay visible).
 *   3. Local page renders against the injected base — clicking nav-jobs fetches
 *      from the local API (injected base + bearer) and renders the mocked row.
 *
 * The local API is mocked. `addInitScript` injects `__KQ_LOCAL__` before any
 * page script runs; Patchright's `**​/api/**` glob matches regardless of host.
 */

const LOCAL_BASE = "http://127.0.0.1:9999/api";
const LOCAL_TOKEN = "local-t";

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

test.describe("Local mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([baseUrl, token]) => {
        window.__KQ_LOCAL__ = { baseUrl, token };
      },
      [LOCAL_BASE, LOCAL_TOKEN] as const,
    );

    // Catch-all FIRST so the specific routes below win (Patchright matches
    // handlers in reverse registration order). Keeps the console quiet for any
    // local API probe not explicitly mocked.
    await page.route("**/api/**", async (route) => {
      await route.fulfill(json({}));
    });

    // Capability gate: agents:false proves /agents is hidden; the rest stay on.
    await page.route("**/api/capabilities", async (route) => {
      await route.fulfill(
        json({
          jobs: true,
          submit: true,
          logs: true,
          workflows: true,
          agents: false,
          metrics: true,
          software: true,
          ssh: false,
        }),
      );
    });

    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fulfill(json({}));
        return;
      }
      await route.fulfill(
        json({
          jobs: [
            { id: "j1", name: "demo", status: "running", submittedAt: "2026-06-02T00:00:00Z" },
          ],
        }),
      );
    });

    await page.route("**/api/workflows", async (route) => {
      await route.fulfill(json({ runs: [] }));
    });
    await page.route("**/api/software/agents/*/installed", async (route) => {
      await route.fulfill(json({ success: true, data: [] }));
    });
    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill(json({ token: LOCAL_TOKEN, expiresIn: 86400 }));
    });
    await page.route("**/api/auth/oidc/config-public", async (route) => {
      await route.fulfill(json({ enabled: false, providerName: "" }));
    });
  });

  test("auto-authenticates from the injected token (no /login bounce)", async ({ page }) => {
    await page.goto("/");
    // The injected token promotes to a session via ensureLocalSession, so the
    // ProtectedRoute renders the dashboard rather than redirecting to /login.
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("login-page")).toHaveCount(0);
    // The user menu (only rendered when authenticated) confirms the session.
    await expect(page.getByTestId("user-menu")).toBeVisible();
  });

  test("nav gating: Server-only + uncapable items hidden, supported items shown", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("sidebar")).toBeVisible();

    // Capability-backed + always-available local surfaces are present.
    await expect(page.getByTestId("nav-dashboard")).toBeVisible();
    await expect(page.getByTestId("nav-jobs")).toBeVisible();
    await expect(page.getByTestId("nav-workflows")).toBeVisible();
    await expect(page.getByTestId("nav-software")).toBeVisible();
    await expect(page.getByTestId("nav-settings")).toBeVisible();

    // Server-only surfaces are always dropped in local mode.
    await expect(page.getByTestId("nav-cp")).toHaveCount(0);
    await expect(page.getByTestId("nav-terminal")).toHaveCount(0);
    await expect(page.getByTestId("nav-files")).toHaveCount(0);
    // agents:false in /api/capabilities → /agents hidden.
    await expect(page.getByTestId("nav-agents")).toHaveCount(0);
  });

  test("local jobs page renders the row fetched from the injected local API", async ({ page }) => {
    let jobsRequestUrl: string | undefined;
    page.on("request", (req) => {
      if (req.method() === "GET" && req.url().endsWith("/api/jobs")) jobsRequestUrl = req.url();
    });

    await page.goto("/");
    await page.getByTestId("nav-jobs").click();
    await expect(page).toHaveURL("/jobs");

    // The mocked job (fetched from the injected local base) renders.
    await expect(page.getByTestId("job-row-j1")).toBeVisible();
    await expect(page.getByTestId("job-row-j1")).toContainText("demo");

    // Prove the fetch targeted the injected local base, not the Server `/api`.
    expect(jobsRequestUrl).toBe(`${LOCAL_BASE}/jobs`);
  });
});
