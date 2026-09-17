import { createHash, verify, X509Certificate } from "node:crypto";
import { agentCerts, type PgDb } from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import type {
  DataImportCoordinator,
  DataImportScanAttestation,
  DataImportScanRequest,
  PersistedDataScanRequest,
} from "./data-import-coordinator";

export interface DataScanDispatcher {
  pushDataScanRequest(agentId: string, request: DataScanWireRequest): boolean;
}

export interface DataScanWireRequest extends DataImportScanRequest {
  requestId: string;
}

export interface DataScanWireResult extends DataScanWireRequest {
  agentId: string;
  manifestDigest: string;
  contentSha256: string;
  totalSizeBytes: number;
  format: string;
  files: Array<{ path: string; digest: string; sizeBytes: number; mediaType?: string }>;
  attestationAlgorithm: string;
  attestationKeyId: string;
  attestationSignature: string;
  scannedAt: Date;
  error?: string;
}

export interface DataScanCertificate {
  agentId: string;
  fingerprintSha256: string;
  subjectCn: string;
  certPem: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface DataScanCertificateLookup {
  findByFingerprint(
    agentId: string,
    fingerprintSha256: string,
  ): Promise<DataScanCertificate | null>;
}

interface PendingScan {
  request: DataScanWireRequest;
  deadline: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface DataScanAttestationPayload extends Record<string, unknown> {
  requestId: string;
  importId: string;
  assetId: string;
  versionId: string;
  agentId: string;
  providerOrgId: string;
  managedRootId: string;
  relativePath: string;
  manifestDigest: string;
  contentSha256: string;
  totalSizeBytes: number;
  format: string;
  entriesDigest: string;
  scannedAtUnixMs: number;
}

export class PgDataScanCertificateLookup implements DataScanCertificateLookup {
  constructor(private readonly db: PgDb) {}

  async findByFingerprint(
    agentId: string,
    fingerprintSha256: string,
  ): Promise<DataScanCertificate | null> {
    const [certificate] = await this.db
      .select({
        agentId: agentCerts.agentId,
        fingerprintSha256: agentCerts.fingerprintSha256,
        subjectCn: agentCerts.subjectCn,
        certPem: agentCerts.certPem,
        issuedAt: agentCerts.issuedAt,
        expiresAt: agentCerts.expiresAt,
        revokedAt: agentCerts.revokedAt,
      })
      .from(agentCerts)
      .where(
        and(eq(agentCerts.agentId, agentId), eq(agentCerts.fingerprintSha256, fingerprintSha256)),
      )
      .limit(1);
    return certificate ?? null;
  }
}

export class DataScanCoordinator {
  private readonly pending = new Map<string, PendingScan>();

  constructor(
    private readonly dataImports: DataImportCoordinator,
    private readonly dispatcher: DataScanDispatcher,
    private readonly certificates: DataScanCertificateLookup,
    private readonly options: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  async recoverPending(): Promise<number> {
    const stored = await this.dataImports.listPendingCpLocalScans();
    for (const record of stored) {
      if (record.deadlineAt.getTime() <= this.now()) {
        await this.fail(record, "CP-local data scan timed out");
        continue;
      }
      this.track(record);
    }
    return this.pending.size;
  }

  async requestScan(request: DataScanWireRequest): Promise<boolean> {
    assertWireRequest(request);
    const inMemory = this.pending.get(request.requestId);
    if (inMemory) {
      assertSameRequest(inMemory.request, request);
      return this.dispatch(inMemory.request);
    }
    const deadlineAt = new Date(this.now() + (this.options.timeoutMs ?? 300_000));
    const { request: persisted } = await this.dataImports.requestCpLocalScan({
      ...request,
      deadlineAt,
    });
    assertSameRequest(persisted, request);
    if (persisted.status === "completed") return true;
    if (persisted.status === "failed") {
      throw new Error("Data scan request has already failed");
    }
    this.track(persisted);
    return this.dispatch(request);
  }

  async requestScanIfMissing(request: DataScanWireRequest): Promise<boolean | null> {
    assertWireRequest(request);
    const deadlineAt = new Date(this.now() + (this.options.timeoutMs ?? 300_000));
    const persisted = await this.dataImports.requestCpLocalScan({ ...request, deadlineAt });
    assertSameRequest(persisted.request, request);
    if (!persisted.created) return null;
    this.track(persisted.request);
    return this.dispatch(request);
  }

  async onAgentConnected(agentId: string): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.request.agentId === agentId && pending.deadline > this.now()) {
        await this.dispatch(pending.request);
      }
    }
  }

