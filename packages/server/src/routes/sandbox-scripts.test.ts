import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  auditLog,
  createPgDb,
  orgs,
  type PgDb,
  sandboxRuntimeProfiles,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
  users,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createSandboxScriptRoutes, type SandboxScriptRoutesDeps } from "./sandbox-scripts";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const USER_ID = "71d6e8e0-4517-4f2f-9a9d-a1eab07a0011";
const OTHER_USER_ID = "71d6e8e0-4517-4f2f-9a9d-a1eab07a0022";
const RUNTIME_ID = "71d6e8e0-4517-4f2f-9a9d-a1eab07a0033";
const ORG_ID = "71d6e8e0-4517-4f2f-9a9d-a1eab07a0044";
const RUN_ID = "71d6e8e0-4517-4f2f-9a9d-a1eab07a0055";
const NAME_PREFIX = "sandbox-route-test-";

function makeApp(
  db: PgDb,
  userId = USER_ID,
  authz?: AuthzService,
  submitTestRun?: SandboxScriptRoutesDeps["submitTestRun"],
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: userId,
      role: "user",
      email: `${userId}@example.test`,
      userId,
      orgId: ORG_ID,
      orgIds: [ORG_ID],
      memberships: [],
    });
    await next();
  });
  app.route("/api", createSandboxScriptRoutes({ db, authz, submitTestRun }));
  return app;
}

function scriptBody(name: string) {
  return {
    name,
    version: "0.1.0",
    language: "python",
    runtimeProfileId: RUNTIME_ID,
    entrypoint: "main.py",
    content: "print('ok')",
    inputs: {},
    outputs: {},
  };
}

async function cleanup(db: PgDb) {
  await db.delete(auditLog).where(like(auditLog.action, "sandbox.script.%"));
  await db.delete(softwareAssets).where(like(softwareAssets.name, `${NAME_PREFIX}%`));
}

