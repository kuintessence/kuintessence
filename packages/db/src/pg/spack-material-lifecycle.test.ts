import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "./index";
import { agents, softwareOperations, userOrgMemberships, users } from "./schema";
import {
  spackMaterialBindingRetirements,
  spackMaterialBindings,
  spackMaterialLifecycleEvents,
  spackMaterialOperationReferences,
} from "./schema-spack-materials";
import { SpackMaterialLifecycle } from "./spack-material-lifecycle";
import { SpackMaterialReferences } from "./spack-material-references";
import { SpackMaterialRollout } from "./spack-material-rollout";

const SCHEMA = `spack_lifecycle_${randomUUID().replaceAll("-", "")}`;
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
];
const OPERATOR = randomUUID();
const AGENT = `lifecycle-${randomUUID()}`;
const SPEC = "hello@2.12.1";
const EVIDENCE = {
  legacyProcessesStoppedAndDrained: true,
  legacyAccessRevoked: true,
  legacyInventoryComplete: true,
} as const;
const UNAVAILABLE = { code: "MATERIAL_LIFECYCLE_UNAVAILABLE", status: 503 };
const FORBIDDEN = { code: "MATERIAL_LIFECYCLE_FORBIDDEN", status: 403 };
const CONFLICT = { code: "MATERIAL_LIFECYCLE_CONFLICT", status: 409 };
const REFERENCED = { code: "MATERIAL_RELEASE_REFERENCED", status: 409 };
const WITHDRAWN = { code: "MATERIAL_RELEASE_WITHDRAWN", status: 404 };
const INVALID = { code: "MATERIAL_LIFECYCLE_INVALID", status: 422 };
const REFERENCE_ERROR = { code: "SPACK_MATERIAL_REFERENCE_ERROR" };
type Authorize = Parameters<SpackMaterialLifecycle["inspect"]>[2];
const allow: Authorize = async () => {};

