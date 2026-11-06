import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  federationAttestationAttempts as attempts,
  federationEvidenceBatches as batches,
  federationBudgets as budgets,
  createPgDb,
  jobs,
  federationAttestationOutbox as outbox,
  federationReservations as reservations,
} from "@kuintessence/db";
import { asc } from "drizzle-orm";
import postgres from "postgres";
import { migratePostgresDatabase } from "../packages/db/src/pg/migrate";
import { Network, Site } from "./fabric-evidence-fixture";
import { databaseUrlWithName, unitDatabaseName } from "./test-unit";

/** Real PostgreSQL and Node sidecar; each checkpoint is advanced by a fresh Bun worker. */
export async function verifyDatabaseAttestation(
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
  const env = { ...process.env, DATABASE_URL: url, LOG_LEVEL: "warn" };
  const workerPath = resolve(import.meta.dir, "fabric-evidence-worker.ts");
  const network = Network.parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
  const site = Site.parse(network.sites.find((member) => member.name === "B"));
  const socket = join(root, "adapter-run", "evidence.sock");
  const configPath = join(root, "adapter-config.json");
  const executable = join(root, "adapter.mjs");
  const processes = new Set<Bun.Subprocess>();
  let created = false;
  let ordinal = 0;
  function start(label: string, command: string[], extra: NodeJS.ProcessEnv = {}) {
    const descriptor = openSync(join(root, `${label}-${++ordinal}.log`), "a", 0o600);
    try {
      const child = Bun.spawn(command, {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...env, ...extra },
        stdout: descriptor,
        stderr: descriptor,
      });
      processes.add(child);
      return child;
    } finally {
      closeSync(descriptor);
    }
  }
  async function stop(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (child.exitCode === null) child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
      processes.delete(child);
    }
  }
  async function worker(action: string, expectedExit = 0) {
    const child = start(`worker-${action}`, ["bun", workerPath, root, action]);
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    try {
      assert.equal(await child.exited, expectedExit, `Worker ${action}; inspect private test log`);
    } finally {
      clearTimeout(timer);
      processes.delete(child);
    }
  }
  async function until(predicate: () => Promise<boolean>, timeout: number, message: string) {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      assert(Date.now() < deadline, message);
      await Bun.sleep(500);
    }
  }
  async function startAdapter() {
    const child = start("adapter", ["node", "--max-old-space-size=192", executable], {
      KQ_FABRIC_ADAPTER_CONFIG: configPath,
    });
    await until(
      async () => {
        assert.equal(child.exitCode, null, "Node adapter must remain running");
        try {
          return (await lstat(socket)).isSocket();
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return false;
          throw error;
        }
      },
      10_000,
      "Node adapter socket ready",
    );
    return child;
  }
  const getBatches = () => db.select().from(batches).orderBy(asc(batches.firstSequence));
  const getAttempts = () => db.select().from(attempts).orderBy(asc(attempts.createdAt));
  let cleaned: Promise<void> | undefined;
  function cleanup() {
    cleaned ??= (async () => {
      for (const child of [...processes]) await stop(child);
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
    const keys = await readdir(join(site.userMsp, "keystore"));
    assert(keys.length === 1 && keys[0]);
    const recoveryKeyFile = join(root, "adapter-recovery.key");
    await writeFile(recoveryKeyFile, randomBytes(32), { mode: 0o600 });
    await chmod(join(site.tls, "server.key"), 0o600);
    await writeFile(
      configPath,
      JSON.stringify({
        adapter: {
          siteId: site.siteId,
          channel: network.channel,
          chaincode: network.chaincode,
          trust: network.trust,
        },
        peerEndpoint: `localhost:${site.peerPort}`,
        peerTlsCaFile: join(site.tls, "ca.crt"),
        tlsCertificateFile: join(site.tls, "server.crt"),
        tlsPrivateKeyFile: join(site.tls, "server.key"),
        identityCertificateFile: join(site.userMsp, "signcerts", "User1@b.kq.test-cert.pem"),
        identityPrivateKeyFile: join(site.userMsp, "keystore", keys[0]),
        recoveryKeyFile,
        runDirectory: join(root, "adapter-run"),
      }),
      { mode: 0o600 },
    );
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../packages/fabric-adapter/src/main.ts")],
      target: "node",
      format: "esm",
      external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
    });
    assert(build.success && build.outputs[0]);
    await writeFile(executable, await build.outputs[0].text(), { mode: 0o600 });
    await worker("initialize");
    await controls.stopOrderer();
    await worker("admit-direct");
    assert.equal((await db.select().from(reservations)).length, 1);
    assert.equal((await db.select().from(outbox)).length, 0);
    pass(
      "database direct admission works with orderer and adapter offline, without an evidence outbox",
    );

    await worker("admit-attested");
    assert.equal((await db.select().from(outbox)).length, 2);
    let adapter = await startAdapter();
    for (let i = 0; i < 3; i++) await worker("advance");
    const [prepared] = await getAttempts();
    assert.equal(prepared?.stage, "transaction");
    assert(prepared);
    await worker("tick");
    const [pending] = await getBatches();
    assert.equal(pending?.state, "pending");
    assert.equal(pending?.lastError, "LEDGER_PENDING");
    assert.deepEqual(
      (await getAttempts()).map((item) => [item.transactionId, item.stage]),
      [[prepared.transactionId, "transaction"]],
    );
    await worker("admit-attested");
    assert.equal((await db.select().from(reservations)).length, 3);
    const waiting = await db.select().from(outbox);
    assert.equal(waiting.filter((item) => item.state === "pending").length, 2);
    assert.equal(waiting.filter((item) => item.state === "batched").length, 2);
    const budgetBefore = await db.select().from(budgets).orderBy(asc(budgets.domainId));
    pass("chain outage persists the original transaction and allows another attested admission");

    await stop(adapter, "SIGKILL");
    // The previous owned process is confirmed dead before removing its crash-left socket.
    await rm(socket, { force: true });
    adapter = await startAdapter();
    await controls.startOrderer();
    await until(
      async () =>
        (await getBatches()).every((batch) => batch.nextAttemptAt.getTime() <= Date.now()),
      35_000,
      "Persisted retry deadline reached",
    );
    await worker("crash-after-commit", 86);
    const [unconfirmed] = await getBatches();
    assert.equal(unconfirmed?.state, "pending");
    assert(unconfirmed?.leaseToken && unconfirmed.leaseUntil);
    assert.deepEqual(
      (await getAttempts()).map((item) => [item.transactionId, item.stage]),
      [[prepared.transactionId, "transaction"]],
    );
    pass(
      "adapter restart preserves signed recovery; worker death after VALID leaves a recoverable DB checkpoint",
    );

    const resumed = start("worker-resumed", ["bun", workerPath, root, "serve"]);
    console.log(
      "Waiting for the real 90-second database lease to expire and the worker to recover",
    );
    await until(
      async () => {
        assert.equal(resumed.exitCode, null, "Automatic worker must remain running");
        const rows = await db.select().from(outbox);
        return rows.length === 4 && rows.every((row) => row.state === "anchored");
      },
      125_000,
      "Automatic worker must anchor both batches after the original lease expires",
    );
    await stop(resumed);
    const complete = await getBatches();
    assert.equal(complete.length, 2);
    assert.deepEqual(
      complete.map((batch) => [batch.firstSequence, batch.manifest.records.length, batch.state]),
      [
        ["1", 2, "anchored"],
        ["3", 2, "anchored"],
      ],
    );
    const completedAttempts = await getAttempts();
    assert.equal(completedAttempts.length, 2);
    assert.equal(completedAttempts[0]?.transactionId, prepared.transactionId);
    assert(
      completedAttempts.every(
        (attempt) =>
          attempt.stage === "anchored" && attempt.validationCode === 0 && attempt.blockNumber,
      ),
    );
    assert.deepEqual(await db.select().from(budgets).orderBy(asc(budgets.domainId)), budgetBefore);
    assert.equal((await db.select().from(jobs)).length, 0);
    pass(
      "automatic recovery finalizes the original txId and next batch, without duplicate attempts, budget changes or Jobs",
    );
    await stop(adapter);
  } finally {
    await cleanup();
  }
}
