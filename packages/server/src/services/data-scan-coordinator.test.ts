import { describe, expect, test } from "bun:test";
import { createHash, sign, X509Certificate } from "node:crypto";
import forge from "node-forge";
import type {
  DataImportCoordinator,
  DataImportScanAttestation,
  PersistedDataScanRequest,
} from "./data-import-coordinator";
import {
  type DataScanCertificate,
  DataScanCoordinator,
  type DataScanWireRequest,
  type DataScanWireResult,
} from "./data-scan-coordinator";

const request: DataScanWireRequest = {
  requestId: "11111111-1111-4111-8111-111111111111",
  importId: "22222222-2222-4222-8222-222222222222",
  assetId: "33333333-3333-4333-8333-333333333333",
  versionId: "44444444-4444-4444-8444-444444444444",
  agentId: "agent-1",
  providerOrgId: "55555555-5555-4555-8555-555555555555",
  managedRootId: "66666666-6666-4666-8666-666666666666",
  relativePath: "cohort",
};
const SCANNED_AT = new Date("2026-07-24T00:00:00.000Z");
const NOW = SCANNED_AT.getTime();

class MemoryDataImportCoordinator implements DataImportCoordinator {
  readonly records = new Map<string, PersistedDataScanRequest>();
  readonly accepted: DataImportScanAttestation[] = [];
  readonly failures: string[] = [];

  async requestCpLocalScan(
    input: DataScanWireRequest & { deadlineAt: Date },
  ): Promise<{ request: PersistedDataScanRequest; created: boolean }> {
    const existing = this.records.get(input.requestId);
    if (existing) return { request: existing, created: false };
    const created: PersistedDataScanRequest = {
      ...input,
      attempt: 0,
      status: "pending",
    };
    this.records.set(input.requestId, created);
    return { request: created, created: true };
  }

  async listPendingCpLocalScans(): Promise<PersistedDataScanRequest[]> {
    return [...this.records.values()].filter((record) => record.status === "pending");
  }

  async getCpLocalScan(requestId: string): Promise<PersistedDataScanRequest | null> {
    return this.records.get(requestId) ?? null;
  }

  async markCpLocalScanAttempt(requestId: string, _dispatched: boolean): Promise<void> {
    const record = this.records.get(requestId);
    if (record?.status === "pending") record.attempt += 1;
  }

  async acceptCpLocalScanAttestation(input: DataImportScanAttestation): Promise<void> {
    const record = this.records.get(input.requestId);
    if (!record || record.status === "completed") return;
    record.status = "completed";
    this.accepted.push(input);
  }

  async failCpLocalScan(input: {
    requestId: string;
    importId: string;
    error: string;
    completedAt: Date;
  }): Promise<void> {
    const record = this.records.get(input.requestId);
    if (!record || record.status !== "pending") return;
    record.status = "failed";
    this.failures.push(input.error);
  }
}

