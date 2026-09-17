import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type { PlacementTrace } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService, ShadowCheckInput } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createSchedulerRoutes } from "./scheduler";

const fakeTrace: PlacementTrace = {
  generatedAt: "2026-06-25T00:00:00.000Z",
  preview: true,
  candidateCount: 0,
  stages: [],
  finalDecision: null,
};

describe("scheduler preview authz identity binding", () => {
  test("uses canonical principal id, role, and org for placement preview", async () => {
    const captured: Array<{
      userId: string;
      userRole: string;
      orgId: string | null;
      preview: boolean;
    }> = [];
    const shadowChecks: ShadowCheckInput[] = [];
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "opaque-idp-subject",
        role: "platform_admin",
        email: "stale-token@example.com",
      });
      c.set("principal" as never, {
        sub: "opaque-idp-subject",
        role: "operator",
        email: "bound-user@example.com",
        userId: "user-canonical",
        orgId: "org-from-principal",
        orgIds: ["org-from-principal"],
        memberships: [{ orgId: "org-from-principal", role: "operator" }],
      });
      await next();
    });
    app.route(
      "/api",
      createSchedulerRoutes(
        {
          validateSchedulingIntent: async () => null,
          runWithTrace: async (input: {
            userId: string;
            userRole: string;
            orgId: string | null;
            preview: boolean;
          }) => {
            captured.push(input);
            return fakeTrace;
          },
        } as unknown as PlacementOrchestrator,
        {} as PgDb,
        {
          authz: {
            mode: "shadow",
            shadowCheck: async (check: ShadowCheckInput) => {
              shadowChecks.push(check);
              return check.localAllowed;
            },
          } as unknown as AuthzService,
        },
      ),
    );

    const res = await app.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-preview" },
      }),
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.userId).toBe("user-canonical");
    expect(captured[0]?.userRole).toBe("operator");
    expect(captured[0]?.orgId).toBe("org-from-principal");
    expect(captured[0]?.preview).toBe(true);
    expect(shadowChecks).toEqual([
      expect.objectContaining({
        actorUserId: "user-canonical",
        actorEmail: "bound-user@example.com",
        resource: { type: "queue", id: "queue-preview" },
        permission: "submit",
        subject: { type: "user", id: "user-canonical" },
      }),
    ]);
  });

  test("fails closed when canonical principal is missing", async () => {
    let runCalls = 0;
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "opaque-idp-subject",
        role: "platform_admin",
        email: "user@example.com",
      });
      await next();
    });
    app.route(
      "/api",
      createSchedulerRoutes(
        {
          runWithTrace: async () => {
            runCalls += 1;
            return fakeTrace;
          },
        } as unknown as PlacementOrchestrator,
        {} as PgDb,
      ),
    );

    const res = await app.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });

    expect(res.status).toBe(403);
    expect(runCalls).toBe(0);
  });
});
