import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "./index";
import { agents, softwareOperations, userOrgMemberships, users } from "./schema";
import {
  spackInstallBindingEvents,
  spackMaterialBindings,
  spackMaterialOperationReferences,
} from "./schema-spack-materials";
import { type SpackInstallBindingChange, SpackInstallBindings } from "./spack-install-bindings";
import { SpackMaterialLifecycle } from "./spack-material-lifecycle";
import { SpackMaterialReferences } from "./spack-material-references";
import { SpackMaterialRollout } from "./spack-material-rollout";
import { SpackMaterialVisibility } from "./spack-material-visibility";

const SCHEMA = `spack_install_${randomUUID().replaceAll("-", "")}`;
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
  "spack_install_binding_events",
];
const OPERATOR = randomUUID();
const PROVIDER = randomUUID();
const REQUESTER = randomUUID();
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const SPEC = "hello@2.12.1";
const PLATFORM = { scope: "platform", spec: SPEC };
const AGENTS = [null, ORG, OTHER_ORG].map((providerOrgId) => ({
  agentId: `install-binding-${randomUUID()}`,
  providerOrgId,
  siteName: "install-binding-test",
  schedulerType: "slurm",
  schedulerVersion: "test",
}));
const EVIDENCE = {
  legacyProcessesStoppedAndDrained: true,
  legacyAccessRevoked: true,
  legacyInventoryComplete: true,
} as const;
const CONFLICT = { code: "INSTALL_BINDING_CONFLICT", status: 409 };
const FORBIDDEN = { code: "INSTALL_BINDING_FORBIDDEN", status: 403 };
const IDENTITY_FORBIDDEN = { code: "MATERIAL_LIFECYCLE_FORBIDDEN", status: 403 };
const UNAVAILABLE = { code: "INSTALL_BINDING_UNAVAILABLE", status: 503 };
const REFERENCE_ERROR = { code: "SPACK_MATERIAL_REFERENCE_ERROR" };
const PRIVATE = "private install binding audit diagnostic";
type Authorize = Parameters<SpackInstallBindings["transition"]>[2];
type Principal = Parameters<Authorize>[0];
type RolloutState = Awaited<ReturnType<SpackMaterialRollout["execute"]>>;
const allow: Authorize = async () => {};

function release() {
  return {
    repositoryId: randomBytes(32).toString("hex"),
    manifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
  };
}

function bind(
  binding = release(),
  expectedRevision = 0,
  scope = "platform",
): SpackInstallBindingChange {
  return { scope, spec: SPEC, action: "bind", binding, expectedRevision, reason: "Select release" };
}

function disable(expectedRevision: number, scope = "platform"): SpackInstallBindingChange {
  return { scope, spec: SPEC, action: "disable", expectedRevision, reason: "Stop new installs" };
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
  }
}

