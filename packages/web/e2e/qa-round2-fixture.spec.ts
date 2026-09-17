import type { Page } from "patchright";
import { expect, test } from "patchright/test";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
const ORGANIZATION_CONTEXT_ID = `organization:${ORGANIZATION_ID}`;
const USER_ID = "00000000-0000-4000-8000-000000000001";

function success<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function capabilityResponse() {
  return {
    activeContextId: ORGANIZATION_CONTEXT_ID,
    capabilities: ["workspace.provider.view", "workspace.provider.manage"],
    contexts: [
      {
        id: ORGANIZATION_CONTEXT_ID,
        membershipRole: "admin",
        organizationId: ORGANIZATION_ID,
        type: "organization",
      },
    ],
    devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
    principal: { email: "qa@example.test", role: "user", userId: USER_ID },
  };
}

function asset(id: string, name: string) {
  return {
    accessMode: "request",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    id,
    kind: "scientific-dataset",
    lifecycle: "draft",
    name,
    ownerKind: "provider",
    ownerOrgId: ORGANIZATION_ID,
    ownerUserId: null,
    providerOrgId: ORGANIZATION_ID,
    sensitivity: "internal",
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    visibility: "organization",
  };
}

function accessRequest(status: "approved" | "pending") {
  return {
    assetId: "asset-a",
    capability: "view",
    createdAt: "2026-01-01T00:00:00.000Z",
    decisionReason: status === "approved" ? "approved" : null,
    expiresAt: null,
    id: "request-a",
    reason: "fixture",
    requesterOrgId: ORGANIZATION_ID,
    requesterUserId: "user-a",
    reviewedAt: status === "approved" ? "2026-01-01T01:00:00.000Z" : null,
    reviewedBy: status === "approved" ? "qa" : null,
    status,
    subjectId: "user-a",
    subjectKind: "user",
  };
}

