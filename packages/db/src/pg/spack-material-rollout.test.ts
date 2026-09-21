import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "./index";
import { agents, softwareOperations, users } from "./schema";
import {
  type SpackMaterialRolloutEvidence,
  spackMaterialBindings,
  spackMaterialOperationReferences,
  spackMaterialRollouts,
} from "./schema-spack-materials";
import {
  type SpackMaterialOperationReferenceInput,
  type SpackMaterialReferenceBinding,
  SpackMaterialReferences,
} from "./spack-material-references";
import { SpackMaterialRollout } from "./spack-material-rollout";

const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";
const SCHEMA = `spack_rollout_test_${randomUUID().replaceAll("-", "")}`;
const TABLES = [
  "users",
  "agents",
  "software_operations",
  "spack_material_bindings",
  "spack_material_operation_references",
  "spack_material_rollouts",
] as const;
const OPERATOR_ID = randomUUID();
const AGENT_ID = `rollout-agent-${randomUUID()}`;
const EVIDENCE: SpackMaterialRolloutEvidence = {
  legacyProcessesStoppedAndDrained: true,
  legacyAccessRevoked: true,
  legacyInventoryComplete: true,
};
const ROLLOUT_ERROR = {
  code: "SPACK_MATERIAL_ROLLOUT_ERROR",
  message: "Spack material rollout is unavailable or the request is invalid",
};
const REFERENCE_ERROR = {
  code: "SPACK_MATERIAL_REFERENCE_ERROR",
  message: "Spack material reference operation failed",
};
type State = Awaited<ReturnType<SpackMaterialRollout["execute"]>>;
type BindingMap = Record<string, SpackMaterialReferenceBinding>;

