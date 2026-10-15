import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSqliteMigrations, softwareExecutions } from "@kuintessence/db";
import {
  SoftwareOperationAction as Action,
  SoftwareOperationStatus as Status,
} from "@kuintessence/proto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  executionIdentity,
  INTERRUPTED,
  RECOVERY_REQUIRED,
  softwareExecution,
} from "../spack/execution-identity";
import { SpackInstallStore } from "../spack/install-store";
import { SoftwareOperations } from "./software-operations";

let base: string;
let sqlite: Database;
let ledger: SoftwareOperations;
const input = () => ({ operationId: randomUUID(), action: Action.INSTALL, spec: "fixture@1" });
const results = async () => {
  const values = [];
  for await (const result of ledger.results()) values.push(result);
  return values;
};
beforeEach(async () => {
  base = await mkdtemp("/tmp/kq-operation-recovery-");
  sqlite = new Database(join(base, "agent.db"));
  runSqliteMigrations(sqlite);
  ledger = new SoftwareOperations(drizzle(sqlite));
});
afterEach(async () => {
  sqlite.close();
  await rm(base, { recursive: true, force: true });
});

test("receipt is durable before execution and duplicate receipt never runs again", async () => {
  const request = input();
  expect(await ledger.receive(request)).toBeDefined();
  expect(await ledger.receive(request)).toBeUndefined();
  sqlite.close();
  sqlite = new Database(join(base, "agent.db"));
  ledger = new SoftwareOperations(drizzle(sqlite));
  expect(await ledger.receive(request)).toBeUndefined();
  await ledger.recover();
  expect(await results()).toEqual([]); // Reconnecting a live owner is not a restart.
});

test("namespace fallback receipts survive reconnect and remain pending across unknown instances", async () => {
  const namespace = spyOn(fs, "readlink").mockResolvedValue("pid:[9999999999]");
  try {
    const request = input();
    const identity = await ledger.receive(request);
    expect(identity).toMatchObject({ host: null, boot: null, start: null });
    await ledger.start(request.operationId);
    await ledger.recover();
    expect(await results()).toEqual([]);
    expect(await ledger.receive(request)).toBeUndefined();
    await drizzle(sqlite)
      .update(softwareExecutions)
      .set({ identity: { ...identity, instance: randomUUID() } })
      .where(eq(softwareExecutions.operationId, request.operationId));
    await ledger.recover();
    expect(await results()).toEqual([]);
    const fresh = input();
    expect(await ledger.receive(fresh)).toBeDefined();
    await ledger.finish({ ...fresh, status: Status.SUCCEEDED });
    await ledger.recover();
    expect(await results()).toMatchObject([{ ...fresh, status: Status.SUCCEEDED }]);
  } finally {
    namespace.mockRestore();
  }
});

test("online saved success survives queue loss, reopen, replay and a late failure", async () => {
  const request = input();
  await ledger.receive(request);
  const success = { ...request, status: Status.SUCCEEDED, stdout: "verified", exitCode: 0 };
  await ledger.finish(success);
  sqlite.close();
  sqlite = new Database(join(base, "agent.db"));
  ledger = new SoftwareOperations(drizzle(sqlite));
  expect(await ledger.finish({ ...request, status: Status.FAILED, error: INTERRUPTED })).toEqual(
    success,
  );
  await ledger.recover();
  expect(await results()).toEqual([success]);
  expect(await results()).toEqual([success]);
});

test.each([
  false,
  true,
])("stopped receipt without store: started=%s is explicit and idempotent", async (started) => {
  const request = input();
  await ledger.receive(request);
  const db = drizzle(sqlite);
  await db
    .update(softwareExecutions)
    .set({ started, identity: { ...(await executionIdentity()), start: "0" } })
    .where(eq(softwareExecutions.operationId, request.operationId));
  await ledger.recover();
  await ledger.recover();
  expect(await results()).toMatchObject([
    { ...request, status: Status.FAILED, error: started ? RECOVERY_REQUIRED : INTERRUPTED },
  ]);
});

test("a reboot reconciles the linked store and reports interrupted, never succeeded", async () => {
  const request = input();
  const identity = await ledger.receive(request);
  if (!identity) throw new Error("receipt missing");
  const root = join(base, "store");
  const store = new SpackInstallStore(root);
  await store.initialize();
  await softwareExecution.run(
    {
      identity,
      operationId: request.operationId,
      bindStore: (root) => ledger.bindStore(request.operationId, root),
    },
    () =>
      store.withLock(async () => {
        await store.create({
          manifestDigest: `sha256:${"a".repeat(64)}`,
          manifestSize: 1,
          siteProfileDigest: `sha256:${"b".repeat(64)}`,
          spec: request.spec,
          rootHash: "a".repeat(32),
        });
      }),
  );
  const old = { ...identity, boot: randomUUID() };
  const generation = join(root, ".writer-lock/generations/0000000000000000");
  await rm(join(generation, "released.json"));
  await writeFile(
    join(generation, "owner.json"),
    JSON.stringify({ version: 1, identity: old, operationId: request.operationId }),
  );
  await drizzle(sqlite)
    .update(softwareExecutions)
    .set({ identity: old, started: true })
    .where(eq(softwareExecutions.operationId, request.operationId));
  const [record] = await store.list();
  expect(record?.operationId).toBe(request.operationId);
  expect(record?.executionIdentity?.token).toBe(identity.token);
  await Promise.all([ledger.recover(), new SoftwareOperations(drizzle(sqlite)).recover()]);
  expect((await store.list())[0]?.state).toBe("failed");
  // A losing concurrent recovery may report recovery-required; neither invents success.
  expect((await results())[0]?.status).toBe(Status.FAILED);
  expect([INTERRUPTED, RECOVERY_REQUIRED]).toContain((await results())[0]?.error ?? "");
});

test("foreign-host identity stays pending even with a different boot", async () => {
  const request = input();
  await ledger.receive(request);
  await drizzle(sqlite)
    .update(softwareExecutions)
    .set({ identity: { ...(await executionIdentity()), host: "0".repeat(64), boot: randomUUID() } })
    .where(eq(softwareExecutions.operationId, request.operationId));
  await ledger.recover();
  expect(await results()).toEqual([]);
});

test("terminal replay crosses page boundaries without dropping or duplicating results", async () => {
  const identity = await executionIdentity();
  const rows = Array.from({ length: 205 }, () => {
    const request = input();
    return {
      ...request,
      identity,
      result: { ...request, status: Status.FAILED, error: INTERRUPTED },
    };
  });
  await drizzle(sqlite).insert(softwareExecutions).values(rows);
  const replayed = await results();
  expect(replayed).toHaveLength(205);
  expect(new Set(replayed.map((result) => result.operationId)).size).toBe(205);
});

test("a terminal refusal without a runnable identity is still durable", async () => {
  const request = input();
  await ledger.finish({ ...request, status: Status.FAILED, error: RECOVERY_REQUIRED });
  await ledger.recover();
  expect(await results()).toMatchObject([
    { ...request, status: Status.FAILED, error: RECOVERY_REQUIRED },
  ]);
});