async function prepareAuthenticatedPage(page: Page, evidence: string[]) {
  await page.addInitScript(
    ({ organizationId }: { organizationId: string }) => {
      localStorage.setItem("kq_active_organization_id", organizationId);
      localStorage.setItem("kq_email", "qa@example.test");
      localStorage.setItem("kq_role", "user");
      localStorage.setItem("kq_token", "fixture-token");
      localStorage.setItem("kq_token_expires_at", String(Date.now() + 3_600_000));
    },
    { organizationId: ORGANIZATION_ID },
  );
  await page.route("**/platform/api/branding", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 {}`);
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.route("**/platform/api/me/capabilities", async (route) => {
    const headers = route.request().headers();
    expect(headers.authorization).toBe("Bearer fixture-token");
    expect(headers["x-kq-active-organization"]).toBe(ORGANIZATION_ID);
    const body = capabilityResponse();
    evidence.push(
      `${route.request().method()} ${route.request().url()} -> 200 raw capability schema`,
    );
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/me/active-organization", async (route) => {
    evidence.push(
      `${route.request().method()} ${route.request().url()} -> 200 raw active organization`,
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        activeOrganizationId: ORGANIZATION_ID,
        organizations: [{ name: "QA organization", orgId: ORGANIZATION_ID, role: "admin" }],
      }),
    });
  });
}

test("fixture browser flow rejects invalid and reversed ranges and discloses capped CSV", async ({
  page,
}) => {
  const evidence: string[] = [];
  await prepareAuthenticatedPage(page, evidence);
  await page.route("**/platform/api/metering/webhook", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 {items:[]}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route("**/platform/api/metering/query?*", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 raw query result`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            cpuCoreSeconds: 1,
            gpuSeconds: 0,
            groupKey: ORGANIZATION_ID,
            jobCount: 1,
            memoryMbSeconds: 0,
            networkEgressMb: 0,
            storageMbSeconds: 0,
          },
        ],
        total: 1001,
      }),
    });
  });
  await page.route("**/platform/api/metering/export?*", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 text/csv`);
    await route.fulfill({ contentType: "text/csv", body: "key\norg-a\n" });
  });

  await page.goto("/cp/metering");
  await expect(page.getByTestId("metering-partial-result")).toBeVisible();
  await page.getByTestId("metering-from").fill("");
  await expect(page.getByTestId("metering-range-error")).toBeVisible();
  await expect(page.getByTestId("metering-export")).toBeDisabled();
  await page.getByTestId("metering-from").fill("2026-09-02T12:00");
  await page.getByTestId("metering-to").fill("2026-09-01T12:00");
  await expect(page.getByTestId("metering-range-error")).toBeVisible();
  await expect(page.getByTestId("metering-export")).toBeDisabled();
  await page.getByTestId("metering-from").fill("2026-09-01T12:00");
  await page.getByTestId("metering-to").fill("2026-09-02T12:00");
  await expect(page.getByTestId("metering-range-error")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByTestId("metering-export").click();
  await download;

  expect(
    evidence.some((entry) => entry.includes("metering/query?") && entry.includes("limit=1000")),
  ).toBe(true);
  expect(
    evidence.some((entry) => entry.includes("metering/export?") && entry.includes("limit=1000")),
  ).toBe(true);
});

test("fixture browser flow preserves CP data boundaries across selection, import, and review", async ({
  page,
}) => {
  const evidence: string[] = [];
  let approved = false;
  let releaseImport: (() => void) | undefined;
  const replicaRequests: string[] = [];
  await prepareAuthenticatedPage(page, evidence);
  await page.route("**/platform/api/cp/agents", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 {items:[agent-a]}`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ hostname: "compute-a", id: "agent-a", siteId: "site-a", status: "online" }],
      }),
    });
  });
  await page.route("**/platform/api/admin/cluster-file-roots", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 raw roots`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        roots: [
          {
            agentId: "agent-a",
            enabled: true,
            id: "root-a",
            label: "Research",
            path: "/data",
            providerOrgId: ORGANIZATION_ID,
            visibleOrgIds: [ORGANIZATION_ID],
          },
        ],
      }),
    });
  });
  await page.route("**/platform/api/cp/data/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path.endsWith("/data/assets")) {
      evidence.push(`${request.method()} ${request.url()} -> 200 success assets`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          success({
            assets: [asset("asset-a", "Asset A"), asset("asset-b", "Asset B")],
            limit: 25,
            offset: 0,
            total: 2,
          }),
        ),
      });
      return;
    }
    if (request.method() === "GET" && path.endsWith("/data/assets/asset-a/versions")) {
      evidence.push(`${request.method()} ${request.url()} -> 200 success versions A`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          success({
            limit: 25,
            offset: 0,
            total: 1,
            versions: [
              {
                assetId: "asset-a",
                createdAt: "2026-01-01T00:00:00.000Z",
                createdBy: "qa",
                id: "version-a",
                immutableAt: null,
                manifest: {},
                manifestDigest: null,
                status: "ready",
                version: "v1",
              },
            ],
          }),
        ),
      });
      return;
    }
    if (request.method() === "GET" && path.endsWith("/data/assets/asset-b/versions")) {
      evidence.push(`${request.method()} ${request.url()} -> 200 success versions B`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(success({ limit: 25, offset: 0, total: 0, versions: [] })),
      });
      return;
    }
    if (request.method() === "GET" && path.endsWith("/data/imports")) {
      evidence.push(`${request.method()} ${request.url()} -> 200 success imports`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(success({ imports: [], limit: 25, offset: 0, total: 0 })),
      });
      return;
    }
    if (request.method() === "GET" && path.endsWith("/data/access-requests")) {
      evidence.push(`${request.method()} ${request.url()} -> 200 success access requests`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          success({
            limit: 25,
            offset: 0,
            requests: [accessRequest(approved ? "approved" : "pending")],
            total: 1,
          }),
        ),
      });
      return;
    }
    if (request.method() === "GET" && path.endsWith("/data/access-requests/request-a")) {
      evidence.push(`${request.method()} ${request.url()} -> 200 success access detail`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(success(accessRequest(approved ? "approved" : "pending"))),
      });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/data/access-requests/request-a/review")) {
      approved = true;
      evidence.push(`${request.method()} ${request.url()} -> 200 success review`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(success({ request: accessRequest("approved") })),
      });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/data/imports")) {
      evidence.push(`${request.method()} ${request.url()} -> delayed 200 success import`);
      await new Promise<void>((resolve) => {
        releaseImport = resolve;
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          success({
            dataImport: {
              agentId: "agent-a",
              assetId: "asset-a",
              completedAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              errorMessage: null,
              id: "import-a",
              managedRootId: "root-a",
              relativePath: "input",
              sourceKind: "cp-local",
              status: "pending",
              version: "release-b",
            },
            dispatchState: "dispatched",
            replayed: false,
            version: {
              assetId: "asset-a",
              createdAt: "2026-01-01T00:00:00.000Z",
              createdBy: "qa",
              id: "version-import-a",
              immutableAt: null,
              manifest: {},
              manifestDigest: null,
              status: "validating",
              version: "release-b",
            },
          }),
        ),
      });
      return;
    }
    if (request.method() === "GET" && path.includes("/replicas")) {
      replicaRequests.push(request.url());
      evidence.push(`${request.method()} ${request.url()} -> 200 success replicas`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(success({ limit: 25, offset: 0, replicas: [], total: 0 })),
      });
      return;
    }
    throw new Error(`Unexpected fixture request: ${request.method()} ${request.url()}`);
  });

  await page.goto("/cp/data");
  await page.getByTestId("cp-data-asset-asset-a").click();
  await expect(page.getByTestId("cp-data-version-version-a")).toBeVisible();
  await page.getByTestId("cp-data-agent-select").selectOption("agent-a");
  await page.getByTestId("cp-data-root-select").selectOption("root-a");
  await page.getByPlaceholder("Path relative to root").fill("input");
  await page.getByRole("button", { name: "Import" }).click();
  await expect.poll(() => releaseImport !== undefined).toBe(true);
  await page.getByTestId("cp-data-asset-asset-b").click();
  await expect(page.getByTestId("cp-data-version-version-a")).toHaveCount(0);
  releaseImport?.();
  await page.waitForTimeout(100);
  expect(replicaRequests.some((url) => url.includes("version-import-a"))).toBe(false);
  await page.getByText("view · pending").click();
  await expect(page.getByTestId("cp-data-access-request-detail")).toContainText("pending");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("cp-data-access-request-detail")).toContainText("approved");
  expect(
    evidence.some(
      (entry) => entry.includes("access-requests/request-a/review") && entry.startsWith("POST"),
    ),
  ).toBe(true);
});
