import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { BoundOrgMembership } from "../middleware/principal-binder";
import type { JobService } from "../services/job-service";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createJobRoutes, subjectIdForJobAuthz } from "./jobs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function fakeDbWithoutUser(): PgDb {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  } as unknown as PgDb;
}

function fakeDbWithoutConfigRows(): PgDb {
  return {
    select: () => ({
      from: async () => [],
    }),
  } as unknown as PgDb;
}

function fakeJobService() {
  const calls: string[] = [];
  const service = {
    getById: async () => ({
      id: JOB_ID,
      name: "unit-job",
      command: "sleep 100",
      submittedBy: "owner-user-id",
      status: "running",
    }),
    updateStatus: async () => {
      calls.push("updateStatus");
      return { id: JOB_ID, status: "cancelled" };
    },
    list: async () => [],
    listPage: async () => ({ jobs: [], total: 0 }),
    getPlacementTrace: async () => null,
  } as unknown as JobService;
  return { service, calls };
}

function fakeSubmitJobService() {
  const calls: string[] = [];
  const submitOptions: unknown[] = [];
  const service = {
    submit: async (_data: unknown, userId: string, options: unknown) => {
      calls.push(`submit:${userId}`);
      submitOptions.push(options);
      return {
        id: JOB_ID,
        name: "unit-job-submit",
        command: "true",
        submittedBy: userId,
        status: "pending",
      };
    },
    getById: async () => null,
    updateStatus: async () => null,
    list: async () => [],
    listPage: async () => ({ jobs: [], total: 0 }),
    getPlacementTrace: async () => null,
  } as unknown as JobService;
  return { service, calls, submitOptions };
}

function fakeOrchestrator(): PlacementOrchestrator {
  return {
    validateSchedulingIntent: async () => null,
    placeAndDispatch: async () => ({ selectedAgentId: null, rejections: [], dispatched: false }),
    cancelJob: () => undefined,
  } as unknown as PlacementOrchestrator;
}

function fakeEnforceAuthz(checks: AuthzCheck[]): AuthzService {
  return {
    mode: "enforce",
    requirePermission: async (check: AuthzCheck) => {
      checks.push(check);
    },
    shadowCheck: async () => undefined,
    enqueueMany: async () => undefined,
  } as unknown as AuthzService;
}

function fakeShadowAuthz(checks: ShadowCheckInput[]): AuthzService {
  return {
    mode: "shadow",
    shadowCheck: async (check: ShadowCheckInput) => {
      checks.push(check);
    },
    enqueueMany: async () => undefined,
  } as unknown as AuthzService;
}

function makeApp(
  authz: AuthzService | undefined,
  service: JobService,
  role = "user",
  principalUserId: string | null = null,
  principalRole: string = role,
  principalEmail = "unbound-job-authz@test.local",
  db: PgDb = fakeDbWithoutUser(),
  memberships: BoundOrgMembership[] = [],
  orchestrator: PlacementOrchestrator = fakeOrchestrator(),
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, {
      sub: "unbound-subject",
      role,
      email: "unbound-job-authz@test.local",
    });
    if (principalUserId !== null) {
      c.set("principal" as never, {
        userId: principalUserId,
        role: principalRole,
        email: principalEmail,
        orgId: "job-authz-org",
        orgIds: ["job-authz-org"],
        memberships,
      });
    }
    await next();
  });
  app.route(
    "/api",
    createJobRoutes(service, db, orchestrator, {
      authz,
    }),
  );
  return app;
}

