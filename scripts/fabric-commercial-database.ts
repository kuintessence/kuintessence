import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  federationCommercialAttempts as attempts,
  createPgDb,
  federationAgreements,
  federationBudgets,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migratePostgresDatabase } from "../packages/db/src/pg/migrate";
import { databaseUrlWithName, unitDatabaseName } from "./test-unit";

export async function verifyCommercialDatabase(
  root: string,
  sourceUrl: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(cleanup: () => Promise<void>): void;
  },
  pass: (name: string) => void,
) {
  const name = unitDatabaseName(new Date(), process.pid, randomUUID());
  const url = databaseUrlWithName(sourceUrl, name);
  const admin = postgres(databaseUrlWithName(sourceUrl, "postgres"), {
    max: 1,
    connect_timeout: 5,
  });
  const db = createPgDb(url, { max: 4, idle_timeout: 1 });
  const children = new Set<Bun.Subprocess>();
  const env = { ...process.env, DATABASE_URL: url, LOG_LEVEL: "warn" };
  let created = false,
    ordinal = 0;
  function start(label: string, command: string[], extra: NodeJS.ProcessEnv = {}) {
    const fd = openSync(join(root, `commercial-db-${label}-${++ordinal}.log`), "a", 0o600);
    try {
      const child = Bun.spawn(command, { env: { ...env, ...extra }, stdout: fd, stderr: fd });
      children.add(child);
      return child;
    } finally {
      closeSync(fd);
    }
  }
  async function stop(child: Bun.Subprocess) {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  }
  async function worker(action: string, expected = [0]) {
    const child = start(action, [
      "bun",
      resolve(import.meta.dir, "fabric-commercial-worker.ts"),
      root,
      action,
    ]);
    const timer = setTimeout(() => child.kill("SIGKILL"), 40000);
    try {
      const code = await child.exited;
      assert(expected.includes(code), `Commercial DB worker ${action} exited ${code}`);
      return code;
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  }
  let cleaned: Promise<void> | undefined;
  function cleanup() {
    cleaned ??= (async () => {
      for (const child of [...children]) await stop(child);
      await db.$client.end({ timeout: 5 });
      try {
        if (created) await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
      } finally {
        await admin.end({ timeout: 5 });
      }
    })();
    return cleaned;
  }
  controls.onCleanup(cleanup);
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
    created = true;
    await migratePostgresDatabase(url);
    await worker("initialize");
    await controls.stopOrderer();
    await worker("approve-direct");
    assert.equal((await db.select().from(submissions)).length, 0);
    pass(
      "real database direct commercial approval succeeds with adapter/orderer offline and creates no ledger work",
    );
    await worker("approve-attested");
    const [submission] = await db.select().from(submissions);
    assert(submission?.state === "pending");
    assert.equal((await db.select().from(submissions)).length, 1);
    assert.equal((await db.select().from(federationAgreements)).length, 0);
    assert.equal((await db.select().from(federationBudgets)).length, 0);
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../packages/fabric-adapter/src/main.ts")],
      target: "node",
      format: "esm",
      external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
    });
    assert(build.success && build.outputs[0]);
    const entry = join(root, "commercial-db-adapter.mjs");
    await Bun.write(entry, build.outputs[0]);
    const adapter = start("adapter", ["node", entry], {
      KQ_FABRIC_ADAPTER_KIND: "commercial",
      KQ_FABRIC_ADAPTER_CONFIG: join(root, "commercial-adapter.json"),
    });
    const readyBy = Date.now() + 15000;
    for (;;) {
      assert.equal(adapter.exitCode, null, "Commercial adapter must remain running");
      try {
        const response = await fetch("http://localhost/health", {
          unix: join(root, "commercial-adapter", "commercial.sock"),
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) break;
      } catch {
        /* startup is bounded by readyBy */
      }
      assert(Date.now() < readyBy, "Commercial adapter ready");
      await Bun.sleep(200);
    }
    await worker("advance");
    await worker("advance");
    const [checkpoint] = await db.select().from(attempts);
    assert(checkpoint?.stage === "transaction");
    await worker("advance");
    const [pending] = await db.select().from(submissions);
    assert(pending?.state === "pending" && pending.lastError === "LEDGER_PENDING");
    assert.deepEqual((await db.select().from(attempts))[0], checkpoint);
    pass(
      "commercial database saves each checkpoint before RPC and preserves the original signed transaction during orderer outage",
    );
    await controls.startOrderer();
    await db
      .update(submissions)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(submissions.id, submission.id));
    let crashed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const dueBy = Date.now() + 35000;
      for (;;) {
        const [due] = await db
          .select({ due: sql<boolean>`${submissions.nextAttemptAt} <= clock_timestamp()` })
          .from(submissions);
        if (due?.due) break;
        assert(Date.now() < dueBy, "Commercial retry must become due");
        await Bun.sleep(500);
      }
      if ((await worker("crash-after-commit", [0, 86])) === 86) {
        crashed = true;
        break;
      }
      const [waiting] = await db.select().from(submissions);
      assert(
        waiting?.state === "pending" && waiting.lastError === "LEDGER_PENDING",
        "Raft recovery may only leave the original submission pending",
      );
      assert.deepEqual((await db.select().from(attempts))[0], checkpoint);
    }
    assert(crashed, "Commercial transaction must commit before the simulated crash");
    assert.equal((await db.select().from(submissions))[0]?.state, "pending");
    assert.deepEqual((await db.select().from(attempts))[0], checkpoint);
    console.log("Waiting for the real commercial database lease to expire after process exit");
    const expireBy = Date.now() + 95000;
    for (;;) {
      const [lease] = await db
        .select({ expired: sql<boolean>`${submissions.leaseUntil} <= clock_timestamp()` })
        .from(submissions);
      if (lease?.expired) break;
      assert(Date.now() < expireBy, "Commercial lease must expire");
      await Bun.sleep(500);
    }
    await worker("advance");
    const [committed] = await db.select().from(attempts);
    assert(committed?.stage === "committed" && committed.validationCode === 0);
    assert.equal(committed.transactionId, checkpoint.transactionId);
    assert.equal((await db.select().from(attempts)).length, 1);
    assert.equal((await db.select().from(submissions))[0]?.state, "committed");
    pass(
      "fresh commercial worker recovers original VALID transaction after commit-before-database process exit and real lease expiry",
    );
  } finally {
    await cleanup();
  }
}
