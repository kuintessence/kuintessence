import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPgDb,
  federationBudgets,
  federationReservations,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { FederationAdmission } from "../packages/server/src/federation/admission";
import {
  signFederationMessage,
  verifyFederationMessage,
} from "../packages/server/src/federation/signatures";
import { FederationStorageGuard } from "../packages/server/src/federation/storage-capacity";
import {
  CompletionReserveConfigSchema,
  changeCompletionReserve,
} from "../packages/server/src/federation/storage-reserve";
import {
  testAgreement,
  testDelegation,
  testKeys,
  testNow,
} from "../packages/server/src/federation/test-fixtures";
import { runStorageObserver } from "./federation-storage-observer";

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing isolated PostgreSQL port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function recovery() {
  const root = await mkdtemp(join(tmpdir(), "kq-storage-recovery-"));
  const data = join(root, "data"),
    control = join(root, "control"),
    image = join(root, "filesystem.ext4");
  const pgBin =
    process.env.FEDERATION_TEST_POSTGRES_BIN ??
    "/tmp/kq-auth-pg-tools/extracted/usr/lib/postgresql/16/bin";
  const pgShare =
    process.env.FEDERATION_TEST_POSTGRES_SHARE ??
    "/tmp/kq-auth-pg-tools/extracted/usr/share/postgresql/16";
  const env = {
    ...process.env,
    LD_LIBRARY_PATH:
      process.env.FEDERATION_TEST_POSTGRES_LIB ??
      "/tmp/kq-auth-pg-tools/extracted/usr/lib/x86_64-linux-gnu",
  };
  const port = await availablePort(),
    database = `kuintessence_unit_reserve_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = `postgres://kq@127.0.0.1:${port}/${database}`;
  const pg = (...args: string[]) =>
    execFileSync("runuser", ["-u", "nobody", "--", join(pgBin, args[0] ?? ""), ...args.slice(1)], {
      env,
      stdio: "pipe",
      timeout: 60000,
    });
  const start = () =>
    pg(
      "pg_ctl",
      "-D",
      join(data, "pg"),
      "-l",
      join(root, "pg.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${join(root, "socket")} -c shared_buffers=8MB -c max_connections=10 -c autovacuum=off -c min_wal_size=32MB -c max_wal_size=64MB`,
      "-w",
      "start",
    );
  let mounted = false,
    started = false,
    db: ReturnType<typeof createPgDb> | undefined;
  try {
    await chmod(root, 0o755);
    await mkdir(data, { mode: 0o700 });
    await mkdir(control, { mode: 0o700 });
    await mkdir(join(root, "socket"), { mode: 0o700 });
    await chown(join(root, "socket"), 65534, 65534);
    const file = await open(image, "wx", 0o600);
    try {
      await file.truncate(512 * 1024 * 1024);
    } finally {
      await file.close();
    }
    execFileSync("mkfs.ext4", ["-q", "-F", "-m", "0", image], { stdio: "pipe", timeout: 30000 });
    execFileSync("mount", ["-o", "loop,nodev,nosuid,noexec", image, data], { stdio: "pipe" });
    mounted = true;
    await chown(data, 65534, 65534);
    await mkdir(join(data, "reserve"), { mode: 0o700 });
    await writeFile(join(root, "pg.log"), "", { mode: 0o600 });
    await chown(join(root, "pg.log"), 65534, 65534);
    pg("initdb", "-D", join(data, "pg"), "-A", "trust", "--no-locale", "-U", "kq", "-L", pgShare);
    start();
    started = true;
    pg("createdb", "-h", "127.0.0.1", "-p", String(port), "-U", "kq", database);
    const migrate = Bun.spawn(
      [process.execPath, "--no-env-file", "run", "packages/db/src/pg/migrate.ts"],
      {
        env: { ...env, DATABASE_URL: url, KQ_PG_URL: url },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const migrationError = new Response(migrate.stderr).text();
    assert.equal(await migrate.exited, 0, await migrationError);
    db = createPgDb(url, { max: 2, idle_timeout: 1 });
    const config = CompletionReserveConfigSchema.parse({
      version: 1,
      volumeId: crypto.randomUUID(),
      storageId: crypto.randomUUID(),
      reserveId: crypto.randomUUID(),
      probeDirectory: data,
      reserveDirectory: join(data, "reserve"),
      stateFile: join(control, "state.json"),
      bytes: "33554432",
      releaseBelowBytes: "2097152",
      minAvailableAfterArmBytes: "4194304",
      intervalSec: 1,
    });
    const configFile = join(control, "reserve.json"),
      observerFile = join(control, "observer.json"),
      reportFile = join(control, "report.json"),
      policyFile = join(control, "policy.json"),
      keyFile = join(control, "observer.key");
    const keys = generateKeyPairSync("ed25519"),
      siteId = crypto.randomUUID();
    await writeFile(join(data, ".kq-storage-id"), config.storageId, { mode: 0o600 });
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    await writeFile(
      observerFile,
      JSON.stringify({
        version: 1,
        volumeId: config.volumeId,
        storageId: config.storageId,
        probeDirectory: data,
        reportFile,
        signingKeyFile: keyFile,
        intervalSec: 1,
        completionReserve: { reserveId: config.reserveId, configFile },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      policyFile,
      JSON.stringify({
        version: 1,
        siteId,
        volumes: [
          {
            volumeId: config.volumeId,
            storageId: config.storageId,
            name: "Isolated PostgreSQL volume",
            component: "postgres-data",
            modes: ["bilateral_direct", "bilateral_attested", "ledger_coordinated"],
            reportFile,
            publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
            maxReportAgeSec: 30,
            minAvailableBytes: "1048576",
            minAvailablePercent: 0,
            completionHeadroomBytes: "1048576",
            minAvailableInodes: "1",
            requiredCompletionReserve: {
              reserveId: config.reserveId,
              minAllocatedBytes: config.bytes,
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    await changeCompletionReserve(config, "provision");
    await runStorageObserver(observerFile, true);
    const guard = await FederationStorageGuard.load(policyFile, siteId);
    await guard.assertAdmission("bilateral_attested");
    const [a, b] = await Promise.all([testKeys(), testKeys()]);
    const identity = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
    await db.insert(orgs).values({ id: identity.orgId, name: "Isolated reserve recovery" });
    await db.insert(users).values({
      id: identity.userId,
      orgId: identity.orgId,
      email: `${identity.userId}@test.invalid`,
      role: "user",
      serviceAccount: true,
    });
    await db.insert(userOrgMemberships).values({ ...identity, role: "member" });
    const terms = testAgreement(a.signing.siteId, b.signing.siteId);
    const service = new FederationAdmission(
      db,
      b.signing,
      b.verification,
      () => testNow,
      undefined,
      guard,
    );
    await service.installApprovedAgreement({
      sourceApprovalJws: await signFederationMessage(FederationAgreementSchema, terms, a.signing),
      targetApprovalJws: await signFederationMessage(FederationAgreementSchema, terms, b.signing),
      sourceKey: a.verification,
      targetKey: b.verification,
      identity,
    });
    class BeforeReceipt extends FederationAdmission {
      override async completeReceipt(
        _id: string,
      ): Promise<{ reservationId: string; receiptJws: string }> {
        throw new Error("Injected interruption after durable admission, before receipt signature");
      }
    }
    const request = testDelegation(terms);
    const input = {
      requestJws: await signFederationMessage(FederationDelegationSchema, request, a.signing),
      senderKey: a.verification,
      authenticatedPeerSiteId: a.signing.siteId,
    };
    await assert.rejects(
      new BeforeReceipt(db, b.signing, b.verification, () => testNow, undefined, guard).receive(
        input,
      ),
      /Injected interruption/,
    );
    const [accepted] = await db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.operationId, request.operationId));
    assert(accepted && accepted.receiptJws === null);
    await db.$client`CREATE TABLE reserve_pressure_probe (payload text)`;
    await db.$client`ALTER TABLE reserve_pressure_probe ALTER COLUMN payload SET STORAGE EXTERNAL`;
    await db.$client`CHECKPOINT`;
    const fillerPath = join(data, "owned-pressure-filler");
    const filler = await open(fillerPath, "wx", 0o600);
    let reachedFull = false;
    try {
      const block = Buffer.alloc(1024 * 1024, 0x42);
      for (let i = 0; i < 520; i++) await filler.writeFile(block);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOSPC") throw error;
      reachedFull = true;
    } finally {
      await filler.close();
    }
    assert(reachedFull, "The dedicated ext4 filesystem must reach real ENOSPC");
    await assert.rejects(
      db.$client`INSERT INTO reserve_pressure_probe VALUES (repeat('scientific-test-only', 100000))`,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "53100",
    );
    await runStorageObserver(observerFile, true);
    await assert.rejects(guard.assertAdmission("bilateral_attested"), /STORAGE_PRESSURE/);
    await changeCompletionReserve(config, "tick");
    await runStorageObserver(observerFile, true);
    const observed = (await guard.inspect())[0];
    assert(observed && "completionReserve" in observed);
    assert.equal(observed.completionReserve?.state, "released");
    await assert.rejects(guard.assertAdmission("bilateral_attested"), /STORAGE_PRESSURE/);
    // Restart the real database while the filler remains; only reserve blocks were returned.
    await db.$client.end();
    db = undefined;
    pg("pg_ctl", "-D", join(data, "pg"), "-m", "fast", "-w", "stop");
    started = false;
    start();
    started = true;
    db = createPgDb(url, { max: 2, idle_timeout: 1 });
    const restartedGuard = await FederationStorageGuard.load(policyFile, siteId);
    const restarted = new FederationAdmission(
      db,
      b.signing,
      b.verification,
      () => testNow,
      undefined,
      restartedGuard,
    );
    const completed = await restarted.completeReceipt(accepted.id);
    const receipt = await verifyFederationMessage(
      FederationAcceptanceSchema,
      completed.receiptJws,
      b.verification,
      testNow,
    );
    assert.equal(receipt.payload.operationId, request.operationId);
    assert.equal(receipt.payload.reservationId, accepted.id);
    assert((await stat(fillerPath)).size > 0);
    const next = { ...testDelegation(terms), maxAmount: "1" };
    const nextInput = {
      ...input,
      requestJws: await signFederationMessage(FederationDelegationSchema, next, a.signing),
    };
    await runStorageObserver(observerFile, true);
    await assert.rejects(restarted.receive(nextInput), /STORAGE_PRESSURE/);
    assert.equal((await db.select().from(federationReservations)).length, 1);
    const [budget] = await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, terms.budgetDomainId));
    assert.equal(budget?.reserved, request.maxAmount);
    await rm(fillerPath);
    await changeCompletionReserve(config, "tick");
    await runStorageObserver(observerFile, true);
    await assert.rejects(restartedGuard.assertAdmission("bilateral_attested"), /STORAGE_PRESSURE/);
    await changeCompletionReserve(config, "restore");
    await runStorageObserver(observerFile, true);
    await restartedGuard.assertAdmission("bilateral_attested");
    await restarted.receive(nextInput);
    assert.equal((await db.select().from(federationReservations)).length, 2);
    process.stdout.write(
      "PASS isolated 512 MiB ext4/PostgreSQL: actual SQL disk-full → release 32 MiB reserve → database restart → original receipt committed → new work stays blocked → explicit reserve restoration reopens admission\n",
    );
  } finally {
    await db?.$client.end();
    if (started) pg("pg_ctl", "-D", join(data, "pg"), "-m", "immediate", "-w", "stop");
    if (mounted) execFileSync("umount", [data]);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--inside-mount-namespace") await recovery();
  else if (process.argv.length === 2) {
    const child = Bun.spawn(
      [
        "unshare",
        "--mount",
        "--fork",
        "--propagation",
        "private",
        process.execPath,
        "--no-env-file",
        import.meta.filename,
        "--inside-mount-namespace",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    process.exitCode = await child.exited;
  } else throw new Error("Usage: bun scripts/federation-storage-recovery.ts");
}