describe("job route SpiceDB subject binding", () => {
  test("bound guests are rejected before all job route storage and scheduling effects", async () => {
    const calls: string[] = [];
    const service = {
      ...(fakeJobService().service as JobService),
      getById: async () => {
        calls.push("getById");
        return null;
      },
      listPage: async () => {
        calls.push("listPage");
        return { jobs: [], total: 0 };
      },
      submit: async () => {
        calls.push("submit");
        return null;
      },
    } as unknown as JobService;
    const app = makeApp(undefined, service, "guest", "guest-user-id", "guest");
    const usecaseBody = {
      name: "guest-usecase",
      usecasePackageId: JOB_ID,
      inputs: {},
      resources: { cpus: 1, memoryMb: 1024 },
    };
    const requests = [
      app.request("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "guest-job",
          command: "true",
          resources: { cpus: 1, memoryMb: 1024 },
        }),
      }),
      app.request("/api/jobs/usecase/materialize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(usecaseBody),
      }),
      app.request("/api/jobs/usecase/preview-placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(usecaseBody),
      }),
      app.request("/api/jobs/usecase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(usecaseBody),
      }),
      app.request("/api/jobs"),
      app.request(`/api/jobs/${JOB_ID}`),
      app.request(`/api/jobs/${JOB_ID}/cancel`, { method: "POST" }),
    ];

    for (const request of requests) {
      expect((await request).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("job read and cancel routes reject unbound identity before JobService access", async () => {
    const calls: string[] = [];
    const service = {
      getById: async () => {
        calls.push("getById");
        return { id: JOB_ID, submittedBy: "owner-user-id", status: "running" };
      },
      listPage: async () => {
        calls.push("listPage");
        return { jobs: [], total: 0 };
      },
      getPlacementTrace: async () => {
        calls.push("getPlacementTrace");
        return null;
      },
      updateStatus: async () => {
        calls.push("updateStatus");
        return null;
      },
    } as unknown as JobService;
    const app = makeApp(undefined, service);
    const requests = [
      new Request("http://localhost/api/jobs"),
      new Request(`http://localhost/api/jobs/${JOB_ID}`),
      new Request(`http://localhost/api/jobs/${JOB_ID}/logs`),
      new Request(`http://localhost/api/jobs/${JOB_ID}/placement`),
      new Request(`http://localhost/api/jobs/${JOB_ID}/cancel`, { method: "POST" }),
    ];

    for (const request of requests) {
      const res = await app.request(request);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { message: "Authorization principal is not bound" },
      });
    }
    expect(calls).toEqual([]);
  });

  test("queue submit fails closed in shadow mode without bound principal", async () => {
    const checks: ShadowCheckInput[] = [];
    const { service, calls } = fakeSubmitJobService();
    let validateCalls = 0;
    let placeCalls = 0;
    const orchestrator = {
      validateSchedulingIntent: async () => {
        validateCalls += 1;
        return null;
      },
      placeAndDispatch: async () => {
        placeCalls += 1;
        return { selectedAgentId: null, rejections: [], dispatched: false };
      },
      cancelJob: () => undefined,
    } as unknown as PlacementOrchestrator;
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "submitter-sub",
        role: "platform_admin",
        email: "submitter@example.test",
      });
      await next();
    });
    app.route(
      "/api",
      createJobRoutes(service, fakeDbWithoutUser(), orchestrator, {
        authz: fakeShadowAuthz(checks),
      }),
    );

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "unit-submit-shadow",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-shadow" },
      }),
    });

    expect(res.status).toBe(403);
    expect(checks).toEqual([]);
    expect(calls).toEqual([]);
    expect(validateCalls).toBe(0);
    expect(placeCalls).toBe(0);
  });

  test("queue submit uses canonical principal instead of email lookup", async () => {
    const checks: ShadowCheckInput[] = [];
    const { service, calls, submitOptions } = fakeSubmitJobService();
    const validateCalls: unknown[] = [];
    const placeCalls: unknown[] = [];
    const orchestrator = {
      validateSchedulingIntent: async (input: unknown) => {
        validateCalls.push(input);
        return null;
      },
      placeAndDispatch: async (input: unknown) => {
        placeCalls.push(input);
        return { selectedAgentId: null, rejections: [], dispatched: false };
      },
      cancelJob: () => undefined,
    } as unknown as PlacementOrchestrator;
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "submitter-sub",
        role: "platform_admin",
        email: "stale-token@example.test",
      });
      c.set("principal" as never, {
        userId: "canonical-user-id",
        role: "platform_admin",
        email: "bound-submit@example.test",
        orgId: "canonical-org-id",
        orgIds: ["canonical-org-id"],
        memberships: [],
      });
      await next();
    });
    app.route(
      "/api",
      createJobRoutes(service, fakeDbWithoutUser(), orchestrator, {
        authz: fakeShadowAuthz(checks),
      }),
    );

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "unit-submit-mismatch",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-shadow" },
      }),
    });

    expect(res.status).toBe(201);
    expect(calls).toEqual(["submit:canonical-user-id"]);
    expect(submitOptions).toEqual([{ orgId: "canonical-org-id", trustedMaterialization: false }]);
    expect(checks).toEqual([
      {
        actorUserId: "canonical-user-id",
        actorEmail: "bound-submit@example.test",
        resource: { type: "queue", id: "queue-shadow" },
        permission: "submit",
        subject: { type: "user", id: "canonical-user-id" },
        context: { route: "POST /jobs" },
        localAllowed: true,
      },
    ]);
    expect(validateCalls).toEqual([
      expect.objectContaining({
        userId: "canonical-user-id",
        userRole: "platform_admin",
        orgId: "canonical-org-id",
      }),
    ]);
    expect(placeCalls).toEqual([
      expect.objectContaining({
        jobId: JOB_ID,
        userId: "canonical-user-id",
        userRole: "platform_admin",
        orgId: "canonical-org-id",
      }),
    ]);
  });

  test("job#view fails closed in enforce mode without canonical user id", async () => {
    const checks: AuthzCheck[] = [];
    const { service } = fakeJobService();
    const res = await makeApp(fakeEnforceAuthz(checks), service).request(`/api/jobs/${JOB_ID}`);

    expect(res.status).toBe(403);
    expect(checks).toEqual([]);
  });

  test("job#view in shadow mode denies non-owner and non-platform users", async () => {
    const checks: ShadowCheckInput[] = [];
    const { service } = fakeJobService();
    const res = await makeApp(
      fakeShadowAuthz(checks),
      service,
      "user",
      "not-the-owner",
      "user",
      "viewer-job-authz@test.local",
    ).request(`/api/jobs/${JOB_ID}`);

    expect(res.status).toBe(403);
    expect(checks).toEqual([
      {
        actorUserId: "not-the-owner",
        actorEmail: "viewer-job-authz@test.local",
        resource: { type: "job", id: JOB_ID },
        permission: "view",
        subject: { type: "user", id: "not-the-owner" },
        context: { route: "job#view" },
        localAllowed: false,
      },
    ]);
  });

  test("job#view in shadow mode allows job owner via local authz", async () => {
    const checks: ShadowCheckInput[] = [];
    const { service } = fakeJobService();
    const res = await makeApp(
      fakeShadowAuthz(checks),
      service,
      "user",
      "owner-user-id",
      "user",
      "owner-job-authz@test.local",
    ).request(`/api/jobs/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(checks).toEqual([
      {
        actorUserId: "owner-user-id",
        actorEmail: "owner-job-authz@test.local",
        resource: { type: "job", id: JOB_ID },
        permission: "view",
        subject: { type: "user", id: "owner-user-id" },
        context: { route: "job#view" },
        localAllowed: true,
      },
    ]);
  });

  test("job list in shadow mode pushes the A visibility union into pagination", async () => {
    const checks: ShadowCheckInput[] = [];
    const listOptions: unknown[] = [];
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async (options: unknown) => {
        listOptions.push(options);
        return {
          jobs: [
            {
              id: JOB_ID,
              name: "unit-job",
              command: "sleep 100",
              submittedBy: "not-the-owner",
              status: "running",
            },
          ],
          total: 1,
        };
      },
    } as unknown as JobService;
    const res = await makeApp(
      fakeShadowAuthz(checks),
      service,
      "user",
      "not-the-owner",
      "user",
      "viewer-job-authz2@test.local",
      fakeDbWithoutConfigRows(),
    ).request("/api/jobs");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: { id: string }[]; total: number };
    expect(body.jobs).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(listOptions).toEqual([
      expect.objectContaining({
        limit: 50,
        offset: 0,
        visibility: {
          userId: "not-the-owner",
          includeOwner: true,
          consumerAdminOrgIds: [],
          providerOrgIds: [],
        },
      }),
    ]);
    expect(checks).toEqual([
      {
        actorUserId: "not-the-owner",
        actorEmail: "viewer-job-authz2@test.local",
        resource: { type: "job", id: JOB_ID },
        permission: "view",
        subject: { type: "user", id: "not-the-owner" },
        context: { route: "job#view" },
        localAllowed: true,
      },
    ]);
  });

  test("job list in enforce mode paginates within LookupResources ids", async () => {
    const checks: AuthzCheck[] = [];
    const lookups: unknown[] = [];
    const listOptions: unknown[] = [];
    const authz = {
      ...fakeEnforceAuthz(checks),
      lookupResources: async (input: unknown) => {
        lookups.push(input);
        return [JOB_ID];
      },
    } as unknown as AuthzService;
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async (options: unknown) => {
        listOptions.push(options);
        return {
          jobs: [
            {
              id: JOB_ID,
              name: "unit-job",
              command: "sleep 100",
              submittedBy: "owner-user-id",
              status: "running",
            },
          ],
          total: 1,
        };
      },
    } as unknown as JobService;

    const res = await makeApp(
      authz,
      service,
      "user",
      "viewer-user-id",
      "user",
      "viewer-job-authz3@test.local",
      fakeDbWithoutConfigRows(),
    ).request("/api/jobs");

    expect(res.status).toBe(200);
    expect(lookups).toEqual([
      {
        resourceType: "job",
        permission: "view",
        subject: { type: "user", id: "viewer-user-id" },
      },
    ]);
    expect(listOptions).toEqual([expect.objectContaining({ ids: [JOB_ID], limit: 50, offset: 0 })]);
    expect(listOptions[0]).not.toHaveProperty("visibility");
    expect(await res.json()).toMatchObject({
      jobs: [{ id: JOB_ID, accessScope: "authorization_service" }],
      total: 1,
    });
    expect(checks).toHaveLength(1);
  });

  test("job list keeps an explicit owner scope narrower than delegated authorization", async () => {
    const listOptions: unknown[] = [];
    const authz = {
      ...fakeEnforceAuthz([]),
      lookupResources: async () => [JOB_ID],
    } as unknown as AuthzService;
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async (options: unknown) => {
        listOptions.push(options);
        return { jobs: [], total: 0 };
      },
    } as unknown as JobService;

    const response = await makeApp(
      authz,
      service,
      "user",
      "delegated-user-id",
      "user",
      "delegated-job-authz@test.local",
      fakeDbWithoutConfigRows(),
    ).request("/api/jobs?scope=owner");

    expect(response.status).toBe(200);
    expect(listOptions).toEqual([
      expect.objectContaining({
        ids: [JOB_ID],
        visibility: {
          userId: "delegated-user-id",
          includeOwner: true,
          consumerAdminOrgIds: [],
          providerOrgIds: [],
        },
      }),
    ]);
  });

  test("provider scope filter is pushed into pagination and returned on each row", async () => {
    const checks: ShadowCheckInput[] = [];
    const listOptions: unknown[] = [];
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async (options: unknown) => {
        listOptions.push(options);
        return {
          jobs: [
            {
              id: JOB_ID,
              name: "provider-job",
              command: "true",
              submittedBy: "owner-user-id",
              orgId: "consumer-org",
              providerOrgId: "provider-org",
              status: "running",
            },
          ],
          total: 1,
        };
      },
    } as unknown as JobService;
    const res = await makeApp(
      fakeShadowAuthz(checks),
      service,
      "user",
      "provider-operator-id",
      "user",
      "provider-operator@test.local",
      fakeDbWithoutConfigRows(),
      [{ orgId: "provider-org", role: "operator" }],
    ).request("/api/jobs?scope=provider_operator");

    expect(res.status).toBe(200);
    expect(listOptions).toEqual([
      expect.objectContaining({
        visibility: {
          userId: "provider-operator-id",
          includeOwner: false,
          consumerAdminOrgIds: [],
          providerOrgIds: ["provider-org"],
        },
      }),
    ]);
    expect(await res.json()).toMatchObject({
      jobs: [{ id: JOB_ID, accessScope: "provider_operator" }],
      total: 1,
    });
    expect(checks[0]?.localAllowed).toBe(true);
  });

  test("job list intersects an agent filter with delegated visibility in pagination", async () => {
    const listOptions: unknown[] = [];
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async (options: unknown) => {
        listOptions.push(options);
        return { jobs: [], total: 0 };
      },
    } as unknown as JobService;
    const response = await makeApp(
      undefined,
      service,
      "user",
      "provider-operator-id",
      "user",
      "provider-operator@test.local",
      fakeDbWithoutConfigRows(),
      [{ orgId: "provider-org", role: "operator" }],
    ).request("/api/jobs?scope=provider_operator&agentId=agent-visible");

    expect(response.status).toBe(200);
    expect(listOptions).toEqual([
      expect.objectContaining({
        agentId: "agent-visible",
        visibility: {
          userId: "provider-operator-id",
          includeOwner: false,
          consumerAdminOrgIds: [],
          providerOrgIds: ["provider-org"],
        },
      }),
    ]);
  });

  test("job list rejects an overlong agent filter before querying storage", async () => {
    const listCalls: string[] = [];
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async () => {
        listCalls.push("listPage");
        return { jobs: [], total: 0 };
      },
    } as unknown as JobService;
    const response = await makeApp(
      undefined,
      service,
      "user",
      "owner-user-id",
      "user",
      "owner-job-authz@test.local",
      fakeDbWithoutConfigRows(),
    ).request(`/api/jobs?agentId=${"a".repeat(256)}`);

    expect(response.status).toBe(400);
    expect(listCalls).toEqual([]);
  });

  test("job list fails before querying storage when enforce lookup is unavailable", async () => {
    const listCalls: string[] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        throw new Error("spicedb unavailable");
      },
    } as unknown as AuthzService;
    const service = {
      ...(fakeJobService().service as JobService),
      listPage: async () => {
        listCalls.push("listPage");
        return { jobs: [], total: 0 };
      },
    } as unknown as JobService;

    const res = await makeApp(
      authz,
      service,
      "platform_admin",
      "platform-user-id",
      "platform_admin",
    ).request("/api/jobs");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { message: "Authorization unavailable: spicedb unavailable" },
    });
    expect(listCalls).toEqual([]);
  });

  test("job#cancel fails closed in enforce mode without canonical user id", async () => {
    const checks: AuthzCheck[] = [];
    const { service, calls } = fakeJobService();
    const res = await makeApp(fakeEnforceAuthz(checks), service).request(
      `/api/jobs/${JOB_ID}/cancel`,
      {
        method: "POST",
      },
    );

    expect(res.status).toBe(403);
    expect(checks).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("job#cancel fails closed in shadow mode without canonical user id", async () => {
    const checks: ShadowCheckInput[] = [];
    const { service, calls } = fakeJobService();
    const res = await makeApp(fakeShadowAuthz(checks), service).request(
      `/api/jobs/${JOB_ID}/cancel`,
      {
        method: "POST",
      },
    );

    expect(res.status).toBe(403);
    expect(checks).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("job#cancel local mode does not trust JWT platform_admin without a bound principal", async () => {
    const { service, calls } = fakeJobService();
    const res = await makeApp(undefined, service, "platform_admin").request(
      `/api/jobs/${JOB_ID}/cancel`,
      {
        method: "POST",
      },
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("job#cancel forwards to the Agent only after its first successful transition", async () => {
    const dispatches: string[] = [];
    let transitions = 0;
    const service = {
      ...(fakeJobService().service as JobService),
      cancel: async () => {
        transitions += 1;
        if (transitions > 1) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Job is already in a terminal state", 409);
        }
        return { id: JOB_ID, status: "cancelled", agentId: "agent-1", revokedEpoch: 2 };
      },
    } as unknown as JobService;
    const orchestrator = {
      ...fakeOrchestrator(),
      cancelJob: async (agentId: string, jobId: string, revokedEpoch: number) => {
        dispatches.push(`${agentId}:${jobId}:${revokedEpoch}`);
      },
    } as unknown as PlacementOrchestrator;
    const app = makeApp(
      undefined,
      service,
      "user",
      "owner-user-id",
      "user",
      "owner-job-authz@test.local",
      fakeDbWithoutConfigRows(),
      [],
      orchestrator,
    );

    expect((await app.request(`/api/jobs/${JOB_ID}/cancel`, { method: "POST" })).status).toBe(200);
    const repeated = await app.request(`/api/jobs/${JOB_ID}/cancel`, { method: "POST" });

    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Job is already in a terminal state" },
    });
    expect(dispatches).toEqual([`agent-1:${JOB_ID}:2`]);
  });

  test("job#cancel succeeds when immediate delivery fails after the durable transition", async () => {
    const service = {
      ...(fakeJobService().service as JobService),
      cancel: async () => ({
        id: JOB_ID,
        status: "cancelled",
        agentId: "agent-1",
        revokedEpoch: 2,
      }),
    } as unknown as JobService;
    const orchestrator = {
      ...fakeOrchestrator(),
      cancelJob: async () => {
        throw new Error("Agent stream unavailable");
      },
    } as unknown as PlacementOrchestrator;
    const app = makeApp(
      undefined,
      service,
      "user",
      "owner-user-id",
      "user",
      "owner-job-authz@test.local",
      fakeDbWithoutConfigRows(),
      [],
      orchestrator,
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/cancel`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "cancelled", revokedEpoch: 2 });
  });

  test("subject helper does not use authenticated subject fallback in shadow or off mode", () => {
    expect(subjectIdForJobAuthz({ mode: "enforce" } as AuthzService, "user-uuid")).toBe(
      "user-uuid",
    );
    expect(subjectIdForJobAuthz({ mode: "shadow" } as AuthzService, null)).toBeNull();
    expect(subjectIdForJobAuthz({ mode: "off" } as AuthzService, null)).toBeNull();
    expect(subjectIdForJobAuthz(undefined, null)).toBeNull();
  });
});