function createCertificateFixture(): {
  certificate: DataScanCertificate;
  privateKeyPem: string;
} {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00.000Z");
  cert.validity.notAfter = new Date("2027-01-01T00:00:00.000Z");
  cert.setSubject([{ name: "commonName", value: request.agentId }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const fingerprintSha256 = new X509Certificate(certPem).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  return {
    certificate: {
      agentId: request.agentId,
      fingerprintSha256,
      subjectCn: request.agentId,
      certPem,
      issuedAt: cert.validity.notBefore,
      expiresAt: cert.validity.notAfter,
      revokedAt: null,
    },
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

const certificateFixture = createCertificateFixture();

function signedResult(
  overrides: Partial<DataScanWireResult> = {},
  privateKeyPem = certificateFixture.privateKeyPem,
): DataScanWireResult {
  const unsigned: DataScanWireResult = {
    ...request,
    manifestDigest: "b".repeat(64),
    contentSha256: "c".repeat(64),
    totalSizeBytes: 6,
    format: "directory",
    files: [{ path: "sample.txt", digest: "d".repeat(64), sizeBytes: 6 }],
    attestationAlgorithm: "rsa-sha256",
    attestationKeyId: certificateFixture.certificate.fingerprintSha256,
    attestationSignature: "",
    scannedAt: SCANNED_AT,
    ...overrides,
  };
  const entries = unsigned.files.map((file) => ({
    path: file.path,
    digest: file.digest,
    sizeBytes: file.sizeBytes,
    mediaType: file.mediaType ?? "",
  }));
  const payload = {
    requestId: unsigned.requestId,
    importId: unsigned.importId,
    assetId: unsigned.assetId,
    versionId: unsigned.versionId,
    agentId: unsigned.agentId,
    providerOrgId: unsigned.providerOrgId,
    managedRootId: unsigned.managedRootId,
    relativePath: unsigned.relativePath,
    manifestDigest: unsigned.manifestDigest,
    contentSha256: unsigned.contentSha256,
    totalSizeBytes: unsigned.totalSizeBytes,
    format: unsigned.format,
    entriesDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    scannedAtUnixMs: unsigned.scannedAt.getTime(),
  };
  return {
    ...unsigned,
    attestationSignature: sign(
      "RSA-SHA256",
      Buffer.from(JSON.stringify(payload)),
      privateKeyPem,
    ).toString("base64"),
  };
}

function coordinatorFixture(input?: {
  store?: MemoryDataImportCoordinator;
  certificate?: DataScanCertificate;
  dispatched?: boolean;
  now?: () => number;
}) {
  const store = input?.store ?? new MemoryDataImportCoordinator();
  const sent: string[] = [];
  const coordinator = new DataScanCoordinator(
    store,
    {
      pushDataScanRequest: (agentId, scanRequest) => {
        sent.push(`${agentId}:${scanRequest.requestId}`);
        return input?.dispatched ?? true;
      },
    },
    {
      findByFingerprint: async () => input?.certificate ?? certificateFixture.certificate,
    },
    { now: input?.now ?? (() => NOW), timeoutMs: 1_000 },
  );
  return { coordinator, sent, store };
}

describe("DataScanCoordinator", () => {
  test("verifies and persists a certificate-backed canonical attestation", async () => {
    const { coordinator, sent, store } = coordinatorFixture();
    await expect(coordinator.requestScan(request)).resolves.toBe(true);
    await coordinator.acceptAgentResult(request.agentId, signedResult());
    await coordinator.acceptAgentResult(request.agentId, signedResult());

    expect(sent).toEqual([`${request.agentId}:${request.requestId}`]);
    expect(store.records.get(request.requestId)?.attempt).toBe(1);
    expect(store.accepted).toHaveLength(1);
    expect(JSON.parse(store.accepted[0]?.attestationPayload ?? "{}")).toEqual(
      expect.objectContaining({
        requestId: request.requestId,
        providerOrgId: request.providerOrgId,
        managedRootId: request.managedRootId,
      }),
    );
    expect(store.accepted[0]?.attestationSignature).not.toBe("");
  });

  test("rejects a result bound to another managed root", async () => {
    const { coordinator } = coordinatorFixture();
    await coordinator.requestScan(request);
    await expect(
      coordinator.acceptAgentResult(
        request.agentId,
        signedResult({ managedRootId: "77777777-7777-4777-8777-777777777777" }),
      ),
    ).rejects.toThrow("request binding");
  });

  test("rejects signature forgery", async () => {
    const wrongKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const { coordinator } = coordinatorFixture();
    await coordinator.requestScan(request);
    await expect(
      coordinator.acceptAgentResult(
        request.agentId,
        signedResult({}, forge.pki.privateKeyToPem(wrongKeys.privateKey)),
      ),
    ).rejects.toThrow("signature verification");
  });

  test("rejects a revoked certificate", async () => {
    const { coordinator } = coordinatorFixture({
      certificate: { ...certificateFixture.certificate, revokedAt: SCANNED_AT },
    });
    await coordinator.requestScan(request);
    await expect(coordinator.acceptAgentResult(request.agentId, signedResult())).rejects.toThrow(
      "not registered and valid",
    );
  });

  test("recovers pending requests after restart and replays on Agent reconnect", async () => {
    const store = new MemoryDataImportCoordinator();
    const first = coordinatorFixture({ store });
    await first.coordinator.requestScan(request);
    const restarted = coordinatorFixture({ store });

    await expect(restarted.coordinator.recoverPending()).resolves.toBe(1);
    await restarted.coordinator.onAgentConnected(request.agentId);
    await restarted.coordinator.acceptAgentResult(request.agentId, signedResult());

    expect(restarted.sent).toEqual([`${request.agentId}:${request.requestId}`]);
    expect(store.records.get(request.requestId)?.attempt).toBe(2);
    expect(store.records.get(request.requestId)?.status).toBe("completed");
  });

  test("keeps an unavailable Agent scan pending and reports it as queued", async () => {
    const { coordinator, sent, store } = coordinatorFixture({ dispatched: false });

    await expect(coordinator.requestScan(request)).resolves.toBe(false);

    expect(sent).toEqual([`${request.agentId}:${request.requestId}`]);
    expect(store.records.get(request.requestId)).toMatchObject({
      attempt: 1,
      status: "pending",
    });
  });

  test("dispatches only when requestScanIfMissing creates the durable request", async () => {
    const { coordinator, sent, store } = coordinatorFixture();

    await expect(coordinator.requestScanIfMissing(request)).resolves.toBe(true);
    await expect(coordinator.requestScanIfMissing(request)).resolves.toBeNull();

    expect(sent).toEqual([`${request.agentId}:${request.requestId}`]);
    expect(store.records.get(request.requestId)).toMatchObject({ attempt: 1, status: "pending" });
  });

  test("persists timeout failure for an unfinished recovered scan", async () => {
    let now = NOW;
    const { coordinator, store } = coordinatorFixture({ now: () => now });
    await coordinator.requestScan(request);
    now += 1_000;
    await expect(coordinator.sweepTimedOut()).resolves.toEqual([request.requestId]);
    expect(store.records.get(request.requestId)?.status).toBe("failed");
    expect(store.failures).toEqual(["CP-local data scan timed out"]);
  });
});
