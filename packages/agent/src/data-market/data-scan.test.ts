import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCpLocalDataScanAttestationPayload,
  createCpLocalDataScanner,
  createCpLocalDataScanSigner,
  serializeCpLocalDataScanAttestation,
} from "./data-scan";
import { AgentDataRoots } from "./local-data-security";

const MANAGED_ROOT_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ORG_ID = "22222222-2222-4222-8222-222222222222";

async function scannerFixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-cp-local-scan-"));
  const datasetRoot = join(root, "datasets");
  const jobWorkRoot = join(root, "jobs");
  await mkdir(join(datasetRoot, "registered", "cohort"), { recursive: true, mode: 0o700 });
  await writeFile(join(datasetRoot, "registered", "cohort", "sample.txt"), "sample");
  const roots = new AgentDataRoots({
    datasetRoot,
    managedRoots: { [MANAGED_ROOT_ID]: "registered" },
    jobWorkRoot,
  });
  await roots.initialize();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = createCpLocalDataScanSigner({
    keyId: "agent-cert-fingerprint",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  return { roots, signer, publicKey };
}

describe("CP-local data scanner", () => {
  test("returns signed metadata without dataset bytes or absolute paths", async () => {
    const { roots, signer, publicKey } = await scannerFixture();
    const scanner = createCpLocalDataScanner({
      roots,
      agentId: "agent-1",
      signer,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });
    const result = await scanner.scan({
      requestId: "request-1",
      importId: "import-1",
      assetId: "asset-1",
      versionId: "version-1",
      managedRootId: MANAGED_ROOT_ID,
      relativePath: "cohort",
      providerOrgId: PROVIDER_ORG_ID,
    });

    const attestationPayload = createCpLocalDataScanAttestationPayload({
      request: result,
      agentId: result.agentId,
      manifestDigest: result.manifestDigest,
      contentSha256: result.contentSha256,
      totalSizeBytes: result.totalSizeBytes,
      format: result.format,
      files: result.files,
      scannedAtUnixMs: result.scannedAtUnixMs,
    });
    expect(result.files).toEqual([expect.objectContaining({ path: "sample.txt", sizeBytes: 6 })]);
    expect(result.manifestDigest).toHaveLength(64);
    expect(result.contentSha256).toHaveLength(64);
    expect(JSON.stringify(result)).not.toContain("datasets/");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(serializeCpLocalDataScanAttestation(attestationPayload)),
        publicKey,
        Buffer.from(result.attestationSignature, "base64"),
      ),
    ).toBe(true);
  });

  test("rejects absolute or traversal scan paths before touching the filesystem", async () => {
    const { roots, signer } = await scannerFixture();
    const scanner = createCpLocalDataScanner({ roots, agentId: "agent-1", signer });
    const input = {
      requestId: "request-1",
      importId: "import-1",
      assetId: "asset-1",
      versionId: "version-1",
      managedRootId: MANAGED_ROOT_ID,
      providerOrgId: PROVIDER_ORG_ID,
    };
    await expect(scanner.scan({ ...input, relativePath: "/etc" })).rejects.toThrow("relative");
    await expect(scanner.scan({ ...input, relativePath: "../cohort" })).rejects.toThrow("relative");
  });
});
