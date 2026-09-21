import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "./index";
import { agents, softwareOperations, users } from "./schema";
import {
  spackMaterialBindingRetirements,
  spackMaterialBindings,
  spackMaterialOperationReferences,
  spackMaterialRollouts,
} from "./schema-spack-materials";
import { SpackMaterialReferences } from "./spack-material-references";
import { SpackMaterialRollout } from "./spack-material-rollout";

const SCHEMA = `spack_retirement_${randomUUID().replaceAll("-", "")}`;
const TABLES = [
  "users",
  "agents",
  "software_operations",
  "spack_material_bindings",
  "spack_material_operation_references",
  "spack_material_rollouts",
  "spack_material_binding_retirements",
];
const OPERATOR = randomUUID();
const AGENT = `retirement-${randomUUID()}`;
const SPEC = "hello@2.12.1";
const EVIDENCE = {
  legacyProcessesStoppedAndDrained: true,
  legacyAccessRevoked: true,
  legacyInventoryComplete: true,
} as const;
const ERROR = { code: "SPACK_MATERIAL_ROLLOUT_ERROR" };
const REFERENCE_ERROR = { code: "SPACK_MATERIAL_REFERENCE_ERROR" };
type State = Awaited<ReturnType<SpackMaterialRollout["execute"]>>;

