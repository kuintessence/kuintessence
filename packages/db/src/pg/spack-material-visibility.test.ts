import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "./index";
import { agents, softwareOperations, userOrgMemberships, users } from "./schema";
import {
  spackMaterialLifecycleEvents,
  spackMaterialOperationReferences,
  spackMaterialVisibilityEvents,
} from "./schema-spack-materials";
import { SpackMaterialLifecycle } from "./spack-material-lifecycle";
import { SpackMaterialReferences } from "./spack-material-references";
import { SpackMaterialRollout } from "./spack-material-rollout";
import {
  SpackMaterialVisibility,
  type SpackMaterialVisibilityChange,
  SpackMaterialVisibilityError,
  type SpackMaterialVisibilityPolicy,
} from "./spack-material-visibility";

const SCHEMA = `spack_visibility_${randomUUID().replaceAll("-", "")}`;
const TABLES = [
  "users",
  "user_org_memberships",
  "agents",
  "software_operations",
  "spack_material_bindings",
  "spack_material_operation_references",
  "spack_material_rollouts",
  "spack_material_binding_retirements",
  "spack_material_lifecycle_events",
  "spack_material_visibility_events",
];
const OPERATOR = randomUUID();
const READER = randomUUID();
const OUTSIDER = randomUUID();
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const AGENT = `visibility-${randomUUID()}`;
const SPEC = "hello@2.12.1";
const EVIDENCE = {
  legacyProcessesStoppedAndDrained: true,
  legacyAccessRevoked: true,
  legacyInventoryComplete: true,
} as const;
const UNAVAILABLE = { code: "MATERIAL_VISIBILITY_UNAVAILABLE", status: 503 };
const FORBIDDEN = { code: "MATERIAL_VISIBILITY_FORBIDDEN", status: 403 };
const CONFLICT = { code: "MATERIAL_VISIBILITY_CONFLICT", status: 409 };
const INVALID = { code: "MATERIAL_VISIBILITY_INVALID", status: 422 };
const DENIED = { code: "MATERIAL_VISIBILITY_DENIED", status: 404 };
const REFERENCE_ERROR = { code: "SPACK_MATERIAL_REFERENCE_ERROR" };
const PRIVATE = "private visibility fixture SQL/token diagnostic";
type Authorize = Parameters<SpackMaterialVisibility["inspect"]>[2];
type Principal = Parameters<Authorize>[0];
const allow: Authorize = async () => {};

function release() {
  return {
    repositoryId: randomBytes(32).toString("hex"),
    manifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
  };
}

function allowlist(userIds: string[] = [], orgIds: string[] = []): SpackMaterialVisibilityPolicy {
  return { mode: "allowlist", userIds, orgIds };
}

function change(
  policy: SpackMaterialVisibilityPolicy = allowlist(),
  expectedRevision = 0,
): SpackMaterialVisibilityChange {
  return { policy, expectedRevision, reason: "Operator updated material admission" };
}

async function expectError(work: Promise<unknown>, expected: { code: string; status?: number }) {
  const failure = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject(expected);
  if (failure instanceof Error) {
    expect(failure.cause).toBeUndefined();
    expect(failure.message).not.toContain(PRIVATE);
    expect(failure.message).not.toContain(SCHEMA);
    expect(failure.message).not.toContain("select ");
    expect(JSON.stringify(failure)).not.toContain(PRIVATE);
  }
}

async function waitForLock(
  observer: PgDb,
  waiter: number,
  holder: number,
  kind: "transactionid" | "advisory",
  completed: () => boolean,
) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (completed()) throw new Error("Operation completed before the lock was released");
    const [row] = await observer.$client<{ blocked: boolean }[]>`
      select ${holder} = any(pg_blocking_pids(${waiter}))
        and exists (
          select 1 from pg_locks
          where pid = ${waiter} and locktype = ${kind} and not granted
        ) as blocked
    `;
    if (row?.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error(`Expected a real PostgreSQL ${kind} lock wait`);
}