  async acceptAgentResult(registeredAgentId: string, result: DataScanWireResult): Promise<void> {
    const pending = await this.findPending(result.requestId);
    if (!pending) {
      const stored = await this.dataImports.getCpLocalScan(result.requestId);
      if (stored?.status === "completed") return;
      throw new Error("Unknown data scan requestId");
    }
    if (pending.request.agentId !== registeredAgentId || result.agentId !== registeredAgentId) {
      throw new Error("Data scan result agent identity does not match its request");
    }
    assertSameRequest(pending.request, result);
    if (result.error?.trim()) {
      await this.fail(
        {
          ...pending.request,
          deadlineAt: new Date(pending.deadline),
          attempt: 0,
          status: "pending",
        },
        result.error,
      );
      throw new Error(`Agent data scan failed: ${result.error}`);
    }
    assertAttestation(result);
    const payload = createAttestationPayload(result);
    const serializedPayload = JSON.stringify(payload);
    await this.verifyAttestation(result, serializedPayload);
    const attestation: DataImportScanAttestation = {
      requestId: result.requestId,
      importId: result.importId,
      agentId: registeredAgentId,
      providerOrgId: result.providerOrgId,
      managedRootId: result.managedRootId,
      relativePath: result.relativePath,
      manifestDigest: result.manifestDigest,
      contentHash: result.contentSha256,
      sizeBytes: result.totalSizeBytes,
      format: result.format,
      entries: result.files.map((file) => ({
        path: file.path,
        digest: file.digest,
        sizeBytes: file.sizeBytes,
        mediaType: file.mediaType,
      })),
      scannedAt: result.scannedAt,
      attestationPayload: serializedPayload,
      attestationSignature: result.attestationSignature,
    };
    await this.dataImports.acceptCpLocalScanAttestation(attestation);
    this.removePending(result.requestId);
  }

  async sweepTimedOut(): Promise<string[]> {
    const expired: string[] = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.deadline <= this.now()) {
        const stored: PersistedDataScanRequest = {
          ...pending.request,
          deadlineAt: new Date(pending.deadline),
          attempt: 0,
          status: "pending",
        };
        await this.fail(stored, "CP-local data scan timed out");
        expired.push(requestId);
      }
    }
    return expired;
  }

  private async findPending(requestId: string): Promise<PendingScan | null> {
    const inMemory = this.pending.get(requestId);
    if (inMemory) return inMemory;
    const stored = await this.dataImports.getCpLocalScan(requestId);
    if (!stored || stored.status !== "pending") return null;
    if (stored.deadlineAt.getTime() <= this.now()) {
      await this.fail(stored, "CP-local data scan timed out");
      return null;
    }
    return this.track(stored);
  }

  private track(record: PersistedDataScanRequest): PendingScan {
    const request = toWireRequest(record);
    const pending: PendingScan = { request, deadline: record.deadlineAt.getTime() };
    const delay = Math.max(0, pending.deadline - this.now());
    pending.timeout = setTimeout(() => {
      void this.expire(record.requestId);
    }, delay);
    pending.timeout.unref?.();
    this.pending.set(record.requestId, pending);
    return pending;
  }

  private async dispatch(request: DataScanWireRequest): Promise<boolean> {
    const dispatched = this.dispatcher.pushDataScanRequest(request.agentId, request);
    await this.dataImports.markCpLocalScanAttempt(request.requestId, dispatched);
    return dispatched;
  }

  private async verifyAttestation(
    result: DataScanWireResult,
    serializedPayload: string,
  ): Promise<void> {
    const certificate = await this.certificates.findByFingerprint(
      result.agentId,
      result.attestationKeyId,
    );
    const scannedAt = result.scannedAt.getTime();
    if (
      !certificate ||
      certificate.revokedAt ||
      certificate.agentId !== result.agentId ||
      certificate.subjectCn !== result.agentId ||
      certificate.fingerprintSha256 !== result.attestationKeyId ||
      certificate.issuedAt.getTime() > scannedAt ||
      certificate.expiresAt.getTime() < scannedAt ||
      certificate.expiresAt.getTime() <= this.now()
    ) {
      throw new Error("Data scan attestation certificate is not registered and valid");
    }
    let parsedCertificate: X509Certificate;
    try {
      parsedCertificate = new X509Certificate(certificate.certPem);
    } catch {
      throw new Error("Data scan attestation certificate is invalid");
    }
    const actualFingerprint = parsedCertificate.fingerprint256.replaceAll(":", "").toLowerCase();
    if (actualFingerprint !== result.attestationKeyId.toLowerCase()) {
      throw new Error("Data scan attestation certificate fingerprint does not match its ledger");
    }
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(serializedPayload),
      parsedCertificate.publicKey,
      Buffer.from(result.attestationSignature, "base64"),
    );
    if (!valid) throw new Error("Data scan attestation signature verification failed");
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async expire(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    await this.fail(
      {
        ...pending.request,
        deadlineAt: new Date(pending.deadline),
        attempt: 0,
        status: "pending",
      },
      "CP-local data scan timed out",
    );
  }

  private async fail(record: PersistedDataScanRequest, error: string): Promise<void> {
    this.removePending(record.requestId);
    await this.dataImports.failCpLocalScan({
      requestId: record.requestId,
      importId: record.importId,
      error,
      completedAt: new Date(this.now()),
    });
  }

  private removePending(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending?.timeout) clearTimeout(pending.timeout);
    this.pending.delete(requestId);
  }
}

