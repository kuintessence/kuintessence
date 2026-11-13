import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPgDb, federationCompletionClaims, federationOutbound } from "@kuintessence/db";
import { FederationCompletionCapacity } from "../../packages/server/src/federation/completion-capacity";
import { FederationStorageGuard } from "../../packages/server/src/federation/storage-capacity";
import {
  CompletionReserveConfigSchema,
  changeCompletionReserve,
} from "../../packages/server/src/federation/storage-reserve";
import { runStorageObserver } from "../federation-storage-observer";

const command = process.argv[2];
const url = process.env.DATABASE_URL;
const siteId = process.env.FEDERATION_SITE_ID;
const volume = process.env.LAB_STORAGE_VOLUME;
const control = process.env.LAB_STORAGE_CONTROL;
assert(url && siteId && volume && control);
assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
assert(volume.startsWith("/tmp/kq-federation-pg-"));
const db = createPgDb(url, { max: 1 });
try {
  if (command === "setup") {
    await mkdir(control, { mode: 0o700 });
    const storageId = (await readFile(join(volume, ".kq-storage-id"), "utf8")).trim();
    const reserveDirectory = join(volume, `reserve-${siteId}`);
    await mkdir(reserveDirectory, { mode: 0o700 });
    const reserve = CompletionReserveConfigSchema.parse({
      version: 1,
      volumeId: randomUUID(),
      storageId,
      reserveId: randomUUID(),
      probeDirectory: volume,
      reserveDirectory,
      stateFile: join(control, "reserve-state.json"),
      bytes: "67108864",
      releaseBelowBytes: "2097152",
      minAvailableAfterArmBytes: "8388608",
      intervalSec: 1,
    });
    const keys = generateKeyPairSync("ed25519");
    await writeFile(
      join(control, "observer.key"),
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const observer = {
      version: 1,
      volumeId: reserve.volumeId,
      storageId,
      probeDirectory: volume,
      reportFile: join(control, "report.json"),
      signingKeyFile: join(control, "observer.key"),
      intervalSec: 1,
      completionReserve: {
        reserveId: reserve.reserveId,
        configFile: join(control, "reserve.json"),
      },
    };
    const policy = {
      version: 1,
      siteId,
      volumes: [
        {
          volumeId: reserve.volumeId,
          storageId,
          name: "Isolated PostgreSQL recovery volume",
          component: "postgres-data",
          modes: ["bilateral_direct", "bilateral_attested", "ledger_coordinated"],
          reportFile: observer.reportFile,
          publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
          maxReportAgeSec: 30,
          minAvailableBytes: "1048576",
          minAvailablePercent: 0,
          completionHeadroomBytes: "1048576",
          minAvailableInodes: "1",
          requiredCompletionReserve: {
            reserveId: reserve.reserveId,
            minAllocatedBytes: reserve.bytes,
          },
        },
      ],
    };
    for (const [name, data] of Object.entries({ reserve, observer, policy }))
      await writeFile(join(control, `${name}.json`), JSON.stringify(data), { mode: 0o600 });
    await changeCompletionReserve(reserve, "provision");
    await runStorageObserver(join(control, "observer.json"), true);
    const guard = await FederationStorageGuard.load(join(control, "policy.json"), siteId);
    await new FederationCompletionCapacity(db, siteId, guard).configure(
      {
        reserveId: reserve.reserveId,
        capacityBytes: reserve.bytes,
        taskBytes: "16777216",
        marketBytes: "1048576",
      },
      "isolated-storage-lab",
    );
    await db.$client`CREATE TABLE lab_storage_pressure_probe (payload text)`;
    await db.$client`ALTER TABLE lab_storage_pressure_probe ALTER COLUMN payload SET STORAGE EXTERNAL`;
    await db.$client`CHECKPOINT`;
  } else if (command === "full") {
    await assert.rejects(
      db.$client`INSERT INTO lab_storage_pressure_probe VALUES (repeat('scientific-test-only', 100000))`,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "53100",
    );
    console.log("Actual PostgreSQL SQLSTATE 53100 observed");
  } else if (command === "snapshot") {
    const guard = await FederationStorageGuard.load(join(control, "policy.json"), siteId);
    const result = {
      volume: await guard.inspect(),
      capacity: await new FederationCompletionCapacity(db, siteId, guard).inspect(),
      claims: await db.select().from(federationCompletionClaims),
      cancellations: (
        await db
          .select({
            operationId: federationOutbound.operationId,
            digest: federationOutbound.cancelDigest,
            signature: federationOutbound.cancelJws,
          })
          .from(federationOutbound)
      ).map(({ signature, ...row }) => ({
        ...row,
        signatureDigest: signature ? createHash("sha256").update(signature).digest("hex") : null,
      })),
    };
    const destination = process.env.LAB_EVIDENCE;
    assert(destination);
    await writeFile(destination, JSON.stringify(result, null, 2), { mode: 0o600 });
  } else if (command === "blocked" || command === "restored") {
    await runStorageObserver(join(control, "observer.json"), true);
    const guard = await FederationStorageGuard.load(join(control, "policy.json"), siteId);
    const [observed] = await guard.inspect();
    assert(observed && "completionReserve" in observed);
    assert.equal(observed.completionReserve?.state, command === "blocked" ? "released" : "armed");
    if (command === "blocked")
      await assert.rejects(guard.assertAdmission("bilateral_direct"), /STORAGE_PRESSURE/);
    else await guard.assertAdmission("bilateral_direct");
  } else throw new Error("Expected setup|full|snapshot|blocked|restored");
} finally {
  await db.$client.end();
}