// Real migrated PG only. Clone tables without public fallback or shared test mutations.
describe("Spack binding retirement (isolated real PG)", () => {
  let admin: PgDb;
  let db: PgDb;
  let peerDb: PgDb;
  let rollout: SpackMaterialRollout;
  let peer: SpackMaterialRollout;
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
    const result = createPgDb(url.toString(), { max: 1, idle_timeout: 0 });
    connections.push(result);
    return result;
  }
  function release() {
    return {
      repositoryId: randomBytes(32).toString("hex"),
      manifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
    };
  }
  function inspect() {
    return rollout.execute({ action: "inspect" });
  }
  function pause(revision = 0) {
    return rollout.execute({ action: "pause", operatorId: OPERATOR, expectedRevision: revision });
  }
  function reconcile(state: State, bindings: unknown[] = []) {
    return rollout.execute({
      action: "reconcile",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      bindings,
    });
  }
  function activation(state: State) {
    return {
      action: "activate",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      inventoryDigest: state.inventoryDigest,
      evidence: EVIDENCE,
    };
  }
  function retirement(state: State, bindings: unknown[]) {
    return {
      ...activation(state),
      action: "retire",
      bindings,
      reason: "Replaced deployment binding; rollback configurations removed",
      evidence: { ...EVIDENCE, bindingConfigurationsRemoved: true },
    };
  }
  function references(state: State) {
    if (!state.epoch) throw new Error("Expected persisted epoch");
    return new SpackMaterialReferences(db, state.epoch);
  }
  async function operation(binding: ReturnType<typeof release>, status = "queued") {
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
      status,
    });
    return input;
  }
  async function fixture() {
    const binding = release();
    const bindings = [{ [SPEC]: binding }];
    const state = await reconcile(await pause(), bindings);
    return { binding, bindings, state, command: retirement(state, bindings) };
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
    peer = new SpackMaterialRollout(peerDb);
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
      siteName: "retirement-test",
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

  test("retires without deleting history and permanently rejects stale registration or acquisition", async () => {
    const { binding, bindings, state, command } = await fixture();
    const historicalBindings = await db.select().from(spackMaterialBindings);
    const retired = await rollout.execute(command);
    expect(retired).toMatchObject({
      phase: "paused",
      action: "retire",
      revision: state.revision + 1,
      bindingCount: 1,
      retiredBindingCount: 1,
    });
    expect(retired.inventoryDigest).not.toBe(state.inventoryDigest);
    expect(await db.select().from(spackMaterialBindings)).toEqual(historicalBindings);
    expect(await db.select().from(spackMaterialBindingRetirements)).toMatchObject([
      {
        bindingId: historicalBindings[0]?.id,
        operatorId: OPERATOR,
        epoch: state.epoch,
        revision: retired.revision,
        reason: command.reason,
        evidence: command.evidence,
      },
    ]);
    await expect(rollout.execute(activation(retired))).rejects.toMatchObject(ERROR);
    // Reconciliation retains history; it cannot resurrect a retired binding.
    const reconciled = await reconcile(retired, bindings);
    expect(reconciled.inventoryDigest).toBe(retired.inventoryDigest);
    const ready = await rollout.execute(activation(reconciled));
    const reference = references(ready);
    await reference.registerBindings({});
    await expect(reference.registerBindings(bindings[0] ?? {})).rejects.toMatchObject(
      REFERENCE_ERROR,
    );
    const input = await operation(binding);
    await expect(reference.acquireOperation(input)).rejects.toMatchObject(REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual([]);
    const replacement = { ...binding, manifestDigest: release().manifestDigest };
    await expect(
      reference.registerBindings({ replacement, [SPEC]: binding }),
    ).rejects.toMatchObject(REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialBindings)).toEqual(historicalBindings);
    await reference.registerBindings({ [SPEC]: replacement });
    await reference.acquireOperation(await operation(replacement));
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(2);
  });

  test("preserves terminal references and rechecks retirement even for a previously acquired operation", async () => {
    const binding = release();
    const reference = new SpackMaterialReferences(db);
    await reference.registerBindings({ [SPEC]: binding });
    const input = await operation(binding);
    await reference.acquireOperation(input);
    await db.update(softwareOperations).set({ status: "succeeded" });
    const historical = await db.select().from(spackMaterialOperationReferences);
    const state = await reconcile(await pause());
    const retired = await rollout.execute(retirement(state, [{ [SPEC]: binding }]));
    const ready = await rollout.execute(activation(await reconcile(retired)));
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
    await db.update(softwareOperations).set({ status: "queued" });
    await expect(references(ready).acquireOperation(input)).rejects.toMatchObject(REFERENCE_ERROR);
  });

  test.each([
    "queued",
    "running",
  ])("rejects %s installs even without registered references", async (status) => {
    const { command, state } = await fixture();
    await operation(release(), status);
    await expect(rollout.execute(command)).rejects.toMatchObject(ERROR);
    expect((await inspect()).revision).toBe(state.revision);
    expect(await db.select().from(spackMaterialBindingRetirements)).toEqual([]);
  });

  test("rejects orphan references even when they belong to another release", async () => {
    const { command } = await fixture();
    await db.insert(spackMaterialOperationReferences).values({
      operationId: randomUUID(),
      agentId: AGENT,
      requestedBy: OPERATOR,
      spec: SPEC,
      ...release(),
    });
    const state = await reconcile(await inspect());
    await expect(rollout.execute(retirement(state, command.bindings))).rejects.toMatchObject(ERROR);
    expect(await db.select().from(spackMaterialBindingRetirements)).toEqual([]);
  });

  test.each([
    { role: "user", suspended: false },
    { role: "cp_admin", suspended: false },
    { role: "platform_admin", suspended: true },
  ])("requires a current nonsuspended platform operator: %j", async (actor) => {
    const { command } = await fixture();
    await db.update(users).set(actor).where(eq(users.id, OPERATOR));
    await expect(rollout.execute(command)).rejects.toMatchObject(ERROR);
    expect(await db.select().from(spackMaterialBindingRetirements)).toEqual([]);
  });

  test("rejects missing, mismatched and stale rollout state without partial writes", async () => {
    const { state, command } = await fixture();
    for (const invalid of [
      { ...command, epoch: randomUUID() },
      { ...command, expectedRevision: state.revision - 1 },
      { ...command, inventoryDigest: `sha256:${"0".repeat(64)}` },
      { ...command, operatorId: randomUUID() },
    ]) {
      await expect(rollout.execute(invalid)).rejects.toMatchObject(ERROR);
    }
    const ready = await rollout.execute(activation(state));
    await expect(rollout.execute(retirement(ready, command.bindings))).rejects.toMatchObject(ERROR);
    const paused = await pause(ready.revision);
    await expect(rollout.execute(retirement(paused, command.bindings))).rejects.toMatchObject(
      ERROR,
    );
    expect(await db.select().from(spackMaterialBindingRetirements)).toEqual([]);
  });

  test("requires reconcile again after inventory drift, not just an inspect digest", async () => {
    const { command } = await fixture();
    await db.insert(spackMaterialBindings).values({ spec: "other", ...release() });
    await expect(rollout.execute(command)).rejects.toMatchObject(ERROR);
    await expect(
      rollout.execute({ ...command, inventoryDigest: (await inspect()).inventoryDigest }),
    ).rejects.toMatchObject(ERROR);
    const state = await reconcile(await inspect());
    expect((await rollout.execute(retirement(state, command.bindings))).retiredBindingCount).toBe(
      1,
    );
  });

  test("rejects empty, unknown, duplicate and already-retired bindings atomically", async () => {
    const { state, command, bindings } = await fixture();
    for (const invalid of [[], [{}], [{ [SPEC]: release() }], [...bindings, ...bindings]]) {
      await expect(rollout.execute({ ...command, bindings: invalid })).rejects.toMatchObject(ERROR);
      expect(await inspect()).toEqual(state);
    }
    const retired = await rollout.execute(command);
    const reconciled = await reconcile(retired);
    await expect(rollout.execute(retirement(reconciled, bindings))).rejects.toMatchObject(ERROR);
    expect(await db.select().from(spackMaterialBindingRetirements)).toHaveLength(1);
  });

  test("rolls back earlier pages when the last retirement binding is unknown", async () => {
    const binding = release();
    const bindings = Object.fromEntries(
      Array.from({ length: 251 }, (_, index) => [`hello@${index}`, binding]),
    );
    const state = await reconcile(await pause(), [bindings]);
    await expect(
      rollout.execute(retirement(state, [{ ...bindings, absent: release() }])),
    ).rejects.toMatchObject(ERROR);
    expect(await inspect()).toEqual(state);
    expect(await db.select().from(spackMaterialBindingRetirements)).toEqual([]);
  });

  test("CAS serializes retirement against a concurrent activation", async () => {
    const { state, command } = await fixture();
    const results = await Promise.allSettled([
      rollout.execute(command),
      peer.execute(activation(state)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await inspect();
    expect(current.revision).toBe(state.revision + 1);
    expect(current.retiredBindingCount).toBe(current.phase === "paused" ? 1 : 0);
  });

  test("missing retirement storage fails mutation and inventory inspection closed", async () => {
    const { command } = await fixture();
    await db.execute(
      sql`alter table spack_material_binding_retirements rename to hidden_retirements`,
    );
    try {
      await expect(rollout.execute(command)).rejects.toMatchObject(ERROR);
      await expect(inspect()).rejects.toMatchObject(ERROR);
    } finally {
      await db.execute(
        sql`alter table hidden_retirements rename to spack_material_binding_retirements`,
      );
    }
  });

  test("empty runtime registration checks retirement storage after the ready epoch gate", async () => {
    const { state } = await fixture();
    const ready = await rollout.execute(activation(state));
    const reference = references(ready);
    await reference.registerBindings({});
    await db.execute(
      sql`alter table spack_material_binding_retirements rename to hidden_retirements`,
    );
    try {
      await expect(reference.registerBindings({})).rejects.toMatchObject(REFERENCE_ERROR);
    } finally {
      await db.execute(
        sql`alter table hidden_retirements rename to spack_material_binding_retirements`,
      );
    }
    await reference.registerBindings({});
  });

  test("includes more than one retirement page in the canonical inventory digest", async () => {
    const binding = release();
    const bindings = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [`hello@${index}`, binding]),
    );
    const state = await reconcile(await pause(), [bindings]);
    await expect(rollout.execute(retirement(state, [bindings]))).rejects.toMatchObject(ERROR);
    const firstPage = Object.fromEntries(Object.entries(bindings).slice(0, 1000));
    const first = await rollout.execute(retirement(state, [firstPage]));
    const second = await rollout.execute(
      retirement(await reconcile(first), [{ "hello@1000": binding }]),
    );
    expect(second.retiredBindingCount).toBe(1001);
    const rows = await db
      .select()
      .from(spackMaterialBindings)
      .orderBy(
        spackMaterialBindings.spec,
        spackMaterialBindings.repositoryId,
        spackMaterialBindings.manifestDigest,
      );
    const retirements = await db
      .select()
      .from(spackMaterialBindingRetirements)
      .orderBy(spackMaterialBindingRetirements.bindingId);
    const canonical = {
      bindings: rows.map(({ spec, repositoryId, manifestDigest }) => ({
        spec,
        repositoryId,
        manifestDigest,
      })),
      references: [],
      retirements: retirements.map(
        ({ bindingId, epoch, revision, operatorId, reason, evidence }) => ({
          bindingId,
          epoch,
          revision,
          operatorId,
          reason,
          evidence,
        }),
      ),
    };
    expect(second.inventoryDigest).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`,
    );
    expect((await peer.execute({ action: "inspect" })).inventoryDigest).toBe(
      second.inventoryDigest,
    );
    expect(await db.select().from(spackMaterialRollouts)).toHaveLength(5);
  });

  test("rolls back tombstones if journal persistence fails", async () => {
    const { state, command } = await fixture();
    await db.execute(sql`
      create function reject_retirement_journal() returns trigger as $$
      begin
        if NEW.action = 'retire' then raise exception 'fixture journal rejection'; end if;
        return NEW;
      end
      $$ language plpgsql
    `);
    await db.execute(sql`
      create trigger reject_retirement before insert on spack_material_rollouts
      for each row execute function reject_retirement_journal()
    `);
    try {
      await expect(rollout.execute(command)).rejects.toMatchObject(ERROR);
      expect(await inspect()).toEqual(state);
      expect(await db.select().from(spackMaterialBindingRetirements)).toEqual([]);
    } finally {
      await db.execute(sql`drop trigger reject_retirement on spack_material_rollouts`);
      await db.execute(sql`drop function reject_retirement_journal()`);
    }
  });
});