function toWireRequest(record: PersistedDataScanRequest): DataScanWireRequest {
  return {
    requestId: record.requestId,
    importId: record.importId,
    assetId: record.assetId,
    versionId: record.versionId,
    agentId: record.agentId,
    providerOrgId: record.providerOrgId,
    managedRootId: record.managedRootId,
    relativePath: record.relativePath,
  };
}

function assertWireRequest(request: DataScanWireRequest): void {
  for (const value of [
    request.requestId,
    request.importId,
    request.assetId,
    request.versionId,
    request.agentId,
    request.providerOrgId,
    request.managedRootId,
  ]) {
    if (!value.trim()) throw new Error("Data scan request identifiers must be non-empty");
  }
  if (
    !request.relativePath ||
    request.relativePath.startsWith("/") ||
    request.relativePath.split(/[\\/]/).some((part) => part === "" || part === "..")
  ) {
    throw new Error("Data scan relativePath must be relative without parent traversal");
  }
}

function assertSameRequest(
  request: DataScanWireRequest | PersistedDataScanRequest,
  candidate: DataScanWireRequest | DataScanWireResult,
): void {
  if (
    request.requestId !== candidate.requestId ||
    request.importId !== candidate.importId ||
    request.assetId !== candidate.assetId ||
    request.versionId !== candidate.versionId ||
    request.agentId !== candidate.agentId ||
    request.providerOrgId !== candidate.providerOrgId ||
    request.managedRootId !== candidate.managedRootId ||
    request.relativePath !== candidate.relativePath
  ) {
    throw new Error("Data scan result does not match its request binding");
  }
}

function createAttestationPayload(result: DataScanWireResult): DataScanAttestationPayload {
  const entries = result.files.map((file) => ({
    path: file.path,
    digest: file.digest,
    sizeBytes: file.sizeBytes,
    mediaType: file.mediaType ?? "",
  }));
  return {
    requestId: result.requestId,
    importId: result.importId,
    assetId: result.assetId,
    versionId: result.versionId,
    agentId: result.agentId,
    providerOrgId: result.providerOrgId,
    managedRootId: result.managedRootId,
    relativePath: result.relativePath,
    manifestDigest: result.manifestDigest,
    contentSha256: result.contentSha256,
    totalSizeBytes: result.totalSizeBytes,
    format: result.format,
    entriesDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    scannedAtUnixMs: result.scannedAt.getTime(),
  };
}

function assertAttestation(result: DataScanWireResult): void {
  if (
    result.manifestDigest.length !== 64 ||
    result.contentSha256.length !== 64 ||
    result.totalSizeBytes < 0 ||
    result.format !== "directory" ||
    result.attestationAlgorithm !== "rsa-sha256" ||
    !result.attestationKeyId.trim() ||
    !result.attestationSignature.trim() ||
    Number.isNaN(result.scannedAt.getTime())
  ) {
    throw new Error("Data scan result has an invalid Agent attestation");
  }
  for (const file of result.files) {
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.split(/[\\/]/).some((part) => part === "" || part === "..") ||
      file.digest.length !== 64 ||
      file.sizeBytes < 0
    ) {
      throw new Error("Data scan result contains an invalid file manifest entry");
    }
  }
}