function release() {
  return {
    repositoryId: randomBytes(32).toString("hex"),
    manifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
  };
}
function change(action: "withdraw" | "restore" = "withdraw", expectedRevision = 0) {
  return { action, expectedRevision, reason: `Operator requested ${action}` };
}
async function expectError(work: Promise<unknown>, expected: { code: string; status?: number }) {
  const failure = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject(expected);
  if (failure instanceof Error) expect(failure.cause).toBeUndefined();
}
async function waitForRowLock(
  observer: PgDb,
  writerPid: number,
  holderPid: number,
  completed: () => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (completed()) throw new Error("Revocation finished before authorization was released");
    const [row] = await observer.$client<{ blocked: boolean }[]>`
      select ${holderPid} = any(pg_blocking_pids(${writerPid}))
        and exists (
          select 1 from pg_locks
          where pid = ${writerPid} and locktype = 'transactionid' and not granted
        ) as blocked
    `;
    if (row?.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error("Revocation did not wait on the canonical authorization row lock");
}

// Migrated real PG is mandatory. No public fallback, shared mutations, mocks of PG, or skips.
describe("Spack material lifecycle (isolated real PG)", () => {
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
  async function ready(
    bindings: Record<string, ReturnType<typeof release>> = {},
    retire = false,
    expectedRevision = 0,
  ) {
    const pause = { action: "pause", operatorId: OPERATOR, expectedRevision };
    let state = await rollout.execute(pause);
    const reconcile = () =>
      rollout.execute({
        action: "reconcile",
        operatorId: OPERATOR,
        expectedRevision: state.revision,
        epoch: state.epoch,
        bindings: [bindings],
      });
    state = await reconcile();
    if (retire) {
      state = await rollout.execute({
        action: "retire",
        operatorId: OPERATOR,
        expectedRevision: state.revision,
        epoch: state.epoch,
        inventoryDigest: state.inventoryDigest,
        bindings: [bindings],
        reason: "Deployment binding removed",
        evidence: { ...EVIDENCE, bindingConfigurationsRemoved: true },
      });
      state = await reconcile();
    }
    state = await rollout.execute({
      action: "activate",
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
      lifecycle: new SpackMaterialLifecycle(db, state.epoch),
      peer: new SpackMaterialLifecycle(peerDb, state.epoch),
      references: new SpackMaterialReferences(db, state.epoch),
      peerReferences: new SpackMaterialReferences(peerDb, state.epoch),
    };
  }
  async function operation(binding: ReturnType<typeof release>) {
    const input = {
      operationId: randomUUID(),
      agentId: AGENT,
      requestedBy: OPERATOR,
      spec: SPEC,
      ...binding,
    };
    await db.insert(softwareOperations).values({
      id: input.operationId,
      agentId: AGENT,
      requestedBy: OPERATOR,
      spec: SPEC,
      action: "install",
      status: "queued",
    });
    return input;
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
    await db.insert(users).values({
      id: OPERATOR,
      role: "platform_admin",
      email: `${OPERATOR}@example.invalid`,
    });
    await db.insert(agents).values({
      agentId: AGENT,
      siteName: "lifecycle-test",
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

  test("withdraws and restores with durable audit history and release-pair isolation", async () => {
    const binding = release();
    const { lifecycle, peer, state, references } = await ready();
    expect(await lifecycle.inspect(binding, OPERATOR, allow)).toEqual({
      revision: 0,
      state: "available",
      history: [],
      historyTruncated: false,
    });
    await lifecycle.assertAvailable(binding);
    const withdrawn = await lifecycle.transition(binding, OPERATOR, change(), allow);
    const journal = await db.select().from(spackMaterialLifecycleEvents);
    const createdAt = journal[0]?.createdAt.toISOString();
    expect(Number.isFinite(Date.parse(createdAt ?? ""))).toBe(true);
    expect(withdrawn.history[0]?.createdAt).toBe(createdAt);
    expect(withdrawn).toEqual({
      revision: 1,
      state: "withdrawn",
      historyTruncated: false,
      history: [
        {
          revision: 1,
          state: "withdrawn",
          operatorId: OPERATOR,
          reason: change().reason,
          epoch: state.epoch,
          rolloutRevision: state.revision,
          createdAt,
        },
      ],
    });
    await expect(peer.assertAvailable(binding)).rejects.toMatchObject(WITHDRAWN);
    await expectError(references.registerBindings({ [SPEC]: binding }), REFERENCE_ERROR);
    await peer.assertAvailable({ ...binding, manifestDigest: release().manifestDigest });
    await peer.assertAvailable({ ...release(), manifestDigest: binding.manifestDigest });
    const restored = await peer.transition(binding, OPERATOR, change("restore", 1), allow);
    const restoredCreatedAt = restored.history[0]?.createdAt;
    expect(Number.isFinite(Date.parse(restoredCreatedAt ?? ""))).toBe(true);
    expect(restored).toMatchObject({ revision: 2, state: "available", historyTruncated: false });
    expect(restored.history).toHaveLength(2);
    expect(restored.history).toEqual(expect.arrayContaining(withdrawn.history));
    expect(restored.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          revision: 2,
          state: "available",
          operatorId: OPERATOR,
          reason: change("restore").reason,
          epoch: state.epoch,
          rolloutRevision: state.revision,
          createdAt: restoredCreatedAt,
        }),
      ]),
    );
    expect(await lifecycle.inspect(binding, OPERATOR, allow)).toEqual(restored);
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual(
      expect.arrayContaining(journal),
    );
    await lifecycle.assertAvailable(binding);
    await references.acquireOperation(await operation(binding));
    await references.registerBindings({ [SPEC]: binding });
  });

  test("CAS admits one withdrawal and rejects stale revisions and wrong states", async () => {
    const binding = release();
    const { lifecycle, peer } = await ready();
    await expectError(lifecycle.transition(binding, OPERATOR, change("restore"), allow), CONFLICT);
    const results = await Promise.allSettled([
      lifecycle.transition(binding, OPERATOR, change(), allow),
      peer.transition(binding, OPERATOR, { ...change(), reason: "Concurrent withdrawal" }, allow),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject(CONFLICT);
    }
    for (const invalid of [change("restore", 0), change("withdraw", 1)]) {
      await expectError(peer.transition(binding, OPERATOR, invalid, allow), CONFLICT);
    }
    expect(await db.select().from(spackMaterialLifecycleEvents)).toHaveLength(1);
    const restored = await lifecycle.transition(binding, OPERATOR, change("restore", 1), allow);
    expect(restored.revision).toBe(2);
    await expectError(peer.transition(binding, OPERATOR, change("withdraw", 1), allow), CONFLICT);
    expect(await peer.inspect(binding, OPERATOR, allow)).toEqual(restored);
  });

  test("withdrawal survives epoch rotation and restore retains the previous audit", async () => {
    const binding = release();
    const previous = await ready();
    const withdrawn = await previous.lifecycle.transition(binding, OPERATOR, change(), allow);
    const journal = await db.select().from(spackMaterialLifecycleEvents);
    const current = await ready({}, false, previous.state.revision);
    expect(current.epoch).not.toBe(previous.epoch);
    expect(current.state.revision).toBe(previous.state.revision + 3);
    expect(await current.peer.inspect(binding, OPERATOR, allow)).toEqual(withdrawn);
    await expectError(current.peer.assertAvailable(binding), WITHDRAWN);
    await expectError(previous.lifecycle.inspect(binding, OPERATOR, allow), UNAVAILABLE);
    const restored = await current.peer.transition(binding, OPERATOR, change("restore", 1), allow);
    expect(restored).toMatchObject({
      revision: 2,
      state: "available",
      historyTruncated: false,
    });
    expect(restored.history).toHaveLength(2);
    expect(restored.history[0]).toMatchObject({
      revision: 2,
      state: "available",
      epoch: current.epoch,
      rolloutRevision: current.state.revision,
      operatorId: OPERATOR,
      reason: change("restore").reason,
    });
    expect(restored.history[1]).toEqual(withdrawn.history[0]);
    const persisted = await db.select().from(spackMaterialLifecycleEvents);
    expect(persisted).toHaveLength(2);
    expect(persisted).toEqual(expect.arrayContaining(journal));
    expect(await current.lifecycle.inspect(binding, OPERATOR, allow)).toEqual(restored);
    await current.lifecycle.assertAvailable(binding);
  });

  test("bounds 101 cross-epoch events to the latest 100 without deleting older history", async () => {
    const binding = release();
    const previous = await ready();
    const current = await ready({}, false, previous.state.revision);
    const start = Date.now();
    await db.insert(spackMaterialLifecycleEvents).values(
      Array.from({ length: 101 }, (_, index) => {
        const fixture = index < 50 ? previous : current;
        return {
          ...binding,
          revision: index + 1,
          state: index % 2 === 0 ? "withdrawn" : "available",
          operatorId: OPERATOR,
          reason: `Historical lifecycle event ${index + 1}`,
          epoch: fixture.epoch,
          rolloutRevision: fixture.state.revision,
          createdAt: new Date(start + index),
        };
      }),
    );
    const journal = await db
      .select()
      .from(spackMaterialLifecycleEvents)
      .orderBy(spackMaterialLifecycleEvents.revision);
    const inspected = await current.peer.inspect(binding, OPERATOR, allow);
    expect(inspected).toMatchObject({
      revision: 101,
      state: "withdrawn",
      historyTruncated: true,
    });
    expect(inspected.history).toHaveLength(100);
    expect(inspected.history.map((event) => event.revision)).toEqual(
      Array.from({ length: 100 }, (_, index) => 101 - index),
    );
    expect(new Set(inspected.history.map((event) => event.epoch))).toEqual(
      new Set([previous.epoch, current.epoch]),
    );
    expect(inspected.history[0]).toMatchObject({ revision: 101, state: "withdrawn" });
    expect(inspected.history.at(-1)).toMatchObject({ revision: 2, state: "available" });
    await expectError(current.lifecycle.assertAvailable(binding), WITHDRAWN);
    expect(journal).toHaveLength(101);
    expect(
      await db
        .select()
        .from(spackMaterialLifecycleEvents)
        .orderBy(spackMaterialLifecycleEvents.revision),
    ).toEqual(journal);
  });

  test.each([
    "acquire",
    "register",
  ] as const)("serializes withdrawal against concurrent %s without admitting a withdrawn release", async (method) => {
    const binding = release();
    const { lifecycle, peerReferences } = await ready();
    const input = await operation(binding);
    const results = await Promise.allSettled([
      lifecycle.transition(binding, OPERATOR, change(), allow),
      method === "acquire"
        ? peerReferences.acquireOperation(input)
        : peerReferences.registerBindings({ [SPEC]: binding }),
    ]);
    const [withdrawal, admission] = results;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    if (withdrawal.status === "fulfilled") {
      expect(admission).toMatchObject({ status: "rejected", reason: REFERENCE_ERROR });
      await expect(lifecycle.assertAvailable(binding)).rejects.toMatchObject(WITHDRAWN);
    } else {
      expect(withdrawal.reason).toMatchObject(REFERENCED);
      expect(admission.status).toBe("fulfilled");
      await lifecycle.assertAvailable(binding);
    }
    const admitted = admission.status === "fulfilled" ? 1 : 0;
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(
      method === "register" ? admitted : 0,
    );
    expect(await db.select().from(spackMaterialOperationReferences)).toHaveLength(
      method === "acquire" ? admitted : 0,
    );
    expect(await db.select().from(spackMaterialLifecycleEvents)).toHaveLength(1 - admitted);
  });

  test.each([false, true])("withdrawal requires retired bindings (retired=%s)", async (retire) => {
    const binding = release();
    const { lifecycle, references } = await ready(
      { [SPEC]: binding, "hello@alias": binding },
      retire,
    );
    const bindings = await db.select().from(spackMaterialBindings);
    const retirements = await db.select().from(spackMaterialBindingRetirements);
    if (retire) {
      expect(retirements).toHaveLength(2);
      expect(await lifecycle.transition(binding, OPERATOR, change(), allow)).toMatchObject({
        revision: 1,
        state: "withdrawn",
      });
      await lifecycle.transition(binding, OPERATOR, change("restore", 1), allow);
      await lifecycle.assertAvailable(binding);
      await expectError(references.registerBindings({ [SPEC]: binding }), REFERENCE_ERROR);
    } else {
      await expectError(lifecycle.transition(binding, OPERATOR, change(), allow), REFERENCED);
      expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
    }
    expect(await db.select().from(spackMaterialBindings)).toEqual(bindings);
    expect(await db.select().from(spackMaterialBindingRetirements)).toEqual(retirements);
  });

  test.each([
    "queued",
    "running",
    "succeeded",
    "failed",
    "rejected",
    "orphan",
  ])("protects active/orphan references but retains terminal history (%s)", async (status) => {
    const binding = release();
    const { lifecycle, references } = await ready();
    const input = await operation(binding);
    await references.acquireOperation(input);
    if (status === "orphan") {
      await db.update(softwareOperations).set({ status: "succeeded" });
      await db.delete(softwareOperations).where(eq(softwareOperations.id, input.operationId));
    } else {
      await db.update(softwareOperations).set({ status });
    }
    const historical = await db.select().from(spackMaterialOperationReferences);
    if (["queued", "running", "orphan"].includes(status)) {
      await expectError(lifecycle.transition(binding, OPERATOR, change(), allow), REFERENCED);
      expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
    } else {
      await lifecycle.transition(binding, OPERATOR, change(), allow);
      await db.update(softwareOperations).set({ status: "queued" });
      await expect(references.acquireOperation(input)).rejects.toMatchObject(REFERENCE_ERROR);
      await lifecycle.transition(binding, OPERATOR, change("restore", 1), allow);
      await references.acquireOperation(input);
    }
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
  });

  test("withdrawal waits for DELETE and rejects the orphan", async () => {
    const binding = release();
    const { lifecycle, references } = await ready();
    const input = await operation(binding);
    await references.acquireOperation(input);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    const historical = await db.select().from(spackMaterialOperationReferences);
    const [waiter] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [holder] = await peerDb.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (!waiter || !holder) throw new Error("Expected independent backend PIDs");
    expect(waiter.pid).not.toBe(holder.pid);
    const deleteReady = Promise.withResolvers<void>();
    const commitDeletion = Promise.withResolvers<void>();
    const deletion = peerDb.transaction(async (tx) => {
      await tx.delete(softwareOperations).where(eq(softwareOperations.id, input.operationId));
      deleteReady.resolve();
      await commitDeletion.promise;
    });
    const deletionResult = Promise.allSettled([deletion]);
    let withdrawalCompleted = false;
    let withdrawalResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await Promise.race([
        deleteReady.promise,
        deletion.then(() => {
          throw new Error("DELETE committed before its release signal");
        }),
      ]);
      const withdrawal = lifecycle.transition(binding, OPERATOR, change(), allow);
      withdrawalResult = Promise.allSettled([withdrawal]).then((results) => {
        withdrawalCompleted = true;
        return results;
      });
      const deadline = Date.now() + 4_000;
      let blocked = false;
      while (Date.now() < deadline) {
        if (withdrawalCompleted) throw new Error("Withdrawal did not wait for DELETE");
        // The peer holds RowExclusiveLock; require a relation ShareLock wait, not advisory.
        const [row] = await admin.$client<{ blocked: boolean }[]>`
          select ${holder.pid} = any(pg_blocking_pids(${waiter.pid}))
            and exists (
              select 1 from pg_locks
              where pid = ${waiter.pid} and locktype = 'relation'
                and mode = 'ShareLock' and not granted
                and relation = to_regclass(${`${SCHEMA}.software_operations`})
            ) as blocked
        `;
        if (row?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      expect(withdrawalCompleted).toBe(false);
    } finally {
      deleteReady.resolve();
      commitDeletion.resolve();
      await Promise.all([deletionResult, withdrawalResult]);
    }
    expect(await deletionResult).toMatchObject([{ status: "fulfilled" }]);
    expect(await withdrawalResult).toMatchObject([{ status: "rejected", reason: REFERENCED }]);
    expect(await db.select().from(softwareOperations)).toEqual([]);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
    expect(await lifecycle.inspect(binding, OPERATOR, allow)).toMatchObject({
      revision: 0,
      state: "available",
      history: [],
    });
  }, 15_000);

  test("passes canonical users/memberships to policy and observes revocation", async () => {
    const binding = release();
    const { lifecycle } = await ready();
    const orgId = randomUUID();
    await db.update(users).set({ role: "user" }).where(eq(users.id, OPERATOR));
    await db.insert(userOrgMemberships).values({ userId: OPERATOR, orgId, role: "member" });
    const authorize = mock<Authorize>(async (principal) => {
      if (!principal.orgIds.includes(orgId)) throw new Error("Namespace access revoked");
    });
    await lifecycle.inspect(binding, OPERATOR, authorize);
    await lifecycle.transition(binding, OPERATOR, change(), authorize);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenLastCalledWith({ sub: OPERATOR, role: "user", orgIds: [orgId] });
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, OPERATOR));
    await expectError(lifecycle.inspect(binding, OPERATOR, authorize), FORBIDDEN);
    await expectError(
      lifecycle.transition(binding, OPERATOR, change("restore", 1), authorize),
      FORBIDDEN,
    );
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(authorize).toHaveBeenLastCalledWith({ sub: OPERATOR, role: "user", orgIds: [] });
    expect(await db.select().from(spackMaterialLifecycleEvents)).toHaveLength(1);
  });

  test.each([
    "suspension",
    "membership deletion",
  ])("canonical FOR SHARE locks block concurrent %s until the mutation commits", async (mode) => {
    const binding = release();
    const { lifecycle } = await ready();
    const orgId = randomUUID();
    await db.update(users).set({ role: "user" }).where(eq(users.id, OPERATOR));
    await db.insert(userOrgMemberships).values({ userId: OPERATOR, orgId, role: "member" });
    const [holder] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [writer] = await peerDb.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (!holder || !writer) throw new Error("Expected independent backend PIDs");
    expect(holder.pid).not.toBe(writer.pid);
    const entered = Promise.withResolvers<void>();
    const releaseAuthorization = Promise.withResolvers<void>();
    const authorize = mock<Authorize>(async (principal) => {
      if (!principal.orgIds.includes(orgId)) throw new Error("Namespace access revoked");
      entered.resolve();
      await releaseAuthorization.promise;
    });
    const mutation = lifecycle.transition(binding, OPERATOR, change(), authorize);
    const mutationResult = Promise.allSettled([mutation]);
    let updateCompleted = false;
    let updateResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await Promise.race([
        entered.promise,
        mutation.then(() => {
          throw new Error("Mutation completed without waiting for authorization");
        }),
      ]);
      expect(authorize).toHaveBeenLastCalledWith({
        sub: OPERATOR,
        role: "user",
        orgIds: [orgId],
      });
      updateResult = Promise.allSettled([
        peerDb.transaction(async (tx) => {
          if (mode === "suspension") {
            await tx.update(users).set({ suspended: true }).where(eq(users.id, OPERATOR));
          } else {
            await tx.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, OPERATOR));
          }
        }),
      ]).then((results) => {
        updateCompleted = true;
        return results;
      });
      // Observe a real row-lock conflict, not merely an unsettled client promise.
      await waitForRowLock(admin, writer.pid, holder.pid, () => updateCompleted);
      expect(updateCompleted).toBe(false);
    } finally {
      releaseAuthorization.resolve();
      await Promise.all([mutationResult, updateResult]);
    }
    expect(await mutationResult).toMatchObject([
      { status: "fulfilled", value: { revision: 1, state: "withdrawn" } },
    ]);
    expect(await updateResult).toMatchObject([{ status: "fulfilled" }]);
    expect(updateCompleted).toBe(true);
    if (mode === "suspension") {
      expect(await db.select().from(users).where(eq(users.id, OPERATOR))).toMatchObject([
        { suspended: true },
      ]);
    } else {
      expect(await db.select().from(userOrgMemberships)).toEqual([]);
    }
    await expectError(lifecycle.inspect(binding, OPERATOR, authorize), FORBIDDEN);
    await expectError(
      lifecycle.transition(binding, OPERATOR, change("restore", 1), authorize),
      FORBIDDEN,
    );
    expect(authorize).toHaveBeenCalledTimes(mode === "suspension" ? 1 : 3);
    expect(await db.select().from(spackMaterialLifecycleEvents)).toHaveLength(1);
  }, 15_000);

  test.each(["missing", "suspended", "policy"])("fails authorization closed: %s", async (mode) => {
    const binding = release();
    const { lifecycle } = await ready();
    const subject = mode === "missing" ? randomUUID() : OPERATOR;
    if (mode === "suspended") await db.update(users).set({ suspended: true });
    const authorize = mock<Authorize>(async () => {
      if (mode === "policy") throw new Error("Private namespace policy diagnostic");
    });
    await expectError(lifecycle.inspect(binding, subject, authorize), FORBIDDEN);
    await expectError(lifecycle.transition(binding, subject, change(), authorize), FORBIDDEN);
    expect(authorize).toHaveBeenCalledTimes(mode === "policy" ? 2 : 0);
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
  });

  test.each([
    "observe",
    "missing epoch",
    "wrong epoch",
    "paused",
  ])("requires matching ready rollout for management (%s)", async (mode) => {
    const binding = release();
    let lifecycle = new SpackMaterialLifecycle(db);
    if (mode !== "observe") {
      const fixture = await ready();
      const epoch = mode === "wrong epoch" ? randomUUID() : fixture.epoch;
      lifecycle = new SpackMaterialLifecycle(db, mode === "missing epoch" ? undefined : epoch);
      if (mode === "paused") {
        await rollout.execute({
          action: "pause",
          operatorId: OPERATOR,
          expectedRevision: fixture.state.revision,
        });
      }
    }
    await expectError(lifecycle.inspect(binding, OPERATOR, allow), UNAVAILABLE);
    await expectError(lifecycle.transition(binding, OPERATOR, change(), allow), UNAVAILABLE);
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
  });

  test.each([
    "spack_material_lifecycle_events",
    "spack_material_operation_references",
  ])("missing %s fails closed without falling back to public", async (table) => {
    const binding = release();
    const { lifecycle, references } = await ready();
    const input = await operation(binding);
    await db.execute(sql`alter table ${sql.identifier(table)} rename to hidden_lifecycle_table`);
    try {
      await expectError(lifecycle.transition(binding, OPERATOR, change(), allow), UNAVAILABLE);
      await expectError(references.acquireOperation(input), REFERENCE_ERROR);
      await expectError(references.registerBindings({ [SPEC]: binding }), REFERENCE_ERROR);
      await expectError(references.registerBindings({}), REFERENCE_ERROR);
      if (table === "spack_material_lifecycle_events") {
        await expectError(lifecycle.inspect(binding, OPERATOR, allow), UNAVAILABLE);
        await expectError(lifecycle.assertAvailable(binding), UNAVAILABLE);
      }
    } finally {
      await db.execute(sql`
        alter table hidden_lifecycle_table rename to ${sql.identifier(table)}
      `);
    }
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
    expect(await db.select().from(spackMaterialBindings)).toEqual([]);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual([]);
  });

  test("rejects invalid binding, CAS and reason inputs without journal writes", async () => {
    const binding = release();
    const { lifecycle } = await ready();
    for (const invalid of [
      { ...binding, repositoryId: "invalid" },
      { ...binding, manifestDigest: "invalid" },
    ]) {
      await expectError(lifecycle.inspect(invalid, OPERATOR, allow), INVALID);
      await expectError(lifecycle.transition(invalid, OPERATOR, change(), allow), INVALID);
    }
    for (const invalid of [
      ...[-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => ({
        ...change(),
        expectedRevision,
      })),
      ...["", " ", "x".repeat(1001)].map((reason) => ({ ...change(), reason })),
    ]) {
      await expectError(lifecycle.transition(binding, OPERATOR, invalid, allow), INVALID);
    }
    expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual([]);
  });

  test.each(["withdraw", "restore"] as const)("audit failure rolls back %s", async (action) => {
    const binding = release();
    const { lifecycle, peer } = await ready();
    if (action === "restore") await lifecycle.transition(binding, OPERATOR, change(), allow);
    const before = await lifecycle.inspect(binding, OPERATOR, allow);
    const journal = await db.select().from(spackMaterialLifecycleEvents);
    await db.execute(sql`
      create function reject_lifecycle_audit() returns trigger as $$
      begin
        raise exception 'private lifecycle audit fixture';
      end;
      $$ language plpgsql
    `);
    try {
      await db.execute(sql`
        create trigger reject_lifecycle before insert on spack_material_lifecycle_events
        for each row execute function reject_lifecycle_audit()
      `);
      try {
        await expectError(
          lifecycle.transition(binding, OPERATOR, change(action, before.revision), allow),
          UNAVAILABLE,
        );
        expect(await peer.inspect(binding, OPERATOR, allow)).toEqual(before);
        expect(await db.select().from(spackMaterialLifecycleEvents)).toEqual(journal);
        if (action === "withdraw") await peer.assertAvailable(binding);
        else await expect(peer.assertAvailable(binding)).rejects.toMatchObject(WITHDRAWN);
      } finally {
        await db.execute(sql`drop trigger reject_lifecycle on spack_material_lifecycle_events`);
      }
    } finally {
      await db.execute(sql`drop function reject_lifecycle_audit()`);
    }
    expect(
      await peer.transition(binding, OPERATOR, change(action, before.revision), allow),
    ).toMatchObject({ revision: before.revision + 1 });
  });
});
