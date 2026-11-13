import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FederationStorageGuard,
  loadStorageObserverKey,
  observeStorage,
  readStorageFile,
  StorageGuardConfigSchema,
  type StorageObservation,
  signStorageObservation,
} from "./storage-capacity";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const now = new Date("2026-11-09T00:00:00.000Z");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-storage-capacity-"));
  directories.push(root);
  const keys = generateKeyPairSync("ed25519");
  const volumeId = crypto.randomUUID(),
    storageId = crypto.randomUUID(),
    siteId = crypto.randomUUID();
  const reportFile = join(root, "report.json"),
    keyFile = join(root, "observer.key"),
    policyFile = join(root, "policy.json");
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(join(root, ".kq-storage-id"), storageId, { mode: 0o600 });
  const observer = {
    version: 1 as const,
    volumeId,
    storageId,
    reportFile,
    signingKeyFile: keyFile,
    probeDirectory: root,
    intervalSec: 1,
  };
  const policy = StorageGuardConfigSchema.parse({
    version: 1,
    siteId,
    volumes: [
      {
        volumeId,
        storageId,
        name: "Evidence database",
        component: "postgres-data",
        modes: ["bilateral_direct", "bilateral_attested", "ledger_coordinated"],
        reportFile,
        publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
        maxReportAgeSec: 30,
        minAvailableBytes: "100",
        minAvailablePercent: 10,
        completionHeadroomBytes: "20",
        minAvailableInodes: "10",
      },
    ],
  });
  const report: StorageObservation = {
    version: 1,
    volumeId,
    storageId,
    observedAt: now.toISOString(),
    state: "observed",
    device: "1",
    filesystemType: "1",
    totalBytes: "1000",
    availableBytes: "121",
    totalInodes: "100",
    availableInodes: "10",
  };
  const publish = (value: StorageObservation = report) =>
    writeFile(reportFile, signStorageObservation(value, keys.privateKey));
  const guard = async () => {
    await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
    return FederationStorageGuard.load(policyFile, siteId, () => now);
  };
  await publish();
  return { root, keys, observer, policy, policyFile, report, publish, guard };
}

test("storage observer measures the marked filesystem and fails closed on a replaced or missing identity", async () => {
  const f = await fixture();
  const report = await observeStorage(f.observer, () => now);
  expect(report.state).toBe("observed");
  if (report.state !== "observed") throw new Error("Missing observation");
  const actual = await statfs(f.root, { bigint: true });
  expect(report.totalBytes).toBe((actual.blocks * actual.bsize).toString());
  expect(report.device).toBe((await stat(f.root, { bigint: true })).dev.toString());
  expect(BigInt(report.availableBytes)).toBeGreaterThan(0n);
  expect(report.observedAt).toBe(now.toISOString());
  await writeFile(join(f.root, ".kq-storage-id"), crypto.randomUUID());
  expect((await observeStorage(f.observer)).state).toBe("unavailable");
  await rm(join(f.root, ".kq-storage-id"));
  expect((await observeStorage(f.observer)).state).toBe("unavailable");
  await symlink(f.observer.signingKeyFile, join(f.root, ".kq-storage-id"));
  expect((await observeStorage(f.observer)).state).toBe("unavailable");
});

test("storage guard combines absolute, percentage, completion margin and inode boundaries", async () => {
  const f = await fixture(),
    guard = await f.guard();
  await guard.assertAdmission("bilateral_attested");
  await f.publish({ ...f.report, availableBytes: "120" });
  await expect(guard.assertAdmission("bilateral_attested")).rejects.toThrow("STORAGE_PRESSURE");
  expect((await guard.inspect())[0]).toMatchObject({ state: "pressure", requiredBytes: "120" });
  await f.publish({ ...f.report, availableInodes: "9" });
  await expect(guard.assertAdmission("bilateral_direct")).rejects.toThrow("STORAGE_PRESSURE");
  await f.publish({ ...f.report, totalInodes: null, availableInodes: null });
  expect((await guard.inspect())[0]?.state).toBe("pressure");
  const volume = f.policy.volumes[0];
  if (!volume) throw new Error("Missing volume");
  volume.minAvailableBytes = "9007199254740993001";
  await f.publish({
    ...f.report,
    totalBytes: "99999999999999999999",
    availableBytes: "9007199254740993021",
  });
  volume.minAvailablePercent = 0;
  const exact = await f.guard();
  expect((await exact.inspect())[0]?.state).toBe("pressure");
  await f.publish({
    ...f.report,
    totalBytes: "99999999999999999999",
    availableBytes: "9007199254740993022",
  });
  expect((await exact.inspect())[0]?.state).toBe("healthy");
});