describe("sandbox script routes", () => {
  let db: PgDb;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await cleanup(db);
    await db
      .insert(orgs)
      .values({ id: ORG_ID, name: "Sandbox route test organization" })
      .onConflictDoNothing();
    await db
      .insert(users)
      .values([
        { id: USER_ID, email: `${USER_ID}@example.test`, role: "user" },
        { id: OTHER_USER_ID, email: `${OTHER_USER_ID}@example.test`, role: "user" },
      ])
      .onConflictDoNothing();
    await db
      .insert(sandboxRuntimeProfiles)
      .values({
        id: RUNTIME_ID,
        name: "Sandbox route test Python",
        language: "python",
        languageVersion: "3.12",
        ociDigest: `sha256:${"c".repeat(64)}`,
        signature: "sandbox-route-test-signature",
        dependencies: [],
        documentation: {},
        adapters: ["slurm"],
        securityRequirements: {
          networkDisabled: true,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          seccompRequired: true,
          signatureVerificationRequired: true,
        },
        lifecycle: "active",
      })
      .onConflictDoUpdate({
        target: sandboxRuntimeProfiles.id,
        set: { lifecycle: "active" },
      });
  });

  beforeEach(async () => cleanup(db));

  afterAll(async () => {
    await cleanup(db);
    await db.delete(sandboxRuntimeProfiles).where(eq(sandboxRuntimeProfiles.id, RUNTIME_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(users).where(eq(users.id, OTHER_USER_ID));
    await db.delete(orgs).where(eq(orgs.id, ORG_ID));
  });

  test("revision atomically persists the edited asset name and version", async () => {
    const app = makeApp(db);
    const createResponse = await app.request("/api/sandbox/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptBody(`${NAME_PREFIX}original`)),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { data: { asset: { id: string } } };

    const revisionResponse = await app.request(
      `/api/sandbox/scripts/${created.data.asset.id}/revisions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...scriptBody(`${NAME_PREFIX}renamed`),
          version: "0.2.0",
          changelog: "rename",
        }),
      },
    );
    expect(revisionResponse.status).toBe(201);

    const detailResponse = await app.request(`/api/sandbox/scripts/${created.data.asset.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      data: { asset: { name: string; version: string }; revisions: unknown[] };
    };
    expect(detail.data.asset.name).toBe(`${NAME_PREFIX}renamed`);
    expect(detail.data.asset.version).toBe("0.2.0");
    expect(detail.data.revisions).toHaveLength(2);
  });

  test("owner can read a newly created script while its Authz relationship is pending", async () => {
    let permissionChecks = 0;
    const authz = {
      mode: "enforce",
      enqueueMany: async () => {},
      hasPendingRelationship: async () => true,
      requirePermission: async () => {
        permissionChecks += 1;
        throw new Error("SpiceDB relationship is not visible yet");
      },
    } as unknown as AuthzService;
    const app = makeApp(db, USER_ID, authz);
    const createResponse = await app.request("/api/sandbox/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptBody(`${NAME_PREFIX}read-after-write`)),
    });
    const created = (await createResponse.json()) as { data: { asset: { id: string } } };

    const detailResponse = await app.request(`/api/sandbox/scripts/${created.data.asset.id}`);

    expect(detailResponse.status).toBe(200);
    expect(permissionChecks).toBe(0);
  });

  test("test run synchronously registers workflow authorization in enforce mode", async () => {
    const writes: unknown[][] = [];
    const enqueues: unknown[][] = [];
    const authz = {
      mode: "enforce",
      hasPendingRelationship: async () => true,
      writeRelationships: async (tuples: unknown[]) => writes.push(tuples),
      enqueueMany: async (tuples: unknown[]) => enqueues.push(tuples),
    } as unknown as AuthzService;
    const app = makeApp(db, USER_ID, authz, async (input) => {
      await input.authorizeRun(RUN_ID);
      return { runId: RUN_ID };
    });
    const createResponse = await app.request("/api/sandbox/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptBody(`${NAME_PREFIX}test-run-authz`)),
    });
    const created = (await createResponse.json()) as { data: { asset: { id: string } } };

    const response = await app.request(`/api/sandbox/scripts/${created.data.asset.id}/test-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: {} }),
    });

    expect(response.status).toBe(202);
    const workflowWrites = writes.at(-1) as Array<{
      relation: string;
      resource: { id: string };
      subject: { id: string };
    }>;
    expect(workflowWrites).toEqual([
      expect.objectContaining({
        relation: "owner",
        resource: { type: "workflow", id: RUN_ID },
        subject: { type: "user", id: USER_ID },
      }),
      expect.objectContaining({
        relation: "platform",
        resource: { type: "workflow", id: RUN_ID },
        subject: { type: "platform", id: "root" },
      }),
      expect.objectContaining({
        relation: "consumer_org",
        resource: { type: "workflow", id: RUN_ID },
        subject: { type: "organization", id: ORG_ID },
      }),
    ]);
    expect(enqueues.at(-1)).toEqual(workflowWrites);
  });

  test("draft deletion is owner-only, cascades revisions and grants, and removes authz tuples", async () => {
    const enqueued: Array<Array<{ operation: string }>> = [];
    const authz = {
      mode: "off",
      enqueueMany: async (tuples: Array<{ operation: string }>) => enqueued.push(tuples),
    } as unknown as AuthzService;
    const ownerApp = makeApp(db, USER_ID, authz);
    const createResponse = await ownerApp.request("/api/sandbox/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptBody(`${NAME_PREFIX}delete`)),
    });
    const created = (await createResponse.json()) as { data: { asset: { id: string } } };
    const assetId = created.data.asset.id;

    const denied = await makeApp(db, OTHER_USER_ID).request(`/api/sandbox/scripts/${assetId}`, {
      method: "DELETE",
    });
    expect(denied.status).toBe(403);

    const deleted = await ownerApp.request(`/api/sandbox/scripts/${assetId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(
      enqueued.some(
        (batch) => batch.length > 0 && batch.every((tuple) => tuple.operation === "delete"),
      ),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(softwareAssetRevisions)
        .where(eq(softwareAssetRevisions.assetId, assetId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(softwareAssetGrants).where(eq(softwareAssetGrants.assetId, assetId)),
    ).toHaveLength(0);
  });

  test("published scripts cannot be hard deleted", async () => {
    const app = makeApp(db);
    const createResponse = await app.request("/api/sandbox/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptBody(`${NAME_PREFIX}published`)),
    });
    const created = (await createResponse.json()) as { data: { asset: { id: string } } };
    await db
      .update(softwareAssets)
      .set({ lifecycle: "published" })
      .where(eq(softwareAssets.id, created.data.asset.id));

    const response = await app.request(`/api/sandbox/scripts/${created.data.asset.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
  });
});
