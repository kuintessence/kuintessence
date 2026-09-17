// Tests for `/api/metering/*` HTTP routes.
//
// Uses an in-memory MeteringRepository + InMemoryWebhookRepository so the
// suite stays Docker-free. Auth is faked by setting `c.var.user` directly
// on the test app, mirroring the pattern used by `software.test.ts` /
// `preferences.test.ts`.

import { describe, expect, it, spyOn } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../../authz/service";
import { createErrorHandler } from "../../middleware/error-handler";
import type { OrgMembershipRole } from "../../middleware/principal-binder";
import {
  InMemoryMeteringRepository,
  MeteringService,
  type TenantScope,
} from "../../services/metering";
import type {
  WorkflowNetDriveAttribution,
  WorkflowNetDriveAttributionReader,
} from "../../services/metering-workflow-attribution";
import {
  buildMeteringRouter,
  InMemoryWebhookRepository,
  type WebhookRepository,
} from "../metering";

interface FakePrincipal {
  sub: string;
  role: string;
  email: string;
  orgId: string | null;
  orgIds?: string[];
  userId?: string | null;
}

const ORG_A_ID = "00000000-0000-0000-0000-0000000000a1";
const ORG_B_ID = "00000000-0000-0000-0000-0000000000b2";
const ORG_A_USER_ID = "00000000-0000-4000-8000-00000000d001";
const SUPER_USER_ID = "00000000-0000-4000-8000-00000000d002";
const OPERATOR_USER_ID = "00000000-0000-4000-8000-00000000d003";
const silent = pino({ level: "silent" });

class FakeWorkflowAttributionReader implements WorkflowNetDriveAttributionReader {
  constructor(private readonly rows: WorkflowNetDriveAttribution[]) {}

  async getWorkflowNetDriveAttribution(
    workflowRunId: string,
    scope: TenantScope,
  ): Promise<WorkflowNetDriveAttribution | null> {
    const row = this.rows.find((r) => r.workflowRunId === workflowRunId);
    if (!row) return null;
    if (scope.kind === "all") return row;
    if (!row.orgId || !scope.orgIds.includes(row.orgId)) return null;
    return row;
  }
}

function makeApp(
  principal: FakePrincipal,
  authz?: AuthzService,
  options: {
    bindPrincipal?: boolean;
    principalEmail?: string;
    principalMembershipRole?: OrgMembershipRole;
    principalRole?: string;
  } = {},
): {
  app: Hono;
  service: MeteringService;
  webhookRepo: WebhookRepository;
  workflowAttribution: WorkflowNetDriveAttributionReader;
} {
  const repository = new InMemoryMeteringRepository();
  const service = new MeteringService({ repo: repository });
  const webhookRepo = new InMemoryWebhookRepository();
  const workflowAttribution = new FakeWorkflowAttributionReader([
    {
      workflowRunId: "00000000-0000-4000-8000-000000000111",
      workflowName: "route-attribution",
      orgId: ORG_A_ID,
      transferCount: 2,
      totalTransferBytes: 12,
      networkEgressBytes: 7,
      storageBytes: 5,
      byDirection: { upload: 5, download: 7, mirror: 0 },
      netdriveFileIds: ["00000000-0000-4000-8000-000000000211"],
    },
    {
      workflowRunId: "00000000-0000-4000-8000-000000000112",
      workflowName: "other-org-attribution",
      orgId: ORG_B_ID,
      transferCount: 1,
      totalTransferBytes: 99,
      networkEgressBytes: 99,
      storageBytes: 99,
      byDirection: { upload: 0, download: 99, mirror: 0 },
      netdriveFileIds: [],
    },
  ]);

  const app = new Hono();
  app.onError(createErrorHandler(silent));
  app.use("*", async (c, next) => {
    const principalOrgIds = principal.orgIds ?? (principal.orgId ? [principal.orgId] : []);
    c.set("user" as never, {
      sub: principal.sub,
      role: principal.role,
      email: principal.email,
    });
    if (options.bindPrincipal !== false) {
      c.set("principal" as never, {
        sub: principal.sub,
        role: options.principalRole ?? principal.role,
        email: options.principalEmail ?? principal.email,
        userId: principal.userId ?? null,
        orgId: principal.orgId,
        orgIds: principalOrgIds,
        memberships: principalOrgIds.map((orgId) => ({
          orgId,
          role: options.principalMembershipRole ?? "member",
        })),
        capabilities: [],
      });
    }
    await next();
  });
  app.route(
    "/api",
    buildMeteringRouter({
      service,
      webhookRepo,
      authz,
      workflowAttribution,
    }),
  );
  return { app, service, webhookRepo, workflowAttribution };
}

