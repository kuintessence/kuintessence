import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FederationStorageGuard } from "../packages/server/src/federation/storage-capacity";
import { runStorageObserver } from "./federation-storage-observer";

async function insideMountNamespace() {
  const directory = await mkdtemp(join(tmpdir(), "kq-storage-pressure-"));
  const data = join(directory, "data");
  let mounted = false;
  try {
    await mkdir(data, { mode: 0o700 });
    execFileSync("mount", [
      "-t",
      "tmpfs",
      "-o",
      "size=16m,mode=0700,nodev,nosuid,noexec",
      "tmpfs",
      data,
    ]);
    mounted = true;
    const keys = generateKeyPairSync("ed25519");
    const volumeId = crypto.randomUUID(),
      storageId = crypto.randomUUID(),
      siteId = crypto.randomUUID();
    const reportFile = join(directory, "report.json"),
      keyFile = join(directory, "observer.key");
    const observerFile = join(directory, "observer.json"),
      policyFile = join(directory, "policy.json");
    await writeFile(join(data, ".kq-storage-id"), storageId, { mode: 0o600 });
    await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    await writeFile(
      observerFile,
      JSON.stringify({
        version: 1,
        volumeId,
        storageId,
        probeDirectory: data,
        signingKeyFile: keyFile,
        reportFile,
        intervalSec: 1,
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
            volumeId,
            storageId,
            name: "Isolated filesystem",
            component: "postgres-data",
            modes: ["bilateral_direct", "bilateral_attested", "ledger_coordinated"],
            reportFile,
            publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
            maxReportAgeSec: 2,
            minAvailableBytes: "1048576",
            minAvailablePercent: 10,
            completionHeadroomBytes: "1048576",
            minAvailableInodes: "1",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const guard = await FederationStorageGuard.load(policyFile, siteId);
    await runStorageObserver(observerFile, true);
    assert.equal((await guard.inspect())[0]?.state, "healthy");
    await guard.assertAdmission("bilateral_attested");
    const filler = join(data, "owned-test-filler");
    const file = await open(filler, "wx", 0o600);
    let full = false;
    try {
      const block = Buffer.alloc(1024 * 1024, 0x42);
      for (let i = 0; i < 18; i++) await file.write(block);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOSPC") throw error;
      full = true;
    } finally {
      await file.close();
    }
    assert.equal(full, true, "The isolated filesystem must actually report ENOSPC");
    await runStorageObserver(observerFile, true);
    assert.equal((await guard.inspect())[0]?.state, "pressure");
    await assert.rejects(guard.assertAdmission("bilateral_attested"), /STORAGE_PRESSURE/);
    await rm(filler);
    await runStorageObserver(observerFile, true);
    assert.equal((await guard.inspect())[0]?.state, "healthy");
    await guard.assertAdmission("bilateral_attested");
    await Bun.sleep(2100);
    assert.equal((await guard.inspect())[0]?.state, "stale");
    await assert.rejects(guard.assertAdmission("bilateral_attested"), /STORAGE_PRESSURE/);
    process.stdout.write(
      "PASS actual 16 MiB filesystem: healthy → ENOSPC/pressure → recovered → stale; admission follows signed observations\n",
    );
  } finally {
    if (mounted) execFileSync("umount", [data]);
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--inside-mount-namespace") await insideMountNamespace();
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
  } else throw new Error("Usage: bun scripts/federation-storage-pressure.ts");
}
