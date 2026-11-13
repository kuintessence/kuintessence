import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FederationStorageGuard } from "../packages/server/src/federation/storage-capacity";
import { runStorageObserver } from "./federation-storage-observer";

test("storage observer publishes a real signed sample atomically and replaces it with failure on loss of volume identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-observer-publish-"));
  try {
    const keys = generateKeyPairSync("ed25519"),
      volumeId = crypto.randomUUID(),
      storageId = crypto.randomUUID(),
      siteId = crypto.randomUUID();
    const keyFile = join(directory, "signing.key"),
      configFile = join(directory, "observer.json"),
      reportFile = join(directory, "report.json"),
      policyFile = join(directory, "policy.json");
    await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    await writeFile(join(directory, ".kq-storage-id"), storageId);
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        volumeId,
        storageId,
        signingKeyFile: keyFile,
        reportFile,
        probeDirectory: directory,
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
            name: "Database",
            component: "postgres-data",
            modes: ["bilateral_direct", "bilateral_attested", "ledger_coordinated"],
            reportFile,
            publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
            maxReportAgeSec: 30,
            minAvailableBytes: "0",
            minAvailablePercent: 0,
            completionHeadroomBytes: "0",
            minAvailableInodes: "0",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const guard = await FederationStorageGuard.load(policyFile, siteId);
    expect((await guard.inspect())[0]?.state).toBe("unavailable");
    await runStorageObserver(configFile, true);
    expect((await guard.inspect())[0]?.state).toBe("healthy");
    expect(await readFile(reportFile, "utf8")).not.toContain("PRIVATE KEY");
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await rm(join(directory, ".kq-storage-id"));
    await runStorageObserver(configFile, true);
    expect((await guard.inspect())[0]?.state).toBe("unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