function enforcingAuthz(options: {
  onRequire?: (check: AuthzCheck, isPlatformAdmin: boolean) => Promise<void> | void;
  lookupOrgIds?: string[];
}): AuthzService {
  return {
    mode: "enforce",
    requirePermission: async (check: AuthzCheck, isPlatformAdmin: boolean) => {
      await options.onRequire?.(check, isPlatformAdmin);
    },
    lookupResources: async (input: { resourceType: string; permission: string }) => {
      if (input.resourceType === "organization" && input.permission === "view") {
        return options.lookupOrgIds ?? [];
      }
      return [];
    },
    shadowCheck: async () => undefined,
  } as unknown as AuthzService;
}

function shadowAuthz(calls: ShadowCheckInput[]): AuthzService {
  return {
    mode: "shadow",
    shadowCheck: async (check: ShadowCheckInput) => {
      calls.push(check);
      return check.localAllowed ?? false;
    },
  } as unknown as AuthzService;
}

const PRINCIPAL_ORG_A: FakePrincipal = {
  sub: "u-a",
  role: "org_admin",
  email: "u-a@test.local",
  orgId: ORG_A_ID,
  userId: ORG_A_USER_ID,
};

const PRINCIPAL_SUPER: FakePrincipal = {
  sub: "u-super",
  role: "super_admin",
  email: "super@test.local",
  orgId: null,
  userId: SUPER_USER_ID,
};

const PRINCIPAL_OPERATOR: FakePrincipal = {
  sub: "u-operator",
  role: "operator",
  email: "operator@test.local",
  orgId: null,
  userId: OPERATOR_USER_ID,
};

const PRINCIPAL_GUEST_WITH_MEMBERSHIP: FakePrincipal = {
  sub: "u-guest",
  role: "guest",
  email: "guest@test.local",
  orgId: ORG_A_ID,
  userId: "00000000-0000-4000-8000-00000000d004",
};

const PRINCIPAL_USER_ORG_A: FakePrincipal = {
  ...PRINCIPAL_ORG_A,
  sub: "u-member",
  role: "user",
  email: "member@test.local",
  userId: "00000000-0000-4000-8000-00000000d005",
};

const PRINCIPAL_PLATFORM_ADMIN: FakePrincipal = {
  ...PRINCIPAL_SUPER,
  sub: "u-platform-admin",
  role: "platform_admin",
  email: "platform-admin@test.local",
  userId: "00000000-0000-4000-8000-00000000d006",
};

async function seedRecord(
  service: MeteringService,
  overrides: Partial<{
    jobId: string;
    userId: string;
    orgId: string;
    cpu: number;
    finishedAt: Date;
  }> = {},
) {
  await service.recordJobCompletion({
    jobId: overrides.jobId ?? crypto.randomUUID(),
    userId: overrides.userId ?? "00000000-0000-0000-0000-000000000001",
    orgId: overrides.orgId ?? ORG_A_ID,
    agentId: "agent-A",
    clusterName: "cluster-A",
    appTemplateKey: "gromacs",
    cpuCoreSeconds: overrides.cpu ?? 600,
    gpuSeconds: 0,
    memoryMbSeconds: 1024,
    storageMbSeconds: 0,
    networkEgressMb: 0,
    startedAt: new Date("2026-04-29T00:00:00Z"),
    finishedAt: overrides.finishedAt ?? new Date("2026-04-29T01:00:00Z"),
  });
}