// Requires public tables migrated by GitHub first; never migrate, mock PG, or skip here.
describe("Spack material visibility (isolated real PG)", () => {
  let admin: PgDb;
  let db: PgDb;
  let peerDb: PgDb;
  let rollout: SpackMaterialRollout;
  let created = false;
  const connections: PgDb[] = [];

  function connect(schema: string) {
    const url = new URL(
      process.env.KQ_PG_URL ??
        process.env.DATABASE_URL ??
        "postgres://kq:kq@localhost:5432/kuintessence",
    );
    url.searchParams.set("search_path", schema);
    url.searchParams.set("statement_timeout", "10000");
    const connection = createPgDb(url.toString(), { max: 1, idle_timeout: 0 });
    connections.push(connection);
    return connection;
  }

  async function ready(expectedRevision = 0, policy = true) {
    let state = await rollout.execute({ action: "pause", operatorId: OPERATOR, expectedRevision });
    state = await rollout.execute({
      action: "reconcile",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      bindings: [],
    });
    state = await rollout.execute({
      action: policy ? "activate-policy" : "activate",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      inventoryDigest: state.inventoryDigest,
      evidence: EVIDENCE,
    });
    if (!state.epoch) throw new Error("Expected a ready epoch");
    return {
      state,
      epoch: state.epoch,
      visibility: new SpackMaterialVisibility(db, state.epoch),
      peer: new SpackMaterialVisibility(peerDb, state.epoch),
      lifecycle: new SpackMaterialLifecycle(db, state.epoch),
      references: new SpackMaterialReferences(db, state.epoch),
      peerReferences: new SpackMaterialReferences(peerDb, state.epoch),
    };
  }

  async function operation(binding: ReturnType<typeof release>) {
    const input = {
      operationId: randomUUID(),
      agentId: AGENT,
      requestedBy: READER,
      spec: SPEC,
      ...binding,
    };
    await db.insert(softwareOperations).values({
      id: input.operationId,
      agentId: AGENT,
      requestedBy: READER,
      spec: SPEC,
      action: "install",
      status: "queued",
    });
    return input;
  }

  async function backendPids() {
    const [holder] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [waiter] = await peerDb.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (!holder || !waiter) throw new Error("Expected independent backend PIDs");
    expect(holder.pid).not.toBe(waiter.pid);
    return { holder: holder.pid, waiter: waiter.pid };
  }

  beforeAll(async () => {
    admin = connect("public");
    await admin.execute(sql`create schema ${sql.identifier(SCHEMA)}`);
    created = true;
    for (const table of TABLES) {
      await admin.execute(sql`
        create table ${sql.identifier(SCHEMA)}.${sql.identifier(table)}
        (like public.${sql.identifier(table)} including all)
      `);
    }
    db = connect(SCHEMA);
    peerDb = connect(SCHEMA);
    rollout = new SpackMaterialRollout(db);
  }, 30_000);

  beforeEach(async () => {
    for (const table of [...TABLES].reverse()) {
      await db.execute(sql`truncate table ${sql.identifier(SCHEMA)}.${sql.identifier(table)}`);
    }
    await db.insert(users).values(
      [OPERATOR, READER, OUTSIDER].map((id) => ({
        id,
        role: id === OPERATOR ? "platform_admin" : "user",
        email: `${id}@example.invalid`,
      })),
    );
    await db.insert(agents).values({
      agentId: AGENT,
      siteName: "visibility-test",
      schedulerType: "slurm",
      schedulerVersion: "test",
    });
  });

  afterAll(async () => {
    try {
      if (created) await admin.execute(sql`drop schema ${sql.identifier(SCHEMA)} cascade`);
    } finally {
      await Promise.all(connections.map((connection) => connection.$client.end()));
    }
  });

  test("inherits by default and intersects live authorization with release availability", async () => {
    const binding = release();
    const { visibility, lifecycle } = await ready();
    expect(await visibility.inspect(binding, OPERATOR, allow)).toEqual({
      revision: 0,
      policy: { mode: "inherit" },
      history: [],
      historyTruncated: false,
    });
    const seen: Principal[] = [];
    const authorize: Authorize = async (principal) => {
      seen.push(principal);
    };
    await visibility.assertReadable(binding, READER, authorize);
    expect(seen).toEqual([{ sub: READER, role: "user", orgIds: [] }]);
    await expectError(
      visibility.assertReadable(binding, READER, async () => {
        throw new Error(PRIVATE);
      }),
      DENIED,
    );
    await lifecycle.transition(
      binding,
      OPERATOR,
      { action: "withdraw", expectedRevision: 0, reason: "Unavailable material" },
      allow,
    );
    await expectError(visibility.assertReadable(binding, READER, authorize), DENIED);
    expect(seen).toHaveLength(1);
    await lifecycle.transition(
      binding,
      OPERATOR,
      { action: "restore", expectedRevision: 1, reason: "Material restored" },
      allow,
    );
    await visibility.assertReadable(binding, READER, authorize);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
  });

  test.each(["user", "organization"] as const)(
    "%s allowlisting never broadens the external callback ACL",
    async (mode) => {
      const binding = release();
      const { visibility } = await ready();
      await db.insert(userOrgMemberships).values({ userId: READER, orgId: ORG, role: "member" });
      const policy = mode === "user" ? allowlist([READER]) : allowlist([], [ORG]);
      await visibility.transition(binding, OPERATOR, change(policy), allow);
      await visibility.assertReadable(binding, READER, allow);
      await expectError(visibility.assertReadable(binding, OUTSIDER, allow), DENIED);
      const seen: Principal[] = [];
      await expectError(
        visibility.assertReadable(binding, READER, async (principal) => {
          seen.push(principal);
          throw new Error(PRIVATE);
        }),
        DENIED,
      );
      expect(seen).toEqual([{ sub: READER, role: "user", orgIds: [ORG] }]);
      await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, READER));
      if (mode === "organization") {
        await expectError(visibility.assertReadable(binding, READER, allow), DENIED);
      } else {
        await visibility.assertReadable(binding, READER, allow);
      }
      await db.update(users).set({ suspended: true }).where(eq(users.id, READER));
      await expectError(visibility.assertReadable(binding, READER, allow), DENIED);
    },
  );

  test("combines users and organizations as a union inside the external ACL intersection", async () => {
    const binding = release();
    const { visibility } = await ready();
    await db.insert(userOrgMemberships).values({ userId: OUTSIDER, orgId: ORG, role: "viewer" });
    await visibility.transition(binding, OPERATOR, change(allowlist([READER], [ORG])), allow);
    await visibility.assertReadable(binding, READER, allow);
    await visibility.assertReadable(binding, OUTSIDER, allow);
    await expectError(visibility.assertReadable(binding, OPERATOR, allow), DENIED);
  });

  test("empty allowlists deny super_admin too, while managers can inspect and restore", async () => {
    const binding = release();
    const { visibility } = await ready();
    await db.update(users).set({ role: "super_admin" }).where(eq(users.id, OPERATOR));
    await visibility.transition(binding, OPERATOR, change(), allow);
    for (const subject of [READER, OUTSIDER, OPERATOR]) {
      await expectError(visibility.assertReadable(binding, subject, allow), DENIED);
    }
    expect(await visibility.inspect(binding, OPERATOR, allow)).toMatchObject({ revision: 1 });
    await visibility.transition(binding, OPERATOR, change({ mode: "inherit" }, 1), allow);
    await visibility.assertReadable(binding, OPERATOR, allow);
  });

  test.each(["read", "write"] as const)(
    "management requires the supplied %s permission even for allowlisted users",
    async (missing) => {
      const binding = release();
      const { visibility } = await ready();
      await visibility.transition(binding, OPERATOR, change(allowlist([READER])), allow);
      const checked: string[] = [];
      const seen: Principal[] = [];
      const manage: Authorize = async (principal) => {
        seen.push(principal);
        for (const permission of ["read", "write"]) {
          checked.push(permission);
          if (permission === missing) throw new Error(PRIVATE);
        }
      };
      await expectError(visibility.inspect(binding, READER, manage), FORBIDDEN);
      await expectError(
        visibility.transition(binding, READER, change({ mode: "inherit" }, 1), manage),
        FORBIDDEN,
      );
      expect(checked).toEqual(
        missing === "read" ? ["read", "read"] : ["read", "write", "read", "write"],
      );
      expect(seen).toEqual([
        { sub: READER, role: "user", orgIds: [] },
        { sub: READER, role: "user", orgIds: [] },
      ]);
      expect(await db.select().from(spackMaterialVisibilityEvents)).toHaveLength(1);
    },
  );

  test("ordinary users can manage when the callback grants both read and write", async () => {
    const binding = release();
    const { visibility } = await ready();
    const checked: string[] = [];
    const manage: Authorize = async (principal) => {
      expect(principal).toEqual({ sub: READER, role: "user", orgIds: [] });
      for (const permission of ["read", "write"]) {
        checked.push(permission);
        if (principal.sub !== READER) throw new Error(PRIVATE);
      }
    };
    const revoked = await visibility.transition(binding, READER, change(), manage);
    expect(revoked.history[0]?.operatorId).toBe(READER);
    await expectError(visibility.assertReadable(binding, READER, allow), DENIED);
    expect(await visibility.inspect(binding, READER, manage)).toEqual(revoked);
    expect(checked).toEqual(["read", "write", "read", "write"]);
  });

  test("canonical roles and memberships override stale role, legacy orgId and other users", async () => {
    const binding = release();
    const { visibility } = await ready();
    await db.update(users).set({ role: "super_admin", orgId: ORG }).where(eq(users.id, READER));
    await db.insert(userOrgMemberships).values([
      { userId: READER, orgId: OTHER_ORG, role: "owner" },
      { userId: OUTSIDER, orgId: ORG, role: "admin" },
    ]);
    await visibility.transition(binding, OPERATOR, change(allowlist([], [ORG])), allow);
    await db.update(users).set({ role: "user" }).where(eq(users.id, READER));
    const seen: Principal[] = [];
    await expectError(
      visibility.assertReadable(binding, READER, async (principal) => {
        seen.push(principal);
      }),
      DENIED,
    );
    expect(seen).toEqual([{ sub: READER, role: "user", orgIds: [OTHER_ORG] }]);
    const requireAdmin: Authorize = async (principal) => {
      expect(principal.role).toBe("user");
      if (principal.role !== "super_admin") throw new Error(PRIVATE);
    };
    await expectError(visibility.inspect(binding, READER, requireAdmin), FORBIDDEN);
    await expectError(visibility.transition(binding, READER, change(), requireAdmin), FORBIDDEN);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toHaveLength(1);
  });

  test.each(["missing", "suspended", "malformed"] as const)(
    "rejects %s canonical identities before invoking callbacks",
    async (mode) => {
      const binding = release();
      const { visibility } = await ready();
      const subject = mode === "missing" ? randomUUID() : mode === "malformed" ? "fake" : READER;
      if (mode === "suspended") {
        await db.update(users).set({ suspended: true }).where(eq(users.id, READER));
      }
      let calls = 0;
      const authorize: Authorize = async () => {
        calls++;
      };
      await expectError(visibility.assertReadable(binding, subject, authorize), DENIED);
      await expectError(visibility.inspect(binding, subject, authorize), FORBIDDEN);
      await expectError(visibility.transition(binding, subject, change(), authorize), FORBIDDEN);
      expect(calls).toBe(0);
      expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
    },
  );

  test.each(["observe", "legacy-ready", "missing epoch", "wrong epoch", "paused"] as const)(
    "management is fenced outside matching policy-ready (%s)",
    async (mode) => {
      const binding = release();
      let visibility = new SpackMaterialVisibility(db);
      if (mode !== "observe") {
        const fixture = await ready(0, mode !== "legacy-ready");
        visibility = new SpackMaterialVisibility(
          db,
          mode === "missing epoch" ? undefined : mode === "wrong epoch" ? randomUUID() : fixture.epoch,
        );
        if (mode === "paused") {
          await rollout.execute({
            action: "pause",
            operatorId: OPERATOR,
            expectedRevision: fixture.state.revision,
          });
        }
      }
      let calls = 0;
      const authorize: Authorize = async () => {
        calls++;
      };
      await expectError(visibility.inspect(binding, OPERATOR, authorize), UNAVAILABLE);
      await expectError(visibility.transition(binding, OPERATOR, change(), authorize), UNAVAILABLE);
      expect(calls).toBe(0);
      if (mode === "observe" || mode === "legacy-ready") {
        await visibility.assertReadable(binding, READER, allow);
      } else {
        await expectError(visibility.assertReadable(binding, READER, allow), UNAVAILABLE);
      }
      expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
    },
  );

  test("revoke and restore append durable audit with independent lifecycle and pair revisions", async () => {
    const binding = release();
    const { visibility, peer, lifecycle, epoch, state } = await ready();
    const revoked = await visibility.transition(binding, OPERATOR, change(), allow);
    const journal = await db.select().from(spackMaterialVisibilityEvents);
    const createdAt = journal[0]?.createdAt.toISOString();
    expect(Number.isFinite(Date.parse(createdAt ?? ""))).toBe(true);
    expect(revoked).toEqual({
      revision: 1,
      policy: allowlist(),
      historyTruncated: false,
      history: [
        {
          revision: 1,
          policy: allowlist(),
          operatorId: OPERATOR,
          reason: change().reason,
          epoch,
          rolloutRevision: state.revision,
          createdAt,
        },
      ],
    });
    await expectError(peer.assertReadable(binding, READER, allow), DENIED);
    for (const other of [
      { ...binding, manifestDigest: release().manifestDigest },
      { ...release(), manifestDigest: binding.manifestDigest },
    ]) {
      expect(await peer.inspect(other, OPERATOR, allow)).toMatchObject({ revision: 0 });
      await peer.assertReadable(other, READER, allow);
    }
    const withdrawn = await lifecycle.transition(
      binding,
      OPERATOR,
      { action: "withdraw", expectedRevision: 0, reason: "Independent lifecycle revision" },
      allow,
    );
    expect(withdrawn.revision).toBe(1);
    const lifecycleJournal = await db.select().from(spackMaterialLifecycleEvents);
    const restored = await peer.transition(binding, OPERATOR, change({ mode: "inherit" }, 1), allow);
    expect(restored).toMatchObject({ revision: 2, policy: { mode: "inherit" } });
    expect(restored.history).toHaveLength(2);
    expect(restored.history[1]).toEqual(revoked.history[0]);
    expect(restored.history[0]).toMatchObject({
      revision: 2,
      operatorId: OPERATOR,
      reason: change().reason,
      epoch,
      rolloutRevision: state.revision,
    });
    expect(await visibility.inspect(binding, OPERATOR, allow)).toEqual(restored);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual(
      expect.arrayContaining(journal),
    );
    expect(await db.select().from(spackMaterialVisibilityEvents)).toHaveLength(2);
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual(lifecycleJournal);
    await expectError(peer.assertReadable(binding, READER, allow), DENIED);
    await lifecycle.transition(
      binding,
      OPERATOR,
      { action: "restore", expectedRevision: 1, reason: "Release restored independently" },
      allow,
    );
    await peer.assertReadable(binding, READER, allow);
    expect(await peer.inspect(binding, OPERATOR, allow)).toEqual(restored);
  });

  test("policy and audit survive epoch rotation while old readers and managers are fenced", async () => {
    const binding = release();
    const previous = await ready();
    const revoked = await previous.visibility.transition(binding, OPERATOR, change(), allow);
    const current = await ready(previous.state.revision);
    expect(current.epoch).not.toBe(previous.epoch);
    expect(await current.peer.inspect(binding, OPERATOR, allow)).toEqual(revoked);
    await expectError(current.peer.assertReadable(binding, READER, allow), DENIED);
    await expectError(previous.visibility.assertReadable(binding, READER, allow), UNAVAILABLE);
    await expectError(previous.visibility.inspect(binding, OPERATOR, allow), UNAVAILABLE);
    await expectError(
      previous.visibility.transition(binding, OPERATOR, change({ mode: "inherit" }, 1), allow),
      UNAVAILABLE,
    );
    const restored = await current.peer.transition(
      binding,
      OPERATOR,
      change({ mode: "inherit" }, 1),
      allow,
    );
    expect(restored.history[0]).toMatchObject({
      revision: 2,
      epoch: current.epoch,
      rolloutRevision: current.state.revision,
    });
    expect(restored.history[1]).toEqual(revoked.history[0]);
  });

  test("CAS serializes independent writers and canonical no-ops never append", async () => {
    const binding = release();
    const { visibility, peer } = await ready();
    await expectError(
      visibility.transition(binding, OPERATOR, change({ mode: "inherit" }), allow),
      CONFLICT,
    );
    const input = change(allowlist([READER, OUTSIDER], [ORG, OTHER_ORG]));
    const { holder, waiter } = await backendPids();
    const entered = Promise.withResolvers<void>();
    const releaseAuthorization = Promise.withResolvers<void>();
    const first = visibility.transition(binding, OPERATOR, input, async () => {
      entered.resolve();
      await releaseAuthorization.promise;
    });
    const firstResult = Promise.allSettled([first]);
    let completed = false;
    let secondResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("First writer did not wait for authorization");
        }),
      ]);
      secondResult = Promise.allSettled([
        peer.transition(binding, OPERATOR, change(), allow),
      ]).then((results) => {
        completed = true;
        return results;
      });
      await waitForLock(admin, waiter, holder, "advisory", () => completed);
    } finally {
      releaseAuthorization.resolve();
      await Promise.all([firstResult, secondResult]);
    }
    expect(await firstResult).toMatchObject([{ status: "fulfilled", value: { revision: 1 } }]);
    expect(await secondResult).toMatchObject([{ status: "rejected", reason: CONFLICT }]);
    const journal = await db.select().from(spackMaterialVisibilityEvents);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.policy).toEqual(
      allowlist([READER, OUTSIDER].sort(), [ORG, OTHER_ORG].sort()),
    );
    await expectError(peer.transition(binding, OPERATOR, change({ mode: "inherit" }), allow), CONFLICT);
    await expectError(
      peer.transition(
        binding,
        OPERATOR,
        change(allowlist([OUTSIDER, READER], [OTHER_ORG, ORG]), 1),
        allow,
      ),
      CONFLICT,
    );
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual(journal);
    expect(
      await peer.transition(binding, OPERATOR, change({ mode: "inherit" }, 1), allow),
    ).toMatchObject({ revision: 2 });
  }, 15_000);

  test.each([
    { mode: "suspension", entry: "read" },
    { mode: "membership deletion", entry: "read" },
    { mode: "suspension", entry: "transition" },
    { mode: "membership deletion", entry: "transition" },
  ])(
    "canonical row locks hold $entry against concurrent $mode",
    async ({ mode, entry }) => {
      const binding = release();
      const { visibility } = await ready();
      await db.insert(userOrgMemberships).values({ userId: READER, orgId: ORG, role: "member" });
      await visibility.transition(binding, OPERATOR, change(allowlist([], [ORG])), allow);
      const { holder, waiter } = await backendPids();
      const entered = Promise.withResolvers<void>();
      const releaseAuthorization = Promise.withResolvers<void>();
      const authorize: Authorize = async (principal) => {
        expect(principal).toEqual({ sub: READER, role: "user", orgIds: [ORG] });
        entered.resolve();
        await releaseAuthorization.promise;
      };
      const admission =
        entry === "read"
          ? visibility.assertReadable(binding, READER, authorize)
          : visibility.transition(binding, READER, change(allowlist([READER]), 1), authorize);
      const admissionResult = Promise.allSettled([admission]);
      let completed = false;
      let revocationResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([
          entered.promise,
          admission.then(() => {
            throw new Error("Admission completed before authorization was released");
          }),
        ]);
        revocationResult = Promise.allSettled([
          peerDb.transaction(async (tx) => {
            if (mode === "suspension") {
              await tx.update(users).set({ suspended: true }).where(eq(users.id, READER));
            } else {
              await tx.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, READER));
            }
          }),
        ]).then((results) => {
          completed = true;
          return results;
        });
        await waitForLock(admin, waiter, holder, "transactionid", () => completed);
      } finally {
        releaseAuthorization.resolve();
        await Promise.all([admissionResult, revocationResult]);
      }
      expect(await admissionResult).toMatchObject([{ status: "fulfilled" }]);
      expect(await revocationResult).toMatchObject([{ status: "fulfilled" }]);
      const requireMembership: Authorize = async (principal) => {
        if (!principal.orgIds.includes(ORG)) throw new Error(PRIVATE);
      };
      await expectError(visibility.assertReadable(binding, READER, requireMembership), DENIED);
      await expectError(visibility.inspect(binding, READER, requireMembership), FORBIDDEN);
      await expectError(
        visibility.transition(
          binding,
          READER,
          change({ mode: "inherit" }, entry === "read" ? 1 : 2),
          requireMembership,
        ),
        FORBIDDEN,
      );
      expect(await db.select().from(spackMaterialVisibilityEvents)).toHaveLength(
        entry === "read" ? 1 : 2,
      );
    },
    15_000,
  );

  test.each(["queued", "running"] as const)(
    "tightens active %s operations, blocks concurrent retries and preserves reference history",
    async (status) => {
      const binding = release();
      const { visibility, peer, references, peerReferences } = await ready();
      const input = await operation(binding);
      await references.acquireOperation(input);
      await db
        .update(softwareOperations)
        .set({ status })
        .where(eq(softwareOperations.id, input.operationId));
      const original = await db.select().from(spackMaterialOperationReferences);
      const { holder, waiter } = await backendPids();
      const entered = Promise.withResolvers<void>();
      const releaseAuthorization = Promise.withResolvers<void>();
      const tighten = visibility.transition(binding, OPERATOR, change(), async () => {
        entered.resolve();
        await releaseAuthorization.promise;
      });
      const tightenResult = Promise.allSettled([tighten]);
      let completed = false;
      let retryResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([
          entered.promise,
          tighten.then(() => {
            throw new Error("Policy mutation did not wait for authorization");
          }),
        ]);
        retryResult = Promise.allSettled([peerReferences.acquireOperation(input)]).then((results) => {
          completed = true;
          return results;
        });
        await waitForLock(admin, waiter, holder, "advisory", () => completed);
      } finally {
        releaseAuthorization.resolve();
        await Promise.all([tightenResult, retryResult]);
      }
      expect(await tightenResult).toMatchObject([{ status: "fulfilled", value: { revision: 1 } }]);
      expect(await retryResult).toMatchObject([{ status: "rejected", reason: REFERENCE_ERROR }]);
      await expectError(peerReferences.acquireOperation(input), REFERENCE_ERROR);
      await expectError(peer.assertReadable(binding, READER, allow), DENIED);
      await expectError(references.acquireOperation(await operation(binding)), REFERENCE_ERROR);
      expect(await db.select().from(spackMaterialOperationReferences)).toEqual(original);
      await visibility.transition(binding, OPERATOR, change(allowlist([READER]), 1), allow);
      await peerReferences.acquireOperation(input);
      expect(await db.select().from(spackMaterialOperationReferences)).toEqual(original);
      expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
    },
    15_000,
  );

  test("old operation tickets recheck canonical membership and suspension even on retry", async () => {
    const binding = release();
    const { visibility, references } = await ready();
    await db.insert(userOrgMemberships).values({ userId: READER, orgId: ORG, role: "member" });
    await visibility.transition(binding, OPERATOR, change(allowlist([], [ORG])), allow);
    const input = await operation(binding);
    await references.acquireOperation(input);
    const original = await db.select().from(spackMaterialOperationReferences);
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, READER));
    await expectError(references.acquireOperation(input), REFERENCE_ERROR);
    await db.insert(userOrgMemberships).values({ userId: READER, orgId: ORG, role: "member" });
    await references.acquireOperation(input);
    await db.update(users).set({ suspended: true }).where(eq(users.id, READER));
    await expectError(references.acquireOperation(input), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(original);
  });

  test.each([100, 101])("bounds %s cross-epoch events without deleting older audit", async (count) => {
    const binding = release();
    const previous = await ready();
    const current = await ready(previous.state.revision);
    await db.insert(spackMaterialVisibilityEvents).values(
      Array.from({ length: count }, (_, index) => ({
        ...binding,
        revision: index + 1,
        policy: index % 2 === 0 ? allowlist() : { mode: "inherit" as const },
        operatorId: OPERATOR,
        reason: `Historical policy event ${index + 1}`,
        epoch: index < 50 ? previous.epoch : current.epoch,
        rolloutRevision: index < 50 ? previous.state.revision : current.state.revision,
        createdAt: new Date(Date.UTC(2026, 0, 1) + index),
      })),
    );
    const journal = await db
      .select()
      .from(spackMaterialVisibilityEvents)
      .orderBy(spackMaterialVisibilityEvents.revision);
    const inspected = await current.peer.inspect(binding, OPERATOR, allow);
    expect(inspected).toMatchObject({
      revision: count,
      policy: count === 101 ? allowlist() : { mode: "inherit" },
      historyTruncated: count > 100,
    });
    expect(inspected.history).toHaveLength(100);
    expect(inspected.history.map((event) => event.revision)).toEqual(
      Array.from({ length: 100 }, (_, index) => count - index),
    );
    expect(new Set(inspected.history.map((event) => event.epoch))).toEqual(
      new Set([previous.epoch, current.epoch]),
    );
    if (count === 101) {
      await expectError(current.peer.assertReadable(binding, READER, allow), DENIED);
    } else {
      await current.peer.assertReadable(binding, READER, allow);
    }
    expect(
      await db
        .select()
        .from(spackMaterialVisibilityEvents)
        .orderBy(spackMaterialVisibilityEvents.revision),
    ).toEqual(journal);
  });

  test("a gap in audit history rejects inspection and rolls back attempted restoration", async () => {
    const binding = release();
    const { visibility, epoch, state } = await ready();
    await db.insert(spackMaterialVisibilityEvents).values({
      ...binding,
      revision: 2,
      policy: allowlist(),
      operatorId: OPERATOR,
      reason: "Prior event is missing",
      epoch,
      rolloutRevision: state.revision,
    });
    const before = await db.select().from(spackMaterialVisibilityEvents);
    await expectError(visibility.inspect(binding, OPERATOR, allow), UNAVAILABLE);
    await expectError(
      visibility.transition(binding, OPERATOR, change({ mode: "inherit" }, 2), allow),
      UNAVAILABLE,
    );
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual(before);
  });

  test.each([
    { label: "missing identities", policy: { mode: "allowlist" } },
    { label: "extra key", policy: { mode: "inherit", userIds: [] } },
    {
      label: "duplicate identities",
      policy: { mode: "allowlist", userIds: [READER, READER], orgIds: [] },
    },
    { label: "invalid UUID", policy: { mode: "allowlist", userIds: ["fake"], orgIds: [] } },
    {
      label: "noncanonical order",
      policy: { mode: "allowlist", userIds: [READER, OUTSIDER].sort().reverse(), orgIds: [] },
    },
  ])("corrupt persisted policy fails closed: $label", async ({ policy }) => {
    const binding = release();
    const { visibility, references } = await ready();
    await visibility.transition(binding, OPERATOR, change(allowlist([READER])), allow);
    const input = await operation(binding);
    await references.acquireOperation(input);
    const original = await db.select().from(spackMaterialOperationReferences);
    await db.execute(sql`
      update spack_material_visibility_events set policy = ${JSON.stringify(policy)}::jsonb
    `);
    const corrupted = await db.select().from(spackMaterialVisibilityEvents);
    await expectError(visibility.inspect(binding, OPERATOR, allow), UNAVAILABLE);
    await expectError(visibility.assertReadable(binding, READER, allow), UNAVAILABLE);
    await expectError(
      visibility.transition(binding, OPERATOR, change({ mode: "inherit" }, 1), allow),
      UNAVAILABLE,
    );
    await expectError(references.acquireOperation(input), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual(corrupted);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(original);
  });

  test.each([" leading", "trailing ", "embedded\nnewline", "embedded\x7fdelete"])(
    "corrupt persisted audit reasons fail closed (%j)",
    async (reason) => {
      const binding = release();
      const { visibility } = await ready();
      await visibility.transition(binding, OPERATOR, change(allowlist([READER])), allow);
      await db.update(spackMaterialVisibilityEvents).set({ reason });
      await expectError(visibility.inspect(binding, OPERATOR, allow), UNAVAILABLE);
      await expectError(visibility.assertReadable(binding, READER, allow), UNAVAILABLE);
      await expectError(
        visibility.transition(binding, OPERATOR, change({ mode: "inherit" }, 1), allow),
        UNAVAILABLE,
      );
    },
  );

  test.each([
    "spack_material_visibility_events",
    "spack_material_rollouts",
    "users",
    "user_org_memberships",
  ])("missing %s fails closed without a public search_path fallback", async (table) => {
    const binding = release();
    const { visibility, references } = await ready();
    const input = await operation(binding);
    await db.execute(sql`alter table ${sql.identifier(table)} rename to hidden_visibility_table`);
    try {
      await expectError(visibility.inspect(binding, OPERATOR, allow), UNAVAILABLE);
      await expectError(visibility.transition(binding, OPERATOR, change(), allow), UNAVAILABLE);
      await expectError(visibility.assertReadable(binding, READER, allow), UNAVAILABLE);
      await expectError(references.acquireOperation(input), REFERENCE_ERROR);
    } finally {
      await db.execute(sql`alter table hidden_visibility_table rename to ${sql.identifier(table)}`);
    }
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual([]);
  });

  test("missing availability journal cannot be bypassed by inherited visibility", async () => {
    const binding = release();
    const { visibility, references } = await ready();
    const input = await operation(binding);
    await db.execute(sql`alter table spack_material_lifecycle_events rename to hidden_availability`);
    try {
      await expectError(visibility.assertReadable(binding, READER, allow), UNAVAILABLE);
      await expectError(references.acquireOperation(input), REFERENCE_ERROR);
    } finally {
      await db.execute(sql`alter table hidden_availability rename to spack_material_lifecycle_events`);
    }
  });

  test.each([1, 2, 3])("honors caller deadline checkpoint %s and releases the transaction", async (stop) => {
    const binding = release();
    const { visibility, peer } = await ready();
    let checkpoints = 0;
    let authorized = false;
    await expectError(
      visibility.assertReadable(
        binding,
        READER,
        async () => {
          authorized = true;
        },
        () => {
          if (++checkpoints === stop) {
            throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
          }
        },
      ),
      UNAVAILABLE,
    );
    expect(checkpoints).toBe(stop);
    expect(authorized).toBe(stop === 3);
    await peer.assertReadable(binding, READER, allow);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
  });

  test("PostgreSQL lock deadline returns sanitized 503 without a policy write", async () => {
    const binding = release();
    const { peer } = await ready();
    const { holder, waiter } = await backendPids();
    const entered = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const holding = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('kuintessence:spack-material-lifecycle'))`,
      );
      entered.resolve();
      await releaseLock.promise;
    });
    const holdingResult = Promise.allSettled([holding]);
    let completed = false;
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await Promise.race([
        entered.promise,
        holding.then(() => {
          throw new Error("Advisory lock was not held");
        }),
      ]);
      const mutation = peer.transition(binding, OPERATOR, change(), allow);
      pending = Promise.allSettled([mutation]).then((results) => {
        completed = true;
        return results;
      });
      await waitForLock(admin, waiter, holder, "advisory", () => completed);
      // Keep the lock held until PostgreSQL's lock_timeout aborts the waiter.
      await expectError(mutation, UNAVAILABLE);
      await pending;
      expect(completed).toBe(true);
    } finally {
      releaseLock.resolve();
      await Promise.all([holdingResult, pending]);
    }
    expect(await holdingResult).toMatchObject([{ status: "fulfilled" }]);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
    expect(await peer.transition(binding, OPERATOR, change(), allow)).toMatchObject({ revision: 1 });
  }, 20_000);

  test("statement deadline aborts a slow audit insert and rolls back the journal", async () => {
    const binding = release();
    const { visibility, peer } = await ready();
    // A longer session timeout ensures the service's SET LOCAL supplies the deadline.
    await db.execute(sql`set statement_timeout = '30s'`);
    try {
      await db.execute(sql`
        create function delay_visibility_audit() returns trigger as $$
        begin
          perform pg_sleep(12);
          return new;
        end;
        $$ language plpgsql
      `);
      try {
        await db.execute(sql`
          create trigger delay_visibility before insert on spack_material_visibility_events
          for each row execute function delay_visibility_audit()
        `);
        try {
          await expectError(visibility.transition(binding, OPERATOR, change(), allow), UNAVAILABLE);
          expect(await peer.inspect(binding, OPERATOR, allow)).toMatchObject({
            revision: 0,
            policy: { mode: "inherit" },
            history: [],
          });
          expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
        } finally {
          await db.execute(sql`drop trigger delay_visibility on spack_material_visibility_events`);
        }
      } finally {
        await db.execute(sql`drop function delay_visibility_audit()`);
      }
    } finally {
      await db.execute(sql`set statement_timeout = '10s'`);
    }
    expect(await peer.transition(binding, OPERATOR, change(), allow)).toMatchObject({ revision: 1 });
  }, 25_000);

  test("invalid binding, revision and reason inputs never authorize or write", async () => {
    const binding = release();
    const { visibility } = await ready();
    let calls = 0;
    const authorize: Authorize = async () => {
      calls++;
    };
    for (const invalid of [
      { ...binding, repositoryId: "invalid" },
      { ...binding, manifestDigest: "invalid" },
      { ...binding, extra: true },
    ]) {
      await expectError(visibility.inspect(invalid, OPERATOR, authorize), INVALID);
      await expectError(visibility.assertReadable(invalid, READER, authorize), INVALID);
      await expectError(visibility.transition(invalid, OPERATOR, change(), authorize), INVALID);
    }
    for (const invalid of [
      ...[-1, 0.5, Number.NaN, 2_147_483_647].map((expectedRevision) => ({
        ...change(),
        expectedRevision,
      })),
      ...["", " ", "x".repeat(1001), "reason\nline"].map((reason) => ({ ...change(), reason })),
      change(allowlist([READER, READER])),
      change(allowlist([], ["fake"])),
    ]) {
      await expectError(visibility.transition(binding, OPERATOR, invalid, authorize), INVALID);
    }
    expect(calls).toBe(0);
    expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual([]);
  });

  test.each(["revoke", "restore"] as const)(
    "audit insert failure sanitizes diagnostics and rolls back %s",
    async (mode) => {
      const binding = release();
      const { visibility, peer } = await ready();
      if (mode === "restore") await visibility.transition(binding, OPERATOR, change(), allow);
      const before = await visibility.inspect(binding, OPERATOR, allow);
      const journal = await db.select().from(spackMaterialVisibilityEvents);
      const mutation = change(mode === "restore" ? { mode: "inherit" } : allowlist(), before.revision);
      await db.execute(sql`
        create function reject_visibility_audit() returns trigger as $$
        begin
          raise exception 'private visibility fixture SQL/token diagnostic';
        end;
        $$ language plpgsql
      `);
      try {
        await db.execute(sql`
          create trigger reject_visibility before insert on spack_material_visibility_events
          for each row execute function reject_visibility_audit()
        `);
        try {
          await expectError(visibility.transition(binding, OPERATOR, mutation, allow), UNAVAILABLE);
          expect(await peer.inspect(binding, OPERATOR, allow)).toEqual(before);
          expect(await db.select().from(spackMaterialVisibilityEvents)).toEqual(journal);
          if (mode === "restore") {
            await expectError(peer.assertReadable(binding, READER, allow), DENIED);
          } else {
            await peer.assertReadable(binding, READER, allow);
          }
        } finally {
          await db.execute(sql`drop trigger reject_visibility on spack_material_visibility_events`);
        }
      } finally {
        await db.execute(sql`drop function reject_visibility_audit()`);
      }
      expect(await peer.transition(binding, OPERATOR, mutation, allow)).toMatchObject({
        revision: before.revision + 1,
      });
    },
  );
});