// Migrated PostgreSQL is mandatory: missing migrations/connectivity fail the suite.
// LIKE copies constraints/indexes, but not FKs or rows from the shared public tables.
describe("SpackMaterialRollout (isolated real PG)", () => {
  let admin: PgDb;
  let db: PgDb;
  let peerDb: PgDb;
  let observer: PgDb;
  let rollout: SpackMaterialRollout;
  let peer: SpackMaterialRollout;
  let references: SpackMaterialReferences;
  let schemaCreated = false;
  const connections: PgDb[] = [];

  function connect(schema = "public"): PgDb {
    const url = new URL(PG_URL);
    // Preserve isolation even if postgres.js has to reconnect between statements.
    url.searchParams.set("search_path", schema);
    url.searchParams.set("statement_timeout", "10000");
    url.searchParams.set("connect_timeout", "5");
    const connection = createPgDb(url.toString(), { max: 1, idle_timeout: 0 });
    connections.push(connection);
    return connection;
  }

  async function isolatedConnection(): Promise<PgDb> {
    const connection = connect(SCHEMA);
    // No public fallback, including during missing-table tests.
    await connection.execute(sql`set search_path to ${sql.identifier(SCHEMA)}`);
    await connection.execute(sql`set statement_timeout = '10s'`);
    await assertIsolated(connection);
    return connection;
  }

  async function assertIsolated(connection: PgDb): Promise<void> {
    const [row] = await connection.$client<{ schema: string }[]>`
      select current_schema() as schema
    `;
    expect(row?.schema).toBe(SCHEMA);
  }

  function binding(): SpackMaterialReferenceBinding {
    return {
      repositoryId: randomBytes(32).toString("hex"),
      manifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
    };
  }

  async function operation(
    release = binding(),
    overrides: Partial<typeof softwareOperations.$inferInsert> = {},
  ): Promise<SpackMaterialOperationReferenceInput> {
    const input = {
      operationId: randomUUID(),
      agentId: AGENT_ID,
      requestedBy: OPERATOR_ID,
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

  async function populateInventory(kind: "binding" | "reference", count: number): Promise<void> {
    const release = binding();
    const specPrefix = 'accumulated-"quoted"\\spec@';
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '30s'`);
      if (kind === "binding") {
        // Reverse insertion order and repeated leading keys exercise the full
        // (spec, repository_id, manifest_digest) cursor, including JSON escaping.
        await tx.execute(sql`
          insert into ${sql.identifier(SCHEMA)}.spack_material_bindings
            (spec, repository_id, manifest_digest)
          select
            ${specPrefix} || lpad(((ordinal - 1) / 2100)::text, 6, '0'),
            lpad((((ordinal - 1) / 700) % 3)::text, 64, '0'),
            'sha256:' || lpad(to_hex(((ordinal - 1) % 700) + 1), 64, '0')
          from generate_series(1, ${count}::integer) as series(ordinal)
          order by ordinal desc
        `);
        return;
      }
      // Populate both sides together so accumulated terminal references are not
      // mistaken for active installs or orphans. No per-operation API calls.
      await tx.execute(sql`
        with inserted as (
          insert into ${sql.identifier(SCHEMA)}.software_operations
            (id, agent_id, requested_by, spec, action, status)
          select
            ('00000000-0000-4000-8000-' || lpad(to_hex(ordinal), 12, '0'))::uuid,
            ${AGENT_ID},
            ${OPERATOR_ID},
            ${specPrefix} || ordinal::text,
            'install',
            case ordinal % 3
              when 0 then 'succeeded'
              when 1 then 'failed'
              else 'rejected'
            end
          from generate_series(1, ${count}::integer) as series(ordinal)
          order by ordinal desc
          returning id, agent_id, requested_by, spec
        )
        insert into ${sql.identifier(SCHEMA)}.spack_material_operation_references
          (operation_id, agent_id, requested_by, spec, repository_id, manifest_digest)
        select id, agent_id, requested_by, spec, ${release.repositoryId}, ${release.manifestDigest}
        from inserted
      `);
    });
  }

  function pause(expectedRevision = 0, operatorId: string = OPERATOR_ID) {
    return rollout.execute({ action: "pause", expectedRevision, operatorId });
  }

  function reconcile(state: State, bindings: BindingMap[] = []) {
    return rollout.execute({
      action: "reconcile",
      operatorId: OPERATOR_ID,
      expectedRevision: state.revision,
      epoch: state.epoch,
      bindings,
    });
  }

  function activation(state: State) {
    return {
      action: "activate",
      operatorId: OPERATOR_ID,
      expectedRevision: state.revision,
      epoch: state.epoch,
      inventoryDigest: state.inventoryDigest,
      evidence: EVIDENCE,
    };
  }

  function epoch(state: State): string {
    if (!state.epoch) throw new Error("Expected a persisted rollout epoch");
    return state.epoch;
  }

  async function ready(): Promise<State> {
    return rollout.execute(activation(await reconcile(await pause())));
  }

  function journal() {
    return db.select().from(spackMaterialRollouts).orderBy(spackMaterialRollouts.revision);
  }

  beforeAll(async () => {
    admin = connect();
    await admin.execute(sql`set search_path to public`);
    // Check every column used by the real schemas before cloning any tables.
    await admin.select().from(users).limit(0);
    await admin.select().from(agents).limit(0);
    await admin.select().from(softwareOperations).limit(0);
    await admin.select().from(spackMaterialBindings).limit(0);
    await admin.select().from(spackMaterialOperationReferences).limit(0);
    await admin.select().from(spackMaterialRollouts).limit(0);
    await admin.execute(sql`create schema ${sql.identifier(SCHEMA)}`);
    schemaCreated = true;
    for (const table of TABLES) {
      await admin.execute(sql`
        create table ${sql.identifier(SCHEMA)}.${sql.identifier(table)}
        (like public.${sql.identifier(table)} including all)
      `);
    }
    db = await isolatedConnection();
    peerDb = await isolatedConnection();
    observer = await isolatedConnection();
    rollout = new SpackMaterialRollout(db);
    peer = new SpackMaterialRollout(peerDb);
    references = new SpackMaterialReferences(db);
  }, 30_000);

  beforeEach(async () => {
    await assertIsolated(db);
    await assertIsolated(peerDb);
    // Fully qualified cleanup cannot touch public, even if a connection loses its path.
    for (const table of [...TABLES].reverse()) {
      await db.execute(sql`truncate table ${sql.identifier(SCHEMA)}.${sql.identifier(table)}`);
    }
    await db.insert(users).values({
      id: OPERATOR_ID,
      email: `rollout-${OPERATOR_ID}@example.invalid`,
      role: "super_admin",
    });
    await db.insert(agents).values({
      agentId: AGENT_ID,
      siteName: "rollout-test",
      schedulerType: "slurm",
      schedulerVersion: "test",
    });
  });

  afterAll(async () => {
    try {
      if (schemaCreated) {
        await admin.execute(sql`drop schema ${sql.identifier(SCHEMA)} cascade`);
      }
    } finally {
      await Promise.all(connections.map((connection) => connection.$client.end()));
    }
  }, 30_000);

  test("resolves all six tables only inside the dedicated schema on both connections", async () => {
    for (const connection of [db, peerDb]) {
      for (const table of TABLES) {
        const [row] = await connection.$client<{ schema: string }[]>`
          select n.nspname as schema
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.oid = to_regclass(${table})
        `;
        expect(row?.schema).toBe(SCHEMA);
      }
    }
  });

  test("inspect is observe-only without a journal and permits only an absent runtime epoch", async () => {
    const initial = await rollout.execute({ action: "inspect" });
    expect(initial).toEqual({
      revision: 0,
      epoch: null,
      phase: "observe",
      action: null,
      inventoryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      bindingCount: 0,
      operationReferenceCount: 0,
      activeInstallCount: 0,
      orphanedOperationCount: 0,
    });
    await rollout.assertRuntime();
    await expectError(rollout.assertRuntime(randomUUID()));
    const release = binding();
    const input = await operation(release);
    await references.registerBindings({ [input.spec]: release });
    await references.acquireOperation(input);
    expect(await peer.execute({ action: "inspect" })).toMatchObject({
      revision: 0,
      phase: "observe",
      bindingCount: 1,
      operationReferenceCount: 1,
      activeInstallCount: 1,
    });
    expect(await journal()).toEqual([]);
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(1);
    const unexpectedEpoch = new SpackMaterialReferences(peerDb, randomUUID());
    await expectError(unexpectedEpoch.registerBindings({}), REFERENCE_ERROR);
    await expectError(unexpectedEpoch.acquireOperation(input), REFERENCE_ERROR);
  });

  test("retains immutable history, replaced bindings and terminal references across two cycles", async () => {
    const original = binding();
    const replacement = { ...original, manifestDigest: binding().manifestDigest };
    const other = binding();
    const input = await operation(original);
    await references.registerBindings({ [input.spec]: original });
    await references.acquireOperation(input);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    const oldBindings = await db.select().from(spackMaterialBindings);
    const oldReferences = await db.select().from(spackMaterialOperationReferences);
    const paused = await pause();
    expect(paused).toMatchObject({ revision: 1, phase: "paused", action: "pause" });
    const merged = await reconcile(paused, [
      { [input.spec]: original },
      { [input.spec]: replacement },
      { "hdf5@1.14": other, [input.spec]: original },
      {},
    ]);
    expect(merged).toMatchObject({
      revision: 2,
      epoch: paused.epoch,
      phase: "paused",
      action: "reconcile",
      bindingCount: 3,
      operationReferenceCount: 1,
      activeInstallCount: 0,
      orphanedOperationCount: 0,
    });
    const deduplicated = await reconcile(merged, [{ [input.spec]: replacement }, {}]);
    expect(deduplicated.inventoryDigest).toBe(merged.inventoryDigest);
    expect(deduplicated.bindingCount).toBe(3);
    const activated = await rollout.execute(activation(deduplicated));
    expect(activated).toEqual({
      ...deduplicated,
      revision: 4,
      phase: "ready",
      action: "activate",
    });
    const firstHistory = await journal();
    expect(firstHistory.map((row) => row.action)).toEqual([
      "pause",
      "reconcile",
      "reconcile",
      "activate",
    ]);
    expect(firstHistory.map((row) => row.evidence)).toEqual([null, null, null, EVIDENCE]);
    expect(firstHistory.every((row) => row.operatorId === OPERATOR_ID)).toBe(true);
    const pausedAgain = await pause(activated.revision);
    expect(pausedAgain.epoch).not.toBe(activated.epoch);
    const activatedAgain = await rollout.execute(activation(await reconcile(pausedAgain)));
    expect(activatedAgain).toMatchObject({
      revision: 7,
      bindingCount: 3,
      operationReferenceCount: 1,
      inventoryDigest: activated.inventoryDigest,
    });
    expect((await journal()).slice(0, firstHistory.length)).toEqual(firstHistory);
    expect(await db.select().from(spackMaterialBindings)).toEqual(
      expect.arrayContaining(oldBindings),
    );
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(oldReferences);
    expect(await peer.execute({ action: "inspect" })).toEqual(activatedAgain);
  });

  test.each([
    "super_admin",
    "platform_admin",
  ])("accepts a current %s operator and canonicalizes its UUID", async (role) => {
    await db.update(users).set({ role }).where(eq(users.id, OPERATOR_ID));
    const paused = await pause(0, OPERATOR_ID.toUpperCase());
    expect(paused.revision).toBe(1);
    expect((await journal())[0]?.operatorId).toBe(OPERATOR_ID);
  });

  test.each([
    ["user", false],
    ["admin", false],
    ["org_admin", false],
    ["provider_admin", false],
    ["super_admin", true],
    ["platform_admin", true],
  ] as const)("rejects role %s with suspended=%s without a journal write", async (role, suspended) => {
    await db.update(users).set({ role, suspended }).where(eq(users.id, OPERATOR_ID));
    await expectError(pause());
    expect(await journal()).toEqual([]);
  });

  test("rejects nonexistent operators and rechecks current role/suspension on every mutation", async () => {
    await expectError(pause(0, randomUUID()));
    const paused = await pause();
    await db.update(users).set({ role: "user" }).where(eq(users.id, OPERATOR_ID));
    await expectError(reconcile(paused, [{ "zlib@1.3": binding() }]));
    expect(await db.select().from(spackMaterialBindings)).toEqual([]);
    await db.update(users).set({ role: "platform_admin" }).where(eq(users.id, OPERATOR_ID));
    const merged = await reconcile(paused);
    await db.update(users).set({ suspended: true }).where(eq(users.id, OPERATOR_ID));
    await expectError(rollout.execute(activation(merged)));
    await expectError(pause(merged.revision));
    expect(await journal()).toHaveLength(2);
    await db.update(users).set({ suspended: false }).where(eq(users.id, OPERATOR_ID));
    expect((await rollout.execute(activation(merged))).phase).toBe("ready");
  });

  test("racing pause commands with the same expectedRevision have exactly one winner", async () => {
    const command = { action: "pause", operatorId: OPERATOR_ID, expectedRevision: 0 };
    const winner = await oneWinner([rollout.execute(command), peer.execute(command)]);
    expect(winner).toMatchObject({ revision: 1, phase: "paused", action: "pause" });
    expect(await journal()).toHaveLength(1);
    expect(await peer.execute({ action: "inspect" })).toEqual(winner);
  });

  test("racing activations have exactly one winner and retain one activation row", async () => {
    const merged = await reconcile(await pause());
    const command = activation(merged);
    const winner = await oneWinner([rollout.execute(command), peer.execute(command)]);
    expect(winner).toMatchObject({ revision: 3, phase: "ready", epoch: merged.epoch });
    expect((await journal()).map((row) => row.action)).toEqual(["pause", "reconcile", "activate"]);
  });

  test("pause racing activation uses the same CAS and never appends both transitions", async () => {
    const merged = await reconcile(await pause());
    const winner = await oneWinner([pause(merged.revision), peer.execute(activation(merged))]);
    expect(winner.revision).toBe(3);
    expect(["pause", "activate"]).toContain(winner.action);
    expect(await journal()).toHaveLength(3);
    expect(await rollout.execute({ action: "inspect" })).toEqual(winner);
    if (winner.action === "pause") {
      expect(winner.epoch).not.toBe(merged.epoch);
      await expectError(rollout.assertRuntime(epoch(merged)));
    } else {
      expect(winner.epoch).toBe(merged.epoch);
      await rollout.assertRuntime(epoch(merged));
    }
  });

  test("exact retries and stale revisions reject without rewriting successful commands", async () => {
    const paused = await pause();
    await expectError(pause());
    const release = binding();
    const merged = await reconcile(paused, [{ "zlib@1.3": release }]);
    const rows = await db.select().from(spackMaterialBindings);
    await expectError(reconcile(paused, [{ "zlib@1.3": release }]));
    await expectError(reconcile(paused, [{ "hdf5@1.14": binding() }]));
    const activated = await rollout.execute(activation(merged));
    const history = await journal();
    await expectError(rollout.execute(activation(merged)));
    await expectError(pause(merged.revision));
    expect(await journal()).toEqual(history);
    expect(await db.select().from(spackMaterialBindings)).toEqual(rows);
    expect(await rollout.execute({ action: "inspect" })).toEqual(activated);
  });

  test("reconcile and activate require a current paused epoch and revision", async () => {
    const absent = { ...(await rollout.execute({ action: "inspect" })), epoch: randomUUID() };
    await expectError(reconcile(absent));
    await expectError(rollout.execute(activation(absent)));
    const paused = await pause();
    await expectError(reconcile({ ...paused, epoch: randomUUID() }));
    await expectError(reconcile({ ...paused, revision: paused.revision + 1 }));
    const merged = await reconcile(paused);
    await expectError(rollout.execute(activation({ ...merged, epoch: randomUUID() })));
    await expectError(rollout.execute(activation({ ...merged, revision: merged.revision + 1 })));
    const activated = await rollout.execute(activation(merged));
    await expectError(reconcile(activated));
    await expectError(rollout.execute(activation(activated)));
    expect(await journal()).toHaveLength(3);
  });

  test("activation without a preceding reconcile is rejected even with exact digest and evidence", async () => {
    const paused = await pause();
    await expectError(rollout.execute(activation(paused)));
    const repaused = await pause(paused.revision);
    await expectError(rollout.execute(activation(repaused)));
    expect((await journal()).map((row) => row.action)).toEqual(["pause", "pause"]);
    const activated = await rollout.execute(activation(await reconcile(repaused)));
    expect(activated.phase).toBe("ready");
  });

  test.each([
    ["queued", false],
    ["running", false],
    ["queued", true],
    ["running", true],
  ] as const)("blocks %s installs with registered reference=%s", async (status, registered) => {
    const input = await operation(binding(), { status });
    if (registered) await references.acquireOperation(input);
    const merged = await reconcile(await pause());
    expect(merged).toMatchObject({
      activeInstallCount: 1,
      operationReferenceCount: registered ? 1 : 0,
      orphanedOperationCount: 0,
    });
    await expectError(rollout.execute(activation(merged)));
    expect(await journal()).toHaveLength(2);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    const drained = await rollout.execute({ action: "inspect" });
    expect(drained.inventoryDigest).toBe(merged.inventoryDigest);
    expect(drained.activeInstallCount).toBe(0);
    expect((await rollout.execute(activation(merged))).phase).toBe("ready");
  });

  test("terminal installs and active non-install operations do not block activation", async () => {
    for (const status of ["succeeded", "failed", "rejected"]) {
      const input = await operation();
      await references.acquireOperation(input);
      await db
        .update(softwareOperations)
        .set({ status })
        .where(eq(softwareOperations.id, input.operationId));
    }
    for (const action of ["uninstall", "load", "import_preinstalled"]) {
      await operation(binding(), { action, status: "running" });
    }
    const merged = await reconcile(await pause());
    expect(merged).toMatchObject({
      activeInstallCount: 0,
      operationReferenceCount: 3,
      orphanedOperationCount: 0,
    });
    expect((await rollout.execute(activation(merged))).phase).toBe("ready");
    expect(await db.select().from(spackMaterialOperationReferences)).toHaveLength(3);
  });

  test.each([
    "binding",
    "reference",
  ] as const)("can pause and reactivate after accumulating 100001 terminal-safe %s inventory rows", async (kind) => {
    const activated = await ready();
    const previousHistory = await journal();
    await populateInventory(kind, 100_001);
    await rollout.assertRuntime(epoch(activated));
    const counts = {
      bindingCount: kind === "binding" ? 100_001 : 0,
      operationReferenceCount: kind === "reference" ? 100_001 : 0,
      activeInstallCount: 0,
      orphanedOperationCount: 0,
    };
    const paused = await pause(activated.revision);
    expect(paused).toMatchObject({
      ...counts,
      revision: activated.revision + 1,
      phase: "paused",
      action: "pause",
    });
    expect(epoch(paused)).not.toBe(epoch(activated));
    expect(paused.inventoryDigest).not.toBe(activated.inventoryDigest);
    await expectError(rollout.assertRuntime(epoch(activated)));
    expect(await peer.execute({ action: "inspect" })).toEqual(paused);

    const merged = await reconcile(paused);
    expect(merged).toEqual({
      ...paused,
      revision: paused.revision + 1,
      action: "reconcile",
    });
    const reactivated = await rollout.execute(activation(merged));
    expect(reactivated).toEqual({
      ...merged,
      revision: merged.revision + 1,
      phase: "ready",
      action: "activate",
    });
    await rollout.assertRuntime(epoch(reactivated));
    await expectError(rollout.assertRuntime(epoch(activated)));
    const history = await journal();
    expect(history).toHaveLength(6);
    expect(history.slice(0, previousHistory.length)).toEqual(previousHistory);
  }, 180_000);

  test.each([
    999, 1_000, 1_001, 3_001,
  ])("matches an independent canonical JSON hash with %s rows in each paged inventory", async (count) => {
    await populateInventory("binding", count);
    await populateInventory("reference", count);
    // The oracle loads each complete sorted inventory once, with no keyset
    // pagination or streaming/framing logic shared with the implementation.
    const bindings = await db
      .select({
        spec: spackMaterialBindings.spec,
        repositoryId: spackMaterialBindings.repositoryId,
        manifestDigest: spackMaterialBindings.manifestDigest,
      })
      .from(spackMaterialBindings)
      .orderBy(
        spackMaterialBindings.spec,
        spackMaterialBindings.repositoryId,
        spackMaterialBindings.manifestDigest,
      );
    const operationReferences = await db
      .select({
        operationId: spackMaterialOperationReferences.operationId,
        agentId: spackMaterialOperationReferences.agentId,
        requestedBy: spackMaterialOperationReferences.requestedBy,
        spec: spackMaterialOperationReferences.spec,
        repositoryId: spackMaterialOperationReferences.repositoryId,
        manifestDigest: spackMaterialOperationReferences.manifestDigest,
      })
      .from(spackMaterialOperationReferences)
      .orderBy(spackMaterialOperationReferences.operationId);
    expect(bindings).toHaveLength(count);
    expect(operationReferences).toHaveLength(count);
    const canonicalDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify({ bindings, references: operationReferences }))
      .digest("hex")}`;
    const observed = await rollout.execute({ action: "inspect" });
    expect(observed).toMatchObject({
      revision: 0,
      phase: "observe",
      inventoryDigest: canonicalDigest,
      bindingCount: count,
      operationReferenceCount: count,
      activeInstallCount: 0,
      orphanedOperationCount: 0,
    });
    const paused = await pause(observed.revision);
    expect(paused.inventoryDigest).toBe(canonicalDigest);
    expect(paused.bindingCount).toBe(count);
    expect(paused.operationReferenceCount).toBe(count);
    expect(await peer.execute({ action: "inspect" })).toEqual(paused);
  }, 60_000);

  test("orphan references block activation even when the deleted operation was terminal", async () => {
    const input = await operation();
    await references.acquireOperation(input);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    await db.delete(softwareOperations).where(eq(softwareOperations.id, input.operationId));
    const merged = await reconcile(await pause());
    expect(merged).toMatchObject({
      activeInstallCount: 0,
      operationReferenceCount: 1,
      orphanedOperationCount: 1,
    });
    await expectError(rollout.execute(activation(merged)));
    const rereconciled = await reconcile(merged);
    await expectError(rollout.execute(activation(rereconciled)));
    expect(await db.select().from(spackMaterialOperationReferences)).toMatchObject([input]);
    expect((await rollout.execute({ action: "inspect" })).phase).toBe("paused");
  });

  test.each([
    "binding",
    "reference",
  ] as const)("rejects activation after the %s inventory changes without changing the revision", async (kind) => {
    const input = await operation(binding(), { status: "succeeded" });
    const merged = await reconcile(await pause());
    // Model an out-of-band legacy writer, not an admitted fenced reference API call.
    if (kind === "binding") {
      await db.insert(spackMaterialBindings).values({ spec: input.spec, ...binding() });
    } else {
      await db.insert(spackMaterialOperationReferences).values(input);
    }
    const changed = await peer.execute({ action: "inspect" });
    expect(changed.revision).toBe(merged.revision);
    expect(changed.inventoryDigest).not.toBe(merged.inventoryDigest);
    expect(changed.activeInstallCount).toBe(0);
    expect(changed.orphanedOperationCount).toBe(0);
    await expectError(rollout.execute(activation(merged)));
    await expectError(rollout.execute(activation(changed)));
    expect(await journal()).toHaveLength(2);
    const refreshed = await reconcile(changed);
    expect((await rollout.execute(activation(refreshed))).phase).toBe("ready");
  });

  test.each([
    "legacyProcessesStoppedAndDrained",
    "legacyAccessRevoked",
    "legacyInventoryComplete",
  ] as const)("requires missing/false evidence field %s to fail closed", async (field) => {
    const merged = await reconcile(await pause());
    const missing: Partial<SpackMaterialRolloutEvidence> = { ...EVIDENCE };
    delete missing[field];
    for (const evidence of [missing, { ...EVIDENCE, [field]: false }]) {
      await expectError(rollout.execute({ ...activation(merged), evidence }));
      expect(await journal()).toHaveLength(2);
    }
    expect((await rollout.execute(activation(merged))).phase).toBe("ready");
  });

  test("rejects invalid commands, identifiers, revisions, digest and evidence without writes", async () => {
    const command = { action: "pause", operatorId: OPERATOR_ID, expectedRevision: 0 };
    const invalid: unknown[] = [
      null,
      [],
      "pause",
      {},
      { action: "unknown" },
      { action: "inspect", operatorId: OPERATOR_ID },
      { action: "pause", expectedRevision: 0 },
      { action: "pause", operatorId: OPERATOR_ID },
      { ...command, extra: true },
    ];
    for (const operatorId of [
      "",
      "not-a-uuid",
      ` ${OPERATOR_ID}`,
      OPERATOR_ID.replaceAll("-", ""),
    ]) {
      invalid.push({ ...command, operatorId });
    }
    for (const expectedRevision of [-1, 0.5, "0", null, Number.NaN, Infinity, 2_147_483_647]) {
      invalid.push({ ...command, expectedRevision });
    }
    for (const value of invalid) await expectError(rollout.execute(value));
    expect(await journal()).toEqual([]);
    const merged = await reconcile(await pause());
    for (const epoch of [undefined, "", "not-a-uuid", `${merged.epoch}\n`]) {
      await expectError(rollout.execute({ ...activation(merged), epoch }));
    }
    for (const inventoryDigest of [
      "",
      "a".repeat(64),
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      `sha256:${"a".repeat(64)}`,
    ]) {
      await expectError(rollout.execute({ ...activation(merged), inventoryDigest }));
    }
    for (const evidence of [undefined, null, {}, [], { ...EVIDENCE, extra: true }]) {
      await expectError(rollout.execute({ ...activation(merged), evidence }));
    }
    expect(await journal()).toHaveLength(2);
  });

  test("validates reconcile batches atomically, including strict bindings and aggregate limits", async () => {
    const paused = await pause();
    const release = binding();
    const command = {
      action: "reconcile",
      operatorId: OPERATOR_ID,
      expectedRevision: paused.revision,
      epoch: paused.epoch,
    };
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      [null],
      Array.from({ length: 65 }, () => ({})),
      [{ valid: release, "": release }],
      [{ valid: release, " leading": release }],
      [{ valid: release, "trailing ": release }],
      [{ valid: release, "zlib\nbad": release }],
      [{ valid: release, ["x".repeat(501)]: release }],
      [{ valid: release, bad: { ...release, repositoryId: "A".repeat(64) } }],
      [{ valid: release, bad: { ...release, manifestDigest: "invalid" } }],
      [{ valid: release, bad: { ...release, extra: true } }],
    ];
    const batch = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`package-${index}`, release]),
    );
    invalid.push([batch, batch]);
    for (const bindings of invalid) {
      await expectError(rollout.execute({ ...command, bindings }));
      expect(await db.select().from(spackMaterialBindings)).toEqual([]);
      expect(await journal()).toHaveLength(1);
    }
    expect((await reconcile(paused, [{ ["x".repeat(500)]: release }])).bindingCount).toBe(1);
  });

  test("runtime and reference writes require the ready epoch, including after a later cycle", async () => {
    const activated = await ready();
    await rollout.assertRuntime(epoch(activated));
    await rollout.assertRuntime(epoch(activated).toUpperCase());
    const release = binding();
    const input = await operation(release);
    for (const suppliedEpoch of [undefined, randomUUID(), "", "not-a-uuid"]) {
      await expectError(rollout.assertRuntime(suppliedEpoch));
      const fenced = new SpackMaterialReferences(peerDb, suppliedEpoch);
      await expectError(fenced.registerBindings({}), REFERENCE_ERROR);
      await expectError(fenced.acquireOperation(input), REFERENCE_ERROR);
    }
    const admitted = new SpackMaterialReferences(peerDb, epoch(activated));
    await admitted.registerBindings({ [input.spec]: release });
    await admitted.acquireOperation(input);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    const pausedAgain = await pause(activated.revision);
    for (const suppliedEpoch of [undefined, epoch(activated), epoch(pausedAgain)]) {
      await expectError(rollout.assertRuntime(suppliedEpoch));
    }
    const activatedAgain = await rollout.execute(activation(await reconcile(pausedAgain)));
    await expectError(rollout.assertRuntime(epoch(activated)));
    await expectError(admitted.registerBindings({}), REFERENCE_ERROR);
    const nextInput = await operation();
    await expectError(admitted.acquireOperation(nextInput), REFERENCE_ERROR);
    await rollout.assertRuntime(epoch(activatedAgain));
    const current = new SpackMaterialReferences(peerDb, epoch(activatedAgain));
    await current.registerBindings({});
    await current.acquireOperation(nextInput);
  });

  test.each([
    "registerBindings",
    "acquireOperation",
  ] as const)("the same reference instance rechecks pause on %s, including an exact retry", async (method) => {
    const activated = await ready();
    const release = binding();
    const input = await operation(release);
    const instance = new SpackMaterialReferences(peerDb, epoch(activated));
    const write = () =>
      method === "registerBindings"
        ? instance.registerBindings({ [input.spec]: release })
        : instance.acquireOperation(input);
    await write();
    const bindings = await db.select().from(spackMaterialBindings);
    const acquired = await db.select().from(spackMaterialOperationReferences);
    await pause(activated.revision);
    await expectError(write(), REFERENCE_ERROR);
    await expectError(instance.registerBindings({}), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialBindings)).toEqual(bindings);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(acquired);
  });

  test.each([
    "users",
    "software_operations",
    "spack_material_bindings",
    "spack_material_operation_references",
    "spack_material_rollouts",
  ] as const)("fails closed when isolated table %s is missing", async (table) => {
    const input = await operation();
    const hidden = `${table}_hidden`;
    await db.execute(sql`
      alter table ${sql.identifier(SCHEMA)}.${sql.identifier(table)}
      rename to ${sql.identifier(hidden)}
    `);
    try {
      await expectError(pause());
      if (table !== "users") await expectError(rollout.execute({ action: "inspect" }));
      if (table === "spack_material_rollouts") {
        await expectError(rollout.assertRuntime());
        await expectError(rollout.assertRuntime(randomUUID()));
        await expectError(references.registerBindings({}), REFERENCE_ERROR);
        await expectError(references.acquireOperation(input), REFERENCE_ERROR);
      }
    } finally {
      await db.execute(sql`
        alter table ${sql.identifier(SCHEMA)}.${sql.identifier(hidden)}
        rename to ${sql.identifier(table)}
      `);
    }
    expect(await journal()).toEqual([]);
    expect((await pause()).revision).toBe(1);
  });

  test("closed database connections fail with sanitized rollout and reference errors", async () => {
    const closedDb = await isolatedConnection();
    await closedDb.$client.end();
    const unavailable = new SpackMaterialRollout(closedDb);
    const unavailableReferences = new SpackMaterialReferences(closedDb);
    const input = await operation();
    await expectError(unavailable.execute({ action: "inspect" }));
    await expectError(
      unavailable.execute({ action: "pause", operatorId: OPERATOR_ID, expectedRevision: 0 }),
    );
    await expectError(unavailable.assertRuntime());
    await expectError(unavailableReferences.registerBindings({}), REFERENCE_ERROR);
    await expectError(unavailableReferences.acquireOperation(input), REFERENCE_ERROR);
    expect(await journal()).toEqual([]);
  });

  test("a database failure during reconcile rolls back bindings and preserves the paused journal", async () => {
    const paused = await pause();
    const history = await journal();
    const release = binding();
    await db.execute(sql`
      alter table ${sql.identifier(SCHEMA)}.software_operations
      rename to software_operations_hidden
    `);
    try {
      await expectError(reconcile(paused, [{ "zlib@1.3": release }]));
    } finally {
      await db.execute(sql`
        alter table ${sql.identifier(SCHEMA)}.software_operations_hidden
        rename to software_operations
      `);
    }
    expect(await db.select().from(spackMaterialBindings)).toEqual([]);
    expect(await journal()).toEqual(history);
    const merged = await reconcile(paused, [{ "zlib@1.3": release }]);
    expect(merged.bindingCount).toBe(1);
    expect((await rollout.execute(activation(merged))).phase).toBe("ready");
  });

  test.each([
    "registerBindings",
    "acquireOperation",
  ] as const)("%s waits for the lifecycle lock and checks the fence after a pause commits", async (method) => {
    const activated = await ready();
    const release = binding();
    const input = await operation(release);
    const instance = new SpackMaterialReferences(peerDb, epoch(activated));
    const pid = await backendPid(peerDb);
    let pending: ReturnType<typeof settle> | undefined;
    // Session locks are reentrant on this backend, letting the real pause API run
    // while the peer is already waiting at the reference transaction boundary.
    await db.execute(sql`
      select pg_advisory_lock(hashtext('kuintessence:spack-material-lifecycle'))
    `);
    try {
      pending = settle(
        method === "registerBindings"
          ? instance.registerBindings({ [input.spec]: release })
          : instance.acquireOperation(input),
      );
      await waitForLock(observer, pid, "advisory");
      await pause(activated.revision);
    } finally {
      try {
        await db.execute(sql`
          select pg_advisory_unlock(hashtext('kuintessence:spack-material-lifecycle'))
        `);
      } finally {
        await pending;
      }
    }
    const outcome = await pending;
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) assertError(outcome.error, REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialBindings)).toEqual([]);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual([]);
  }, 20_000);

  test("activation waits for an uncommitted unregistered install and rejects after it commits", async () => {
    const merged = await reconcile(await pause());
    const pid = await backendPid(peerDb);
    const work: { pending?: ReturnType<typeof settle> } = {};
    try {
      await db.transaction(async (tx) => {
        await tx.insert(softwareOperations).values({
          id: randomUUID(),
          agentId: AGENT_ID,
          requestedBy: OPERATOR_ID,
          action: "install",
          status: "queued",
          spec: "unregistered@1",
        });
        work.pending = settle(peer.execute(activation(merged)));
        await waitForLock(observer, pid, "relation");
      });
    } finally {
      await work.pending;
    }
    const outcome = await work.pending;
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) assertError(outcome.error, ROLLOUT_ERROR);
    expect(await rollout.execute({ action: "inspect" })).toMatchObject({
      revision: merged.revision,
      phase: "paused",
      activeInstallCount: 1,
      operationReferenceCount: 0,
      inventoryDigest: merged.inventoryDigest,
    });
    expect(await journal()).toHaveLength(2);
  }, 20_000);
});

