import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  federationCommercialAttempts as attempts,
  auditLog,
  createPgDb,
  federationAgreements,
  federationBudgets,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migratePostgresDatabase } from "../packages/db/src/pg/migrate";
import { UnixCommercialClient } from "../packages/server/src/federation/commercial-client";
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
    await worker("approve-mvcc");
    const [duplicate] = await db.select().from(submissions).where(eq(submissions.state, "pending"));
    assert(duplicate);
    await worker("advance");
    await worker("advance");
    const [original] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, duplicate.id));
    assert(original?.stage === "transaction");
    const client = new UnixCommercialClient(join(root, "commercial-adapter", "commercial.sock"));
    const peerProposal = await client.prepare(duplicate.input);
    const peerPrepared = await client.advance(peerProposal.recovery);
    assert(peerPrepared.state === "prepared");
    let peerResult = await client.advance(peerPrepared.recovery);
    const committedBy = Date.now() + 35000;
    while (peerResult.state === "pending") {
      assert(Date.now() < committedBy);
      await Bun.sleep(500);
      peerResult = await client.advance(peerPrepared.recovery);
    }
    assert(peerResult.state === "committed", "Competing original intent must have a real VALID");
    const advanceDue = async () => {
      await db
        .update(submissions)
        .set({ nextAttemptAt: sql`clock_timestamp()` })
        .where(eq(submissions.id, duplicate.id));
      await worker("advance");
    };
    for (let i = 0; i < 10; i++) {
      await advanceDue();
      const [row] = await db.select().from(attempts).where(eq(attempts.id, original.id));
      if (row?.stage === "invalid") break;
      assert(row?.stage === "transaction");
      await Bun.sleep(500);
    }
    const [failed] = await db.select().from(attempts).where(eq(attempts.id, original.id));
    assert(
      failed?.stage === "invalid" && failed.validationCode === 11 && failed.blockNumber !== null,
    );
    assert.equal(
      (await db.select().from(submissions).where(eq(submissions.id, duplicate.id)))[0]?.lastError,
      "MVCC_RECONCILING",
    );
    for (let i = 0; i < 10; i++) {
      await advanceDue();
      const [row] = await db.select().from(submissions).where(eq(submissions.id, duplicate.id));
      assert(
        row?.state !== "needs_review",
        "Original duplicate must reconcile without a human retry",
      );
      if (row?.state === "committed") break;
      await Bun.sleep(500);
    }
    const history = await db.select().from(attempts).where(eq(attempts.submissionId, duplicate.id));
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.find((row) => row.id === failed.id),
      failed,
    );
    const reconciled = history.find((row) => row.number === 2);
    assert(
      reconciled?.stage === "committed" &&
        reconciled.validationCode === 0 &&
        reconciled.blockNumber !== null,
    );
    assert.equal(
      (await db.select().from(submissions).where(eq(submissions.id, duplicate.id)))[0]?.state,
      "committed",
    );
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, duplicate.id),
          eq(auditLog.action, "federation.commercial.mvcc_reconcile"),
        ),
      );
    assert.equal(audits.length, 1);
    assert.deepEqual(
      await client.receipt({
        operation: "get-commercial-receipt",
        domainId: duplicate.input.domainId,
        recordType: "agreement",
        recordId: duplicate.input.recordId,
      }),
      { receipt: { recordId: duplicate.input.recordId, digest: duplicate.input.digest } },
    );
    await Bun.write(
      join(root, "commercial-mvcc-reconciliation.json"),
      JSON.stringify(
        {
          competing: {
            transactionId: peerResult.transactionId,
            blockNumber: peerResult.blockNumber,
          },
          invalid: {
            transactionId: failed.transactionId,
            blockNumber: failed.blockNumber,
            validationCode: failed.validationCode,
          },
          recovered: {
            transactionId: reconciled.transactionId,
            blockNumber: reconciled.blockNumber,
            validationCode: reconciled.validationCode,
          },
          audits: audits.length,
        },
        null,
        2,
      ),
    );
    pass(
      "real MVCC duplicate reconciles the immutable private receipt automatically, preserves INVALID history and commits a fresh VALID after native endorsement",
    );
  } finally {
    await cleanup();
  }
}