test("storage freshness is exclusive and future or unavailable observations never permit admission", async () => {
  const f = await fixture(),
    guard = await f.guard();
  for (const offset of [-30000, 5001]) {
    await f.publish({ ...f.report, observedAt: new Date(now.getTime() + offset).toISOString() });
    expect((await guard.inspect())[0]?.state).toBe("stale");
    await expect(guard.assertAdmission("bilateral_attested")).rejects.toThrow("STORAGE_PRESSURE");
  }
  await f.publish({ ...f.report, observedAt: new Date(now.getTime() - 29999).toISOString() });
  await guard.assertAdmission("bilateral_attested");
  await f.publish({
    version: 1,
    volumeId: f.report.volumeId,
    storageId: f.report.storageId,
    observedAt: now.toISOString(),
    state: "unavailable",
  });
  expect((await guard.inspect())[0]?.state).toBe("unavailable");
  await expect(guard.assertAdmission("bilateral_attested")).rejects.toThrow("STORAGE_PRESSURE");
});

test("storage guard rejects forged, oversized, redirected and wrong-volume reports without returning their contents", async () => {
  const f = await fixture(),
    guard = await f.guard();
  const valid = JSON.parse(await readFile(f.observer.reportFile, "utf8"));
  const payload = Buffer.from(JSON.stringify({ ...f.report, availableBytes: "999" })).toString(
    "base64url",
  );
  const otherKey = generateKeyPairSync("ed25519");
  for (const bytes of [
    JSON.stringify({ ...valid, payload }),
    signStorageObservation(f.report, otherKey.privateKey),
    signStorageObservation({ ...f.report, volumeId: crypto.randomUUID() }, f.keys.privateKey),
    signStorageObservation({ ...f.report, storageId: crypto.randomUUID() }, f.keys.privateKey),
    "x".repeat(16385),
    "not JSON",
  ]) {
    await writeFile(f.observer.reportFile, bytes);
    expect((await guard.inspect())[0]?.state).toBe("unavailable");
  }
  await rm(f.observer.reportFile);
  expect((await guard.inspect())[0]?.state).toBe("unavailable");
  await symlink(f.observer.signingKeyFile, f.observer.reportFile);
  expect((await guard.inspect())[0]?.state).toBe("unavailable");
  expect(JSON.stringify(await guard.inspect())).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(await guard.inspect())).not.toContain(f.root);
});

test("chain-volume observation cannot become an implicit dependency of configured bilateral modes", async () => {
  const f = await fixture();
  const volume = f.policy.volumes[0];
  if (!volume) throw new Error("Missing volume");
  f.policy.volumes.push({
    ...volume,
    volumeId: crypto.randomUUID(),
    component: "peer",
    name: "Peer",
    reportFile: join(f.root, "missing-peer.json"),
    modes: ["ledger_coordinated"],
  });
  const guard = await f.guard();
  await guard.assertAdmission("bilateral_direct");
  await guard.assertAdmission("bilateral_attested");
  await expect(guard.assertAdmission("ledger_coordinated")).rejects.toThrow("STORAGE_PRESSURE");
  expect(await guard.inspect()).toHaveLength(2);
});