function assertError(error: unknown, expected = ROLLOUT_ERROR): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject(expected);
  if (error instanceof Error) {
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual(["code"]);
  }
}

async function expectError(promise: Promise<unknown>, expected = ROLLOUT_ERROR): Promise<void> {
  const result = await settle(promise);
  expect(result.ok).toBe(false);
  if (!result.ok) assertError(result.error, expected);
}

function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function oneWinner(commands: Promise<State>[]): Promise<State> {
  const outcomes = await Promise.allSettled(commands);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  let winner: State | undefined;
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") assertError(outcome.reason);
    else winner = outcome.value;
  }
  if (!winner) throw new Error("Expected exactly one successful rollout command");
  return winner;
}

async function backendPid(db: PgDb): Promise<number> {
  const [row] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  if (!row) throw new Error("Expected a PostgreSQL backend PID");
  return row.pid;
}

async function waitForLock(db: PgDb, pid: number, kind: "advisory" | "relation"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await db.$client<{ waiting: boolean }[]>`
      select exists (
        select 1 from pg_locks
        where pid = ${pid} and not granted and locktype = ${kind}
          and (
            ${kind} = 'advisory'
            or (
              relation = to_regclass(${`${SCHEMA}.software_operations`})
              and mode = 'ShareLock'
            )
          )
      ) as waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`Expected backend ${pid} to wait for the ${kind} lock`);
}