describe("metering routes", () => {
  it("rejects a bound guest before every protected metering operation", async () => {
    const checks: AuthzCheck[] = [];
    const authz = enforcingAuthz({
      onRequire: (check) => {
        checks.push(check);
      },
      lookupOrgIds: [ORG_A_ID],
    });
    const { app, service, webhookRepo, workflowAttribution } = makeApp(
      PRINCIPAL_GUEST_WITH_MEMBERSHIP,
      authz,
    );
    const query = spyOn(service, "query");
    const attribution = spyOn(workflowAttribution, "getWorkflowNetDriveAttribution");
    const listWebhooks = spyOn(webhookRepo, "listForOrg");
    const insertWebhook = spyOn(webhookRepo, "insert");
    const deleteWebhook = spyOn(webhookRepo, "delete");
    const range = "from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z";
    const requests = [
      new Request(`http://test/api/metering/query?${range}&period=raw&grouping=org`),
      new Request(`http://test/api/metering/export?${range}&period=raw&grouping=org&format=json`),
      new Request(
        "http://test/api/metering/workflow-runs/00000000-0000-4000-8000-000000000111/netdrive-attribution",
      ),
      new Request("http://test/api/metering/webhook"),
      new Request("http://test/api/metering/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.test/hook",
          secret: "topsecret-1234",
          events: ["usage.daily"],
          enabled: true,
        }),
      }),
      new Request("http://test/api/metering/webhook/webhook-1", { method: "DELETE" }),
    ];

    for (const request of requests) {
      const res = await app.fetch(request);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "FORBIDDEN", message: "Metering access requires a user role" },
      });
    }
    expect(checks).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(attribution).not.toHaveBeenCalled();
    expect(listWebhooks).not.toHaveBeenCalled();
    expect(insertWebhook).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it("keeps org admin, operator, and platform admin metering query access", async () => {
    for (const principal of [PRINCIPAL_ORG_A, PRINCIPAL_OPERATOR, PRINCIPAL_PLATFORM_ADMIN]) {
      const { app, service } = makeApp(principal);
      await seedRecord(service);

      const res = await app.fetch(
        new Request(
          "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
            "&period=raw&grouping=org",
        ),
      );

      expect(res.status).toBe(200);
    }
  });

  describe("GET /api/metering/query", () => {
    it("keeps organization-scoped user metering reads available", async () => {
      const { app, service } = makeApp(PRINCIPAL_USER_ORG_A);
      await seedRecord(service);

      const res = await app.fetch(
        new Request(
          "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
            "&period=raw&grouping=org",
        ),
      );

      expect(res.status).toBe(200);
    });

    it("returns aggregated rows for the principal's org", async () => {
      const { app, service } = makeApp(PRINCIPAL_ORG_A);
      await seedRecord(service);
      await seedRecord(service, { cpu: 400 });

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=user";
      const res = await app.fetch(new Request(url));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { rows: Array<{ cpuCoreSeconds: number }>; total: number };
      expect(json.total).toBe(1);
      expect(json.rows[0]?.cpuCoreSeconds).toBe(1000);
    });

    it("intersects requested orgIds with the principal's allowed orgs", async () => {
      const { app, service } = makeApp(PRINCIPAL_ORG_A);
      // Records in two different orgs.
      await seedRecord(service, { orgId: ORG_A_ID });
      await seedRecord(service, { orgId: "00000000-0000-0000-0000-0000000000b2" });

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=org&orgIds=00000000-0000-0000-0000-0000000000b2";
      const res = await app.fetch(new Request(url));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { total: number; rows: unknown[] };
      // Principal can't see org B, so the intersection should be empty.
      expect(json.total).toBe(0);
    });

    it("uses SpiceDB organization lookup as the enforce read scope", async () => {
      const calls: AuthzCheck[] = [];
      const authz = enforcingAuthz({
        lookupOrgIds: [ORG_B_ID],
        onRequire: (check) => {
          calls.push(check);
          if (check.resource.type === "platform") {
            throw new AppError(ErrorCode.FORBIDDEN, "platform denied", 403);
          }
        },
      });
      const { app, service } = makeApp(PRINCIPAL_ORG_A, authz);
      await seedRecord(service, { orgId: ORG_A_ID, cpu: 100 });
      await seedRecord(service, { orgId: ORG_B_ID, cpu: 900 });

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=org";
      const res = await app.fetch(new Request(url));
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{ groupKey: string; cpuCoreSeconds: number }>;
        total: number;
      };
      expect(json.total).toBe(1);
      expect(json.rows[0]?.groupKey).toBe(ORG_B_ID);
      expect(json.rows[0]?.cpuCoreSeconds).toBe(900);
      expect(calls[0]?.subject).toEqual({ type: "user", id: ORG_A_USER_ID });
      expect(calls[0]?.actorUserId).toBe(ORG_A_USER_ID);
    });

    it("lets platform view read a requested org scope in enforce mode", async () => {
      const authz = enforcingAuthz({ lookupOrgIds: [] });
      const { app, service } = makeApp(PRINCIPAL_ORG_A, authz);
      await seedRecord(service, { orgId: ORG_A_ID, cpu: 100 });
      await seedRecord(service, { orgId: ORG_B_ID, cpu: 700 });

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        `&period=raw&grouping=org&orgIds=${ORG_B_ID}`;
      const res = await app.fetch(new Request(url));
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{ groupKey: string; cpuCoreSeconds: number }>;
        total: number;
      };
      expect(json.total).toBe(1);
      expect(json.rows[0]?.groupKey).toBe(ORG_B_ID);
      expect(json.rows[0]?.cpuCoreSeconds).toBe(700);
    });

    it("platform view degraded fallback uses bound principal role", async () => {
      const fallbackDecisions: boolean[] = [];
      const authz = enforcingAuthz({
        lookupOrgIds: [],
        onRequire: (_check, isPlatformAdmin) => {
          fallbackDecisions.push(isPlatformAdmin);
        },
      });
      const { app, service } = makeApp({ ...PRINCIPAL_ORG_A, role: "platform_admin" }, authz, {
        principalRole: "user",
      });
      await seedRecord(service, { orgId: ORG_A_ID, cpu: 100 });

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=org";
      const res = await app.fetch(new Request(url));

      expect(res.status).toBe(200);
      expect(fallbackDecisions).toEqual([false]);
    });

    it("platform operator view scope uses localAllowed without degraded fallback", async () => {
      const calls: Array<{
        check: AuthzCheck & { localAllowed: boolean };
        isPlatformAdmin: boolean;
      }> = [];
      const authz = enforcingAuthz({
        lookupOrgIds: [],
        onRequire: (check, isPlatformAdmin) => {
          calls.push({ check: check as AuthzCheck & { localAllowed: boolean }, isPlatformAdmin });
        },
      });
      const { app, service } = makeApp(
        { ...PRINCIPAL_OPERATOR, email: "stale-operator-token@test.local" },
        authz,
        { principalEmail: "bound-operator@test.local" },
      );
      await seedRecord(service, { orgId: ORG_A_ID, cpu: 100 });
      await seedRecord(service, { orgId: ORG_B_ID, cpu: 700 });

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=org";
      const res = await app.fetch(new Request(url));

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{ groupKey: string; cpuCoreSeconds: number }>;
        total: number;
      };
      expect(json.total).toBe(2);
      expect(calls).toEqual([
        {
          check: {
            actorUserId: OPERATOR_USER_ID,
            actorEmail: "bound-operator@test.local",
            resource: { type: "platform", id: "root" },
            permission: "view",
            subject: { type: "user", id: OPERATOR_USER_ID },
            context: { localAllowed: true, source: "metering-query" },
            localAllowed: true,
          },
          isPlatformAdmin: false,
        },
      ]);
    });

    it("fails closed in enforce mode without canonical user id", async () => {
      const calls: AuthzCheck[] = [];
      const authz = enforcingAuthz({
        lookupOrgIds: [ORG_A_ID],
        onRequire: (check) => {
          calls.push(check);
        },
      });
      const { app, service } = makeApp({ ...PRINCIPAL_ORG_A, userId: null }, authz);
      await seedRecord(service);

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=user";
      const res = await app.fetch(new Request(url));

      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("fails closed in shadow mode without canonical user id", async () => {
      const calls: ShadowCheckInput[] = [];
      const { app, service } = makeApp({ ...PRINCIPAL_ORG_A, userId: null }, shadowAuthz(calls));
      await seedRecord(service);

      const url =
        "http://test/api/metering/query?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=user";
      const res = await app.fetch(new Request(url));

      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("rejects stale JWT identity before any metering downstream call", async () => {
      const { app, service, webhookRepo, workflowAttribution } = makeApp(
        PRINCIPAL_SUPER,
        undefined,
        { bindPrincipal: false },
      );
      const query = spyOn(service, "query");
      const attribution = spyOn(workflowAttribution, "getWorkflowNetDriveAttribution");
      const listWebhooks = spyOn(webhookRepo, "listForOrg");
      const insertWebhook = spyOn(webhookRepo, "insert");
      const deleteWebhook = spyOn(webhookRepo, "delete");
      const range = "from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z";
      const requests = [
        new Request(`http://test/api/metering/query?${range}&period=raw&grouping=org`),
        new Request(`http://test/api/metering/export?${range}&period=raw&grouping=org&format=csv`),
        new Request(
          "http://test/api/metering/workflow-runs/00000000-0000-4000-8000-000000000111/netdrive-attribution",
        ),
        new Request("http://test/api/metering/webhook"),
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
        new Request("http://test/api/metering/webhook/webhook-1", { method: "DELETE" }),
      ];

      for (const request of requests) {
        const res = await app.fetch(request);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: { message: "Authorization principal is not bound" },
        });
      }
      expect(query).not.toHaveBeenCalled();
      expect(attribution).not.toHaveBeenCalled();
      expect(listWebhooks).not.toHaveBeenCalled();
      expect(insertWebhook).not.toHaveBeenCalled();
      expect(deleteWebhook).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/metering/export", () => {
    it("returns CSV with the right Content-Type and Content-Disposition", async () => {
      const { app, service } = makeApp(PRINCIPAL_SUPER);
      await seedRecord(service, { orgId: "00000000-0000-0000-0000-0000000000a1" });
      const url =
        "http://test/api/metering/export?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=user&format=csv";
      const res = await app.fetch(new Request(url));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/csv");
      const dispo = res.headers.get("content-disposition") ?? "";
      expect(dispo).toContain("metering-2026-04-28_2026-04-30.csv");
      const body = await res.text();
      expect(body.split("\n")[0]).toBe(
        "groupKey,cpuCoreSeconds,gpuSeconds,memoryMbSeconds,storageMbSeconds,networkEgressMb,jobCount",
      );
    });

    it("rejects Parquet until a real writer is enabled", async () => {
      const { app } = makeApp(PRINCIPAL_SUPER);
      const url =
        "http://test/api/metering/export?from=2026-04-28T00:00:00Z&to=2026-04-30T00:00:00Z" +
        "&period=raw&grouping=user&format=parquet";
      const res = await app.fetch(new Request(url));
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe("EXPORT_FORMAT_NOT_SUPPORTED");
      expect(body.error.details?.reason).toBe("EXPORT_FORMAT_NOT_SUPPORTED");
    });
  });

  describe("GET /api/metering/workflow-runs/:runId/netdrive-attribution", () => {
    it("returns a run-level NetDrive attribution summary in the principal scope", async () => {
      const { app } = makeApp(PRINCIPAL_ORG_A);
      const res = await app.fetch(
        new Request(
          "http://test/api/metering/workflow-runs/00000000-0000-4000-8000-000000000111/netdrive-attribution",
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkflowNetDriveAttribution;
      expect(body.workflowName).toBe("route-attribution");
      expect(body.networkEgressBytes).toBe(7);
      expect(body.netdriveFileIds).toEqual(["00000000-0000-4000-8000-000000000211"]);
    });

    it("does not reveal run-level attribution outside the principal scope", async () => {
      const { app } = makeApp(PRINCIPAL_ORG_A);
      const res = await app.fetch(
        new Request(
          "http://test/api/metering/workflow-runs/00000000-0000-4000-8000-000000000112/netdrive-attribution",
        ),
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("/api/metering/webhook", () => {
    it("creates and lists webhooks for the principal's org", async () => {
      const { app } = makeApp(PRINCIPAL_ORG_A);
      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );
      expect(created.status).toBe(201);
      const createdJson = (await created.json()) as { id: string; events: string[] };
      expect(createdJson.events).toEqual(["usage.daily"]);

      const listed = await app.fetch(new Request("http://test/api/metering/webhook"));
      expect(listed.status).toBe(200);
      const listedJson = (await listed.json()) as { items: Array<{ id: string }> };
      expect(listedJson.items.length).toBe(1);
      expect(listedJson.items[0]?.id).toBe(createdJson.id);
    });

    it("rejects webhook creation in shadow mode for non-org-admin local principal", async () => {
      const { app } = makeApp({
        ...PRINCIPAL_ORG_A,
        role: "user",
        email: "member-org@test.local",
      });

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );

      expect(created.status).toBe(403);
    });

    it("allows provider administrator membership to manage webhooks", async () => {
      const { app } = makeApp(
        {
          ...PRINCIPAL_ORG_A,
          role: "user",
          email: "provider-admin@test.local",
        },
        undefined,
        { principalMembershipRole: "admin" },
      );

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );

      expect(created.status).toBe(201);
    });

    it("requires an active organization before multi-organization webhook mutations", async () => {
      const { app } = makeApp(
        {
          ...PRINCIPAL_ORG_A,
          role: "user",
          orgId: null,
          orgIds: [ORG_A_ID, ORG_B_ID],
        },
        undefined,
        { principalMembershipRole: "admin" },
      );

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );
      const deleted = await app.fetch(
        new Request("http://test/api/metering/webhook/webhook-1", { method: "DELETE" }),
      );

      expect(created.status).toBe(409);
      expect(deleted.status).toBe(409);
    });

    it("rejects webhook creation when SpiceDB denies organization manage", async () => {
      const calls: AuthzCheck[] = [];
      const authz = enforcingAuthz({
        onRequire: (check) => {
          calls.push(check);
          throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
        },
      });
      const { app } = makeApp({ ...PRINCIPAL_ORG_A, email: "stale-org-token@test.local" }, authz, {
        principalEmail: "bound-org@test.local",
      });

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );

      expect(created.status).toBe(403);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.subject).toEqual({ type: "user", id: ORG_A_USER_ID });
      expect(calls[0]?.actorUserId).toBe(ORG_A_USER_ID);
      expect(calls[0]?.resource).toEqual({ type: "organization", id: ORG_A_ID });
      expect(calls[0]?.permission).toBe("manage");
      expect(calls[0]?.context?.source).toBe("metering-webhook-create");
    });

    it("creates webhooks authorized by organization#manage in enforce mode", async () => {
      const calls: Array<{
        check: AuthzCheck & { localAllowed: boolean };
        isPlatformAdmin: boolean;
      }> = [];
      const authz = enforcingAuthz({
        onRequire: (check, isPlatformAdmin) => {
          calls.push({ check: check as AuthzCheck & { localAllowed: boolean }, isPlatformAdmin });
        },
      });
      const { app } = makeApp({ ...PRINCIPAL_ORG_A, email: "stale-org-token@test.local" }, authz, {
        principalEmail: "bound-org@test.local",
      });

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );

      expect(created.status).toBe(201);
      const body = (await created.json()) as { orgId: string; events: string[] };
      expect(body.orgId).toBe(ORG_A_ID);
      expect(body.events).toEqual(["usage.daily"]);
      expect(calls).toEqual([
        {
          check: {
            actorUserId: ORG_A_USER_ID,
            actorEmail: "bound-org@test.local",
            resource: { type: "organization", id: ORG_A_ID },
            permission: "manage",
            subject: { type: "user", id: ORG_A_USER_ID },
            context: { localAllowed: true, source: "metering-webhook-create" },
            localAllowed: true,
          },
          isPlatformAdmin: false,
        },
      ]);
    });

    it("fails closed for webhook creation in enforce mode without canonical user id", async () => {
      const calls: AuthzCheck[] = [];
      const authz = enforcingAuthz({
        onRequire: (check) => {
          calls.push(check);
        },
      });
      const { app } = makeApp({ ...PRINCIPAL_ORG_A, userId: null }, authz);

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );

      expect(created.status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("fails closed for webhook creation in shadow mode without canonical user id", async () => {
      const calls: ShadowCheckInput[] = [];
      const { app } = makeApp({ ...PRINCIPAL_ORG_A, userId: null }, shadowAuthz(calls));

      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );

      expect(created.status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("deletes a webhook by id", async () => {
      const { app } = makeApp(PRINCIPAL_ORG_A);
      const created = await app.fetch(
        new Request("http://test/api/metering/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.test/hook",
            secret: "topsecret-1234",
            events: ["usage.daily"],
            enabled: true,
          }),
        }),
      );
      const { id } = (await created.json()) as { id: string };
      const del = await app.fetch(
        new Request(`http://test/api/metering/webhook/${id}`, { method: "DELETE" }),
      );
      expect(del.status).toBe(200);
      const after = await app.fetch(new Request("http://test/api/metering/webhook"));
      const afterJson = (await after.json()) as { items: unknown[] };
      expect(afterJson.items.length).toBe(0);
    });
  });

  describe("InMemoryWebhookRepository emitter methods", () => {
    it("listEnabledForEvent filters by enabled + event and includes the secret", async () => {
      const repo = new InMemoryWebhookRepository();
      const subbed = await repo.insert({
        orgId: "org-1",
        url: "https://a.test",
        secret: "secret-a",
        events: ["usage.daily", "usage.monthly"],
        enabled: true,
      });
      // Disabled — excluded.
      await repo.insert({
        orgId: "org-1",
        url: "https://b.test",
        secret: "secret-b",
        events: ["usage.daily"],
        enabled: false,
      });
      // Enabled but not subscribed to the event — excluded.
      await repo.insert({
        orgId: "org-2",
        url: "https://c.test",
        secret: "secret-c",
        events: ["usage.monthly"],
        enabled: true,
      });

      const got = await repo.listEnabledForEvent("usage.daily");
      expect(got.length).toBe(1);
      expect(got[0]?.id).toBe(subbed.id);
      expect(got[0]?.secret).toBe("secret-a");
      expect(got[0]?.enabled).toBe(true);
    });

    it("recordResult(ok) sets lastSentAt + resets failures; recordResult(!ok) increments", async () => {
      const repo = new InMemoryWebhookRepository();
      const w = await repo.insert({
        orgId: "org-1",
        url: "https://a.test",
        secret: "secret-a",
        events: ["usage.daily"],
        enabled: true,
      });
      await repo.recordResult(w.id, false);
      await repo.recordResult(w.id, false);
      let [row] = await repo.listEnabledForEvent("usage.daily");
      expect(row?.failures).toBe(2);

      await repo.recordResult(w.id, true);
      [row] = await repo.listEnabledForEvent("usage.daily");
      expect(row?.failures).toBe(0);
    });
  });
});
