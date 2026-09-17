import { createHash, sign } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  type AgentDataRoots,
  createLocalDatasetAttestation,
  type DatasetFileManifest,
} from "./local-data-security";

export interface CpLocalDataScanRequest {
  requestId: string;
  importId: string;
  assetId: string;
  versionId: string;
  managedRootId: string;
  relativePath: string;
  providerOrgId: string;
}

export interface CpLocalDataScanResult extends CpLocalDataScanRequest {
  agentId: string;
  manifestDigest: string;
  contentSha256: string;
  totalSizeBytes: number;
  format: "directory";
  files: DatasetFileManifest[];
  attestationAlgorithm: "rsa-sha256";
  attestationKeyId: string;
  attestationSignature: string;
  scannedAtUnixMs: number;
}

export interface CpLocalDataScanSigner {
  keyId: string;
  sign(payload: string): string;
}

export interface CpLocalDataScanner {
  scan(request: CpLocalDataScanRequest): Promise<CpLocalDataScanResult>;
}

export interface CpLocalDataScanAttestationPayload {
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
  format: "directory";
  entriesDigest: string;
  scannedAtUnixMs: number;
}

export function createCpLocalDataScanAttestationPayload(input: {
  request: CpLocalDataScanRequest;
  agentId: string;
  manifestDigest: string;
  contentSha256: string;
  totalSizeBytes: number;
  format: "directory";
  files: readonly DatasetFileManifest[];
  scannedAtUnixMs: number;
}): CpLocalDataScanAttestationPayload {
  return {
    requestId: input.request.requestId,
    importId: input.request.importId,
    assetId: input.request.assetId,
    versionId: input.request.versionId,
    agentId: input.agentId,
    providerOrgId: input.request.providerOrgId,
    managedRootId: input.request.managedRootId,
    relativePath: input.request.relativePath,
    manifestDigest: input.manifestDigest,
    contentSha256: input.contentSha256,
    totalSizeBytes: input.totalSizeBytes,
    format: input.format,
    entriesDigest: createDataScanEntriesDigest(input.files),
    scannedAtUnixMs: input.scannedAtUnixMs,
  };
}

export function serializeCpLocalDataScanAttestation(
  payload: CpLocalDataScanAttestationPayload,
): string {
  return JSON.stringify(payload);
}

function createDataScanEntriesDigest(files: readonly DatasetFileManifest[]): string {
  const entries = files.map((file) => ({
    path: file.path,
    digest: file.sha256,
    sizeBytes: file.sizeBytes,
    mediaType: "",
  }));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function createCpLocalDataScanSigner(input: {
  keyId: string;
  privateKeyPem: string;
}): CpLocalDataScanSigner {
  if (!input.keyId.trim() || !input.privateKeyPem.trim()) {
    throw new Error("CP-local data scans require an Agent mTLS signing key");
  }
  return {
    keyId: input.keyId,
    sign: (payload) =>
      sign("RSA-SHA256", Buffer.from(payload), input.privateKeyPem).toString("base64"),
  };
}

export function createCpLocalDataScanner(input: {
  roots: AgentDataRoots;
  agentId: string;
  signer: CpLocalDataScanSigner;
  now?: () => Date;
}): CpLocalDataScanner {
  return {
    async scan(request) {
      assertScanRequest(request);
      const manifest = await input.roots.scanManagedDataset(
        request.managedRootId,
        request.relativePath,
      );
      const localAttestation = createLocalDatasetAttestation(manifest);
      const scannedAtUnixMs = (input.now ?? (() => new Date()))().getTime();
      const result = {
        ...request,
        agentId: input.agentId,
        manifestDigest: localAttestation.manifestDigest,
        contentSha256: manifest.merkleRoot,
        totalSizeBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
        format: "directory" as const,
        files: manifest.files,
        attestationAlgorithm: "rsa-sha256" as const,
        attestationKeyId: input.signer.keyId,
        scannedAtUnixMs,
      };
      const attestationPayload = createCpLocalDataScanAttestationPayload({
        request,
        agentId: result.agentId,
        manifestDigest: result.manifestDigest,
        contentSha256: result.contentSha256,
        totalSizeBytes: result.totalSizeBytes,
        format: result.format,
        files: result.files,
        scannedAtUnixMs,
      });
      return {
        ...result,
        attestationSignature: input.signer.sign(
          serializeCpLocalDataScanAttestation(attestationPayload),
        ),
      };
    },
  };
}

function assertScanRequest(request: CpLocalDataScanRequest): void {
  for (const value of [
    request.requestId,
    request.importId,
    request.assetId,
    request.versionId,
    request.managedRootId,
    request.providerOrgId,
  ]) {
    if (!value.trim()) throw new Error("CP-local data scan identifiers must be non-empty");
  }
  if (
    !request.relativePath ||
    isAbsolute(request.relativePath) ||
    request.relativePath.split(/[\\/]/).some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error("CP-local data scan path must be relative without parent traversal");
  }
}