test("storage policy and private keys require protected files, expected site and complete database mode coverage", async () => {
  const f = await fixture();
  await f.guard();
  await expect(FederationStorageGuard.load(f.policyFile, crypto.randomUUID())).rejects.toThrow(
    "another site",
  );
  await chmod(f.policyFile, 0o644);
  await expect(FederationStorageGuard.load(f.policyFile, f.policy.siteId)).rejects.toThrow(
    "Invalid storage observer file",
  );
  expect((await loadStorageObserverKey(f.observer.signingKeyFile)).asymmetricKeyType).toBe(
    "ed25519",
  );
  await chmod(f.observer.signingKeyFile, 0o644);
  await expect(loadStorageObserverKey(f.observer.signingKeyFile)).rejects.toThrow(
    "Invalid storage observer file",
  );
  await expect(readStorageFile(f.root)).rejects.toThrow("Invalid storage observer file");
  expect(StorageGuardConfigSchema.safeParse({ ...f.policy, volumes: [] }).success).toBe(false);
  const volume = f.policy.volumes[0];
  expect(
    StorageGuardConfigSchema.safeParse({ ...f.policy, volumes: [volume, volume] }).success,
  ).toBe(false);
  expect(
    StorageGuardConfigSchema.safeParse({
      ...f.policy,
      volumes: [{ ...volume, modes: ["ledger_coordinated"] }],
    }).success,
  ).toBe(false);
});

test("storage observation delivery cannot roll a known pressure sample back to an older healthy sample", async () => {
  const f = await fixture(),
    guard = await f.guard();
  await f.publish({ ...f.report, availableBytes: "100" });
  expect((await guard.inspect())[0]?.state).toBe("pressure");
  await f.publish({ ...f.report, observedAt: new Date(now.getTime() - 1000).toISOString() });
  expect((await guard.inspect())[0]?.state).toBe("stale");
  await expect(guard.assertAdmission("bilateral_attested")).rejects.toThrow("STORAGE_PRESSURE");
});

test("storage guard requires the configured physical reserve and does not reopen admission when released blocks become free", async () => {
  const f = await fixture();
  const reserveId = crypto.randomUUID();
  const volume = f.policy.volumes[0];
  if (!volume) throw new Error("Missing policy");
  volume.requiredCompletionReserve = { reserveId, minAllocatedBytes: "100" };
  const guard = await f.guard();
  await expect(guard.assertAdmission("bilateral_direct")).rejects.toThrow("STORAGE_PRESSURE");
  for (const state of ["arming", "released", "unavailable"] as const) {
    await f.publish({
      ...f.report,
      availableBytes: "999",
      completionReserve: { reserveId, state, allocatedBytes: null },
    });
    expect((await guard.inspect())[0]?.state).toBe("pressure");
  }
  await f.publish({
    ...f.report,
    completionReserve: { reserveId, state: "armed", allocatedBytes: "99" },
  });
  await expect(guard.assertAdmission("bilateral_direct")).rejects.toThrow("STORAGE_PRESSURE");
  await f.publish({
    ...f.report,
    completionReserve: { reserveId: crypto.randomUUID(), state: "armed", allocatedBytes: "100" },
  });
  await expect(guard.assertAdmission("bilateral_direct")).rejects.toThrow("STORAGE_PRESSURE");
  await f.publish({
    ...f.report,
    completionReserve: { reserveId, state: "armed", allocatedBytes: "100" },
  });
  await guard.assertAdmission("bilateral_direct");
  const observed = (await guard.inspect())[0];
  if (!observed || !("completionReserve" in observed))
    throw new Error("Missing reserve observation");
  expect(observed.completionReserve).toEqual({
    reserveId,
    state: "armed",
    allocatedBytes: "100",
  });
});

test("an observer-declared released reserve blocks admission even before the policy declares a reserve minimum", async () => {
  const f = await fixture();
  await f.publish({
    ...f.report,
    completionReserve: { reserveId: crypto.randomUUID(), state: "released", allocatedBytes: null },
  });
  await expect((await f.guard()).assertAdmission("bilateral_attested")).rejects.toThrow(
    "STORAGE_PRESSURE",
  );
});