async function waitForRowLock(observer: PgDb, waiter: number, holder: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const [row] = await observer.$client<{ blocked: boolean }[]>`
      select ${holder} = any(pg_blocking_pids(${waiter}))
        and exists (
          select 1 from pg_locks
          where pid = ${waiter} and locktype = 'transactionid' and not granted
        ) as blocked
    `;
    if (row?.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected a PostgreSQL canonical identity row-lock wait");
}

// Actions must supply migrated real PG. Never skip, migrate here, or fall back to public.
describe("Spack install bindings (isolated real PG)", () => {
  let admin: PgDb;
  let db: PgDb;
  let peerDb: PgDb;
  let rollout: SpackMaterialRollout;
  let created = false;
  const connections = new Set<PgDb>();

  function connect(schema = SCHEMA) {
    const url = new URL(
      process.env.KQ_PG_URL ??
        process.env.DATABASE_URL ??
        "postgres://kq:kq@localhost:5432/kuintessence",
    );
    url.searchParams.set("search_path", schema);
    url.searchParams.set("statement_timeout", "10000");
    const connection = createPgDb(url.toString(), { max: 1, idle_timeout: 0 });
    connections.add(connection);
    return connection;
  }

  async function reconcile(state: RolloutState) {
    return rollout.execute({
      action: "reconcile",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      bindings: [],
    });
  }

  async function activate(state: RolloutState) {
    const active = await rollout.execute({
      action: "activate-policy",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      inventoryDigest: state.inventoryDigest,
      evidence: EVIDENCE,
    });
    if (!active.epoch) throw new Error("Expected a ready epoch");
    return {
      state: active,
      epoch: active.epoch,
      bindings: new SpackInstallBindings(db, active.epoch),
      peer: new SpackInstallBindings(peerDb, active.epoch),
      references: new SpackMaterialReferences(db, active.epoch),
      peerReferences: new SpackMaterialReferences(peerDb, active.epoch),
      lifecycle: new SpackMaterialLifecycle(db, active.epoch),
      visibility: new SpackMaterialVisibility(db, active.epoch),
    };
  }

  async function ready() {
    const paused = await rollout.execute({
      action: "pause",
      operatorId: OPERATOR,
      expectedRevision: 0,
    });
    return activate(await reconcile(paused));
  }

  async function operation(providerOrgId: string | null = null, spec = SPEC) {
    const agent = AGENTS.find((candidate) => candidate.providerOrgId === providerOrgId);
    if (!agent) throw new Error("Missing provider agent fixture");
    const input = {
      operationId: randomUUID(),
      agentId: agent.agentId,
      requestedBy: REQUESTER,
      spec,
      providerOrgId,
    };
    await db.insert(softwareOperations).values({
      id: input.operationId,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      spec,
      action: "install",
      status: "queued",
    });
    return input;
  }

  async function retire(binding: ReturnType<typeof release>, expectedRevision: number) {
    // Offline retirement requires drained operations, including those without references.
    await db.update(softwareOperations).set({ status: "succeeded" });
    const paused = await rollout.execute({
      action: "pause",
      operatorId: OPERATOR,
      expectedRevision,
    });
    const state = await reconcile(paused);
    const retired = await rollout.execute({
      action: "retire",
      operatorId: OPERATOR,
      expectedRevision: state.revision,
      epoch: state.epoch,
      inventoryDigest: state.inventoryDigest,
      bindings: [{ [SPEC]: binding }],
      reason: "Removed all configuration references",
      evidence: { ...EVIDENCE, bindingConfigurationsRemoved: true },
    });
    return activate(await reconcile(retired));
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
    db = connect();
    peerDb = connect();
    rollout = new SpackMaterialRollout(db);
  }, 30_000);

  beforeEach(async () => {
    for (const table of [...TABLES].reverse()) {
      await db.execute(sql`truncate table ${sql.identifier(SCHEMA)}.${sql.identifier(table)}`);
    }
    await db.insert(users).values([
      { id: OPERATOR, role: "platform_admin", email: `${OPERATOR}@example.invalid` },
      { id: PROVIDER, role: "org_admin", email: `${PROVIDER}@example.invalid`, orgId: OTHER_ORG },
      { id: REQUESTER, role: "user", email: `${REQUESTER}@example.invalid` },
    ]);
    await db.insert(userOrgMemberships).values([
      { userId: PROVIDER, orgId: ORG, role: "member" },
      { userId: REQUESTER, orgId: ORG, role: "member" },
    ]);
    await db.insert(agents).values(AGENTS);
  });

  afterAll(async () => {
    try {
      if (created) await admin.execute(sql`drop schema ${sql.identifier(SCHEMA)} cascade`);
    } finally {
      await Promise.all([...connections].map((connection) => connection.$client.end()));
    }
  });

  test("CAS across independent backends admits one winner and preserves its audit and ledger", async () => {
    const { bindings, peer, epoch, state } = await ready();
    const first = release();
    const second = { ...first, manifestDigest: release().manifestDigest };
    const results = await Promise.allSettled([
      bindings.transition(bind(first), OPERATOR, allow),
      peer.transition(bind(second), OPERATOR, allow),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject(CONFLICT);
    }
    const current = await peer.inspect(PLATFORM, OPERATOR);
    expect(current).toMatchObject({ revision: 1, state: "enabled", historyTruncated: false });
    expect(current.history).toHaveLength(1);
    expect([first, second]).toContainEqual(current.binding);
    const journal = await db.select().from(spackInstallBindingEvents);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      ...PLATFORM,
      ...current.binding,
      source: "web",
      operatorId: OPERATOR,
      epoch,
      rolloutRevision: state.revision,
      reason: "Select release",
    });
    expect(current.history[0]?.createdAt).toBe(journal[0]?.createdAt.toISOString());
    expect(await db.select().from(spackMaterialBindings)).toMatchObject([
      { spec: SPEC, ...current.binding },
    ]);
    await expectError(peer.transition(disable(0), OPERATOR, allow), CONFLICT);
    await peer.transition(disable(1), OPERATOR, allow);
    await expectError(bindings.transition(bind(first, 1), OPERATOR, allow), CONFLICT);
    await expectError(bindings.transition(disable(2), OPERATOR, allow), CONFLICT);
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(1);
    expect((await bindings.inspect(PLATFORM, OPERATOR)).history[1]).toEqual(current.history[0]);
  });

  test("canonical role and membership restrict CP scope and ignore legacy users.orgId", async () => {
    const { bindings } = await ready();
    const seen: Principal[] = [];
    const authorize: Authorize = async (principal) => {
      seen.push(principal);
    };
    await bindings.transition(bind(release(), 0, ORG), PROVIDER, authorize);
    expect(seen).toEqual([
      {
        sub: PROVIDER,
        role: "org_admin",
        orgIds: [ORG],
      },
    ]);
    for (const scope of ["platform", OTHER_ORG]) {
      await expectError(bindings.inspect({ scope, spec: SPEC }, PROVIDER), FORBIDDEN);
      await expectError(
        bindings.transition(bind(release(), 0, scope), PROVIDER, authorize),
        FORBIDDEN,
      );
    }
    await db.update(users).set({ role: "user" }).where(eq(users.id, PROVIDER));
    await expectError(bindings.transition(disable(1, ORG), PROVIDER, authorize), FORBIDDEN);
    await db.update(users).set({ role: "org_admin" }).where(eq(users.id, PROVIDER));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, PROVIDER));
    await expectError(bindings.inspect({ scope: ORG, spec: SPEC }, PROVIDER), FORBIDDEN);
    await expectError(bindings.transition(disable(1, ORG), PROVIDER, authorize), FORBIDDEN);
    expect(seen).toHaveLength(1);
    expect(await db.select().from(spackInstallBindingEvents)).toHaveLength(1);
  });

  test.each([
    "owner",
    "admin",
    "operator",
  ] as const)("global org_admin with A %s and B member cannot manage B through legacy fallback", async (role) => {
    const { bindings } = await ready();
    await db
      .update(userOrgMemberships)
      .set({ role })
      .where(eq(userOrgMemberships.userId, PROVIDER));
    await db.insert(userOrgMemberships).values({
      userId: PROVIDER,
      orgId: OTHER_ORG,
      role: "member",
    });
    await bindings.transition(bind(release(), 0, OTHER_ORG), OPERATOR, allow);
    const seen: Principal[] = [];
    const authorize: Authorize = async (principal) => {
      seen.push(principal);
    };
    if (role === "operator") {
      await expectError(
        bindings.transition(bind(release(), 0, ORG), PROVIDER, authorize),
        FORBIDDEN,
      );
      expect(seen).toEqual([]);
    } else {
      await bindings.transition(bind(release(), 0, ORG), PROVIDER, authorize);
      expect(await bindings.inspect({ scope: ORG, spec: SPEC }, PROVIDER)).toMatchObject({
        revision: 1,
        state: "enabled",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        sub: PROVIDER,
        role: "org_admin",
        orgIds: expect.arrayContaining([ORG, OTHER_ORG]),
      });
    }
    const calls = seen.length;
    const journal = await db.select().from(spackInstallBindingEvents);
    const ledger = await db.select().from(spackMaterialBindings);
    const before = await bindings.inspect({ scope: OTHER_ORG, spec: SPEC }, OPERATOR);
    await expectError(bindings.inspect({ scope: OTHER_ORG, spec: SPEC }, PROVIDER), FORBIDDEN);
    for (const change of [
      { ...bind(release(), 0, OTHER_ORG), spec: "hello@new" },
      bind(release(), 1, OTHER_ORG),
      disable(1, OTHER_ORG),
    ]) {
      await expectError(bindings.transition(change, PROVIDER, authorize), FORBIDDEN);
    }
    expect(seen).toHaveLength(calls);
    expect(await bindings.inspect({ scope: OTHER_ORG, spec: SPEC }, OPERATOR)).toEqual(before);
    expect(await db.select().from(spackInstallBindingEvents)).toEqual(journal);
    expect(await db.select().from(spackMaterialBindings)).toEqual(ledger);
  });

  test.each([
    "owner",
    "admin",
  ] as const)("ordinary user with current %s membership manages only that organization", async (role) => {
    const { bindings } = await ready();
    await db.update(users).set({ role: "user" }).where(eq(users.id, PROVIDER));
    await db
      .update(userOrgMemberships)
      .set({ role })
      .where(eq(userOrgMemberships.userId, PROVIDER));
    let calls = 0;
    const authorize: Authorize = async (principal) => {
      calls++;
      expect(principal).toEqual({
        sub: PROVIDER,
        role: "user",
        orgIds: [ORG],
      });
    };
    await bindings.transition(bind(release(), 0, ORG), PROVIDER, authorize);
    expect(await bindings.inspect({ scope: ORG, spec: SPEC }, PROVIDER)).toMatchObject({
      revision: 1,
    });
    for (const scope of ["platform", OTHER_ORG]) {
      await expectError(bindings.inspect({ scope, spec: SPEC }, PROVIDER), FORBIDDEN);
      await expectError(
        bindings.transition(bind(release(), 0, scope), PROVIDER, authorize),
        FORBIDDEN,
      );
    }
    for (const demoted of ["operator", "member"]) {
      await db
        .update(userOrgMemberships)
        .set({ role: demoted })
        .where(eq(userOrgMemberships.userId, PROVIDER));
      await expectError(bindings.inspect({ scope: ORG, spec: SPEC }, PROVIDER), FORBIDDEN);
      await expectError(bindings.transition(disable(1, ORG), PROVIDER, authorize), FORBIDDEN);
    }
    expect(calls).toBe(1);
    expect(await db.select().from(spackInstallBindingEvents)).toHaveLength(1);
  });

  test.each([
    "missing",
    "suspended",
    "policy",
  ] as const)("rejects %s authorization without a ledger or audit write", async (mode) => {
    const { bindings } = await ready();
    const subject = mode === "missing" ? randomUUID() : OPERATOR;
    if (mode === "suspended") {
      await db.update(users).set({ suspended: true }).where(eq(users.id, OPERATOR));
    }
    let calls = 0;
    await expectError(
      bindings.transition(bind(), subject, async () => {
        calls++;
        throw new Error(PRIVATE);
      }),
      IDENTITY_FORBIDDEN,
    );
    expect(calls).toBe(mode === "policy" ? 1 : 0);
    if (mode !== "policy") {
      await expectError(bindings.inspect(PLATFORM, subject), IDENTITY_FORBIDDEN);
    }
    expect(await db.select().from(spackMaterialBindings)).toEqual([]);
    expect(await db.select().from(spackInstallBindingEvents)).toEqual([]);
  });

  test.each(["suspension", "membership", "membership role"] as const)(
    "holds canonical row locks until binding commit during concurrent %s revocation",
    async (mode) => {
      const { bindings } = await ready();
      await db.update(users).set({ role: "user" }).where(eq(users.id, PROVIDER));
      await db
        .update(userOrgMemberships)
        .set({ role: "admin" })
        .where(eq(userOrgMemberships.userId, PROVIDER));
      const [holder] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const [waiter] = await peerDb.$client<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!holder || !waiter) throw new Error("Missing PostgreSQL backend PID");
      expect(holder.pid).not.toBe(waiter.pid);
      const entered = Promise.withResolvers<void>();
      const releaseAuthorization = Promise.withResolvers<void>();
      const mutation = bindings.transition(bind(release(), 0, ORG), PROVIDER, async (principal) => {
        expect(principal).toEqual({
          sub: PROVIDER,
          role: "user",
          orgIds: [ORG],
        });
        entered.resolve();
        await releaseAuthorization.promise;
      });
      const mutationResult = Promise.allSettled([mutation]);
      let revocationResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([
          entered.promise,
          mutation.then(() => {
            throw new Error("Mutation finished before authorization was released");
          }),
        ]);
        revocationResult = Promise.allSettled([
          peerDb.transaction(async (tx) => {
            if (mode === "suspension") {
              await tx.update(users).set({ suspended: true }).where(eq(users.id, PROVIDER));
            } else if (mode === "membership role") {
              await tx
                .update(userOrgMemberships)
                .set({ role: "operator" })
                .where(eq(userOrgMemberships.userId, PROVIDER));
            } else {
              await tx.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, PROVIDER));
            }
          }),
        ]);
        await waitForRowLock(admin, waiter.pid, holder.pid);
      } finally {
        releaseAuthorization.resolve();
        await Promise.all([mutationResult, revocationResult]);
      }
      expect(await mutationResult).toMatchObject([{ status: "fulfilled", value: { revision: 1 } }]);
      expect(await revocationResult).toMatchObject([{ status: "fulfilled" }]);
      const error = mode === "suspension" ? IDENTITY_FORBIDDEN : FORBIDDEN;
      await expectError(bindings.inspect({ scope: ORG, spec: SPEC }, PROVIDER), error);
      await expectError(bindings.transition(disable(1, ORG), PROVIDER, allow), error);
      expect(await db.select().from(spackInstallBindingEvents)).toHaveLength(1);
    },
    15_000,
  );

  test("configuration seeds only missing platform selections and retains the full protective ledger", async () => {
    const first = release();
    const later = release();
    const references = new SpackMaterialReferences(db);
    await references.seedConfiguration({ [SPEC]: first });
    await new SpackMaterialReferences(peerDb).seedConfiguration({
      [SPEC]: later,
      "hello@alias": later,
    });
    await references.seedConfiguration({});
    const events = await db.select().from(spackInstallBindingEvents);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...PLATFORM,
          ...first,
          revision: 1,
          source: "config",
          operatorId: null,
        }),
        expect.objectContaining({ scope: "platform", spec: "hello@alias", ...later, revision: 1 }),
      ]),
    );
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(3);
    const { bindings } = await ready();
    expect(await bindings.inspect(PLATFORM, OPERATOR)).toMatchObject({
      revision: 1,
      binding: first,
      state: "enabled",
    });
    expect(await bindings.inspect({ ...PLATFORM, spec: "hello@alias" }, OPERATOR)).toMatchObject({
      revision: 1,
      binding: later,
    });
  });

  test("concurrent initial configurations produce one selection without losing either ledger entry", async () => {
    const first = release();
    const second = release();
    await Promise.all([
      new SpackMaterialReferences(db).seedConfiguration({ [SPEC]: first }),
      new SpackMaterialReferences(peerDb).seedConfiguration({ [SPEC]: second }),
    ]);
    const events = await db.select().from(spackInstallBindingEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ...PLATFORM, revision: 1, source: "config" });
    expect([first, second]).toContainEqual({
      repositoryId: events[0]?.repositoryId,
      manifestDigest: events[0]?.manifestDigest,
    });
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(2);
  });

  test("a fresh connection cannot overwrite Web replacement or disable with stale startup configuration", async () => {
    const { bindings, references, epoch } = await ready();
    const old = release();
    const replacement = release();
    await references.seedConfiguration({ [SPEC]: old });
    await bindings.transition(bind(replacement, 1), OPERATOR, allow);
    const snapshot = await bindings.inspect(PLATFORM, OPERATOR);
    await peerDb.$client.end();
    connections.delete(peerDb);
    peerDb = connect();
    const restarted = new SpackMaterialReferences(peerDb, epoch);
    const manager = new SpackInstallBindings(peerDb, epoch);
    await restarted.seedConfiguration({ [SPEC]: old });
    expect(await manager.inspect(PLATFORM, OPERATOR)).toEqual(snapshot);
    expect(await restarted.resolveOperation(await operation())).toEqual(replacement);
    await manager.transition(disable(2), OPERATOR, allow);
    const disabled = await manager.inspect(PLATFORM, OPERATOR);
    await references.seedConfiguration({ [SPEC]: old });
    await restarted.seedConfiguration({ [SPEC]: replacement });
    expect(await bindings.inspect(PLATFORM, OPERATOR)).toEqual(disabled);
    await expectError(restarted.resolveOperation(await operation()), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(2);
  });

  test("organization selection wins; absence alone falls back, while disable never falls back", async () => {
    const { bindings, references } = await ready();
    const platform = release();
    const organization = release();
    await bindings.transition(bind(platform), OPERATOR, allow);
    await bindings.transition(bind(organization, 0, ORG), PROVIDER, allow);
    expect(await references.resolveOperation(await operation(ORG))).toEqual(organization);
    expect(await references.resolveOperation(await operation(OTHER_ORG))).toEqual(platform);
    expect(await references.resolveOperation(await operation())).toEqual(platform);
    await bindings.transition(disable(1, ORG), PROVIDER, allow);
    const snapshot = await db.select().from(spackMaterialOperationReferences);
    await expectError(references.resolveOperation(await operation(ORG)), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(snapshot);
    await bindings.transition(disable(1), OPERATOR, allow);
    await expectError(references.resolveOperation(await operation(OTHER_ORG)), REFERENCE_ERROR);
    await bindings.transition(bind(organization, 2, ORG), PROVIDER, allow);
    expect(await references.resolveOperation(await operation(ORG))).toEqual(organization);
    await expectError(
      references.resolveOperation(await operation(null, "hello@2.12")),
      REFERENCE_ERROR,
    );
  });

  test("retries retain their immutable release after replacement and disable while new operations do not", async () => {
    const { bindings, references, peerReferences } = await ready();
    const original = release();
    const replacement = { ...original, manifestDigest: release().manifestDigest };
    await bindings.transition(bind(original), OPERATOR, allow);
    const old = await operation();
    expect(await references.resolveOperation(old)).toEqual(original);
    const historical = await db.select().from(spackMaterialOperationReferences);
    await bindings.transition(bind(replacement, 1), OPERATOR, allow);
    expect(await peerReferences.resolveOperation(old)).toEqual(original);
    const fresh = await operation();
    expect(await references.resolveOperation(fresh)).toEqual(replacement);
    await bindings.transition(disable(2), OPERATOR, allow);
    expect(await peerReferences.resolveOperation(old)).toEqual(original);
    expect(await references.resolveOperation(fresh)).toEqual(replacement);
    await expectError(references.resolveOperation(await operation()), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(
      expect.arrayContaining(historical),
    );
    expect(await db.select().from(spackMaterialOperationReferences)).toHaveLength(2);
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(2);
  });

  test("concurrent resolution and replacement pin one complete release and retries agree", async () => {
    const { bindings, references, peerReferences, peer } = await ready();
    const original = release();
    const replacement = release();
    await bindings.transition(bind(original), OPERATOR, allow);
    const input = await operation();
    const [first, , second] = await Promise.all([
      references.resolveOperation(input),
      peer.transition(bind(replacement, 1), OPERATOR, allow),
      peerReferences.resolveOperation(input),
    ]);
    expect([original, replacement]).toContainEqual(first);
    expect(second).toEqual(first);
    expect(await references.resolveOperation(input)).toEqual(first);
    expect(await db.select().from(spackMaterialOperationReferences)).toMatchObject([
      { operationId: input.operationId, ...first },
    ]);
    expect(await references.resolveOperation(await operation())).toEqual(replacement);
  });

  test("retry rechecks operation identity, action and status without rewriting historical references", async () => {
    const { bindings, references } = await ready();
    await bindings.transition(bind(), OPERATOR, allow);
    const input = await operation();
    await references.resolveOperation(input);
    const historical = await db.select().from(spackMaterialOperationReferences);
    for (const change of [
      { requestedBy: PROVIDER },
      { spec: "hello@other" },
      { agentId: "different-agent" },
      { providerOrgId: ORG },
    ]) {
      await expectError(references.resolveOperation({ ...input, ...change }), REFERENCE_ERROR);
    }
    for (const change of [
      { requestedBy: PROVIDER },
      { spec: "hello@other" },
      { action: "uninstall" },
      { status: "succeeded" },
    ]) {
      await db
        .update(softwareOperations)
        .set(change)
        .where(eq(softwareOperations.id, input.operationId));
      await expectError(references.resolveOperation(input), REFERENCE_ERROR);
      await expectError(references.resolveOperation({ ...input, ...change }), REFERENCE_ERROR);
      await db
        .update(softwareOperations)
        .set({
          requestedBy: input.requestedBy,
          spec: input.spec,
          action: "install",
          status: "queued",
        })
        .where(eq(softwareOperations.id, input.operationId));
    }
    await db.delete(softwareOperations).where(eq(softwareOperations.id, input.operationId));
    await expectError(references.resolveOperation(input), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
  });

  test("visibility revocation blocks fresh admission and retries instead of using platform fallback", async () => {
    const { bindings, references, visibility } = await ready();
    const selected = release();
    await bindings.transition(bind(), OPERATOR, allow);
    await bindings.transition(bind(selected, 0, ORG), PROVIDER, allow);
    const input = await operation(ORG);
    await references.resolveOperation(input);
    const historical = await db.select().from(spackMaterialOperationReferences);
    await visibility.transition(
      selected,
      OPERATOR,
      {
        expectedRevision: 0,
        policy: { mode: "allowlist", userIds: [PROVIDER], orgIds: [] },
        reason: "Revoke requester visibility",
      },
      allow,
    );
    await expectError(references.resolveOperation(input), REFERENCE_ERROR);
    await expectError(references.resolveOperation(await operation(ORG)), REFERENCE_ERROR);
    await expectError(bindings.transition(bind(selected, 1), OPERATOR, allow), {
      code: "MATERIAL_VISIBILITY_DENIED",
      status: 404,
    });
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
    expect(await db.select().from(spackInstallBindingEvents)).toHaveLength(2);
  });

  test.each([
    "suspension",
    "membership",
  ] as const)("resolution rechecks canonical requester %s even for an existing reference", async (mode) => {
    const { bindings, references, visibility } = await ready();
    const selected = release();
    await bindings.transition(bind(selected), OPERATOR, allow);
    await visibility.transition(
      selected,
      OPERATOR,
      {
        expectedRevision: 0,
        policy: { mode: "allowlist", userIds: [], orgIds: [ORG] },
        reason: "Organization-only material",
      },
      allow,
    );
    const input = await operation();
    await references.resolveOperation(input);
    const historical = await db.select().from(spackMaterialOperationReferences);
    if (mode === "suspension") {
      await db.update(users).set({ suspended: true }).where(eq(users.id, REQUESTER));
    } else {
      await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, REQUESTER));
    }
    await expectError(references.resolveOperation(input), REFERENCE_ERROR);
    await expectError(references.resolveOperation(await operation()), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
  });

  test.each([
    "retired",
    "withdrawn",
  ] as const)("%s selection fails closed without fallback or rewriting historical operations", async (mode) => {
    const initial = await ready();
    const selected = release();
    await initial.bindings.transition(bind(), OPERATOR, allow);
    await initial.bindings.transition(bind(selected, 0, ORG), PROVIDER, allow);
    const input = await operation(ORG);
    await initial.references.resolveOperation(input);
    const historical = await db.select().from(spackMaterialOperationReferences);
    const journal = await db.select().from(spackInstallBindingEvents);
    const current = await retire(selected, initial.state.revision);
    if (mode === "withdrawn") {
      await current.lifecycle.transition(
        selected,
        OPERATOR,
        {
          action: "withdraw",
          expectedRevision: 0,
          reason: "Retired release withdrawn",
        },
        allow,
      );
    }
    await db
      .update(softwareOperations)
      .set({ status: "queued" })
      .where(eq(softwareOperations.id, input.operationId));
    await expectError(current.references.resolveOperation(input), REFERENCE_ERROR);
    await expectError(current.references.resolveOperation(await operation(ORG)), REFERENCE_ERROR);
    await expectError(
      current.bindings.transition(bind(selected, 1, ORG), PROVIDER, allow),
      UNAVAILABLE,
    );
    await expectError(current.references.seedConfiguration({ [SPEC]: selected }), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
    expect(await db.select().from(spackInstallBindingEvents)).toEqual(journal);
  });

  test("withdrawn material cannot become a new selection or seed", async () => {
    const { bindings, references, lifecycle } = await ready();
    const selected = release();
    await lifecycle.transition(
      selected,
      OPERATOR,
      {
        action: "withdraw",
        expectedRevision: 0,
        reason: "Unreferenced material withdrawn",
      },
      allow,
    );
    await expectError(bindings.transition(bind(selected), OPERATOR, allow), {
      code: "MATERIAL_RELEASE_WITHDRAWN",
      status: 404,
    });
    await expectError(references.seedConfiguration({ [SPEC]: selected }), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialBindings)).toEqual([]);
    expect(await db.select().from(spackInstallBindingEvents)).toEqual([]);
  });

  test("legacy operation references recheck withdrawal independently of binding retirement", async () => {
    const { bindings, references, lifecycle } = await ready();
    const original = release();
    const replacement = release();
    const input = await operation();
    await references.acquireOperation({
      operationId: input.operationId,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      spec: input.spec,
      ...original,
    });
    const historical = await db.select().from(spackMaterialOperationReferences);
    await bindings.transition(bind(replacement), OPERATOR, allow);
    expect(await references.resolveOperation(input)).toEqual(original);
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, input.operationId));
    await lifecycle.transition(
      original,
      OPERATOR,
      {
        action: "withdraw",
        expectedRevision: 0,
        reason: "Withdraw terminal legacy operation material",
      },
      allow,
    );
    await db
      .update(softwareOperations)
      .set({ status: "queued" })
      .where(eq(softwareOperations.id, input.operationId));
    await expectError(references.resolveOperation(input), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
    expect(await references.resolveOperation(await operation())).toEqual(replacement);
    await lifecycle.transition(
      original,
      OPERATOR,
      { action: "restore", expectedRevision: 1, reason: "Restore legacy material" },
      allow,
    );
    expect(await references.resolveOperation(input)).toEqual(original);
  });

  test("withdrawal racing a Web bind has one winner and never admits withdrawn material", async () => {
    const { bindings, epoch } = await ready();
    const selected = release();
    const lifecycle = new SpackMaterialLifecycle(peerDb, epoch);
    const results = await Promise.allSettled([
      bindings.transition(bind(selected), OPERATOR, allow),
      lifecycle.transition(
        selected,
        OPERATOR,
        { action: "withdraw", expectedRevision: 0, reason: "Concurrent withdrawal" },
        allow,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [selection, withdrawal] = results;
    if (selection.status === "fulfilled") {
      expect(withdrawal).toMatchObject({
        status: "rejected",
        reason: { code: "MATERIAL_RELEASE_REFERENCED", status: 409 },
      });
      await lifecycle.assertAvailable(selected);
    } else {
      expect(selection.reason).toMatchObject({ code: "MATERIAL_RELEASE_WITHDRAWN", status: 404 });
      expect(withdrawal.status).toBe("fulfilled");
    }
    const count = selection.status === "fulfilled" ? 1 : 0;
    expect(await db.select().from(spackInstallBindingEvents)).toHaveLength(count);
    expect(await db.select().from(spackMaterialBindings)).toHaveLength(count);
  });

  test.each([
    "missing epoch",
    "wrong epoch",
    "paused",
  ] as const)("%s fences management, configuration seed and both fresh and existing operation resolution", async (mode) => {
    const fixture = await ready();
    const selected = release();
    await fixture.bindings.transition(bind(selected), OPERATOR, allow);
    const old = await operation();
    await fixture.references.resolveOperation(old);
    const fresh = await operation();
    const historical = await db.select().from(spackMaterialOperationReferences);
    const journal = await db.select().from(spackInstallBindingEvents);
    if (mode === "paused") {
      await rollout.execute({
        action: "pause",
        operatorId: OPERATOR,
        expectedRevision: fixture.state.revision,
      });
    }
    const epoch =
      mode === "missing epoch"
        ? undefined
        : mode === "wrong epoch"
          ? randomUUID()
          : fixture.epoch;
    const bindings = new SpackInstallBindings(peerDb, epoch);
    const references = new SpackMaterialReferences(peerDb, epoch);
    await expectError(bindings.inspect(PLATFORM, OPERATOR), UNAVAILABLE);
    await expectError(bindings.transition(disable(1), OPERATOR, allow), UNAVAILABLE);
    await expectError(references.seedConfiguration({ [SPEC]: selected }), REFERENCE_ERROR);
    await expectError(references.resolveOperation(old), REFERENCE_ERROR);
    await expectError(references.resolveOperation(fresh), REFERENCE_ERROR);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual(historical);
    expect(await db.select().from(spackInstallBindingEvents)).toEqual(journal);
  });

  test("observe mode cannot manage selections and an absent exact spec cannot be resolved", async () => {
    const bindings = new SpackInstallBindings(db);
    await expectError(bindings.inspect(PLATFORM, OPERATOR), UNAVAILABLE);
    await expectError(bindings.transition(bind(), OPERATOR, allow), UNAVAILABLE);
    const { references } = await ready();
    await expectError(references.resolveOperation(await operation()), REFERENCE_ERROR);
    expect(await db.select().from(spackInstallBindingEvents)).toEqual([]);
    expect(await db.select().from(spackMaterialOperationReferences)).toEqual([]);
  });

  test.each([
    "web",
    "configuration",
  ] as const)("failed %s audit insertion rolls back both selection and protective ledger", async (source) => {
    const { bindings, peer, references } = await ready();
    const selected = release();
    await db.execute(sql`
        create function reject_install_binding_audit() returns trigger as $$
        begin
          raise exception 'private install binding audit diagnostic';
        end;
        $$ language plpgsql
      `);
    try {
      await db.execute(sql`
          create trigger reject_install_binding before insert on spack_install_binding_events
          for each row execute function reject_install_binding_audit()
        `);
      try {
        if (source === "web") {
          await expectError(bindings.transition(bind(selected), OPERATOR, allow), UNAVAILABLE);
        } else {
          await expectError(references.seedConfiguration({ [SPEC]: selected }), REFERENCE_ERROR);
        }
        expect(await peer.inspect(PLATFORM, OPERATOR)).toMatchObject({
          revision: 0,
          state: "absent",
          binding: null,
          history: [],
        });
        expect(await db.select().from(spackMaterialBindings)).toEqual([]);
        expect(await db.select().from(spackInstallBindingEvents)).toEqual([]);
      } finally {
        await db.execute(sql`
            drop trigger reject_install_binding on spack_install_binding_events
          `);
      }
    } finally {
      await db.execute(sql`drop function reject_install_binding_audit()`);
    }
    expect(await peer.transition(bind(selected), OPERATOR, allow)).toMatchObject({ revision: 1 });
  });

  test("missing selection storage fails closed instead of using config or public fixtures", async () => {
    const { bindings, references } = await ready();
    const selected = release();
    await references.seedConfiguration({ [SPEC]: selected });
    const input = await operation();
    await db.execute(sql`alter table spack_install_binding_events rename to hidden_install_events`);
    try {
      await expectError(bindings.inspect(PLATFORM, OPERATOR), UNAVAILABLE);
      await expectError(bindings.transition(bind(selected, 1), OPERATOR, allow), UNAVAILABLE);
      await expectError(references.seedConfiguration({}), REFERENCE_ERROR);
      await expectError(references.resolveOperation(input), REFERENCE_ERROR);
      expect(await db.select().from(spackMaterialOperationReferences)).toEqual([]);
    } finally {
      await db.execute(sql`
        alter table hidden_install_events rename to spack_install_binding_events
      `);
    }
    expect(await references.resolveOperation(input)).toEqual(selected);
  });
});
