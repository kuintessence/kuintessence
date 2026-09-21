import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type PgDb,
  type SpackMaterialVisibilityPolicy,
  softwareOperations,
  spackMaterialOperationReferences,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import {
  ACTOR,
  AGENT,
  BINDING,
  BLOB,
  BLOB_BYTES,
  MANIFEST_BYTES,
  READER_ORG,
  SPEC,
  visibilityDatabase,
  visibilityDelivery,
} from "./spack-material-visibility.test-helpers";

type Fixture = Awaited<ReturnType<typeof visibilityDelivery>>;
const DENY_ALL: SpackMaterialVisibilityPolicy = {
  mode: "allowlist",
  userIds: [],
  orgIds: [],
};

// Actions supplies migrated PG. Missing tables must fail, never fall back to public or skip.
describe("Server material visibility (isolated real PG)", () => {
  const database = visibilityDatabase();
  let db: PgDb;
  let f: Fixture;

  beforeAll(async () => {
    db = await database.initialize();
  }, 30_000);
  beforeEach(async () => {
    await database.reset(db);
    f = await visibilityDelivery(db);
  }, 30_000);
  afterAll(async () => {
    await database.close();
  });

  async function prepare(status: "queued" | "running" = "queued") {
    const input = {
      operationId: randomUUID(),
      agentId: AGENT,
      requestedBy: ACTOR,
      spec: SPEC,
    };
    await db.insert(softwareOperations).values({
      id: input.operationId,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      spec: input.spec,
      action: "install",
      status,
    });
    return { ...input, ...(await f.delivery.prepareOperation(input)) };
  }

  function request(ticket: Awaited<ReturnType<typeof prepare>>, kind: "manifest" | "blob") {
    const suffix = kind === "manifest" ? "manifest" : `blobs/${encodeURIComponent(BLOB.digest)}`;
    return f.app.request(`/api/agent/spack/operations/${ticket.operationId}/${suffix}`, {
      headers: { Authorization: `Bearer ${ticket.spackMaterialTicket}` },
    });
  }

  async function expectDownloads(ticket: Awaited<ReturnType<typeof prepare>>) {
    const manifest = await request(ticket, "manifest");
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(MANIFEST_BYTES.toString());
    const blob = await request(ticket, "blob");
    expect(blob.status).toBe(200);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(BLOB_BYTES);
  }

  async function expectDenied(ticket: Awaited<ReturnType<typeof prepare>>, status = 503) {
    const calls = f.registryCalls.length;
    for (const kind of ["manifest", "blob"] as const) {
      const response = await request(ticket, kind);
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).not.toContain(MANIFEST_BYTES.toString());
      expect(body).not.toContain(BLOB_BYTES.toString());
      expect(body).not.toContain(ACTOR);
      expect(body).not.toContain("spack_material_visibility_events");
    }
    expect(f.registryCalls).toHaveLength(calls);
  }

  test("inherit permits repeated manifest/blob reads with one durable operation reference", async () => {
    const ticket = await prepare();
    await expectDownloads(ticket);
    await expectDownloads(ticket);
    const references = await db.select().from(spackMaterialOperationReferences);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      ...BINDING,
      operationId: ticket.operationId,
      requestedBy: ACTOR,
    });
  });

  test.each([
    "queued",
    "running",
  ] as const)("tightening revokes the same %s ticket for both routes, including an existing reference", async (status) => {
    const ticket = await prepare(status);
    await expectDownloads(ticket);
    const references = await db.select().from(spackMaterialOperationReferences);
    await f.changePolicy({
      policy: DENY_ALL,
      expectedRevision: 0,
      reason: "Restrict an active installation",
    });
    // Operation/CP/certificate access still permits this requester. Only visibility changed.
    expect(await f.access.operation(ticket.operationId)).not.toBeNull();
    await expectDenied(ticket);
    await expectDenied(ticket);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(references);
    const [operation] = await db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.id, ticket.operationId));
    expect(operation?.status).toBe(status);

    await f.changePolicy({
      policy: { mode: "inherit" },
      expectedRevision: 1,
      reason: "Restore access after review",
    });
    await expectDownloads(ticket);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(references);
  });

  test("user allowlist admits preparation and is read again on old-ticket requests", async () => {
    await f.changePolicy({
      policy: { mode: "allowlist", userIds: [ACTOR], orgIds: [] },
      expectedRevision: 0,
      reason: "Allow the installing user",
    });
    const ticket = await prepare();
    await expectDownloads(ticket);
    await f.changePolicy({
      policy: { mode: "allowlist", userIds: [randomUUID()], orgIds: [] },
      expectedRevision: 1,
      reason: "Remove the installing user",
    });
    await expectDenied(ticket);
  });

  test("org allowlist uses live membership independently of retained provider authorization", async () => {
    await f.changePolicy({
      policy: { mode: "allowlist", userIds: [], orgIds: [READER_ORG] },
      expectedRevision: 0,
      reason: "Allow the material reader organization",
    });
    const ticket = await prepare();
    await expectDownloads(ticket);
    await db
      .delete(userOrgMemberships)
      .where(and(eq(userOrgMemberships.userId, ACTOR), eq(userOrgMemberships.orgId, READER_ORG)));
    expect(await f.access.operation(ticket.operationId)).not.toBeNull();
    await expectDenied(ticket);
    await db.insert(userOrgMemberships).values({
      userId: ACTOR,
      orgId: READER_ORG,
      role: "member",
    });
    await expectDownloads(ticket);
  });

  test("a tightened policy on the ticket binding cannot be bypassed by a replacement config", async () => {
    const ticket = await prepare();
    await f.changePolicy({
      policy: DENY_ALL,
      expectedRevision: 0,
      reason: "Revoke the original release",
    });
    f.bindings[SPEC] = { ...BINDING, manifestDigest: `sha256:${"e".repeat(64)}` };
    await expectDenied(ticket);
    const [reference] = await db.select().from(spackMaterialOperationReferences);
    expect(reference).toMatchObject(BINDING);
  });

  test("a denied preparation persists rejection and cannot dispatch an install", async () => {
    await f.changePolicy({
      policy: DENY_ALL,
      expectedRevision: 0,
      reason: "Deny new installations",
    });
    const rejected = await f.requestInstall();
    expect(rejected.status).toBe("rejected");
    expect(rejected.error).toContain("reference registry is unavailable");
    expect(f.pushed).toHaveLength(0);
    expect(await db.select().from(spackMaterialOperationReferences)).toHaveLength(0);
    const [persisted] = await db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.id, rejected.id));
    expect(persisted?.status).toBe("rejected");

    await f.changePolicy({
      policy: { mode: "inherit" },
      expectedRevision: 1,
      reason: "Allow installations after review",
    });
    const allowed = await f.requestInstall();
    expect(allowed.status).toBe("queued");
    expect(f.pushed).toHaveLength(1);
    const message = f.pushed[0];
    expect(message?.payload.case).toBe("softwareOperationRequest");
    if (message?.payload.case !== "softwareOperationRequest") throw new Error("Missing dispatch");
    expect(message.payload.value.operationId).toBe(allowed.id);
    expect(message.payload.value.spackMaterialTicket).toBeTruthy();
    expect(message.payload.value.spackManifestDigest).toBe(BINDING.manifestDigest);
    await expectDownloads({
      operationId: allowed.id,
      agentId: AGENT,
      requestedBy: ACTOR,
      spec: SPEC,
      spackMaterialTicket: message.payload.value.spackMaterialTicket,
      spackManifestDigest: message.payload.value.spackManifestDigest,
    });
  });

  test.each([
    "visibility",
    "suspension",
  ] as const)("preparation rechecks %s after the Registry read before issuing a ticket", async (change) => {
    f.afterManifest(async () => {
      if (change === "visibility") {
        await f.changePolicy({
          policy: DENY_ALL,
          expectedRevision: 0,
          reason: "Tighten policy while preparation is reading the manifest",
        });
      } else {
        await db.update(users).set({ suspended: true }).where(eq(users.id, ACTOR));
      }
    });
    await expect(prepare()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.registryCalls).toHaveLength(1);
    expect(await db.select().from(spackMaterialOperationReferences)).toHaveLength(0);
  });

  test("suspending a canonical requester revokes both old-ticket routes", async () => {
    const ticket = await prepare();
    await expectDownloads(ticket);
    await db.update(users).set({ suspended: true }).where(eq(users.id, ACTOR));
    await expectDenied(ticket, 403);
  });
});
