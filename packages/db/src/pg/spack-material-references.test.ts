import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "./index";
import { agents, softwareOperations } from "./schema";
import { spackMaterialBindings, spackMaterialOperationReferences } from "./schema-spack-materials";
import {
  type SpackMaterialOperationReferenceInput,
  type SpackMaterialReferenceBinding,
  SpackMaterialReferences,
  withSpackMaterialLifecycleTransaction,
} from "./spack-material-references";

const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";
const AGENT_ID = `spack-reference-test-${randomUUID()}`;
const REQUESTER = `spack-reference-user-${randomUUID()}`;
const REFERENCE_ERROR = {
  code: "SPACK_MATERIAL_REFERENCE_ERROR",
  message: "Spack material reference operation failed",
};

// Real migrated PG is mandatory. Missing tables or connectivity must fail, never skip.
describe("SpackMaterialReferences (real PG)", () => {
  let db: PgDb;
  let peerDb: PgDb;
  let references: SpackMaterialReferences;
  let peer: SpackMaterialReferences;
  const repositories = new Set<string>();

  function binding(): SpackMaterialReferenceBinding {
    const repositoryId = randomBytes(32).toString("hex");
    repositories.add(repositoryId);
    return { repositoryId, manifestDigest: `sha256:${randomBytes(32).toString("hex")}` };
  }

  async function operation(
    release: SpackMaterialReferenceBinding,
    overrides: Partial<typeof softwareOperations.$inferInsert> = {},
  ): Promise<SpackMaterialOperationReferenceInput> {
    const input = {
      operationId: randomUUID(),
      agentId: AGENT_ID,
      requestedBy: REQUESTER,
      spec: "zlib@1.3",
      ...release,
    };
    await db.insert(softwareOperations).values({
      id: input.operationId,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      spec: input.spec,
      action: "install",
      status: "queued",
      ...overrides,
    });
    return input;
  }

  async function cleanup(): Promise<void> {
    await db
      .delete(spackMaterialOperationReferences)
      .where(eq(spackMaterialOperationReferences.agentId, AGENT_ID));
    await db.delete(softwareOperations).where(eq(softwareOperations.agentId, AGENT_ID));
    if (repositories.size > 0) {
      await db
        .delete(spackMaterialBindings)
        .where(inArray(spackMaterialBindings.repositoryId, [...repositories]));
      repositories.clear();
    }
  }

  beforeAll(async () => {
    db = createPgDb(PG_URL);
    peerDb = createPgDb(PG_URL);
    references = new SpackMaterialReferences(db);
    peer = new SpackMaterialReferences(peerDb);
    await db.select().from(spackMaterialBindings).limit(0);
    await db.select().from(spackMaterialOperationReferences).limit(0);
    await db.insert(agents).values({
      agentId: AGENT_ID,
      siteName: "spack-reference-test",
      schedulerType: "slurm",
      schedulerVersion: "test",
    });
  });

  beforeEach(cleanup);

  afterAll(async () => {
    try {
      await cleanup();
      await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
    } finally {
      await Promise.all([db.$client.end(), peerDb.$client.end()]);
    }
  });

  test("empty registration still requires migrated reference tables", async () => {
    await references.registerBindings({});
    const isolatedDb = createPgDb(PG_URL);
    try {
      // Hide real tables only on this connection; do not modify the migrated schema.
      await isolatedDb.execute(sql`set search_path to pg_temp`);
      await expectReferenceError(new SpackMaterialReferences(isolatedDb).registerBindings({}));
    } finally {
      await isolatedDb.$client.end();
    }
  });

  test.each([
    "bindings",
    "operations",
  ] as const)("empty registration checks all columns of the %s reference table", async (table) => {
    try {
      if (table === "bindings") {
        await peerDb.execute(sql`
            create temporary table spack_material_bindings (id uuid)
          `);
      } else {
        await peerDb.execute(sql`
            create temporary table spack_material_operation_references (operation_id uuid)
          `);
      }
      await peerDb.execute(sql`set search_path = pg_temp, public`);
      await expectReferenceError(peer.registerBindings({}));
    } finally {
      try {
        if (table === "bindings") {
          await peerDb.execute(sql`drop table pg_temp.spack_material_bindings`);
        } else {
          await peerDb.execute(sql`drop table pg_temp.spack_material_operation_references`);
        }
      } finally {
        await peerDb.execute(sql`reset search_path`);
      }
    }
  });

  test("keeps an append-only multi-Server union and isolates repository/digest pairs", async () => {
    const first = binding();
    const replaced = { ...first, manifestDigest: `sha256:${randomBytes(32).toString("hex")}` };
    const otherRepository = { ...binding(), manifestDigest: first.manifestDigest };
    await Promise.all([
      references.registerBindings({ "zlib@1.3": first }),
      peer.registerBindings({ "zlib@1.3": first, "zlib@1.3+shared": first }),
      peer.registerBindings({ "zlib@1.3": replaced }),
      references.registerBindings({ "zlib@1.3": otherRepository }),
    ]);
    await references.registerBindings({});
    await references.registerBindings({ "zlib@1.3": replaced });
    expect(await references.listReleaseReferences(first)).toEqual({
      bindingCount: 2,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
    expect(await references.listReleaseReferences(replaced)).toEqual({
      bindingCount: 1,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
    expect(await references.listReleaseReferences(otherRepository)).toEqual({
      bindingCount: 1,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
    expect(await references.listReleaseReferences(binding())).toEqual({
      bindingCount: 0,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
  });

  test("persists exact retries across independent connections and a connection restart", async () => {
    const release = binding();
    const input = await operation(release);
    await references.registerBindings({ [input.spec]: release });
    await Promise.all([
      references.acquireOperation(input),
      peer.acquireOperation(input),
      references.acquireOperation(input),
      peer.acquireOperation(input),
    ]);
    const before = await db.query.spackMaterialOperationReferences.findFirst({
      where: eq(spackMaterialOperationReferences.operationId, input.operationId),
    });
    await peerDb.$client.end();
    peerDb = createPgDb(PG_URL);
    peer = new SpackMaterialReferences(peerDb);
    await peer.registerBindings({ [input.spec]: release });
    await peer.acquireOperation({ ...input, operationId: input.operationId.toUpperCase() });
    expect(
      await peerDb.query.spackMaterialOperationReferences.findFirst({
        where: eq(spackMaterialOperationReferences.operationId, input.operationId),
      }),
    ).toEqual(before);
    expect(await peer.listReleaseReferences(release)).toEqual({
      bindingCount: 1,
      activeOperationCount: 1,
      orphanedOperationCount: 0,
    });
  });

  test("racing different bindings yield one immutable winner", async () => {
    const first = binding();
    const second = binding();
    const input = await operation(first);
    const outcomes = await Promise.allSettled([
      references.acquireOperation(input),
      peer.acquireOperation({ ...input, ...second }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject(REFERENCE_ERROR);
    }
    const rows = await db
      .select()
      .from(spackMaterialOperationReferences)
      .where(eq(spackMaterialOperationReferences.operationId, input.operationId));
    expect(rows).toHaveLength(1);
    const winner = rows[0];
    if (!winner) throw new Error("Expected the winning reference");
    const loser = winner.repositoryId === first.repositoryId ? second : first;
    await expectReferenceError(references.acquireOperation({ ...input, ...loser }));
    await references.acquireOperation({
      ...input,
      repositoryId: winner.repositoryId,
      manifestDigest: winner.manifestDigest,
    });
  });

  test("keeps old operation bindings after configuration replacement", async () => {
    const original = binding();
    const replacement = {
      ...original,
      manifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
    };
    const input = await operation(original);
    await references.registerBindings({ [input.spec]: original });
    await references.acquireOperation(input);
    await peer.registerBindings({ [input.spec]: replacement });
    await expectReferenceError(peer.acquireOperation({ ...input, ...replacement }));
    await peer.acquireOperation(input);
    expect(await peer.listReleaseReferences(original)).toEqual({
      bindingCount: 1,
      activeOperationCount: 1,
      orphanedOperationCount: 0,
    });
    expect(await peer.listReleaseReferences(replacement)).toEqual({
      bindingCount: 1,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
  });

  test("rejects missing, mismatched, non-install and terminal operations without writing", async () => {
    const release = binding();
    const input = await operation(release);
    for (const change of [
      { operationId: randomUUID() },
      { agentId: `${AGENT_ID}-wrong` },
      { requestedBy: `${REQUESTER}-wrong` },
      { spec: "zlib@1.2" },
    ]) {
      await expectReferenceError(references.acquireOperation({ ...input, ...change }));
    }
    for (const overrides of [
      { requestedBy: null },
      { action: "uninstall" },
      { action: "load" },
      { action: "import_preinstalled" },
      { status: "succeeded" },
      { status: "failed" },
      { status: "rejected" },
    ]) {
      await expectReferenceError(references.acquireOperation(await operation(release, overrides)));
    }
    expect(await references.listReleaseReferences(release)).toEqual({
      bindingCount: 0,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
  });

  test("rechecks retry identity without rewriting the reference", async () => {
    const release = binding();
    const input = await operation(release);
    await references.acquireOperation(input);
    for (const change of [{ requestedBy: "changed-requester" }, { spec: "zlib@1.2" }]) {
      await db
        .update(softwareOperations)
        .set(change)
        .where(eq(softwareOperations.id, input.operationId));
      await expectReferenceError(references.acquireOperation(input));
      await expectReferenceError(references.acquireOperation({ ...input, ...change }));
      await db
        .update(softwareOperations)
        .set({ requestedBy: input.requestedBy, spec: input.spec })
        .where(eq(softwareOperations.id, input.operationId));
    }
    await references.acquireOperation(input);
  });

  test("only explicit terminal statuses stop counting as active; rows remain", async () => {
    const release = binding();
    await references.registerBindings({ "zlib@1.3": release, "zlib@1.3+shared": release });
    const inputs: SpackMaterialOperationReferenceInput[] = [];
    for (const status of ["queued", "running", "succeeded", "failed", "rejected"]) {
      const input = await operation(release);
      await references.acquireOperation(input);
      await db
        .update(softwareOperations)
        .set({ status })
        .where(eq(softwareOperations.id, input.operationId));
      inputs.push(input);
      if (status === "queued" || status === "running") {
        await references.acquireOperation(input);
      } else {
        await expectReferenceError(references.acquireOperation(input));
      }
    }
    expect(await references.listReleaseReferences(release)).toEqual({
      bindingCount: 2,
      activeOperationCount: 2,
      orphanedOperationCount: 0,
    });
    expect(
      await db
        .select()
        .from(spackMaterialOperationReferences)
        .where(
          inArray(
            spackMaterialOperationReferences.operationId,
            inputs.map((input) => input.operationId),
          ),
        ),
    ).toHaveLength(5);
  });

  test("counts unknown and null future statuses as active on real PG", async () => {
    const release = binding();
    const future = await operation(release);
    const nullable = await operation(release);
    await references.acquireOperation(future);
    await references.acquireOperation(nullable);
    // Session-local projection models future statuses without changing the shared
    // operation CHECK constraint, schema or migrations.
    await peerDb.execute(sql`
      create temporary table software_operations (id uuid primary key, status varchar(32))
    `);
    try {
      // Invalidate plans previously resolved against public.software_operations.
      await peerDb.execute(sql`set search_path = pg_temp, public`);
      await peerDb.execute(sql`
        insert into pg_temp.software_operations (id, status)
        values (${future.operationId}, 'future-state'), (${nullable.operationId}, null)
      `);
      expect(await peer.listReleaseReferences(release)).toEqual({
        bindingCount: 0,
        activeOperationCount: 2,
        orphanedOperationCount: 0,
      });
    } finally {
      try {
        await peerDb.execute(sql`drop table pg_temp.software_operations`);
      } finally {
        await peerDb.execute(sql`reset search_path`);
      }
    }
  });

  test("deleted operations become durable orphans, including previously terminal ones", async () => {
    const release = binding();
    const input = await operation(release);
    const active = await operation(release);
    await references.acquireOperation(input);
    await references.acquireOperation(active);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    await db
      .delete(softwareOperations)
      .where(inArray(softwareOperations.id, [input.operationId, active.operationId]));
    await expectReferenceError(peer.acquireOperation(input));
    await expectReferenceError(peer.acquireOperation(active));
    expect(await peer.listReleaseReferences(release)).toEqual({
      bindingCount: 0,
      activeOperationCount: 0,
      orphanedOperationCount: 2,
    });
    expect(
      await peerDb.query.spackMaterialOperationReferences.findFirst({
        where: eq(spackMaterialOperationReferences.operationId, input.operationId),
      }),
    ).toMatchObject(input);
  });

  test.each([
    "registerBindings",
    "acquireOperation",
  ] as const)("%s waits on the shared lifecycle transaction lock", async (method) => {
    const release = binding();
    const input = await operation(release);
    const observer = createPgDb(PG_URL);
    const [backend] = await peerDb.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (!backend) throw new Error("Expected the peer backend PID");
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('kuintessence:spack-material-lifecycle'))`,
        );
        const write =
          method === "registerBindings"
            ? peer.registerBindings({ [input.spec]: release })
            : peer.acquireOperation(input);
        pending = write.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        await waitForAdvisoryWait(observer, backend.pid);
      });
      expect(await pending).toEqual({ ok: true });
    } finally {
      await pending;
      await observer.$client.end();
    }
  }, 15_000);

  test("rolls back failed mutations and releases the transaction lock", async () => {
    const release = binding();
    await expectReferenceError(
      withSpackMaterialLifecycleTransaction(db, async (tx) => {
        await tx.insert(spackMaterialBindings).values({ spec: "zlib@1.3", ...release });
        throw new Error("Private database diagnostic must not escape");
      }),
    );
    expect((await peer.listReleaseReferences(release)).bindingCount).toBe(0);
    await peer.registerBindings({ "zlib@1.3": release });
    expect((await references.listReleaseReferences(release)).bindingCount).toBe(1);
  });

  test("validates batches atomically and bounds specs at 500 characters", async () => {
    const release = binding();
    const input = await operation(release);
    for (const spec of ["", " ", " zlib", "zlib ", "zlib\nother", "x".repeat(501)]) {
      await expectReferenceError(
        references.registerBindings({ "valid@1": release, [spec]: release }),
      );
      await expectReferenceError(references.acquireOperation({ ...input, spec }));
    }
    for (const change of [
      { repositoryId: "a".repeat(63) },
      { repositoryId: "A".repeat(64) },
      { repositoryId: `sha256:${"a".repeat(64)}` },
      { manifestDigest: "a".repeat(64) },
      { manifestDigest: `sha256:${"A".repeat(64)}` },
      { manifestDigest: `sha256:${"a".repeat(65)}` },
    ]) {
      const invalid = { ...release, ...change };
      await expectReferenceError(references.registerBindings({ "valid@1": release, bad: invalid }));
      await expectReferenceError(references.acquireOperation({ ...input, ...change }));
      await expectReferenceError(references.listReleaseReferences(invalid));
    }
    for (const change of [
      { operationId: "not-a-uuid" },
      { operationId: input.operationId.replaceAll("-", "") },
      { operationId: `${input.operationId}\n` },
      { agentId: "" },
      { agentId: "a".repeat(256) },
      { requestedBy: "" },
      { requestedBy: "u".repeat(256) },
    ]) {
      await expectReferenceError(references.acquireOperation({ ...input, ...change }));
    }
    for (const value of [null, [], "invalid", 42, { extra: true }, { ...release, extra: true }]) {
      await expectReferenceError(
        references.listReleaseReferences(value as unknown as SpackMaterialReferenceBinding),
      );
    }
    for (const value of [null, [], "invalid", 42, { invalid: null }]) {
      await expectReferenceError(
        references.registerBindings(
          value as unknown as Record<string, SpackMaterialReferenceBinding>,
        ),
      );
    }
    for (const value of [null, [], { ...input, agentId: 42 }, { ...input, extra: true }]) {
      await expectReferenceError(
        references.acquireOperation(value as unknown as SpackMaterialOperationReferenceInput),
      );
    }
    expect(await references.listReleaseReferences(release)).toEqual({
      bindingCount: 0,
      activeOperationCount: 0,
      orphanedOperationCount: 0,
    });
    const spec = "x".repeat(500);
    const boundary = { ...(await operation(release, { spec })), spec };
    await references.registerBindings({ [spec]: release });
    await references.acquireOperation(boundary);
    expect(await references.listReleaseReferences(release)).toEqual({
      bindingCount: 1,
      activeOperationCount: 1,
      orphanedOperationCount: 0,
    });
  });

  test("reports generic errors for database failures without exposing SQL or causes", async () => {
    const closedDb = createPgDb(PG_URL);
    await closedDb.execute(sql`select 1`);
    await closedDb.$client.end();
    const unavailable = new SpackMaterialReferences(closedDb);
    const release = binding();
    const input = await operation(release);
    await expectReferenceError(unavailable.registerBindings({ [input.spec]: release }));
    await expectReferenceError(unavailable.acquireOperation(input));
    await expectReferenceError(unavailable.listReleaseReferences(release));
  });

  test("enforces binding uniqueness and the operation primary key", async () => {
    const release = binding();
    const input = await operation(release);
    await references.registerBindings({ [input.spec]: release });
    await expect(
      db
        .insert(spackMaterialBindings)
        .values({ spec: input.spec, ...release })
        .execute(),
    ).rejects.toThrow();
    await references.acquireOperation(input);
    await expect(
      db.insert(spackMaterialOperationReferences).values(input).execute(),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(spackMaterialBindings)
        .where(
          and(
            eq(spackMaterialBindings.repositoryId, release.repositoryId),
            eq(spackMaterialBindings.manifestDigest, release.manifestDigest),
          ),
        ),
    ).toHaveLength(1);
  });
});

async function expectReferenceError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject(REFERENCE_ERROR);
  if (error instanceof Error) {
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual(["code"]);
  }
}

async function waitForAdvisoryWait(db: PgDb, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await db.$client<{ waiting: boolean }[]>`
      select exists (
        select 1 from pg_locks
        where pid = ${pid} and locktype = 'advisory' and not granted
      ) as waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("The reference writer did not wait on the lifecycle advisory lock");
}
